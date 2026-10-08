import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";

import type { Context } from "@earendil-works/chord";
import type { Evidence } from "./state.ts";

const readLimit = 64 * 1024;
const writeLimit = 64 * 1024;
const listLimit = 1000;
const vcsDirectories = [".git", ".hg", ".svn"];
const revision = Type.String({ pattern: "^[a-f0-9]{64}$" });

export type WorkspaceProvider = "git" | "arc";

/** Host-persisted allocation facts; this module neither creates nor verifies the allocation. */
export type WorkspaceAuthority = {
  projectId: string;
  repositoryId: string;
  provider: WorkspaceProvider;
  workspaceId: string;
  receiptId: string;
  attemptId: string;
  leaseRevision: string;
  workspaceRoot: string;
  files: readonly string[];
  /** Any non-VCS path in the allocated root is owned; `files` is then empty. */
  wholeRepository?: true;
  expiresAt: string;
};

export type WorkspaceWorkerBinding = { role: "durable-worker"; conversationId: number };
export type AuthorityValidation = { approved: false; blocker: string } | { approved: true; authority: WorkspaceAuthority };
/** Called immediately before every filesystem read and inside the write lock before replacement. */
export type AuthorityValidator = (authority: Readonly<WorkspaceAuthority>, action: "read" | "write") => Promise<AuthorityValidation>;
/** A host-owned SQLite location shared by every factory that can write this authorization domain. */
export type WorkspaceWriteLock = { controlRoot: string; databasePath: string; waitMs?: number };
/** Test-only bounded observer: it receives a verified replacement before Durable stores the final tool result. */
export type WorkspaceWriteTestObserver = (effect: Readonly<{ taskId: string; callId: string; revision: string; bytes: number }>) => Promise<void>;

export type WorkspaceCapabilityOptions = {
  caller: "durable-worker";
  authority?: WorkspaceAuthority;
  binding?: WorkspaceWorkerBinding;
  validateAuthority?: AuthorityValidator;
  writeLock?: WorkspaceWriteLock;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  testAfterWrite?: WorkspaceWriteTestObserver;
  captureEvidence?: (input: { path: string; title: string; bytes: Buffer }, api: ToolExecutionApi, context: Context) => Promise<Evidence>;
};

/**
 * Return registrations with deterministic workspace-specific names. Configure exactly
 * these names on the selected worker conversation; do not offer them to a coordinator.
 */
export async function workspaceCapabilities(options: WorkspaceCapabilityOptions): Promise<ToolRegistration[]> {
  const supplied = options.authority ? canonicalWorkspaceAuthority(options.authority) : null;
  const root = supplied === null ? { pin: null, blocker: "No workspace allocation authority was supplied." } : await captureRoot(supplied);
  const scope = supplied !== null && root.pin !== null ? canonicalWorkspaceAuthority({ ...supplied, workspaceRoot: root.pin.path }) : supplied;
  const lock = options.writeLock ? await captureLock(options.writeLock) : { path: null, blocker: "No host-owned write lock is configured." };
  const bytes = { read: options.maxReadBytes ?? readLimit, write: options.maxWriteBytes ?? writeLimit };
  const names = scope === null ? { read: "projects_workspace_unbound_read", write: "projects_workspace_unbound_write" } : toolNames(scope.workspaceId);

  const read = defineTool({
    name: names.read,
    description: "Read one approved regular file from this allocated workspace. No other path is available.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }) }), replay: "safe", executionMode: "sequential",
    async execute(args, api) {
      const checked = await fileFor("read", args.path, Number(api.conversationId));
      if ("blocker" in checked) return blocked(checked.blocker);
      try {
        const data = await readBounded(checked.path, bytes.read);
        return result({ path: args.path, revision: digest(data), text: data.toString("utf8"), bytes: data.byteLength });
      } catch (error) { return blocked(message(error)); }
    },
  });

  const write = defineTool({
    name: names.write,
    description: "Atomically create or revision-check one approved regular file in this allocated workspace.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }), text: Type.String({ maxLength: writeLimit }), expectedRevision: Type.Union([revision, Type.Null()]) }),
    // The built-in ToolTask records this intent, and never reruns unsafe execution after recovery.
    replay: "unsafe", executionMode: "sequential",
    async execute(args, api) {
      if (Buffer.byteLength(args.text) > bytes.write) return blocked(`Write exceeds the ${bytes.write}-byte scope limit.`);
      if (lock.path === null) return blocked(lock.blocker);
      try {
        return await withWriteLock(lock.path, options.writeLock?.waitMs ?? 250, async () => {
          const checked = await fileFor("write", args.path, Number(api.conversationId));
          if ("blocker" in checked) return blocked(checked.blocker);
          const before = await readCurrent(checked.path);
          if (args.expectedRevision === null ? before !== null : before === null || digest(before) !== args.expectedRevision) return blocked("Revision conflict; reread the owned file before writing.");
          // This second authorization, path, and revision check is immediately before replacement.
          const again = await fileFor("write", args.path, Number(api.conversationId));
          if ("blocker" in again) return blocked(again.blocker);
          const latest = await readCurrent(again.path);
          if (args.expectedRevision === null ? latest !== null : latest === null || digest(latest) !== args.expectedRevision) return blocked("Revision conflict; the owned file changed before replacement.");
          await replace(again.path, Buffer.from(args.text));
          const after = await readCurrent(again.path);
          if (after === null || after.toString("utf8") !== args.text) return blocked("Write result could not be verified by its owned file hash.");
          const effect = { taskId: String(api.taskId), callId: api.callId, revision: digest(after), bytes: after.byteLength };
          // Used only by the owned crash E2E; it cannot grant, alter, or bypass scope checks.
          await options.testAfterWrite?.(effect);
          return result({ path: args.path, revision: effect.revision, bytes: effect.bytes, effect: `${effect.taskId}:${effect.callId}`, receipt: scope?.receiptId ?? null });
        });
      } catch (error) { return blocked(message(error)); }
    },
  });

  const list = defineTool({
    name: `${names.read}_list`,
    description: "List one directory of this allocated workspace, non-recursively. Use \".\" for the repository root. Directories end with /, symlinks with @.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }) }), replay: "safe", executionMode: "sequential",
    async execute(args, api) {
      const checked = await directoryFor(args.path, Number(api.conversationId));
      if ("blocker" in checked) return blocked(checked.blocker);
      try {
        const entries = (await readdir(checked.path, { withFileTypes: true })).filter(entry => !vcsDirectories.includes(entry.name)).map(entry => entry.isSymbolicLink() ? `${entry.name}@` : entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
        return result({ path: args.path, entries: entries.slice(0, listLimit).join("\n"), total: entries.length, truncated: entries.length > listLimit ? 1 : 0 });
      } catch (error) { return blocked(message(error)); }
    },
  });

  async function directoryFor(requested: string, conversationId: number): Promise<{ path: string } | { blocker: string }> {
    if (scope === null || root.pin === null) return { blocker: root.blocker };
    if (options.binding?.role !== "durable-worker" || options.binding.conversationId !== conversationId) return { blocker: "This workspace scope is bound to a different worker conversation." };
    const name = requested === "." ? "." : approvedPath(requested, scope);
    if (name === null) return { blocker: "Path is not an approved relative directory." };
    const authorized = await validate(scope, options.validateAuthority, root.pin, "read");
    if ("blocker" in authorized) return authorized;
    const current = await currentRoot(scope, root.pin);
    if (current === null) return { blocker: "Allocated workspace root changed or traverses a symlink." };
    let cursor = current;
    for (const part of name === "." ? [] : name.split("/")) {
      cursor = join(cursor, part); const stat = await lstat(cursor).catch(() => null);
      if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return { blocker: "Path is missing, traverses a symlink, or is not a directory." };
    }
    return { path: cursor };
  }

  async function fileFor(action: "read" | "write", requested: string, conversationId: number): Promise<{ path: string } | { blocker: string }> {
    if (scope === null || root.pin === null) return { blocker: root.blocker };
    if (options.binding?.role !== "durable-worker" || options.binding.conversationId !== conversationId) return { blocker: "This workspace scope is bound to a different worker conversation." };
    const name = approvedPath(requested, scope);
    if (name === null) return { blocker: "Path is not an approved relative owned file." };
    const authorized = await validate(scope, options.validateAuthority, root.pin, action);
    if ("blocker" in authorized) return authorized;
    const current = await currentRoot(scope, root.pin);
    if (current === null) return { blocker: "Allocated workspace root changed or traverses a symlink." };
    const checked = await inspectPath(current, name, action === "write");
    return checked === null ? { blocker: "Path traverses a symlink, escapes the allocated root, or is not a regular file." } : { path: checked };
  }

  const capture = defineTool({ name: `${names.read}_capture_evidence`, description: "Capture an assigned file as immutable project evidence at its exact SHA-256 revision. Native task/call identity is recorded. No unassigned paths are available.", parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }), title: Type.String({ minLength: 1, maxLength: 2000 }), expectedRevision: revision }, { additionalProperties: false }), replay: "unsafe", executionMode: "sequential", async execute(args, api, context) {
    if (!options.captureEvidence) return blocked("Evidence capture is unavailable for this scope.");
    const checked = await fileFor("read", args.path, Number(api.conversationId));
    if ("blocker" in checked) return blocked(checked.blocker);
    try {
      context.abortSignal?.throwIfAborted();
      const data = await readBounded(checked.path, bytes.read);
      if (digest(data) !== args.expectedRevision) return blocked("Evidence revision conflict; reread the assigned file before capture.");
      const again = await fileFor("read", args.path, Number(api.conversationId));
      if ("blocker" in again) return blocked(again.blocker);
      context.abortSignal?.throwIfAborted();
      return result(await options.captureEvidence({ path: args.path, title: args.title, bytes: data }, api, context));
    } catch (error) { return blocked(message(error)); }
  } });
  const tools = options.captureEvidence ? [read, write, capture] : [read, write];
  return scope?.wholeRepository ? [...tools, list] : tools;
}

/** Host-factory lock path for a real allocated root. A control-root domain serializes aliases of one physical workspace, not unrelated roots. */
export async function workspacePhysicalLockPath(controlRoot: string, workspaceRoot: string): Promise<string> {
  try {
    const control = await realpath(controlRoot), lexical = await lstat(workspaceRoot), root = await realpath(workspaceRoot), stat = await lstat(root, { bigint: true });
    if (lexical.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Allocated workspace root is not a real directory");
    const key = createHash("sha256").update(`${stat.dev}:${stat.ino}`).digest("hex");
    return join(control, `workspace-write-${key}.sqlite`);
  } catch (error) { throw new Error(`Physical workspace lock identity is unavailable: ${message(error)}`); }
}
/** Deterministic names avoid collisions when one registry serves multiple workspace scopes. */
export function workspaceToolNames(workspaceId: string): { read: string; write: string } { return toolNames(workspaceId); }
/** Clone and freeze allocation facts so later option mutation cannot alter an active scope. */
export function canonicalWorkspaceAuthority(source: WorkspaceAuthority): Readonly<WorkspaceAuthority> { return Object.freeze({ ...source, files: Object.freeze([...source.files]) }); }

function toolNames(workspaceId: string): { read: string; write: string } {
  const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
  return { read: `projects_workspace_${key}_read`, write: `projects_workspace_${key}_write` };
}

type RootPin = { path: string; dev: bigint; ino: bigint };
function suppliedRoot(path: string): string { return path.length > 1 ? path.replace(/[\\/]+$/, "") : path; }
async function captureRoot(scope: Readonly<WorkspaceAuthority>): Promise<{ pin: RootPin | null; blocker: string }> {
  try {
    const supplied = suppliedRoot(scope.workspaceRoot), lexical = await lstat(supplied, { bigint: true });
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) return { pin: null, blocker: "Allocated workspace root is not a supplied real directory." };
    const path = await realpath(supplied), stat = await lstat(path, { bigint: true });
    return !stat.isSymbolicLink() && stat.isDirectory() ? { pin: { path, dev: stat.dev, ino: stat.ino }, blocker: "" } : { pin: null, blocker: "Allocated workspace root is not a real directory." };
  } catch { return { pin: null, blocker: "Allocated workspace root is unavailable." }; }
}
async function currentRoot(scope: Readonly<WorkspaceAuthority>, pin: RootPin): Promise<string | null> {
  try {
    const supplied = suppliedRoot(scope.workspaceRoot), lexical = await lstat(supplied, { bigint: true });
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) return null;
    const path = await realpath(supplied), stat = await lstat(path, { bigint: true });
    return path === pin.path && !stat.isSymbolicLink() && stat.isDirectory() && stat.dev === pin.dev && stat.ino === pin.ino ? pin.path : null;
  } catch { return null; }
}
async function captureLock(lock: WorkspaceWriteLock): Promise<{ path: string | null; blocker: string }> {
  try {
    const root = await realpath(lock.controlRoot), database = join(root, relative(root, lock.databasePath));
    if (relative(root, database).startsWith(`..${sep}`) || relative(root, database) === "..") return { path: null, blocker: "Write lock database is outside the host control root." };
    if ((await lstat(root)).isSymbolicLink()) return { path: null, blocker: "Write lock control root cannot be a symlink." };
    for (let cursor = dirname(database); cursor !== root; cursor = dirname(cursor)) if ((await lstat(cursor)).isSymbolicLink()) return { path: null, blocker: "Write lock path cannot traverse symlinks." };
    if ((await lstat(database).catch(() => null))?.isSymbolicLink()) return { path: null, blocker: "Write lock database cannot be a symlink." };
    return { path: database, blocker: "" };
  } catch { return { path: null, blocker: "Host write lock control root is unavailable." }; }
}
async function validate(scope: Readonly<WorkspaceAuthority>, validator: AuthorityValidator | undefined, pin: RootPin, action: "read" | "write"): Promise<{ ok: true } | { blocker: string }> {
  const expires = Date.parse(scope.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now()) return { blocker: "Workspace authority is missing or expired." };
  if (!validator) return { blocker: "No authority validator is configured; workspace access is blocked." };
  try {
    const decision = await validator(scope, action);
    if (!decision.approved) return { blocker: `Workspace authority blocked: ${decision.blocker}` };
    return await sameAuthority(scope, decision.authority, pin) ? { ok: true } : { blocker: "Workspace authority changed, is foreign, or has a provider mismatch." };
  } catch (error) { return { blocker: `Workspace authority validation failed: ${message(error)}` }; }
}
async function sameAuthority(left: Readonly<WorkspaceAuthority>, right: WorkspaceAuthority, pin: RootPin): Promise<boolean> { if (left.projectId !== right.projectId || left.repositoryId !== right.repositoryId || left.provider !== right.provider || left.workspaceId !== right.workspaceId || left.receiptId !== right.receiptId || left.attemptId !== right.attemptId || left.leaseRevision !== right.leaseRevision || left.expiresAt !== right.expiresAt || left.wholeRepository !== right.wholeRepository || left.files.length !== right.files.length || !left.files.every((file, index) => file === right.files[index])) return false; try { const supplied = suppliedRoot(right.workspaceRoot), lexical = await lstat(supplied, { bigint: true }); if (lexical.isSymbolicLink() || !lexical.isDirectory()) return false; const path = await realpath(supplied), stat = await lstat(path, { bigint: true }); return !stat.isSymbolicLink() && stat.isDirectory() && stat.dev === pin.dev && stat.ino === pin.ino; } catch { return false; } }
function approvedPath(value: string, scope: Readonly<WorkspaceAuthority>): string | null {
  if (value.includes("\0") || isAbsolute(value) || value.includes("\\")) return null;
  const parts = value.split("/");
  return parts.some(part => part.length === 0 || part === "." || part === ".." || vcsDirectories.includes(part)) || !scope.wholeRepository && !scope.files.includes(value) ? null : value;
}
async function inspectPath(root: string, name: string, write: boolean): Promise<string | null> {
  const target = join(root, name);
  if (relative(root, target).startsWith(`..${sep}`) || relative(root, target) === "..") return null;
  let cursor = root;
  for (const part of name.split("/").slice(0, -1)) {
    cursor = join(cursor, part); const stat = await lstat(cursor).catch(() => null);
    if (stat === null) { if (!write) return null; continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }
  const final = await lstat(target).catch(() => null);
  return final?.isSymbolicLink() || (final !== null && !final.isFile()) || (!write && final === null) ? null : target;
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, "r");
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw new Error(`Read exceeds the ${limit}-byte scope limit.`); return await file.readFile(); }
  finally { await file.close(); }
}
async function readCurrent(path: string): Promise<Buffer | null> { try { return await readFile(path); } catch (error) { if (isMissing(error)) return null; throw error; } }
async function replace(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temp = join(dirname(path), `.projects-write-${randomUUID()}`);
  try { const file = await open(temp, "wx", 0o600); try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); } await rename(temp, path); }
  finally { await unlink(temp).catch(() => undefined); }
}
export async function withWorkspaceMutationLock<T>(lock: WorkspaceWriteLock, action: () => Promise<T>): Promise<T> {
  const captured = await captureLock(lock);
  if (captured.path === null) throw new Error(captured.blocker);
  return withWriteLock(captured.path, lock.waitMs ?? 250, action);
}
async function withWriteLock<T>(path: string, waitMs: number, action: () => Promise<T>): Promise<T> {
  const database = new DatabaseSync(path);
  try {
    // SQLite's own busy wait would block the event loop, so a holder in this same process could never finish; poll instead.
    database.exec("PRAGMA busy_timeout=0");
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 5_000));
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE"); break; }
      catch (error) { if (!/locked|busy/i.test(message(error)) || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    try { const value = await action(); database.exec("COMMIT"); return value; }
    catch (error) { try { database.exec("ROLLBACK"); } catch { } throw error; }
  } finally { database.close(); }
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function result(value: Record<string, string | number | null>) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; }
function blocked(blocker: string) { return { ...result({ blocker }), isError: true }; }
