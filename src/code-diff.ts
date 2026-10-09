import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findVcsRoot, cli, runCli, type CliResult } from "./vcs.ts";

/** Cap on the diff text returned to a scout/reviewer. The harness clips any tool result at 50 KB without a note, so the cap stays below it to keep ours visible. */
export const CODE_DIFF_CAP = 46 * 1024;
const REV = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,199}$/;
const DEFAULT_BASES = { git: ["origin/HEAD", "origin/main", "origin/master", "main", "master"], arc: ["trunk"] } as const;

/** Read-only change view of a checkout: changed files, then the unified diff of HEAD plus uncommitted work against the merge-base with `base` (default branch / trunk). Only diff, merge-base, rev-parse, status and ls-files run; nothing is written. */
export async function codeDiff(root: string, base?: string): Promise<string> {
  if (base !== undefined && (!REV.test(base) || base.includes("..") || base.includes("@{"))) throw new Error(`Invalid base ${JSON.stringify(base)}: use a branch, tag or commit SHA`);
  const vcs = findVcsRoot(root);
  if (!vcs) throw new Error(`${root} is not a git or Arc checkout; no diff is available`);
  const text = async (result: Promise<CliResult>, what: string, tolerate = false) => { const out = await result; if (out.code && !(tolerate && out.stdout)) throw new Error(`${what} failed: ${out.stderr.trim().slice(-300) || `exit ${out.code}`}`); return out.stdout; };
  const git = (...args: string[]) => runCli(cli.git(), ["-C", vcs.root, ...args]);
  const arc = (...args: string[]) => runCli(cli.arc(), args, vcs.root);
  let mergeBase: string, changed: string, diff: string, untracked: string[] = [];
  if (vcs.kind === "git") {
    let chosen = base;
    for (const candidate of base ? [] : DEFAULT_BASES.git) if (!chosen && (await git("rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`)).code === 0) chosen = candidate;
    if (!chosen) throw new Error("Could not find a default branch to diff against (tried origin/HEAD, origin/main, origin/master, main, master); pass base");
    mergeBase = (await text(git("merge-base", "--end-of-options", chosen, "HEAD"), `git merge-base ${chosen} HEAD`)).trim();
    const flags = ["--no-ext-diff", "--no-textconv", "--no-color"];
    changed = await text(git("diff", ...flags, "--stat=200", mergeBase, "--"), "git diff --stat", true);
    diff = await text(git("diff", ...flags, mergeBase, "--"), "git diff", true);
    untracked = (await text(git("ls-files", "--others", "--exclude-standard"), "git ls-files")).split("\n").filter(Boolean);
    for (const file of untracked) { if (diff.length > CODE_DIFF_CAP) break; diff += await text(git("diff", ...flags, "--no-index", "--", "/dev/null", file), `git diff ${file}`, true); }
  } else {
    const wanted = base ?? DEFAULT_BASES.arc[0];
    // `arc merge-base` may be unavailable; the plain base is then the comparison point.
    const found = await arc("merge-base", wanted, "HEAD");
    mergeBase = found.code === 0 && found.stdout.trim() ? found.stdout.trim().split(/\s+/)[0] : wanted;
    changed = await text(arc("diff", "--stat", mergeBase, "HEAD"), "arc diff --stat", true) + await text(arc("diff", "--stat"), "arc diff --stat (uncommitted)", true);
    diff = await text(arc("diff", mergeBase, "HEAD"), "arc diff", true) + await text(arc("diff"), "arc diff (uncommitted)", true);
    untracked = (await text(arc("status", "--short"), "arc status")).split("\n").filter(line => line.startsWith("??")).map(line => line.slice(3).trim());
    // arc has no diff for untracked files: show them as additions (regular files only, bounded).
    for (const file of untracked) {
      if (diff.length > CODE_DIFF_CAP) break;
      try { const path = join(vcs.root, file); if (lstatSync(path).isFile()) diff += `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n${readFileSync(path, "utf8").slice(0, 20_000).split("\n").map(line => `+${line}`).join("\n")}\n`; } catch { /* unreadable: still listed above */ }
    }
  }
  const head = `Diff of this checkout (${vcs.kind}) against merge-base ${mergeBase.slice(0, 12)}${base ? ` with ${base}` : ""}, including uncommitted changes.${untracked.length ? ` New untracked files: ${untracked.join(", ")}.` : ""}`;
  if (!diff.trim() && !untracked.length) return `${head}\nNo changes.`;
  const body = diff.length > CODE_DIFF_CAP ? `${diff.slice(0, CODE_DIFF_CAP)}\n[diff truncated at ${CODE_DIFF_CAP / 1024} KB of ${Math.ceil(diff.length / 1024)} KB; read the rest with code_read]` : diff;
  return `${head}\nChanged files:\n${changed.trim() || "(none tracked)"}\n\n${body}`;
}

/** Coordinator view of a worker's worktree: branch, head and status list (staged, unstaged, untracked), then the capped diff. Read-only like codeDiff. */
export async function workerChanges(root: string, base?: string): Promise<string> {
  const vcs = findVcsRoot(root);
  if (!vcs) throw new Error(`${root} is not a git or Arc checkout; no diff is available`);
  let branch = "", head = "", status = "";
  if (vcs.kind === "git") {
    const git = async (...args: string[]) => (await runCli(cli.git(), ["-C", vcs.root, ...args])).stdout;
    [branch, head, status] = [(await git("rev-parse", "--abbrev-ref", "HEAD")).trim(), (await git("rev-parse", "HEAD")).trim(), await git("status", "--porcelain=v1", "--untracked-files=all")];
  } else {
    try { const info = JSON.parse((await runCli(cli.arc(), ["info", "--json"], vcs.root)).stdout) as { branch?: string; hash?: string }; branch = info.branch ?? ""; head = info.hash ?? ""; } catch { /* reported as unknown */ }
    status = (await runCli(cli.arc(), ["status", "--short"], vcs.root)).stdout;
  }
  const lines = status.split("\n").filter(Boolean);
  return `Worktree ${vcs.root} (${vcs.kind})\nBranch: ${branch || "unknown"}\nHead: ${head || "unknown"}\nStatus (${lines.length ? `${lines.length} path(s); XY codes: first column staged, second unstaged, ?? untracked` : "clean"}):\n${lines.slice(0, 200).join("\n")}${lines.length > 200 ? `\n... ${lines.length - 200} more` : ""}\n\n${await codeDiff(root, base)}`;
}
