import { execFile } from "node:child_process";
import { globSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { lstat, opendir, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";

/** The cleanup routine's own steps besides the safe worktree rule (scripts/workspace-cleanup-failures.md). Paths in, paths out:
 * the runtime decides what to remove and removes it. */
const run = promisify(execFile);
const DAY_MS = 86_400_000;
/** A cache written this recently may be in a build right now; the size cap and the budget wait. */
const ACTIVE_MS = 3_600_000;
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

export type CleanupSettings = {
  /** A live workspace's cache over this size is removed once it has been idle for an hour. */
  cacheCapGb: number;
  /** All of a project's caches together; over it, the least recently written idle ones are removed. */
  budgetGb: number;
  /** A live workspace's cache not written this long is removed. */
  unusedDays: number;
  /** Videos of Jobs approved or dismissed this long ago are removed; screenshots, logs and reports stay. */
  videoDays: number;
  /** Globs relative to each worktree; a match not written for a day is removed once git confirms it is ignored. */
  disposable: string[];
};
export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = { cacheCapGb: 20, budgetGb: 50, unusedDays: 7, videoDays: 14, disposable: [] };
/** Stored settings with the fields added since they were written. */
export const withCleanupDefaults = (stored: Partial<CleanupSettings>): CleanupSettings => ({ ...DEFAULT_CLEANUP_SETTINGS, ...stored });
/** Every project's cleanup routine: daily, first run an hour after it is created. */
export const CLEANUP_ROUTINE = { id: "workspace-cleanup", name: "Workspace cleanup", everyMs: 86_400_000, firstDelayMs: 3_600_000 };
/** A run's steps in order: removing settled worktrees, measuring caches, removing caches, paths and videos, then plugin steps. */
export const CLEANUP_STEPS = ["worktrees", "measure", "remove", "plugins"] as const;
export type CleanupStep = (typeof CLEANUP_STEPS)[number];
/** Where a running cleanup is: `total` is null until the step knows it; `freedBytes` counts the caches removed so far. */
export type CleanupProgress = { step: CleanupStep; done: number; total: number | null; freedBytes: number };

export function cleanupSettingsError(settings: CleanupSettings): string | null {
  const whole = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (!whole(settings.cacheCapGb, 10_000)) return "The cache cap must be 1 to 10000 GB";
  if (!whole(settings.budgetGb, 100_000)) return "The cache budget must be 1 to 100000 GB";
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

/** Removes each path off the event loop; one that cannot go is reported as `path: reason` and the rest still go. Retries ride out
 * a file written meanwhile (Finder's .DS_Store, an indexer). */
export async function removePaths(
  paths: readonly string[],
  onDone?: (path: string) => void,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [],
    failed: string[] = [];
  for (const path of paths) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed.push(path);
    } catch (error) {
      failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    onDone?.(path);
  }
  return { removed, failed };
}

export type CacheUse = { bytes: number; lastWriteMs: number };

/** Disk use and newest write anywhere in a cache (symlinks not followed); a missing cache is empty and never written. */
export async function cacheUsage(dir: string): Promise<CacheUse> {
  const use: CacheUse = { bytes: 0, lastWriteMs: 0 };
  const count = (stat: { blocks: number; mtimeMs: number }) => {
    use.bytes += stat.blocks * 512;
    use.lastWriteMs = Math.max(use.lastWriteMs, stat.mtimeMs);
  };
  const walk = async (path: string) => {
    let entries;
    try {
      count(await lstat(path));
      entries = await opendir(path);
    } catch {
      return;
    }
    const files: string[] = [];
    for await (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files.push(child);
    }
    // Batched so a cache of a million files neither blocks the host nor floods the thread pool.
    for (let at = 0; at < files.length; at += 64)
      for (const stat of await Promise.all(files.slice(at, at + 64).map((file) => lstat(file).catch(() => null)))) if (stat) count(stat);
  };
  await walk(dir);
  return use;
}

type WorkspaceItem = { kind: string; intentId?: string; threadId: string | null; pullRequests: readonly { state: string }[] };
/** Workers whose work is over: Job approved or dismissed, or every PR merged or closed; never a running thread or a chat's workspace. */
export function settledWorkspaces(input: {
  items: readonly WorkspaceItem[];
  jobs: readonly { id: string; status: string; dismissedAt?: number }[];
  live: ReadonlySet<string>;
}): Set<string> {
  const jobs = new Map(input.jobs.map((job) => [job.id, job]));
  const settled = new Set<string>();
  for (const item of input.items) {
    if (item.kind !== "worker" || !item.intentId || !item.threadId || input.live.has(item.threadId)) continue;
    const job = jobs.get(item.threadId);
    if (job?.status === "running") continue;
    const merged = item.pullRequests.length > 0 && item.pullRequests.every((pr) => pr.state !== "open");
    if (job?.status === "approved" || job?.dismissedAt !== undefined || merged) settled.add(item.intentId);
  }
  return settled;
}

/** Live workspace caches to remove: settled ones, ones not written past the window, ones over the cap, then the least recently
 * written until the project is under its budget. Only the first two may go while written in the last hour. */
export async function cachesToTrim(input: {
  caches: readonly { dir: string; settled: boolean }[];
  capBytes: number;
  budgetBytes: number;
  unusedMs: number;
  now?: number;
  usageOf?: (dir: string) => Promise<CacheUse>;
  onMeasured?: (done: number, total: number) => void;
}): Promise<{ count: number; bytes: number; trimmed: { dir: string; bytes: number }[]; trimmedBytes: number }> {
  const now = input.now ?? Date.now(),
    usageOf = input.usageOf ?? cacheUsage;
  const plan = { count: 0, bytes: 0, trimmed: [] as { dir: string; bytes: number }[], trimmedBytes: 0 };
  const trim = (dir: string, bytes: number) => {
    plan.trimmed.push({ dir, bytes });
    plan.trimmedBytes += bytes;
  };
  const kept: { dir: string; bytes: number; lastWriteMs: number }[] = [];
  for (const [index, { dir, settled }] of input.caches.entries()) {
    input.onMeasured?.(index, input.caches.length);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const use = await usageOf(dir);
    plan.count++;
    plan.bytes += use.bytes;
    const idle = now - use.lastWriteMs;
    if (settled || idle > input.unusedMs || (idle > ACTIVE_MS && use.bytes > input.capBytes)) trim(dir, use.bytes);
    else kept.push({ dir, ...use });
  }
  let total = kept.reduce((sum, item) => sum + item.bytes, 0);
  for (const item of kept.sort((a, b) => a.lastWriteMs - b.lastWriteMs)) {
    if (total <= input.budgetBytes) break;
    if (now - item.lastWriteMs <= ACTIVE_MS) continue;
    trim(item.dir, item.bytes);
    total -= item.bytes;
  }
  return plan;
}

/** Video files in the artifacts of these Jobs. */
export function jobVideos(controlRoot: string, jobIds: readonly string[]): string[] {
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
  for (const id of jobIds) if (!id.includes(sep) && id !== ".." && id !== ".") walk(join(controlRoot, "artifacts", id));
  return videos;
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
  const old = input.jobs.filter(
    (job) =>
      (job.status === "approved" && job.endedAt !== null && now - job.endedAt > windowMs) ||
      (job.dismissedAt !== undefined && now - job.dismissedAt > windowMs),
  );
  return jobVideos(
    input.controlRoot,
    old.map((job) => job.id),
  );
}
