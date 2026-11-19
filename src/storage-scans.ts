import type { StorageUsage } from "./storage-usage.ts";

export const STORAGE_SCAN_TTL_MS = 10 * 60_000;

/** What Settings → Storage shows: the last good measurement and whether a newer one is on its way (scripts/storage-usage-failures.md U13-U16). */
export type StorageScanStatus = {
  usage: StorageUsage | null;
  scanning: boolean;
  scanStartedAt: number | null;
  /** The last scan's failure; the previous good `usage` stays. Cleared by the next success. */
  error: string | null;
  /** The measurement is older than the window, or from before a cleanup. */
  stale: boolean;
};

/** One project's measurements: at most one scan runs, a status never waits for it, and a failed scan keeps the last good result. */
export function createStorageScans(input: {
  measure: () => Promise<StorageUsage>;
  ttlMs: number;
  /** True while something else (the cleanup routine) works on the same files; no scan starts on its own then. */
  busy?: () => boolean;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let latest: { usage: StorageUsage; generation: number } | null = null;
  let running: { promise: Promise<StorageUsage>; startedAt: number } | null = null;
  let error: { message: string; at: number } | null = null;
  let generation = 0;

  const stale = () => !latest || latest.generation < generation || now() - latest.usage.measuredAt > input.ttlMs;
  const scan = (): Promise<StorageUsage> => {
    if (running) return running.promise;
    const startedGeneration = generation;
    const promise = input.measure().then(
      (usage) => {
        latest = { usage, generation: startedGeneration };
        error = null;
        return usage;
      },
      (failure) => {
        // A scan that cleanup already outdated fails silently: the follow-up scan matters, not its error.
        if (generation === startedGeneration) error = { message: failure instanceof Error ? failure.message : String(failure), at: now() };
        throw failure;
      },
    );
    running = { promise, startedAt: now() };
    const done = () => {
      running = null;
      if (!error && stale() && !input.busy?.()) background();
    };
    promise.then(done, done);
    return promise;
  };
  const background = () => void scan().catch(() => {});
  /** A failed scan is retried on a refresh or once the window has passed, not on every poll. */
  const wantsScan = () => stale() && !(error && now() - error.at <= input.ttlMs);

  return {
    scan,
    status(refresh = false): StorageScanStatus {
      if (!running && !input.busy?.() && (refresh || wantsScan())) background();
      return {
        usage: latest?.usage ?? null,
        scanning: running !== null,
        scanStartedAt: running?.startedAt ?? null,
        error: error?.message ?? null,
        stale: stale(),
      };
    },
    /** The files changed (a cleanup ran): what was measured no longer holds, so measure again. */
    invalidate(): void {
      generation++;
      error = null;
      if (!running && !input.busy?.()) background();
    },
    /** The last good measurement if it is within `maxAgeMs` (any age while busy), else a scan (joined when one runs). */
    usage(maxAgeMs: number): Promise<StorageUsage> {
      if (input.busy?.())
        return latest ? Promise.resolve(latest.usage) : Promise.reject(new Error("A cleanup is running; measure again when it ends"));
      return latest && latest.generation === generation && now() - latest.usage.measuredAt <= maxAgeMs
        ? Promise.resolve(latest.usage)
        : scan();
    },
  };
}
