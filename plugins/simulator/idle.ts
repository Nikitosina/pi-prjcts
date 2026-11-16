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

/** A testing clone stays this long after its last use: xcodebuild creates it shut down just before a run boots it. */
const TESTING_ACTIVE_MS = 3_600_000;

/** Parallel-testing clones xcodebuild left behind from this project's simulators, also from ones deleted since: in Xcode's
 * `testing` set (folders under `root`), named `Clone N of pi-projects <project> <request>`, shut down and unused for an hour. */
export function strayTestClones<T extends { udid: string; name: string; state: string; set: string }>(input: {
  devices: readonly T[];
  projectId: string;
  root: string;
  now: number;
}): (T & { directory: string })[] {
  const name = new RegExp(`^Clone \\d+ of pi-projects ${input.projectId.slice(0, 8)} [0-9a-f-]{36}$`, "i");
  return input.devices
    .filter((device) => device.set === "testing" && device.state === "Shutdown" && name.test(device.name))
    .map((device) => ({ ...device, directory: join(input.root, device.udid) }))
    .filter((device) => input.now - deviceLastUse(device.directory) > TESTING_ACTIVE_MS);
}

export const diskBytes = async (paths: readonly string[]) => {
  if (!paths.length) return 0;
  const { stdout } = await run("/usr/bin/du", ["-skP", "--", ...paths], { maxBuffer: 1 << 20 });
  return stdout
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.split("\t")[0]) * 1024, 0);
};

/** The Storage row of a project's clones: their whole size with stray testing clones, and what erasing the idle ones' data and
 * deleting the strays frees. */
export async function cloneUsage(input: {
  owned: readonly { directory: string }[];
  idle: readonly { directory: string }[];
  strays: readonly { directory: string }[];
}): Promise<{ count: number; bytes: number; reclaimableBytes: number }> {
  const strayBytes = await diskBytes(input.strays.map((stray) => stray.directory));
  return {
    count: input.owned.length + input.strays.length,
    bytes: (await diskBytes(input.owned.map((owned) => owned.directory))) + strayBytes,
    reclaimableBytes: (await diskBytes(input.idle.map((owned) => join(owned.directory, "data")))) + strayBytes,
  };
}
