import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { Project, parse } from "./state.ts";

/** This is an archival preparation format, not a Durable runtime import format. */
const FORMAT = 1;
const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
const terminalStates = new Set(["complete", "failed", "stopped"]);

export type LegacyFileKind = "config" | "permission" | "note" | "decision" | "evidence" | "receipt" | "session" | "history" | "other";
export type LegacyFile = Readonly<{ path: string; kind: LegacyFileKind; bytes: number; sha256: string }>;
export type LegacyReceipt = Readonly<{ runId: string; status: string; receipt: string | null }>;
export type LegacyProjectInspection = Readonly<{
  format: 1;
  legacyProjectDir: string;
  projectId: string;
  cwd: string;
  files: readonly LegacyFile[];
  totalBytes: number;
  receipts: readonly LegacyReceipt[];
  historyHandling: "Archived data only. Later runtime UI may offer read-only history/receipt viewers; never submit it as an instruction or runnable task.";
}>;

export type InspectLegacyProjectArgs = Readonly<{
  legacyProjectDir: string;
  expectedProjectId: string;
  expectedCwd: string;
  /** Explicit acknowledgement: this helper must only receive a disposable copy. */
  confirmDisposable: true;
}>;
export type PrepareLegacyMigrationArgs = InspectLegacyProjectArgs & Readonly<{ archiveDir: string }>;
export type PreparedLegacyMigration = Readonly<{
  inspection: LegacyProjectInspection;
  archiveDir: string;
  manifestSha256: string;
  completionMarker: string;
  idempotent: boolean;
  runtimeIntegrationGate: "No production migration is accepted. Reconcile active/interrupted work separately, then expose originals through read-only archived-history views.";
}>;

type Owner = { format: number; projectId: string; cwd: string; source: string };
type Manifest = { format: number; projectId: string; cwd: string; source: string; files: LegacyFile[]; totalBytes: number };

/** Inspect only an explicitly supplied disposable legacy project; it never writes the source. */
export function inspectLegacyProject(args: InspectLegacyProjectArgs): LegacyProjectInspection {
  requireDisposable(args.confirmDisposable);
  const root = safeExistingDirectory(args.legacyProjectDir, "legacy project directory");
  const project = readProject(root);
  validateIdentity(root, project.id, project.cwd, args);
  const files = scanFiles(root);
  const receipts = inspectReceipts(root, project.runs);
  rejectActive(root, project.phase, project.runs, receipts);
  return Object.freeze({ format: 1, legacyProjectDir: root, projectId: project.id, cwd: realpathSync(project.cwd), files, totalBytes: files.reduce((n, file) => n + file.bytes, 0), receipts, historyHandling: "Archived data only. Later runtime UI may offer read-only history/receipt viewers; never submit it as an instruction or runnable task." });
}

/** Copy a verified inspection into an owned archive. This prepares evidence only; it does not import, run, or switch anything. */
export function prepareLegacyMigration(args: PrepareLegacyMigrationArgs): PreparedLegacyMigration {
  const inspection = inspectLegacyProject(args);
  const archive = prepareArchiveDirectory(args.archiveDir, inspection);
  const ownerPath = join(archive, ".durable-migration-owner.json");
  const manifestPath = join(archive, "manifest.json");
  const completePath = join(archive, "complete.json");
  const existingOwner = Boolean(lstatOrNull(ownerPath));
  if (!existingOwner) atomicCreate(ownerPath, JSON.stringify({ format: FORMAT, projectId: inspection.projectId, cwd: inspection.cwd, source: inspection.legacyProjectDir } satisfies Owner) + "\n");
  else verifyOwner(ownerPath, inspection);

  if (lstatOrNull(completePath)) {
    const manifest = verifyArchive(archive, inspection);
    return Object.freeze({ inspection, archiveDir: archive, manifestSha256: hash(readRegular(manifestPath, MAX_METADATA_BYTES)), completionMarker: completePath, idempotent: true, runtimeIntegrationGate: "No production migration is accepted. Reconcile active/interrupted work separately, then expose originals through read-only archived-history views." });
  }
  if (lstatOrNull(manifestPath)) verifyPartialManifest(manifestPath, inspection);

  for (const file of inspection.files) copyOrVerify(inspection.legacyProjectDir, archive, file);
  const manifest: Manifest = { format: FORMAT, projectId: inspection.projectId, cwd: inspection.cwd, source: inspection.legacyProjectDir, files: [...inspection.files], totalBytes: inspection.totalBytes };
  if (!lstatOrNull(manifestPath)) atomicCreate(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  else verifyPartialManifest(manifestPath, inspection);
  // Completion is deliberately last and atomic: its absence is a recoverable partial archive.
  atomicCreate(completePath, JSON.stringify({ format: FORMAT, manifestSha256: hash(readRegular(manifestPath, MAX_METADATA_BYTES)), completedAt: new Date().toISOString(), nonce: randomUUID() }) + "\n");
  return Object.freeze({ inspection, archiveDir: archive, manifestSha256: hash(readRegular(manifestPath, MAX_METADATA_BYTES)), completionMarker: completePath, idempotent: false, runtimeIntegrationGate: "No production migration is accepted. Reconcile active/interrupted work separately, then expose originals through read-only archived-history views." });
}

function requireDisposable(value: true): void { if (value !== true) throw new Error("A disposable-project acknowledgement is required"); }
function safeExistingDirectory(path: string, label: string): string {
  const absolute = resolve(path); assertNoSymlinkPath(absolute, label);
  const canonical = realpathSync(absolute);
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}
function assertNoSymlinkPath(path: string, label: string): void {
  let current = resolve(path); const chain: string[] = [];
  while (true) { chain.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  for (const part of chain.reverse()) { const stat = lstatOrNull(part); if (stat?.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${part}`); }
}
function readProject(root: string) {
  const path = join(root, "project.json");
  const stat = lstatOrNull(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error("Legacy project.json is missing or unsafe");
  try { return parse(Project, JSON.parse(readRegular(path, MAX_METADATA_BYTES).toString("utf8"))); } catch (error) { throw new Error(`Invalid legacy project.json: ${error instanceof Error ? error.message : String(error)}`); }
}
function validateIdentity(root: string, id: string, cwd: string, args: InspectLegacyProjectArgs): void {
  if (!ID.test(args.expectedProjectId) || id !== args.expectedProjectId || root !== resolve(dirname(root), id)) throw new Error("Legacy project identity does not match the supplied ID/directory");
  const expected = safeExistingDirectory(args.expectedCwd, "expected CWD");
  const actual = safeExistingDirectory(cwd, "legacy project CWD");
  if (actual !== expected) throw new Error("Legacy project CWD does not match the supplied expected CWD");
}
function scanFiles(root: string): readonly LegacyFile[] {
  const files: LegacyFile[] = []; let total = 0;
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const relativePath = prefix ? `${prefix}/${name}` : name; const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Legacy source contains a symlink: ${relativePath}`);
      if (stat.isDirectory()) walk(path, relativePath);
      else if (stat.isFile()) {
        if (files.length >= MAX_FILES) throw new Error(`Legacy source exceeds ${MAX_FILES} files`);
        const bytes = readRegular(path, MAX_BYTES - total); total += bytes.length;
        if (total > MAX_BYTES) throw new Error(`Legacy source exceeds ${MAX_BYTES} archive bytes`);
        files.push(Object.freeze({ path: relativePath, kind: kindOf(relativePath), bytes: bytes.length, sha256: hash(bytes) }));
      } else throw new Error(`Legacy source contains a non-regular file: ${relativePath}`);
    }
  };
  walk(root, ""); return Object.freeze(files);
}
function kindOf(path: string): LegacyFileKind {
  if (path === "project.json") return "config";
  if (path === "worker-policy.ts" || /(^|\/)(permissions?|settings)(\/|$)/.test(path)) return "permission";
  if (path.startsWith("notes/")) return "note";
  if (path.startsWith("inbox/")) return "decision";
  if (path.startsWith("evidence/")) return "evidence";
  if (path.startsWith("runs/")) return "receipt";
  if (path.startsWith("sessions/") || path.endsWith(".session.jsonl")) return "session";
  if (path === "events.jsonl" || path.includes("history")) return "history";
  return "other";
}
function inspectReceipts(root: string, runs: { id: string; receipt: string | null }[]): readonly LegacyReceipt[] {
  return Object.freeze(runs.map(run => {
    if (!run.receipt) return Object.freeze({ runId: run.id, status: "unverified", receipt: null });
    const receipt = resolve(root, run.receipt);
    if (!isBelow(root, receipt)) return Object.freeze({ runId: run.id, status: "external", receipt: run.receipt });
    try {
      assertNoSymlinkPath(receipt, "legacy receipt");
      const directory = lstatOrNull(receipt);
      const statusPath = join(receipt, "status.json");
      const status = lstatOrNull(statusPath);
      if (!directory?.isDirectory() || !status || status.isSymbolicLink() || !status.isFile()) return Object.freeze({ runId: run.id, status: "unverified", receipt: run.receipt });
      const value = JSON.parse(readRegular(statusPath, MAX_BYTES).toString("utf8"));
      return Object.freeze({ runId: run.id, status: typeof value.state === "string" ? value.state : "unverified", receipt: run.receipt });
    } catch { return Object.freeze({ runId: run.id, status: "unverified", receipt: run.receipt }); }
  }));
}
function rejectActive(root: string, phase: string, runs: { id: string }[], receipts: readonly LegacyReceipt[]): void {
  if (phase === "busy" || lstatOrNull(join(root, "writer-launch.json"))) throw new Error("Legacy project has active coordinator/writer work");
  const inbox = join(root, "inbox");
  if (lstatOrNull(inbox)) for (const name of readdirSync(inbox)) if (name.endsWith(".json")) { try { const job = JSON.parse(readRegular(join(inbox, name), MAX_METADATA_BYTES).toString("utf8")); if (job.state === "queued" || job.state === "running") throw new Error("Legacy project has queued or running inbox work"); } catch (error) { if (error instanceof Error && error.message.includes("queued or running")) throw error; throw new Error(`Legacy inbox record is malformed: ${name}`); } }
  if (runs.length !== receipts.length || receipts.some(receipt => !terminalStates.has(receipt.status))) throw new Error("Legacy runs are active, interrupted, missing receipts, or have unknown status; explicit reconciliation is required");
}
function prepareArchiveDirectory(path: string, inspection: LegacyProjectInspection): string {
  const archive = resolve(path); if (!isAbsolute(path)) throw new Error("archiveDir must be absolute");
  assertNoSymlinkPath(dirname(archive), "archive parent");
  if (archive === inspection.legacyProjectDir || archive.startsWith(`${inspection.legacyProjectDir}/`) || inspection.legacyProjectDir.startsWith(`${archive}/`)) throw new Error("Archive directory must not overlap legacy source");
  if (!lstatOrNull(archive)) mkdirSync(archive, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(archive, "archive directory");
  if (!statSync(archive).isDirectory()) throw new Error("archiveDir must be a directory");
  assertTreeHasNoSymlinks(archive);
  const entries = readdirSync(archive); if (entries.length && !lstatOrNull(join(archive, ".durable-migration-owner.json"))) throw new Error("archiveDir is not an owned migration archive");
  return realpathSync(archive);
}
function assertTreeHasNoSymlinks(directory: string): void {
  for (const name of readdirSync(directory)) { const path = join(directory, name); const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error(`Archive contains a symlink: ${path}`); if (stat.isDirectory()) assertTreeHasNoSymlinks(path); }
}
function verifyOwner(path: string, inspection: LegacyProjectInspection): void {
  let owner: Owner; try { owner = JSON.parse(readRegular(path, MAX_METADATA_BYTES).toString("utf8")); } catch { throw new Error("Migration archive ownership marker is invalid"); }
  if (owner.format !== FORMAT || owner.projectId !== inspection.projectId || owner.cwd !== inspection.cwd || owner.source !== inspection.legacyProjectDir) throw new Error("Migration archive belongs to a different source identity");
}
function verifyPartialManifest(path: string, inspection: LegacyProjectInspection): void {
  let manifest: Manifest; try { manifest = JSON.parse(readRegular(path, MAX_METADATA_BYTES).toString("utf8")); } catch { throw new Error("Migration manifest is invalid"); }
  if (manifest.format !== FORMAT || manifest.projectId !== inspection.projectId || manifest.cwd !== inspection.cwd || manifest.source !== inspection.legacyProjectDir || JSON.stringify(manifest.files) !== JSON.stringify(inspection.files)) throw new Error("Migration manifest conflicts with current source; refusing to overwrite archive");
}
function copyOrVerify(sourceRoot: string, archive: string, file: LegacyFile): void {
  const source = inside(sourceRoot, file.path); const destination = inside(archive, join("originals", file.path));
  const bytes = readRegular(source, file.bytes); if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Legacy source changed during preparation: ${file.path}`);
  if (lstatOrNull(destination)) { const archived = readRegular(destination, file.bytes); if (archived.length !== file.bytes || hash(archived) !== file.sha256) throw new Error(`Archive contains human/conflicting changes: originals/${file.path}`); return; }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); atomicCreate(destination, bytes);
}
function verifyArchive(archive: string, inspection: LegacyProjectInspection): Manifest {
  const manifestPath = join(archive, "manifest.json"); if (!lstatOrNull(manifestPath)) throw new Error("Completed archive has no manifest");
  verifyPartialManifest(manifestPath, inspection);
  for (const file of inspection.files) { const bytes = readRegular(inside(archive, join("originals", file.path)), file.bytes); if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Completed archive hash mismatch: ${file.path}`); }
  return JSON.parse(readRegular(manifestPath, MAX_METADATA_BYTES).toString("utf8")) as Manifest;
}
function isBelow(root: string, path: string): boolean { const suffix = relative(root, path); return Boolean(suffix) && suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix); }
function inside(root: string, child: string): string { const path = resolve(root, child); if (!isBelow(root, path)) throw new Error("Unsafe archive/source path"); return path; }
function lstatOrNull(path: string) { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function readRegular(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 0 || stat.size > maximum) throw new Error(`File exceeds bounded read limit or is not regular: ${path}`);
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const read = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) break; offset += read; }
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
/** Hard-linking a fully written temporary file creates the final name without replacing a human-created file. */
function atomicCreate(path: string, content: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { flag: "wx", mode: 0o600 }); linkSync(temporary, path); }
  finally { if (lstatOrNull(temporary)) unlinkSync(temporary); }
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
