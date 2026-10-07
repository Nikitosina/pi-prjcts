import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;
const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Read-only, helper-free Git for verification; failures are reduced to a fingerprint. */
function metadataGit(root: string, signal?: AbortSignal) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1" };
  return async (arguments_: string[], maxBuffer = 262144): Promise<Buffer> => {
    signal?.throwIfAborted();
    try {
      const result = await execute("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...arguments_], { encoding: "buffer", env, signal, timeout: 10000, maxBuffer });
      return result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown local Git metadata failure";
      throw new Error(`Local Git metadata unavailable; fingerprint ${createHash("sha256").update(message).digest("hex")}`);
    }
  };
}
export async function localPublicationSnapshot(input: { root: string; branch: string; head: string; base: string; frozenBase?: string; previous?: string | null; files: readonly string[]; signal?: AbortSignal }) {
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Local Git verification refuses NODE_OPTIONS or PI_PACKAGE_DIR overrides");
  if (!sha.test(input.head) || !sha.test(input.base) || input.frozenBase && !sha.test(input.frozenBase) || input.previous && !sha.test(input.previous)) throw new Error("Local publication requires immutable commit SHAs");
  const allowed = new Set(input.files);
  if (allowed.size !== input.files.length || input.files.some(file => file.includes("\\") || file.includes("\0") || file.split("/").some(part => !part || part === "." || part === ".." || part === ".git"))) throw new Error("Invalid owned local publication paths");
  const root = await realpath(input.root);
  const git = metadataGit(root, input.signal);
  async function assertCheckout() {
    if (await realpath(text(await git(["rev-parse", "--show-toplevel"])).trim()) !== root || await realpath(input.root) !== root) throw new Error("Local publication checkout root changed");
    if (text(await git(["symbolic-ref", "--short", "HEAD"])).trim() !== input.branch || text(await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== input.head) throw new Error("Local task branch/head does not match publication");
    if ((await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...input.files])).length !== 0) throw new Error("Assigned local files differ from the pushed commit");
  }
  await assertCheckout();
  if (text(await git(["rev-parse", "--verify", `${input.base}^{commit}`])).trim() !== input.base) throw new Error("Frozen publication base is not locally available");
  if (input.frozenBase) await git(["merge-base", "--is-ancestor", input.frozenBase, input.base]);
  await git(["merge-base", "--is-ancestor", input.base, input.head]);
  if (input.previous) await git(["merge-base", "--is-ancestor", input.previous, input.head]);
  const names = text(await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", input.base, input.head, "--"]));
  if (names && !names.endsWith("\0")) throw new Error("Local change list is incomplete");
  const changed = names ? names.slice(0, -1).split("\0") : [];
  if (changed.some(file => !allowed.has(file))) throw new Error("Local task commit changes unassigned repository paths");
  let totalBytes = 0;
  const files: { path: string; mode: string; bytes: number; sha256: string }[] = [];
  for (const file of input.files) {
    const tree = text(await git(["ls-tree", "-z", "--full-tree", input.head, "--", file]));
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(tree);
    const mode = match?.[1], blob = match?.[2];
    if (!match || !mode || !blob || match[3] !== file) throw new Error("Local publication requires regular assigned blobs; deletion/symlinks/submodules are unavailable");
    const bytes = await git(["cat-file", "blob", blob]);
    if (bytes.length > 65536) throw new Error("Local publication file exceeds scope limit");
    text(bytes);
    totalBytes += bytes.length;
    if (totalBytes > 262144) throw new Error("Local publication exceeds aggregate scope limit");
    files.push({ path: file, mode, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await assertCheckout();
  return { head: input.head, base: input.base, frozenBase: input.frozenBase ?? input.base, branch: input.branch, changed, files };
}

/** Whole-repository heads: any path may change, so the receipt records the full base..head name-status list instead of assigned blobs. */
export async function wholeRepositorySnapshot(input: { root: string; branch: string; head: string; base: string; previous: string | null; signal?: AbortSignal }) {
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Local Git verification refuses NODE_OPTIONS or PI_PACKAGE_DIR overrides");
  if (!sha.test(input.head) || !sha.test(input.base) || input.previous && !sha.test(input.previous)) throw new Error("Local publication requires immutable commit SHAs");
  const root = await realpath(input.root);
  const git = metadataGit(root, input.signal);
  async function assertCheckout() {
    if (await realpath(text(await git(["rev-parse", "--show-toplevel"])).trim()) !== root || await realpath(input.root) !== root) throw new Error("Local publication checkout root changed");
    if (text(await git(["symbolic-ref", "--short", "HEAD"])).trim() !== input.branch) throw new Error(`Worktree is not on its worker branch ${input.branch}`);
    if (text(await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== input.head) throw new Error("Worktree HEAD differs from expectedHead; commit and push first");
  }
  await assertCheckout();
  try { await git(["merge-base", "--is-ancestor", input.base, input.head]); } catch { throw new Error("Pushed head does not descend from the thread base"); }
  if (input.previous) try { await git(["merge-base", "--is-ancestor", input.previous, input.head]); } catch { throw new Error("Pushed head rewinds the previously verified head"); }
  const raw = text(await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", input.base, input.head, "--"], 4194304));
  if (raw && !raw.endsWith("\0")) throw new Error("Local change list is incomplete");
  const fields = raw ? raw.slice(0, -1).split("\0") : [];
  const changed: { status: string; path: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index], path = fields[index + 1];
    if (!status || !/^[ADMT]$/.test(status) || path === undefined) throw new Error("Unexpected local change entry");
    changed.push({ status, path });
  }
  if (changed.length === 0) throw new Error("Pushed head has no changes relative to the thread base");
  await assertCheckout();
  return { head: input.head, base: input.base, branch: input.branch, changed };
}
