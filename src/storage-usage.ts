import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** What a project keeps on disk (scripts/storage-usage-failures.md): one row per kind, measured independently. */
export type StorageKind = "worktrees" | "caches" | "disposable" | "videos" | "plugin";
export type StorageMeasure = {
  count: number | null;
  /** null: not measured (unreadable, timed out or on a virtual mount); `note` says why. */
  bytes: number | null;
  /** What the cleanup routine would free with its current settings. */
  reclaimableBytes: number | null;
  note?: string;
};
export type StorageRow = { id: string; kind: StorageKind; label: string } & StorageMeasure;
export type StorageUsage = { measuredAt: number; rows: StorageRow[] };

/** A scan runs in the background, so no request waits for it; a row still gives up eventually. */
export const MEASURE_TIMEOUT_MS = 600_000;

/** Disk use of each path with `du` (symlinks not followed), in one run; a path gone meanwhile counts zero, anything unreadable makes the answer null.
 * `du` counts a file linked from two paths once, under the first. */
export async function diskBytesByPath(paths: readonly string[], timeoutMs = MEASURE_TIMEOUT_MS): Promise<Map<string, number> | null> {
  const sizes = new Map(paths.map((path) => [path, 0]));
  const present = paths.filter((path) => existsSync(path));
  if (!present.length) return sizes;
  return new Promise((resolve) => {
    execFile("/usr/bin/du", ["-skP", "--", ...present], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout) => {
      if (error) return resolve(null);
      for (const line of stdout.split("\n").filter(Boolean)) {
        const tab = line.indexOf("\t"),
          kb = Number(line.slice(0, tab));
        if (tab < 0 || !Number.isFinite(kb)) return resolve(null);
        sizes.set(line.slice(tab + 1), kb * 1024);
      }
      resolve(sizes);
    });
  });
}

/** Disk use of these paths together; null when any is unreadable. */
export async function diskBytes(paths: readonly string[], timeoutMs = MEASURE_TIMEOUT_MS): Promise<number | null> {
  const sizes = await diskBytesByPath(paths, timeoutMs);
  return sizes && [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
}

/** Measures every row; one that throws or outlasts `timeoutMs` is unknown with the reason, the others still answer. */
export type StorageTotal = { bytes: number; reclaimableBytes: number; unknown: number; measuredAt: number };
/** A project's total: the sum of its known rows; unknown rows are counted, not guessed. */
export function storageTotal(usage: StorageUsage): StorageTotal {
  const known = usage.rows.filter((row) => row.bytes !== null);
  return {
    bytes: known.reduce((sum, row) => sum + row.bytes!, 0),
    reclaimableBytes: known.reduce((sum, row) => sum + (row.reclaimableBytes ?? 0), 0),
    unknown: usage.rows.length - known.length,
    measuredAt: usage.measuredAt,
  };
}

export async function measureRows(
  sources: readonly {
    id: string;
    kind: StorageKind;
    label: string;
    measure: () => Promise<(StorageMeasure & { label?: string }) | null>;
  }[],
  timeoutMs = MEASURE_TIMEOUT_MS,
): Promise<StorageRow[]> {
  const rows = await Promise.all(
    sources.map(async ({ id, kind, label, measure }) => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Measuring timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      });
      try {
        const measured = await Promise.race([measure(), late]);
        // A source with nothing for this project has no row.
        return measured && { id, kind, label, ...measured };
      } catch (error) {
        return {
          id,
          kind,
          label,
          count: null,
          bytes: null,
          reclaimableBytes: null,
          note: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return rows.filter((row): row is StorageRow => row !== null);
}
