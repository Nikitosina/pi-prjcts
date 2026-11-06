import { statSync } from "node:fs";
import { join } from "node:path";

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
