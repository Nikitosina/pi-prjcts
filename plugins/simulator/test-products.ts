import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename } from "node:path";
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
export async function pruneTestProducts(input: {
  root: string;
  now: number;
  keepMs: number;
  only?: ReadonlySet<string>;
}): Promise<{ removed: number; bytes: number }> {
  const workspaces = (await readdir(input.root).catch(() => [] as string[])).filter((name) => !input.only || input.only.has(name));
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

/** XcodeBuildMCP's workspace folder for a checkout root (utils/workspace-identity.js): the slugged name and 12 hex of sha256 of the real path. */
export function workspaceKeyForRoot(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* an absent root keys by its own path, as XcodeBuildMCP does */
  }
  const slug =
    (basename(real) || "workspace")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 64) || "workspace";
  return `${slug}-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
}

/** Prunes only the workspaces a project owns: its checkout and worktrees (`roots`). Anything else under `root` is left alone. */
export const pruneProjectProducts = (input: { root: string; now: number; keepMs: number; roots: readonly string[] }) =>
  pruneTestProducts({ root: input.root, now: input.now, keepMs: input.keepMs, only: new Set(input.roots.map(workspaceKeyForRoot)) });

/** The hourly sweep: each project that has the plugin on prunes its own workspaces; a project that turned it off is not touched. */
export async function pruneEnabledProjects(input: {
  root: string;
  now: number;
  keepMs: number;
  projects: ReadonlyArray<{ disabledPlugins?: string[]; roots: readonly string[] }>;
}): Promise<{ removed: number; bytes: number }> {
  let removed = 0,
    bytes = 0;
  for (const project of input.projects) {
    if (project.disabledPlugins?.includes("simulator")) continue;
    const done = await pruneProjectProducts({ root: input.root, now: input.now, keepMs: input.keepMs, roots: project.roots });
    removed += done.removed;
    bytes += done.bytes;
  }
  return { removed, bytes };
}
