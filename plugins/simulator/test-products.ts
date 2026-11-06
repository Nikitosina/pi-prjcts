import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { diskBytes } from "./idle.ts";

/** XcodeBuildMCP's own name for a test run's products, with the owner process id (utils/test-products-path.js). */
const PRODUCTS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_pid(\d+)_[a-f0-9]{8}\.xctestproducts$/;
const MARKER = ".xcodebuildmcp-completed";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Removes finished test products older than `keepMs` in every XcodeBuildMCP workspace under `root`, keeping each workspace's
 * newest finished run for a rerun without building. A run is finished when its completion marker exists or its owner is gone. */
export async function pruneTestProducts(input: { root: string; now: number; keepMs: number }): Promise<{ removed: number; bytes: number }> {
  const workspaces = await readdir(input.root).catch(() => [] as string[]);
  let removed = 0,
    bytes = 0;
  for (const workspace of workspaces) {
    const folder = join(input.root, workspace, "test-products");
    const runs = [];
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      const pid = Number(PRODUCTS_NAME.exec(name)?.[1]);
      const path = join(folder, name);
      const stat = pid ? await lstat(path).catch(() => null) : null;
      if (!stat?.isDirectory()) continue;
      const finished = (await exists(`${path}${MARKER}`)) || !alive(pid);
      if (finished) runs.push({ path, at: stat.mtimeMs });
    }
    runs.sort((a, b) => b.at - a.at);
    for (const run of runs.slice(1).filter((run) => input.now - run.at > input.keepMs)) {
      const size = await diskBytes([run.path]).catch(() => 0);
      await rm(run.path, { recursive: true, force: true });
      await rm(`${run.path}${MARKER}`, { force: true });
      removed++;
      bytes += size;
    }
  }
  return { removed, bytes };
}
