import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Last use of a simulator device: CoreSimulator rewrites device.plist on every boot and shutdown, and the data folder while it runs.
 * An unreadable device is never idle. */
export function deviceLastUse(directory: string): number {
  const times = ["device.plist", "data"].flatMap((name) => statSync(join(directory, name), { throwIfNoEntry: false })?.mtimeMs ?? []);
  return times.length ? Math.max(...times) : Number.POSITIVE_INFINITY;
}

/** Owned clones the cleanup routine may erase: shut down, not leased, unused past the window. A clone missing from the inventory stays. */
export function idleClones<T extends { udid: string; directory: string }>(input: {
  owned: readonly T[];
  /** Inventory state by UDID. */
  states: ReadonlyMap<string, string>;
  leased(owned: T): boolean;
  now: number;
  unusedMs: number;
}): T[] {
  return input.owned.filter(
    (owned) =>
      input.states.get(owned.udid) === "Shutdown" && !input.leased(owned) && input.now - deviceLastUse(owned.directory) > input.unusedMs,
  );
}

const duBytes = async (paths: readonly string[]) => {
  if (!paths.length) return 0;
  const { stdout } = await run("/usr/bin/du", ["-skP", "--", ...paths], { maxBuffer: 1 << 20 });
  return stdout
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.split("\t")[0]) * 1024, 0);
};

/** The Storage row of a project's clones: their whole size, and the data erasing the idle ones frees. */
export async function cloneUsage(input: {
  owned: readonly { directory: string }[];
  idle: readonly { directory: string }[];
}): Promise<{ count: number; bytes: number; reclaimableBytes: number }> {
  return {
    count: input.owned.length,
    bytes: await duBytes(input.owned.map((owned) => owned.directory)),
    reclaimableBytes: await duBytes(input.idle.map((owned) => join(owned.directory, "data"))),
  };
}
