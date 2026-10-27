import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const MAX_FILES = 50_000, MAX_BYTES = 1024 ** 3;

/** One target file as the verifier sees it: `kind:mode:hash`, where a symlink hashes its link text. */
export type TargetEntry = { path: string; digest: string };
export type TargetManifest = {
  /** Content revision: sha256 over every non-ignored file (tracked, modified or untracked) and its mode. HEAD is recorded beside it, not inside it. */
  revision: string;
  head: string | null;
  branch: string | null;
  files: TargetEntry[];
  bytes: number;
};

function git(root: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/git", ["-C", root, ...args], { env: GIT_ENV, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    if (input) child.stdin?.end(input);
  });
}

async function digestOf(root: string, path: string, remainingBytes: number): Promise<{ digest: string; bytes: number } | null> {
  const full = join(root, path);
  const stat = await lstat(full).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { digest: `l:${createHash("sha256").update(await readlink(full)).digest("hex")}`, bytes: 0 };
  if (!stat.isFile()) throw new Error(`Unsupported target entry: ${path}`);
  if (stat.size > remainingBytes) throw new Error("Target exceeds revision hashing byte limit");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(full, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.length;
    if (bytes > remainingBytes) throw new Error("Target exceeds revision hashing byte limit while reading");
    hash.update(chunk);
  }
  return { digest: `f:${(stat.mode & 0o111) ? "x" : "-"}:${hash.digest("hex")}`, bytes };
}

const revisionOf = (files: readonly TargetEntry[]) => createHash("sha256").update(files.map(entry => `${entry.digest}\0${entry.path}\n`).join("")).digest("hex");

/** The non-ignored files of a worktree, as git sees them: tracked (including uncommitted edits) and untracked, minus deletions. */
async function listFiles(root: string): Promise<string[]> {
  const staged = (await git(root, ["ls-files", "--stage", "-z"])).toString("utf8");
  if (/(^|\0)160000 /.test(staged)) throw new Error("Gitlink/submodule targets are unsupported; their nested contents cannot be verified");
  const out = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).toString("utf8");
  return [...new Set(out.split("\0").filter(Boolean))].sort().filter(path => path !== ".git" && !path.startsWith(`.git${sep}`));
}

/** Content revision of a worktree including uncommitted and untracked work. Throws when the target is too large to snapshot. */
export async function captureTarget(root: string, maxBytes = MAX_BYTES): Promise<TargetManifest> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) throw new Error("Capture byte limit must not exceed 1 GiB");
  const paths = await listFiles(root), files: TargetEntry[] = [];
  let bytes = 0;
  if (paths.length > MAX_FILES) throw new Error(`Target has ${paths.length} files; revision hashing is limited to ${MAX_FILES}`);
  for (const path of paths) {
    const found = await digestOf(root, path, maxBytes - bytes);
    if (!found) continue;
    bytes += found.bytes;
    files.push({ path, digest: found.digest });
  }
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => Buffer.alloc(0))).toString().trim() || null;
  const branch = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => Buffer.alloc(0))).toString().trim() || null;
  return { revision: revisionOf(files), head, branch, files, bytes };
}

export type Drift = { added: string[]; removed: string[]; modified: string[] };
export const driftPaths = (drift: Drift): string[] => [...drift.added, ...drift.removed, ...drift.modified].sort();
/** What differs between two captures of one tree: files that appeared, vanished or changed content or mode. Ignored files are in neither. */
export function diffManifests(before: Pick<TargetManifest, "files">, after: Pick<TargetManifest, "files">): Drift {
  const was = new Map(before.files.map(entry => [entry.path, entry.digest])), now = new Map(after.files.map(entry => [entry.path, entry.digest]));
  return {
    added: [...now.keys()].filter(path => !was.has(path)).sort(),
    removed: [...was.keys()].filter(path => !now.has(path)).sort(),
    modified: [...now].filter(([path, digest]) => was.has(path) && was.get(path) !== digest).map(([path]) => path).sort(),
  };
}

/** Files that define what counts as proof: verification skills, scripts, tests, build and CI config. A worker that edits them can weaken the check it is judged by. */
const PROOF_FILE = /^(\.agents|\.cursor|\.claude)\/skills\/|^scripts\/|(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|^(package\.json|Makefile|\.github\/workflows\/)/;
export type ProofChanges = { paths: string[]; diff: string };
/** Proof changes since the host's frozen allocation base, including committed, staged and untracked edits. */
export async function proofChanges(root: string, manifest: Pick<TargetManifest, "files" | "head">, baseRevision: string): Promise<ProofChanges> {
  if (!manifest.head) throw new Error("Proof changes require a committed allocation base");
  const trackedPaths = (await git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", baseRevision, "--"])).toString("utf8").split("\0");
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).toString("utf8").split("\0");
  const paths = [...new Set([...trackedPaths, ...untracked])].filter(path => PROOF_FILE.test(path)).sort();
  if (!paths.length) return { paths, diff: "" };
  const tracked = (await git(root, ["diff", baseRevision, "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...paths])).toString("utf8");
  const added = paths.filter(path => untracked.includes(path)).map(path => `(untracked proof file) ${path}`).join("\n");
  const text = `Allocation base: ${baseRevision}\n${tracked}${added ? `\n${added}` : ""}`;
  return { paths, diff: text.length > 6000 ? `${text.slice(0, 6000)}\n… (diff capped; ${paths.length} proof file(s) changed)` : text };
}

export async function writeManifest(path: string, manifest: TargetManifest): Promise<void> { await writeFile(path, JSON.stringify(manifest), { mode: 0o600 }); }
export async function readManifest(path: string): Promise<TargetManifest> { return JSON.parse(await readFile(path, "utf8")) as TargetManifest; }
