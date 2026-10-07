import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "./state.ts";
import { WorkerSkillDocument, type WorkerSkillDocument as Document } from "./worker-skill-types.ts";

const maxBytes = 65536;
type FileFacts = BigIntStats;
type ProtectedFile = { path: string; dev: string; ino: string };
type ReadOptions = { root: string; relativePath: string; protectedFiles: readonly ProtectedFile[] };

function physical(facts: FileFacts): Document["physical"] {
  return { dev: facts.dev.toString(), ino: facts.ino.toString(), size: facts.size.toString(), mtimeNs: facts.mtimeNs.toString(), ctimeNs: facts.ctimeNs.toString() };
}
function sameFile(left: FileFacts, right: FileFacts) {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function backingFile(path: string) {
  const name = basename(path).toLowerCase();
  return /^(?:auth|models|settings|credentials)\.json$/.test(name) || /^\.env(?:\.|$)/.test(name);
}
async function readSelectedDocument(input: ReadOptions) {
  const relativePath = parse(WorkerSkillDocument.properties.relativePath, input.relativePath);
  const root = resolve(input.root);
  if (!isAbsolute(input.root) || root !== input.root || await realpath(root) !== root) throw new Error("Skill directory must be its captured canonical absolute path");
  const path = join(root, relativePath), suffix = relative(root, path);
  const privateDirectory = path.split(sep).some(part => [".git", ".arc", ".ssh", ".aws", ".gnupg", "sessions"].includes(part.toLowerCase()));
  if (!suffix || suffix !== relativePath || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`) || backingFile(path) || privateDirectory) throw new Error("Skill document is outside its approved directory or names a backing file");
  const directories: Array<{ path: string; facts: FileFacts }> = [];
  let current = root;
  for (const part of ["", ...relativePath.split("/").slice(0, -1)]) {
    if (part) current = join(current, part);
    const facts = await lstat(current, { bigint: true });
    if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("Skill document parent must be a regular directory, not a symlink");
    directories.push({ path: current, facts });
  }
  const expected = await lstat(path, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > BigInt(maxBytes) || await realpath(path) !== path) throw new Error("Skill document must be a bounded regular file inside its approved directory");
  if (input.protectedFiles.some(file => resolve(file.path) === path || file.dev === expected.dev.toString() && file.ino === expected.ino.toString())) throw new Error("Skill document aliases a protected backing file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let outcome: { kind: "read"; text: string; sha256: string; facts: FileFacts } | { kind: "failed"; error: unknown };
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFile(expected, before)) throw new Error("Skill document identity changed before reading");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (length > maxBytes || BigInt(length) !== before.size || !sameFile(before, after) || !sameFile(before, named) || await realpath(path) !== path) throw new Error("Skill document changed during its bounded read");
    for (const directory of directories) {
      const namedDirectory = await lstat(directory.path, { bigint: true });
      if (!namedDirectory.isDirectory() || namedDirectory.isSymbolicLink() || directory.facts.dev !== namedDirectory.dev || directory.facts.ino !== namedDirectory.ino) throw new Error("Skill document directory identity changed during reading");
    }
    const captured = bytes.subarray(0, length);
    outcome = { kind: "read", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured), sha256: createHash("sha256").update(captured).digest("hex"), facts: before };
  } catch (error) { outcome = { kind: "failed", error }; }
  try { await handle.close(); }
  catch (error) {
    if (outcome.kind === "failed") throw new AggregateError([outcome.error, error], "Skill document read and close failed");
    throw error;
  }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome;
}

export async function captureWorkerSkillDocument(input: ReadOptions): Promise<Document> {
  const result = await readSelectedDocument(input);
  const identity = { root: input.root, relativePath: input.relativePath, sha256: result.sha256, physical: physical(result.facts) };
  return parse(WorkerSkillDocument, { id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), relativePath: input.relativePath, sha256: result.sha256, size: Number(result.facts.size), physical: identity.physical });
}

export async function readWorkerSkillDocument(input: Omit<ReadOptions, "relativePath"> & { document: Document }): Promise<string> {
  const result = await readSelectedDocument({ ...input, relativePath: input.document.relativePath });
  if (result.sha256 !== input.document.sha256 || Number(result.facts.size) !== input.document.size || JSON.stringify(physical(result.facts)) !== JSON.stringify(input.document.physical)) throw new Error("Frozen skill document changed; no substitute or new revision will be read");
  return result.text;
}
