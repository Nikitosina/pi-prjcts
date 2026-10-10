import { findVcsRoot, cli, runCli, type CliResult } from "./vcs.ts";
import { plugins } from "./plugins.ts";

/** Cap on the diff text returned to a scout/reviewer. The harness clips any tool result at 50 KB without a note, so the cap stays below it to keep ours visible. */
export const CODE_DIFF_CAP = 46 * 1024;
const REV = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/;
const DEFAULT_BASES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"] as const;

/** Read-only change view of a checkout: changed files, then the unified diff of HEAD plus uncommitted work against the merge-base with `base` (default branch / trunk). Only diff, merge-base, rev-parse, status and ls-files run; nothing is written. */
export async function codeDiff(root: string, base?: string): Promise<string> {
  if (base !== undefined && (!REV.test(base) || base.includes("..") || base.includes("@{"))) throw new Error(`Invalid base ${JSON.stringify(base)}: use a branch, tag or commit SHA`);
  const vcs = findVcsRoot(root);
  if (!vcs) throw new Error(`${root} is not a git checkout (or a plugin checkout kind that is loaded); no diff is available`);
  const text = async (result: Promise<CliResult>, what: string, tolerate = false) => { const out = await result; if (out.code && !(tolerate && out.stdout)) throw new Error(`${what} failed: ${out.stderr.trim().slice(-300) || `exit ${out.code}`}`); return out.stdout; };
  const git = (...args: string[]) => runCli(cli.git(), ["-C", vcs.root, ...args]);
  let mergeBase: string, changed: string, diff: string, untracked: string[] = [];
  if (vcs.kind === "git") {
    let chosen = base;
    for (const candidate of base ? [] : DEFAULT_BASES) if (!chosen && (await git("rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`)).code === 0) chosen = candidate;
    if (!chosen) throw new Error("Could not find a default branch to diff against (tried origin/HEAD, origin/main, origin/master, main, master); pass base");
    mergeBase = (await text(git("merge-base", "--end-of-options", chosen, "HEAD"), `git merge-base ${chosen} HEAD`)).trim();
    const flags = ["--no-ext-diff", "--no-textconv", "--no-color"];
    changed = await text(git("diff", ...flags, "--stat=200", mergeBase, "--"), "git diff --stat", true);
    diff = await text(git("diff", ...flags, mergeBase, "--"), "git diff", true);
    untracked = (await text(git("ls-files", "--others", "--exclude-standard"), "git ls-files")).split("\n").filter(Boolean);
    for (const file of untracked) { if (diff.length > CODE_DIFF_CAP) break; diff += await text(git("diff", ...flags, "--no-index", "--", "/dev/null", file), `git diff ${file}`, true); }
  } else {
    const provider = plugins.vcsProvider(vcs.kind);
    if (!provider) throw new Error(`No plugin for ${vcs.kind} checkouts is loaded; no diff is available`);
    ({ mergeBase, changed, diff, untracked } = await provider.codeDiff(vcs.root, base, { text, cap: CODE_DIFF_CAP }));
  }
  const head = `Diff of this checkout (${vcs.kind}) against merge-base ${mergeBase.slice(0, 12)}${base ? ` with ${base}` : ""}, including uncommitted changes.${untracked.length ? ` New untracked files: ${untracked.join(", ")}.` : ""}`;
  if (!diff.trim() && !untracked.length) return `${head}\nNo changes.`;
  const body = diff.length > CODE_DIFF_CAP ? `${diff.slice(0, CODE_DIFF_CAP)}\n[diff truncated at ${CODE_DIFF_CAP / 1024} KB of ${Math.ceil(diff.length / 1024)} KB; read the rest with code_read]` : diff;
  return `${head}\nChanged files:\n${changed.trim() || "(none tracked)"}\n\n${body}`;
}

/** Coordinator view of a worker's worktree: branch, head and status list (staged, unstaged, untracked), then the capped diff. Read-only like codeDiff. */
export async function workerChanges(root: string, base?: string): Promise<string> {
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
  const lines = status.split("\n").filter(Boolean);
  return `Worktree ${vcs.root} (${vcs.kind})\nBranch: ${branch || "unknown"}\nHead: ${head || "unknown"}\nStatus (${lines.length ? `${lines.length} path(s); XY codes: first column staged, second unstaged, ?? untracked` : "clean"}):\n${lines.slice(0, 200).join("\n")}${lines.length > 200 ? `\n... ${lines.length - 200} more` : ""}\n\n${await codeDiff(root, base)}`;
}
