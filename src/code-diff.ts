import { isAbsolute } from "node:path";
import { findVcsRoot, cli, runCli, type CliResult } from "./vcs.ts";
import { plugins } from "./plugins.ts";
import { RESPONSE_LIMIT, bytes, ellipsize, fitPrefix } from "./response-limit.ts";

/** How much diff text is collected before paging; a page is at most RESPONSE_LIMIT bytes, so the rest is reached with offset or narrowed with path. */
export const CODE_DIFF_CAP = 256 * 1024;
// Every part that leads a page is bounded, so the diff text always gets at least MIN_PAGE bytes and offset always advances.
const CHANGED_FILES_BYTES = 2048, HEAD_BYTES = 1000, STATUS_BYTES = 1500, FIELD_BYTES = 200, NOTE_ROOM = 240, MIN_PAGE = 512;
export type DiffPage = { path?: string; offset?: number; /** Bytes already spent on text placed before this page. */ reserve?: number };
const REV = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/;
const DEFAULT_BASES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"] as const;

/** Read-only change view of a checkout: changed files, then one page of the unified diff of HEAD plus uncommitted work against the merge-base with `base` (default branch / trunk). A page is at most RESPONSE_LIMIT bytes with its position note; `offset` continues it and `path` narrows it to one file or directory. Only diff, merge-base, rev-parse, status and ls-files run; nothing is written. */
export async function codeDiff(root: string, base?: string, page: DiffPage = {}): Promise<string> {
  if (base !== undefined && (!REV.test(base) || base.includes("..") || base.includes("@{"))) throw new Error(`Invalid base ${JSON.stringify(base)}: use a branch, tag or commit SHA`);
  const { path, offset = 0 } = page;
  if (path !== undefined && (!path || path.length > 400 || path.startsWith("-") || path.startsWith("~") || isAbsolute(path) || path.split(/[\\/]/).includes("..") || /[\0-\x1f]/.test(path))) throw new Error(`Invalid path ${JSON.stringify(path)}: use a path inside the checkout, relative to its root`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  const vcs = findVcsRoot(root);
  if (!vcs) throw new Error(`${root} is not a git checkout (or a plugin checkout kind that is loaded); no diff is available`);
  const text = async (result: Promise<CliResult>, what: string, tolerate = false) => { const out = await result; if (out.code && !(tolerate && out.stdout)) throw new Error(`${what} failed: ${out.stderr.trim().slice(-300) || `exit ${out.code}`}`); return out.stdout; };
  const git = (...args: string[]) => runCli(cli.git(), ["-C", vcs.root, "--literal-pathspecs", ...args]);
  const only = path === undefined ? [] : [path];
  let mergeBase: string, changed: string, diff: string, revision = "", untracked: string[] = [];
  if (vcs.kind === "git") {
    let chosen = base;
    for (const candidate of base ? [] : DEFAULT_BASES) if (!chosen && (await git("rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`)).code === 0) chosen = candidate;
    if (!chosen) throw new Error("Could not find a default branch to diff against (tried origin/HEAD, origin/main, origin/master, main, master); pass base");
    mergeBase = (await text(git("merge-base", "--end-of-options", chosen, "HEAD"), `git merge-base ${chosen} HEAD`)).trim();
    revision = (await text(git("rev-parse", "--verify", "HEAD^{commit}"), "git rev-parse HEAD")).trim();
    const flags = ["--no-ext-diff", "--no-textconv", "--no-color"];
    changed = await text(git("diff", ...flags, "--stat=200", mergeBase, "--", ...only), "git diff --stat", true);
    diff = await text(git("diff", ...flags, mergeBase, "--", ...only), "git diff", true);
    untracked = (await text(git("ls-files", "--others", "--exclude-standard", "--", ...only), "git ls-files")).split("\n").filter(Boolean);
    let done = 0;
    for (const file of untracked) { if (diff.length > CODE_DIFF_CAP) break; diff += await text(git("diff", ...flags, "--no-index", "--", "/dev/null", file), `git diff ${file}`, true); done++; }
    // Untracked files past the collection cap are named, so a complete-looking last page cannot hide them.
    if (done < untracked.length) diff += `\n[${untracked.length - done} untracked ${untracked.length - done === 1 ? "file" : "files"} not included: collection stopped at ${CODE_DIFF_CAP / 1024} KB; read one with path]\n`;
  } else {
    if (path !== undefined) throw new Error(`path narrows diffs of git checkouts only; ${vcs.kind} checkouts page with offset`);
    const provider = plugins.vcsProvider(vcs.kind);
    if (!provider) throw new Error(`No plugin for ${vcs.kind} checkouts is loaded; no diff is available`);
    ({ mergeBase, changed, diff, untracked } = await provider.codeDiff(vcs.root, base, { text, cap: CODE_DIFF_CAP }));
  }
  if (offset > diff.length) throw new Error(`offset ${offset} is past the end of the ${diff.length}-character diff`);
  const head = ellipsize(`Diff of this checkout (${vcs.kind})${revision ? ` at HEAD ${revision}` : ""} against merge-base ${mergeBase.slice(0, 12)}${base ? ` with ${base}` : ""}${path ? `, limited to ${path}` : ""}, including uncommitted changes.${untracked.length ? ` ${untracked.length} new untracked file(s): ${untracked.slice(0, 12).join(", ")}${untracked.length > 12 ? ", ..." : ""}.` : ""}`, HEAD_BYTES);
  if (!diff.trim() && !untracked.length) return `${head}\nNo changes.`;
  // Page 0 leads with the changed-file list; later pages are the bare continuation.
  const lead = offset === 0 ? `${head}\nChanged files:\n${shortList(changed.trim() || "(none tracked)")}\n\n` : "";
  const shown = fitPrefix(diff.slice(offset), Math.max(RESPONSE_LIMIT - (page.reserve ?? 0) - bytes(lead) - NOTE_ROOM, MIN_PAGE)), next = offset + shown.length;
  const note = next >= diff.length ? (offset === 0 ? "" : `\n[diff chars ${offset}-${next} of ${diff.length}; end of diff]`) : `\n[diff chars ${offset}-${next} of ${diff.length}; continue with offset=${next}, or pass path for one file]`;
  return `${lead}${shown}${note}`;
}

/** The changed-file list is at most CHANGED_FILES_BYTES; a long list keeps its first lines and counts the rest. */
function shortList(list: string): string {
  if (bytes(list) <= CHANGED_FILES_BYTES) return list;
  const lines = list.split("\n"); let used = 0, kept = 0;
  while (kept < lines.length && used + bytes(lines[kept]!) + 1 <= CHANGED_FILES_BYTES - 80) used += bytes(lines[kept++]!) + 1;
  return `${lines.slice(0, kept).join("\n")}\n... ${lines.length - kept} more lines; pass path to see one file`;
}

/** Coordinator view of a worker's worktree: branch, head and status list (staged, unstaged, untracked), then one page of the diff. Page 0 carries the header; later pages are the bare continuation. Read-only like codeDiff. */
export async function workerChanges(root: string, base?: string, page: DiffPage = {}): Promise<string> {
  if (page.offset) return codeDiff(root, base, page);
  const vcs = findVcsRoot(root);
  if (!vcs) throw new Error(`${root} is not a git checkout (or a plugin checkout kind that is loaded); no diff is available`);
  let branch = "", head = "", status = "";
  if (vcs.kind === "git") {
    const git = async (...args: string[]) => (await runCli(cli.git(), ["-C", vcs.root, ...args])).stdout;
    [branch, head, status] = [(await git("rev-parse", "--abbrev-ref", "HEAD")).trim(), (await git("rev-parse", "HEAD")).trim(), await git("status", "--porcelain=v1", "--untracked-files=all")];
  } else {
    const provider = plugins.vcsProvider(vcs.kind);
    if (!provider) throw new Error(`No plugin for ${vcs.kind} checkouts is loaded; no diff is available`);
    ({ branch, head, status } = await provider.workerState(vcs.root));
  }
  const lines = status.split("\n").filter(Boolean).map(line => ellipsize(line, FIELD_BYTES)); let used = 0, kept = 0;
  while (kept < lines.length && used + bytes(lines[kept]!) + 1 <= STATUS_BYTES) used += bytes(lines[kept++]!) + 1;
  const field = (value: string) => ellipsize(value, FIELD_BYTES);
  const lead = `Worktree ${field(vcs.root)} (${vcs.kind})\nBranch: ${field(branch || "unknown")}\nHead: ${field(head || "unknown")}\nStatus (${lines.length ? `${lines.length} path(s); XY codes: first column staged, second unstaged, ?? untracked` : "clean"}):\n${lines.slice(0, kept).join("\n")}${lines.length > kept ? `\n... ${lines.length - kept} more; pass path to see one file` : ""}\n\n`;
  return lead + await codeDiff(root, base, { ...page, reserve: bytes(lead) });
}
