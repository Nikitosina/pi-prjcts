import { mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectLegacyProject, prepareLegacyMigration } from "./durable-migration.ts";
import { rollbackDisposableProject, switchDisposableProject } from "./durable-switch.ts";
import { home } from "./state.ts";

const markerName = ".pi-projects-disposable-copy.json";
function canonical(path: string): string {
  if (!path.startsWith("/")) throw new Error("Use an absolute canonical path");
  const resolved = resolve(path);
  let cursor = "/";
  for (const part of resolved.slice(1).split("/")) { cursor = join(cursor, part); const stat = lstatSync(cursor); if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not accepted: ${cursor}`); }
  return realpathSync(resolved);
}
function checkRoot(path: string, initialize: boolean): string {
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Maintenance refuses NODE_OPTIONS or PI_PACKAGE_DIR overrides");
  const root = resolve(path), active = resolve(home()), defaultHome = resolve(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "projects"));
  if ([active, defaultHome].some(home => root === home || root.startsWith(`${home}/`) || home.startsWith(`${root}/`))) throw new Error("Disposable root cannot overlap active or default production project home");
  if (initialize) {
    if (lstatSync(root, { throwIfNoEntry: false })) throw new Error("Disposable root must be newly created");
    mkdirSync(root, { recursive: false, mode: 0o700 });
    writeFileSync(join(root, markerName), JSON.stringify({ format: 1, root }) + "\n", { flag: "wx", mode: 0o600 });
  }
  const safe = canonical(root), marker = JSON.parse(readFileSync(join(safe, markerName), "utf8"));
  if (marker.format !== 1 || marker.root !== safe || safe !== root) throw new Error("Disposable root ownership marker does not match canonical root");
  return safe;
}
function project(rootPath: string, id: string, cwd: string) {
  const root = checkRoot(rootPath, false), dir = canonical(join(root, id));
  if (dirname(dir) !== root || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Project must be a UUID-named direct child of the owned disposable root");
  return { projectDir: dir, expectedProjectId: id, expectedCwd: canonical(cwd), confirmDisposable: true as const };
}
export function initializeDisposableRoot(path: string) { return { root: checkRoot(path, true), guidance: "Copy only an already-authorized, inactive project into this new root. Do not copy active production state or open/start the copy." }; }
export function inspectDisposableCopy(root: string, id: string, cwd: string) { const value = project(root, id, cwd); return inspectLegacyProject({ legacyProjectDir: value.projectDir, expectedProjectId: id, expectedCwd: value.expectedCwd, confirmDisposable: true }); }
export function archiveDisposableCopy(root: string, id: string, cwd: string, archive: string) {
  const value = project(root, id, cwd), archiveDir = canonical(archive);
  if (archiveDir === value.projectDir || archiveDir.startsWith(`${value.projectDir}/`) || value.projectDir.startsWith(`${archiveDir}/`) || archiveDir === dirname(value.projectDir)) throw new Error("Archive must be separate from the copied project; use a sibling archive directory");
  return prepareLegacyMigration({ legacyProjectDir: value.projectDir, archiveDir, expectedProjectId: id, expectedCwd: value.expectedCwd, confirmDisposable: true });
}
export function switchCopy(root: string, id: string, cwd: string, archive: string) { const value = project(root, id, cwd); return switchDisposableProject({ ...value, archiveDir: canonical(archive) }); }
export function rollbackCopy(root: string, id: string, cwd: string, archive: string) { const value = project(root, id, cwd); return rollbackDisposableProject({ ...value, archiveDir: canonical(archive) }); }
