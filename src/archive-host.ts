import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { listArchiveProjects, openArchiveProject, type ArchiveProjectReader } from "./archive-reader.ts";
import { home, saveJson } from "./state.ts";
import type { PageOptions } from "./transcript-reader.ts";

/** Host side of the Archive: where the old host's data lives (`archive.json` in the host home) and a few open read-only readers. */
export const DEFAULT_ARCHIVE_HOME = join(homedir(), ".pi", "agent", "projects-dev");
const IDLE_MS = 60_000,
  MAX_OPEN = 3;

const configPath = () => join(home(), "archive.json");
const expand = (value: string) => (value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value);

export function archiveHome(): string {
  try {
    const saved = (JSON.parse(readFileSync(configPath(), "utf8")) as { home?: unknown }).home;
    if (typeof saved === "string" && saved) return saved;
  } catch {
    // No saved setting: the default applies.
  }
  return DEFAULT_ARCHIVE_HOME;
}

/** Absolute directory outside this host's own home: opening the live databases would be a write path. */
function validHome(value: string): string {
  const path = resolve(expand(value.trim()));
  if (!isAbsolute(expand(value.trim()))) throw new Error("The archive folder must be an absolute path");
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("The archive folder does not exist");
  const real = realpathSync(path),
    live = existsSync(home()) ? realpathSync(home()) : home();
  if (real === live || real.startsWith(live + sep) || live.startsWith(real + sep))
    throw new Error("The archive folder cannot contain or be this host's own data");
  return real;
}

export function archiveConfig(set?: string): { home: string; default: string; exists: boolean } {
  if (set !== undefined) {
    const next = validHome(set);
    saveJson(configPath(), { home: next });
    closeArchives();
  }
  const current = archiveHome();
  return { home: current, default: DEFAULT_ARCHIVE_HOME, exists: existsSync(expand(current)) };
}

type Open = { reader: ArchiveProjectReader; timer: NodeJS.Timeout };
const open = new Map<string, Open>();
export function closeArchives(): void {
  for (const entry of open.values()) {
    clearTimeout(entry.timer);
    entry.reader.close();
  }
  open.clear();
}
function reader(projectId: string): ArchiveProjectReader {
  const root = validHome(archiveHome()),
    key = `${root}\0${projectId}`;
  let entry = open.get(key);
  if (!entry) {
    if (open.size >= MAX_OPEN) {
      const [oldest, value] = open.entries().next().value!;
      clearTimeout(value.timer);
      value.reader.close();
      open.delete(oldest);
    }
    entry = { reader: openArchiveProject(root, projectId), timer: setTimeout(() => {}, 0) };
    open.set(key, entry);
  }
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.reader.close();
    if (open.get(key) === entry) open.delete(key);
  }, IDLE_MS);
  entry.timer.unref();
  return entry.reader;
}

export const archiveProjects = () => {
  const root = validHome(archiveHome());
  return { home: root, projects: listArchiveProjects(root) };
};
/** Chats and worker conversations of one old project. */
export const archiveProject = (projectId: string) => {
  const found = reader(projectId);
  return { projectId, warnings: found.warnings, chats: found.chats(), workers: found.workers() };
};
export const archiveHistory = (projectId: string, conversationId: number, options: PageOptions) =>
  reader(projectId).page(conversationId, options);
export const archiveText = (projectId: string, conversationId: number, ref: string, range: { offset?: number; limit?: number }) =>
  reader(projectId).text(conversationId, ref, range);
export const archiveImage = (projectId: string, conversationId: number, ref: string) => reader(projectId).image(conversationId, ref);
