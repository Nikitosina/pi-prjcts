import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { inspectLegacyProject, prepareLegacyMigration } from "./durable-migration.ts";
import { Project, parse, type Project as ProjectData } from "./state.ts";

const MAX_METADATA = 16 * 1024 * 1024, MAX_ARCHIVE = 128 * 1024 * 1024;
const durableFiles = ["durable.sqlite", "durable.sqlite-journal", "durable.sqlite-wal", "durable.sqlite-shm", "durable-owner.sqlite", "durable-owner.sqlite-journal", "durable-owner.sqlite-wal", "durable-owner.sqlite-shm"];
const hashText = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ManifestFile = Type.Object({ path: Type.String({ minLength: 1 }), kind: Type.String(), bytes: Type.Integer({ minimum: 0, maximum: MAX_ARCHIVE }), sha256: hashText }, { additionalProperties: false });
const ManifestSchema = Type.Object({ format: Type.Literal(1), projectId: Type.String(), cwd: Type.String(), source: Type.String(), files: Type.Array(ManifestFile, { maxItems: 10000 }), totalBytes: Type.Integer({ minimum: 0, maximum: MAX_ARCHIVE }) }, { additionalProperties: false });
const CompleteSchema = Type.Object({ format: Type.Literal(1), manifestSha256: hashText, completedAt: Type.String(), nonce: Type.String() }, { additionalProperties: false });
const MarkerSchema = Type.Object({ format: Type.Literal(1), projectId: Type.String(), cwd: Type.String(), archiveDir: Type.String(), originalProjectSha256: hashText, durableProjectSha256: hashText, switchedAt: Type.String() }, { additionalProperties: false });
type Manifest = Static<typeof ManifestSchema>;
type SwitchMarker = Static<typeof MarkerSchema>;

export type DisposableDurableSwitchArgs = Readonly<{ projectDir: string; archiveDir: string; expectedProjectId: string; expectedCwd: string; confirmDisposable: true }>;
export type DisposableDurableSwitchResult = Readonly<{ project: ProjectData; archiveDir: string; archiveManifest: string; idempotent: boolean; history: "Original history remains byte-preserved in archive references only; it is never imported as instructions or runnable tool calls." }>;
export type DisposableDurableRollbackResult = Readonly<{ project: ProjectData; archiveDir: string; archiveManifest: string; durableEvidencePreserved: true; idempotent: boolean }>;

/** Switch an explicitly acknowledged copied project only; this never starts, restarts, or contacts a host. */
export function switchDisposableProject(args: DisposableDurableSwitchArgs): DisposableDurableSwitchResult {
  const input = validateArgs(args); assertHostNotLive(input.dir);
  const markerPath = join(input.dir, ".durable-switch.json"), initialMarker = readMarker(markerPath);
  if (!initialMarker) {
    const existing = durableFiles.filter(name => lstatSync(join(input.dir, name), { throwIfNoEntry: false }));
    const hasPending = readdirSync(input.dir).some(name => name.startsWith(".durable-switch.json.") && name.endsWith(".tmp"));
    // Only a prior gate's ownership file together with a recoverable marker temp may survive an interruption.
    if (existing.length && !(hasPending && existing.every(name => name.startsWith("durable-owner.sqlite")))) throw new Error("Project has unsupported existing Durable runtime storage");
    const completed = lstatSync(join(input.archive, "complete.json"), { throwIfNoEntry: false });
    if (completed) {
      // A completed archive can be checked without asking prepareLegacyMigration to reinterpret an interrupted marker temp as source history.
      const verified = verifyArchive(input.dir, input.archive, input.project); pendingMarker(input.dir, verified);
      inspectLegacyProject({ legacyProjectDir: input.dir, expectedProjectId: args.expectedProjectId, expectedCwd: args.expectedCwd, confirmDisposable: true });
    } else {
      prepareLegacyMigration({ legacyProjectDir: input.dir, archiveDir: input.archive, expectedProjectId: args.expectedProjectId, expectedCwd: args.expectedCwd, confirmDisposable: true });
      // A malformed interrupted marker must fail before this gate creates a lease artifact.
      pendingMarker(input.dir, verifyArchive(input.dir, input.archive, input.project));
    }
  }
  return withDurableLease(input.dir, () => {
  let marker = readMarker(markerPath);
  if (marker) inspectLegacyProject({ legacyProjectDir: input.dir, expectedProjectId: args.expectedProjectId, expectedCwd: args.expectedCwd, confirmDisposable: true });
  const archive = verifyArchive(input.dir, input.archive, input.project);
  marker ??= recoverMarker(input.dir, markerPath, archive);
  const original = archiveProject(archive);
  if (marker) {
    verifyMarker(marker, archive, original);
    // This remains mandatory even for an otherwise idempotent retry.
    assertOriginalFiles(input.dir, archive, true);
    const current = readBytes(join(input.dir, "project.json"), MAX_METADATA);
    if (hash(current) === marker.durableProjectSha256) return result(readProject(input.dir), archive, true);
    if (hash(current) !== marker.originalProjectSha256) throw new Error("Project metadata has conflicting human edits; refusing switch retry");
    atomicReplace(join(input.dir, "project.json"), durableProjectBytes(original));
    return result(readProject(input.dir), archive, false);
  }
  if (input.project.runtime !== undefined) throw new Error("Project already has an unsupported existing runtime; a switch marker is required for Durable retries");
  assertOriginalFiles(input.dir, archive, false);
  const originalBytes = readBytes(join(input.dir, "project.json"), MAX_METADATA), durable = durableProjectBytes(original);
  const next: SwitchMarker = { format: 1, projectId: original.id, cwd: resolve(original.cwd), archiveDir: archive.dir, originalProjectSha256: hash(originalBytes), durableProjectSha256: hash(durable), switchedAt: new Date().toISOString() };
  if (next.originalProjectSha256 !== hash(archive.projectBytes)) throw new Error("Copied project metadata differs from verified archive");
  atomicCreate(markerPath, JSON.stringify(next, null, 2) + "\n");
  atomicReplace(join(input.dir, "project.json"), durable);
  return result(readProject(input.dir), archive, false);
  });
}

/** Restore the archived project metadata byte-for-byte; Durable databases and marker remain immutable evidence. */
export function rollbackDisposableProject(args: DisposableDurableSwitchArgs): DisposableDurableRollbackResult {
  const input = validateArgs(args); assertHostNotLive(input.dir);
  return withDurableLease(input.dir, () => {
  const archive = verifyArchive(input.dir, input.archive, input.project), original = archiveProject(archive);
  const markerPath = join(input.dir, ".durable-switch.json");
  const marker = readMarker(markerPath) ?? recoverMarker(input.dir, markerPath, archive);
  if (!marker) throw new Error("No owned Durable switch marker exists for this copied project");
  verifyMarker(marker, archive, original);
  // Reject source changes even if project.json already happens to be restored.
  assertOriginalFiles(input.dir, archive, true);
  const current = readBytes(join(input.dir, "project.json"), MAX_METADATA);
  if (hash(current) === marker.originalProjectSha256) return Object.freeze({ project: readProject(input.dir), archiveDir: archive.dir, archiveManifest: archive.manifestSha256, durableEvidencePreserved: true, idempotent: true });
  if (hash(current) !== marker.durableProjectSha256) throw new Error("Project metadata has conflicting human edits; refusing rollback");
  atomicReplace(join(input.dir, "project.json"), archive.projectBytes);
  return Object.freeze({ project: readProject(input.dir), archiveDir: archive.dir, archiveManifest: archive.manifestSha256, durableEvidencePreserved: true, idempotent: false });
  });
}

function validateArgs(args: DisposableDurableSwitchArgs): { dir: string; archive: string; project: ProjectData; cwd: string } {
  if (args.confirmDisposable !== true) throw new Error("A disposable-project acknowledgement is required");
  if (!isAbsolute(args.projectDir) || !isAbsolute(args.archiveDir)) throw new Error("projectDir and archiveDir must be absolute");
  const dir = safeDir(args.projectDir, "project directory"), archive = safeDir(args.archiveDir, "archive directory"), project = readProject(dir), cwd = safeDir(args.expectedCwd, "expected CWD");
  if (project.id !== args.expectedProjectId || dir !== join(dirname(dir), project.id) || safeDir(project.cwd, "project CWD") !== cwd) throw new Error("Copied project identity does not match expected project ID/CWD");
  return { dir, archive, project, cwd };
}
function safeDir(path: string, label: string): string { const absolute = resolve(path); assertNoSymlinks(absolute, label); const stat = lstatSync(absolute); if (!stat.isDirectory()) throw new Error(`${label} must be a directory`); return absolute; }
function assertNoSymlinks(path: string, label: string): void { let current = parsePath(path).root; for (const part of resolve(path).slice(current.length).split("/").filter(Boolean)) { current = join(current, part); const stat = lstatSync(current, { throwIfNoEntry: false }); if (!stat) throw new Error(`${label} is missing: ${current}`); if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`); } }
function readProject(dir: string): ProjectData { return json(Project, join(dir, "project.json"), "project metadata"); }
function json<T extends import("typebox").TSchema>(schema: T, path: string, label: string): Static<T> { try { return parse(schema, JSON.parse(readBytes(path, MAX_METADATA).toString("utf8"))); } catch (error) { throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`); } }
function verifyArchive(dir: string, archive: string, project: ProjectData): { dir: string; manifest: Manifest; manifestSha256: string; projectBytes: Buffer } {
  assertTreeNoSymlinks(archive); const manifestBytes = readBytes(join(archive, "manifest.json"), MAX_METADATA), manifest = json(ManifestSchema, join(archive, "manifest.json"), "migration archive manifest");
  if (manifest.projectId !== project.id || manifest.cwd !== resolve(project.cwd) || manifest.source !== dir) throw new Error("Migration archive identity is inconsistent");
  const complete = json(CompleteSchema, join(archive, "complete.json"), "migration archive completion marker");
  if (complete.manifestSha256 !== hash(manifestBytes)) throw new Error("Migration archive completion marker is inconsistent");
  for (const file of manifest.files) { if (!safeRelative(file.path)) throw new Error("Migration archive manifest has unsafe file metadata"); const value = readBytes(join(archive, "originals", file.path), file.bytes); if (value.length !== file.bytes || hash(value) !== file.sha256) throw new Error(`Migration archive hash mismatch: ${file.path}`); }
  const projectBytes = readBytes(join(archive, "originals", "project.json"), MAX_METADATA);
  return { dir: archive, manifest, manifestSha256: hash(manifestBytes), projectBytes };
}
function archiveProject(archive: { projectBytes: Buffer }): ProjectData { try { return parse(Project, JSON.parse(archive.projectBytes.toString("utf8"))); } catch (error) { throw new Error(`Invalid archived project metadata: ${error instanceof Error ? error.message : String(error)}`); } }
function safeRelative(path: string): boolean { return path.length > 0 && !path.startsWith("/") && !path.split("/").includes(".."); }
function assertOriginalFiles(dir: string, archive: { dir: string; manifest: Manifest }, allowDurableProject: boolean): void { for (const file of archive.manifest.files) { if (file.path === "project.json" && allowDurableProject) continue; const value = readBytes(join(dir, file.path), file.bytes); if (value.length !== file.bytes || hash(value) !== file.sha256) throw new Error(`Copied source has conflicting human edits: ${file.path}`); } }
function assertTreeNoSymlinks(dir: string): void { assertNoSymlinks(dir, "archive directory"); for (const name of readdirSync(dir)) { const path = join(dir, name), stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`Unsafe archive symlink: ${path}`); if (stat.isDirectory()) assertTreeNoSymlinks(path); } }
function readMarker(path: string): SwitchMarker | null { const stat = lstatSync(path, { throwIfNoEntry: false }); if (!stat) return null; if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Durable switch marker is unsafe"); return json(MarkerSchema, path, "Durable switch marker"); }
function pendingMarker(dir: string, archive: { dir: string; projectBytes: Buffer }): { path: string; marker: SwitchMarker } | null {
  const names = readdirSync(dir).filter(name => name.startsWith(".durable-switch.json.") && name.endsWith(".tmp"));
  if (!names.length) return null;
  if (names.length !== 1) throw new Error("Ambiguous interrupted Durable switch marker files");
  const path = join(dir, names[0]), marker = readMarker(path);
  if (!marker) throw new Error("Interrupted Durable switch marker is missing");
  verifyMarker(marker, archive, archiveProject(archive)); return { path, marker };
}
function recoverMarker(dir: string, markerPath: string, archive: { dir: string; projectBytes: Buffer }): SwitchMarker | null {
  const pending = pendingMarker(dir, archive); if (!pending) return null;
  // A complete owned temp is recoverable; malformed/truncated temps intentionally remain forensic evidence and fail above.
  linkSync(pending.path, markerPath); unlinkSync(pending.path); return pending.marker;
}
function verifyMarker(marker: SwitchMarker, archive: { dir: string; projectBytes: Buffer }, original: ProjectData): void {
  if (marker.projectId !== original.id || marker.cwd !== resolve(original.cwd) || marker.archiveDir !== archive.dir) throw new Error("Durable switch marker belongs to another project");
  if (marker.originalProjectSha256 !== hash(archive.projectBytes) || marker.durableProjectSha256 !== hash(durableProjectBytes(original))) throw new Error("Durable switch marker hashes do not match the verified archive");
}
function durableProjectBytes(project: ProjectData): Buffer { return Buffer.from(JSON.stringify(parse(Project, { ...project, runtime: "durable" }), null, 2) + "\n"); }
function result(project: ProjectData, archive: { dir: string; manifestSha256: string }, idempotent: boolean): DisposableDurableSwitchResult { return Object.freeze({ project, archiveDir: archive.dir, archiveManifest: archive.manifestSha256, idempotent, history: "Original history remains byte-preserved in archive references only; it is never imported as instructions or runnable tool calls." }); }
function readBytes(path: string, maximum: number): Buffer { assertNoSymlinks(path, "file path"); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size < 0 || stat.size > maximum) throw new Error(`File exceeds bounded read limit or is not regular: ${path}`); const value = Buffer.alloc(stat.size); let offset = 0; while (offset < value.length) { const count = readSync(fd, value, offset, value.length - offset, offset); if (!count) break; offset += count; } return value.subarray(0, offset); } finally { closeSync(fd); } }
function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
/** Write temp first, then hard-link it into its final name; no partial marker is ever a final marker. */
function atomicCreate(path: string, value: string): void { const temp = `${path}.${randomUUID()}.tmp`; try { writeFileSync(temp, value, { flag: "wx", mode: 0o600 }); linkSync(temp, path); } finally { if (lstatSync(temp, { throwIfNoEntry: false })) unlinkSync(temp); } }
function atomicReplace(path: string, value: Buffer): void { const temp = `${path}.${randomUUID()}.tmp`; try { writeFileSync(temp, value, { flag: "wx", mode: 0o600 }); renameSync(temp, path); } finally { if (lstatSync(temp, { throwIfNoEntry: false })) unlinkSync(temp); } }
function withDurableLease<T>(dir: string, operation: () => T): T {
  const path = join(dir, "durable-owner.sqlite"); assertNoSymlinks(dirname(path), "Durable ownership path");
  const stat = lstatSync(path, { throwIfNoEntry: false }); if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error("Durable ownership lease is unsafe");
  const owner = new DatabaseSync(path);
  try { try { owner.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); } catch (error) { throw new Error("Durable project storage is already owned by another process", { cause: error }); } return operation(); }
  finally { try { owner.exec("ROLLBACK"); } catch { } owner.close(); }
}
function assertHostNotLive(dir: string): void { const lock = join(dirname(dir), "host.lock"), stat = lstatSync(lock, { throwIfNoEntry: false }); if (!stat) return; if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Host lock is unsafe; refusing while ownership is unclear"); const text = readBytes(lock, 1024).toString("utf8").trim(); if (!/^[1-9][0-9]*$/.test(text)) throw new Error("Host lock is invalid; refusing while ownership is unclear"); const pid = Number(text); if (!Number.isSafeInteger(pid)) throw new Error("Host lock PID is invalid; refusing while ownership is unclear"); try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return; throw error; } throw new Error("A live host owns this copied project state; stop it before switching or rollback"); }
