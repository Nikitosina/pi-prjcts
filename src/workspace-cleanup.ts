import { execFile } from "node:child_process";
import { globSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";

/** The cleanup routine's own steps besides the safe worktree rule (scripts/workspace-cleanup-failures.md). Paths in, paths out:
 * the runtime decides what to remove and removes it. */
const run = promisify(execFile);
const DAY_MS = 86_400_000;
/** A cache used this recently may be in a build right now; the size cap waits. */
const ACTIVE_MS = 3_600_000;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

export type CleanupSettings = {
  /** A live workspace's cache over this size is removed once it has been idle for an hour. */
  cacheCapGb: number;
  /** A live workspace's cache unused this long is removed. */
  unusedDays: number;
  /** Videos of Jobs approved or dismissed this long ago are removed; screenshots, logs and reports stay. */
  videoDays: number;
  /** Globs relative to each worktree; a match not written for a day is removed once git confirms it is ignored. */
  disposable: string[];
};
export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = { cacheCapGb: 20, unusedDays: 7, videoDays: 14, disposable: [] };
/** Every project's cleanup routine: daily, first run an hour after it is created. */
export const CLEANUP_ROUTINE = { id: "workspace-cleanup", name: "Workspace cleanup", everyMs: 86_400_000, firstDelayMs: 3_600_000 };

export function cleanupSettingsError(settings: CleanupSettings): string | null {
  const whole = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (!whole(settings.cacheCapGb, 10_000)) return "The cache cap must be 1 to 10000 GB";
  if (!whole(settings.unusedDays, 365) || !whole(settings.videoDays, 3650)) return "Day counts must be whole numbers from 1";
  if (settings.disposable.length > 64) return "At most 64 disposable paths";
  for (const glob of settings.disposable) {
    const plain = normalize(glob);
    if (!glob || glob.length > 256 || isAbsolute(glob) || glob.startsWith("~") || plain === "." || plain.split(sep).includes(".."))
      return `Disposable paths must be relative to the worktree and stay inside it: ${JSON.stringify(glob)}`;
  }
  return null;
}

/** Matches of the globs inside the worktree that were not written in the last day; never a symlink or anything reached through one. */
export function disposableCandidates(worktree: string, globs: readonly string[], now = Date.now()): string[] {
  const root = realpathSync(worktree);
  const found = new Set<string>();
  for (const glob of globs)
    for (const relative of globSync(glob, { cwd: root })) {
      if (relative.split(sep)[0] === ".git") continue;
      const path = join(root, relative),
        stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink() || now - stat.mtimeMs < DAY_MS) continue;
      if (realpathSync(path).startsWith(root + sep)) found.add(path);
    }
  return [...found];
}

/** The paths git ignores that hold no tracked file; none outside a git worktree. */
export async function gitIgnored(worktree: string, paths: readonly string[]): Promise<string[]> {
  if (!paths.length) return [];
  let listed: string;
  try {
    const child = run("git", ["-C", worktree, "check-ignore", "-z", "--stdin"], { maxBuffer: 8 << 20 });
    child.child.stdin?.end(paths.join("\0"));
    listed = (await child).stdout;
  } catch (error) {
    // Exit 1 means none is ignored; anything else (not a repository) proves nothing.
    const failed = error as { code?: number; stdout?: string };
    if (failed.code !== 1) return [];
    listed = failed.stdout ?? "";
  }
  const ignored: string[] = [];
  for (const path of listed
    .split("\0")
    .filter(Boolean)
    .map((item) => (isAbsolute(item) ? item : join(worktree, item)))) {
    const tracked = await run("git", ["-C", worktree, "ls-files", "-z", "--", path]).then(
      (result) => result.stdout !== "",
      () => true,
    );
    if (!tracked) ignored.push(path);
  }
  return ignored;
}

const duBytes = async (dir: string) => Number((await run("du", ["-sk", dir])).stdout.split("\t")[0]) * 1024;

/** Live workspace caches to remove: unused past the window, or over the cap and idle for an hour. A folder's mtime is its last use. */
export async function cachesToTrim(input: {
  dirs: readonly string[];
  capBytes: number;
  unusedMs: number;
  now?: number;
  sizeOf?: (dir: string) => Promise<number>;
}): Promise<string[]> {
  const now = input.now ?? Date.now(),
    sizeOf = input.sizeOf ?? duBytes;
  const trimmed: string[] = [];
  for (const dir of input.dirs) {
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    const idle = now - stat.mtimeMs;
    if (idle > input.unusedMs || (idle > ACTIVE_MS && (await sizeOf(dir)) > input.capBytes)) trimmed.push(dir);
  }
  return trimmed;
}

/** Video files in the artifacts of Jobs approved or dismissed more than `days` ago. */
export function oldJobVideos(input: {
  controlRoot: string;
  jobs: readonly { id: string; status: string; endedAt: number | null; dismissedAt?: number }[];
  now?: number;
  days: number;
}): string[] {
  const now = input.now ?? Date.now(),
    windowMs = input.days * DAY_MS;
  const videos: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && VIDEO.test(entry.name)) videos.push(path);
    }
  };
  for (const job of input.jobs) {
    const approved = job.status === "approved" && job.endedAt !== null && now - job.endedAt > windowMs;
    const dismissed = job.dismissedAt !== undefined && now - job.dismissedAt > windowMs;
    if ((approved || dismissed) && !job.id.includes(sep) && job.id !== "..") walk(join(input.controlRoot, "artifacts", job.id));
  }
  return videos;
}
