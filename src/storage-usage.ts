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

export const MEASURE_TIMEOUT_MS = 120_000;

/** Disk use of these paths with `du` (symlinks not followed); a path gone meanwhile counts zero, anything unreadable makes it null. */
export async function diskBytes(paths: readonly string[], timeoutMs = MEASURE_TIMEOUT_MS): Promise<number | null> {
  const present = paths.filter((path) => existsSync(path));
  if (!present.length) return 0;
  return new Promise((resolve) => {
    execFile("/usr/bin/du", ["-skP", "--", ...present], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout) => {
      if (error) return resolve(null);
      let kb = 0;
      for (const line of stdout.split("\n").filter(Boolean)) {
        const value = Number(line.split("\t")[0]);
        if (!Number.isFinite(value)) return resolve(null);
        kb += value;
      }
      resolve(kb * 1024);
    });
  });
}

/** Measures every row; one that throws or outlasts `timeoutMs` is unknown with the reason, the others still answer. */
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
