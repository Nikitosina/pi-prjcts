import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { findVcsRoot, cli, runCli, type CliResult } from "./vcs.ts";
import { plugins } from "./plugins.ts";
import { RESPONSE_LIMIT, bytes, ellipsize, fitPrefix } from "./response-limit.ts";

/** How much diff text is collected before paging; a page is at most RESPONSE_LIMIT bytes, so the rest is reached with offset or narrowed with path. */
export const CODE_DIFF_CAP = 256 * 1024;
// Every part that leads a page is bounded, so the diff text always gets at least MIN_PAGE bytes and offset always advances.
const CHANGED_FILES_BYTES = 2048,
  HEAD_BYTES = 1000,
  STATUS_BYTES = 1500,
  FIELD_BYTES = 200,
  STAT_ROW_BYTES = 600,
  NOTE_ROOM = 240,
  MIN_PAGE = 512;
/** What a page shows: the unified diff (offset counts characters) or the changed files with line counts (offset counts files). */
export const DiffMode = { Diff: "diff", Stat: "stat" } as const;
export type DiffMode = (typeof DiffMode)[keyof typeof DiffMode];
export const DiffModeSchema = Type.Union([Type.Literal(DiffMode.Diff), Type.Literal(DiffMode.Stat)], {
  description:
    "diff (default): pages of the unified diff. stat: pages of the changed files with +/- line counts, to choose files to read with path.",
});
export type DiffPage = {
  /** One file or directory, relative to the project directory (the root code_read uses). */
  path?: string;
  offset?: number;
  mode?: DiffMode;
  /** Bytes already spent on text placed before this page. */
  reserve?: number;
};
/** One changed file of a diff; paths are relative to the checkout root until a page shows them. */
export type FileStat =
  | { kind: "text"; path: string; added: number; removed: number }
  | { kind: "binary"; path: string }
  /** An untracked file past the collection cap: named, not counted. */
  | { kind: "uncounted"; path: string };
const REV = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/;
const DEFAULT_BASES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"] as const;

type Collected = {
  kind: string;
  /** Checkout root. */
  root: string;
  /** Project directory the call was made from; path and the stat list are relative to it. */
  dir: string;
  mergeBase: string;
  revision: string;
  changed: string;
  diff: string;
  untracked: string[];
  /** Whether this checkout kind narrows by path, so notes may advise it. */
  narrows: boolean;
};

/** Read-only change view of a checkout: changed files, then one page of the unified diff of HEAD plus uncommitted work against the merge-base with `base` (default branch / trunk), or with mode "stat" one page of the changed files with +/- counts. A page is at most RESPONSE_LIMIT bytes with its position note; `offset` continues it and `path` narrows it to one file or directory of the project directory. Only diff, merge-base, rev-parse, status and ls-files run; nothing is written. */
export async function codeDiff(root: string, base?: string, page: DiffPage = {}): Promise<string> {
  if (base !== undefined && (!REV.test(base) || base.includes("..") || base.includes("@{")))
    throw new Error(`Invalid base ${JSON.stringify(base)}: use a branch, tag or commit SHA`);
  const { path, offset = 0, mode = DiffMode.Diff } = page;
  if (
    path !== undefined &&
    (!path ||
      path.length > 400 ||
      path.startsWith("-") ||
      path.startsWith("~") ||
      isAbsolute(path) ||
      path.split(/[\\/]/).includes("..") ||
      /[\0-\x1f]/.test(path))
  )
    throw new Error(`Invalid path ${JSON.stringify(path)}: use a path inside the project directory, relative to it`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  const found = await collect(root, base, path);
  const { kind, mergeBase, revision, diff, untracked } = found;
  const where = found.dir === found.root ? "" : relative(found.root, found.dir);
  const head = ellipsize(
    [
      `${mode === DiffMode.Stat ? "Changed files of" : "Diff of"} this checkout (${kind})${revision ? ` at HEAD ${revision}` : ""} against merge-base ${mergeBase.slice(0, 12)}${base ? ` with ${base}` : ""}${path ? `, limited to ${path}` : ""}, including uncommitted changes.`,
      mode === DiffMode.Diff && untracked.length
        ? `${untracked.length} new untracked file(s): ${untracked.slice(0, 12).join(", ")}${untracked.length > 12 ? ", ..." : ""}.`
        : "",
      !where
        ? ""
        : mode === DiffMode.Stat
          ? `Paths are relative to the project directory ${where}.`
          : `Paths below are relative to the checkout root; path is relative to the project directory ${where}.`,
    ]
      .filter(Boolean)
      .join(" "),
    HEAD_BYTES,
  );
  if (!diff.trim() && !untracked.length) return `${head}\nNo changes.`;
  if (mode === DiffMode.Stat) return statPage(found, head, offset, page.reserve ?? 0);
  if (offset > diff.length) throw new Error(`offset ${offset} is past the end of the ${diff.length}-character diff`);
  // Page 0 leads with the changed-file list; later pages are the bare continuation.
  const lead = offset === 0 ? `${head}\nChanged files:\n${shortList(found.changed.trim() || "(none tracked)")}\n\n` : "";
  const shown = fitPrefix(diff.slice(offset), Math.max(RESPONSE_LIMIT - (page.reserve ?? 0) - bytes(lead) - NOTE_ROOM, MIN_PAGE)),
    next = offset + shown.length;
  const note =
    next >= diff.length
      ? offset === 0
        ? ""
        : `\n[diff chars ${offset}-${next} of ${diff.length}; end of diff]`
      : `\n[diff chars ${offset}-${next} of ${diff.length}; continue with offset=${next}${found.narrows ? ", pass path for one file," : ","} or mode="stat" for the files with +/- counts]`;
  return `${lead}${shown}${note}`;
}

/** Runs the checkout kind's diff once: git here, a plugin kind through its provider. `path` reaches the provider relative to its checkout root. */
async function collect(root: string, base: string | undefined, path: string | undefined): Promise<Collected> {
  const vcs = findVcsRoot(root);
  if (!vcs) throw new Error(`${root} is not a git checkout (or a plugin checkout kind that is loaded); no diff is available`);
  const dir = realpathSync(root);
  const only = path === undefined ? undefined : relative(vcs.root, resolve(dir, path)) || ".";
  const text = async (result: Promise<CliResult>, what: string, tolerate = false) => {
    const out = await result;
    if (out.code && !(tolerate && out.stdout)) throw new Error(`${what} failed: ${out.stderr.trim().slice(-300) || `exit ${out.code}`}`);
    return out.stdout;
  };
  if (vcs.kind !== "git") {
    const provider = plugins.vcsProvider(vcs.kind);
    if (!provider) throw new Error(`No plugin for ${vcs.kind} checkouts is loaded; no diff is available`);
    const narrows = provider.codeDiffPath === true;
    if (only !== undefined && !narrows)
      throw new Error(`The ${vcs.kind} plugin cannot narrow diffs to a path; page with offset, or use mode="stat" to list the files`);
    const parts = await provider.codeDiff(vcs.root, base, { text, cap: CODE_DIFF_CAP, ...(only === undefined ? {} : { path: only }) });
    const untracked = only === undefined ? parts.untracked : parts.untracked.filter((file) => under(only, file));
    return { kind: vcs.kind, root: vcs.root, dir, revision: "", narrows, ...parts, untracked };
  }
  const git = (...args: string[]) => runCli(cli.git(), ["-C", vcs.root, "--literal-pathspecs", ...args]);
  const pathspec = only === undefined ? [] : [only];
  let chosen = base;
  for (const candidate of base ? [] : DEFAULT_BASES)
    if (!chosen && (await git("rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`)).code === 0)
      chosen = candidate;
  if (!chosen)
    throw new Error(
      "Could not find a default branch to diff against (tried origin/HEAD, origin/main, origin/master, main, master); pass base",
    );
  const mergeBase = (await text(git("merge-base", "--end-of-options", chosen, "HEAD"), `git merge-base ${chosen} HEAD`)).trim();
  const revision = (await text(git("rev-parse", "--verify", "HEAD^{commit}"), "git rev-parse HEAD")).trim();
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color"];
  const changed = await text(git("diff", ...flags, "--stat=200", mergeBase, "--", ...pathspec), "git diff --stat", true);
  let diff = await text(git("diff", ...flags, mergeBase, "--", ...pathspec), "git diff", true);
  const untracked = (await text(git("ls-files", "--others", "--exclude-standard", "--", ...pathspec), "git ls-files"))
    .split("\n")
    .filter(Boolean);
  let done = 0;
  for (const file of untracked) {
    if (diff.length > CODE_DIFF_CAP) break;
    diff += await text(git("diff", ...flags, "--no-index", "--", "/dev/null", file), `git diff ${file}`, true);
    done++;
  }
  // Untracked files past the collection cap are named, so a complete-looking last page cannot hide them.
  if (done < untracked.length)
    diff += `\n[${untracked.length - done} untracked ${untracked.length - done === 1 ? "file" : "files"} not included: collection stopped at ${CODE_DIFF_CAP / 1024} KB; read one with path]\n`;
  return { kind: "git", root: vcs.root, dir, mergeBase, revision, changed, diff, untracked, narrows: true };
}

const under = (dir: string, file: string) => dir === "." || file === dir || file.startsWith(`${dir}/`);

/** One page of the changed files with +/- counts; offset counts files. Paths are shown relative to the project directory, so they can be passed back as path. */
function statPage(found: Collected, head: string, offset: number, reserve: number): string {
  const counted = fileStats(found.diff);
  const seen = new Set(counted.map((item) => item.path));
  const files: FileStat[] = [
    ...counted,
    ...found.untracked.filter((file) => !seen.has(file)).map((file): FileStat => ({ kind: "uncounted", path: file })),
  ];
  if (offset > files.length) throw new Error(`offset ${offset} is past the end of the ${files.length}-file list`);
  const shownPath = (path: string) => relative(found.dir, join(found.root, path)) || ".";
  const rows = files.map((file) => {
    const path = shownPath(file.path);
    switch (file.kind) {
      case "text":
        return ellipsize(`+${file.added} -${file.removed} ${path}`, STAT_ROW_BYTES);
      case "binary":
        return ellipsize(`binary ${path}`, STAT_ROW_BYTES);
      case "uncounted":
        return ellipsize(`untracked, not counted ${path}`, STAT_ROW_BYTES);
      default: {
        const _exhaustive: never = file;
        return _exhaustive;
      }
    }
  });
  const added = counted.reduce((sum, file) => sum + (file.kind === "text" ? file.added : 0), 0),
    removed = counted.reduce((sum, file) => sum + (file.kind === "text" ? file.removed : 0), 0);
  const lead = offset === 0 ? `${head}\n${files.length} changed file(s), +${added} -${removed}:\n` : "";
  const room = Math.max(RESPONSE_LIMIT - reserve - bytes(lead) - NOTE_ROOM, MIN_PAGE);
  let used = 0,
    next = offset;
  while (next < rows.length && (next === offset || used + bytes(rows[next]!) + 1 <= room)) used += bytes(rows[next++]!) + 1;
  const narrow = found.narrows ? `; read one file's diff with path` : "";
  const note =
    next >= rows.length
      ? `[files ${offset + 1}-${next} of ${rows.length}; end of list${narrow}]`
      : `[files ${offset + 1}-${next} of ${rows.length}; continue with offset=${next} and mode="stat"${narrow}]`;
  return `${lead}${rows.slice(offset, next).join("\n")}\n${note}`;
}

/**
 * Per-file +/- counts of a unified diff (git or plain headers). Hunks are consumed by their line counts, so content that looks like a
 * header is counted as content. Blocks of one path (committed and uncommitted parts) merge; a block without a hunk header counts its
 * "+" lines after "+++" (plugin blocks for untracked files).
 */
export function fileStats(diff: string): FileStat[] {
  const files = new Map<string, FileStat>();
  type Block = { path: string; added: number; removed: number; binary: boolean };
  let current: Block | null = null,
    afterHeader = false,
    oldLeft = 0,
    newLeft = 0;
  const flush = () => {
    if (!current?.path) return;
    const { path, added, removed, binary } = current;
    const before = files.get(path);
    files.set(
      path,
      binary || before?.kind === "binary"
        ? { kind: "binary", path }
        : before?.kind === "text"
          ? { kind: "text", path, added: before.added + added, removed: before.removed + removed }
          : { kind: "text", path, added, removed },
    );
  };
  const start = (path: string): Block => {
    flush();
    afterHeader = false;
    return { path, added: 0, removed: 0, binary: false };
  };
  for (const line of diff.split("\n")) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) (newLeft--, current.added++);
      else if (line.startsWith("-")) (oldLeft--, current.removed++);
      else (oldLeft--, newLeft--);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      afterHeader = false;
    } else if (line.startsWith("diff --git ")) current = start(headerPath(line.slice(11)));
    else if (line.startsWith("Index: ")) current = start(line.slice(7).trim());
    else if (line.startsWith("--- ")) {
      // A plain unified diff has no "diff" line: a ---/+++ pair after another file's hunks starts the next file.
      if (!current || afterHeader || current.added + current.removed > 0) current = start("");
      current.path = sidePath(line.slice(4)) ?? current.path;
    } else if (!current) continue;
    else if (line.startsWith("+++ ") && !afterHeader) {
      current.path = sidePath(line.slice(4)) ?? current.path;
      afterHeader = true;
    } else if (line.startsWith("rename to ")) current.path = line.slice(10);
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
    else if (afterHeader && line.startsWith("+")) current.added++;
  }
  flush();
  return [...files.values()];
}

/** The b/ side of a "diff --git a/x b/x" line (quoted when the name has special characters). */
function headerPath(rest: string): string {
  const quoted = / "b\/(.*)"$/.exec(rest);
  if (quoted) return quoted[1]!;
  const at = rest.lastIndexOf(" b/");
  return at >= 0 ? rest.slice(at + 3) : rest;
}

/** The path of a ---/+++ header line: without a/ b/ prefixes, quotes or a trailing tab and date; null for /dev/null. */
function sidePath(value: string): string | null {
  const bare = value.split("\t")[0]!.replace(/^"(.*)"$/, "$1");
  if (bare === "/dev/null") return null;
  return bare.replace(/^[ab]\//, "");
}

/** The changed-file list is at most CHANGED_FILES_BYTES; a long list keeps its first lines and counts the rest. */
function shortList(list: string): string {
  if (bytes(list) <= CHANGED_FILES_BYTES) return list;
  const lines = list.split("\n");
  let used = 0,
    kept = 0;
  while (kept < lines.length && used + bytes(lines[kept]!) + 1 <= CHANGED_FILES_BYTES - 80) used += bytes(lines[kept++]!) + 1;
  return `${lines.slice(0, kept).join("\n")}\n... ${lines.length - kept} more lines; mode="stat" pages the full list`;
}

/** Coordinator view of a worker's worktree: branch, head and status list (staged, unstaged, untracked), then one page of the diff or of the file counts. Page 0 carries the header; later pages are the bare continuation. Read-only like codeDiff. */
export async function workerChanges(root: string, base?: string, page: DiffPage = {}): Promise<string> {
  if (page.offset) return codeDiff(root, base, page);
  const vcs = findVcsRoot(root);
  if (!vcs) throw new Error(`${root} is not a git checkout (or a plugin checkout kind that is loaded); no diff is available`);
  let branch = "",
    head = "",
    status = "";
  if (vcs.kind === "git") {
    const git = async (...args: string[]) => (await runCli(cli.git(), ["-C", vcs.root, ...args])).stdout;
    [branch, head, status] = [
      (await git("rev-parse", "--abbrev-ref", "HEAD")).trim(),
      (await git("rev-parse", "HEAD")).trim(),
      await git("status", "--porcelain=v1", "--untracked-files=all"),
    ];
  } else {
    const provider = plugins.vcsProvider(vcs.kind);
    if (!provider) throw new Error(`No plugin for ${vcs.kind} checkouts is loaded; no diff is available`);
    ({ branch, head, status } = await provider.workerState(vcs.root));
  }
  const lines = status
    .split("\n")
    .filter(Boolean)
    .map((line) => ellipsize(line, FIELD_BYTES));
  let used = 0,
    kept = 0;
  while (kept < lines.length && used + bytes(lines[kept]!) + 1 <= STATUS_BYTES) used += bytes(lines[kept++]!) + 1;
  const field = (value: string) => ellipsize(value, FIELD_BYTES);
  const lead = `Worktree ${field(vcs.root)} (${vcs.kind})\nBranch: ${field(branch || "unknown")}\nHead: ${field(head || "unknown")}\nStatus (${lines.length ? `${lines.length} path(s); XY codes: first column staged, second unstaged, ?? untracked` : "clean"}):\n${lines.slice(0, kept).join("\n")}${lines.length > kept ? `\n... ${lines.length - kept} more; mode="stat" lists every changed file` : ""}\n\n`;
  return lead + (await codeDiff(root, base, { ...page, reserve: bytes(lead) }));
}
