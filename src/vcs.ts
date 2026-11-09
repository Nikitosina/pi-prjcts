import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { plugins } from "./plugins.ts";

/** Version-control binaries. */
export const cli = {
  git: () => "/usr/bin/git",
};

/** Nearest directory above `cwd` that is a checkout root. A plugin kind wins over `.git` in the same directory; a git repository nested in such a checkout is git. */
export function findVcsRoot(cwd: string): { kind: string; root: string } | null {
  const kinds = plugins.vcsProviders();
  for (let at = realpathSync(cwd); ; at = dirname(at)) {
    const provider = kinds.find((item) => item.isRoot(at));
    if (provider) return { kind: provider.kind, root: at };
    if (existsSync(join(at, ".git"))) return { kind: "git", root: at };
    if (dirname(at) === at) return null;
  }
}

export type CliResult = { code: number; stdout: string; stderr: string };
/** Runs a VCS binary without throwing; the exit code is data. */
export function runCli(file: string, args: string[], cwd?: string): Promise<CliResult> {
  return new Promise((done) =>
    execFile(file, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    ),
  );
}
/** HEAD commit of a worktree (git or a plugin kind); null when it cannot be read. */
export async function headCommit(cwd: string): Promise<string | null> {
  const head = await readHead(cwd);
  return head.kind === "commit" ? head.sha : null;
}
export type HeadRead = { kind: "commit"; sha: string } | { kind: "unreadable"; reason: string };
/** HEAD commit of a worktree through its checkout kind (a plugin kind's provider, else git), or why it cannot be read. */
export async function readHead(cwd: string): Promise<HeadRead> {
  const unreadable = (reason: string): HeadRead => ({ kind: "unreadable", reason });
  try {
    const found = findVcsRoot(cwd);
    const provider = found && found.kind !== "git" ? plugins.vcsProvider(found.kind) : undefined;
    if (found && provider) {
      const head = (await provider.workerState(found.root)).head.trim();
      return head ? { kind: "commit", sha: head } : unreadable(`the ${found.kind} checkout reported no HEAD commit`);
    }
    const result = await runCli(cli.git(), ["-C", cwd, "rev-parse", "--verify", "HEAD^{commit}"]);
    const sha = result.stdout.trim();
    return result.code === 0 && sha
      ? { kind: "commit", sha }
      : unreadable(result.stderr.trim().slice(-300) || `git rev-parse exited ${result.code}`);
  } catch (error) {
    return unreadable(error instanceof Error ? error.message : String(error));
  }
}
/** Uncommitted paths of a worktree (git or a plugin kind, by what is found above it); null when the status cannot be read. */
export async function changedFiles(cwd: string): Promise<string[] | null> {
  const found = findVcsRoot(cwd);
  const provider = found && found.kind !== "git" ? plugins.vcsProvider(found.kind) : undefined;
  if (provider) return provider.changedFiles(cwd);
  const result = await runCli(cli.git(), ["-C", cwd, "status", "--porcelain", "--untracked-files=normal"]);
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : null;
}
