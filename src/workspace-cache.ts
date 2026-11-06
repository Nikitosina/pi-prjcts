import { mkdirSync, readdirSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { Conversation } from "@earendil-works/pi-durable";
import { workspaceReceipts } from "./workspace-isolation.ts";

/** Workspace cache folders (scripts/workspace-cache-failures.md): one per workspace, outside its worktree, for build caches, test
 * results, browser profiles and logs. The host names it in `$PI_WORKSPACE_CACHE` and removes it once the workspace is gone. */
export const CACHE_VARIABLE = "PI_WORKSPACE_CACHE";
const INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLACEHOLDER = `\${${CACHE_VARIABLE}}`;

/** `null` keeps caches in each project's folder; a set root holds them as `<root>/<project id>/<intent id>`. */
export function cacheRootError(value: string | null): string | null {
  if (value === null) return null;
  return isAbsolute(value) && normalize(value) === value && !value.endsWith(sep)
    ? null
    : "The cache root must be an absolute, normalized folder path";
}
const cacheRoots = (input: { controlRoot: string; projectId: string; cacheRoot: string | null }) =>
  input.cacheRoot === null ? join(input.controlRoot, "workspace-cache") : join(input.cacheRoot, input.projectId);
export const workspaceCacheDir = (input: { controlRoot: string; projectId: string; intentId: string; cacheRoot: string | null }) =>
  join(cacheRoots(input), input.intentId);

/** The workspace a working folder belongs to: an agent may work in a project subfolder of its worktree. */
export function workspaceIntentFor(workspaces: readonly { intentId: string; workspacePath: string }[], cwd: string): string | undefined {
  return workspaces.find((item) => cwd === item.workspacePath || cwd.startsWith(item.workspacePath + sep))?.intentId;
}

/** An MCP server's env for one caller: the placeholder becomes its cache; without one, entries that use it are left out. */
export function mcpEnvWithCache(env: Record<string, string>, cache: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value.includes(PLACEHOLDER)) out[key] = value;
    else if (cache !== undefined) out[key] = value.replaceAll(PLACEHOLDER, cache);
  }
  return out;
}

/** Removes intent-named folders under the roots whose workspace no longer exists; anything else is left alone. */
export function sweepWorkspaceCaches(input: { roots: readonly string[]; live: ReadonlySet<string> }): string[] {
  const removed: string[] = [];
  for (const root of new Set(input.roots)) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name);
      if (!INTENT_ID.test(name) || input.live.has(name) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}

export const COORDINATOR_CACHE_RULE = `Your bash has $${CACHE_VARIABLE}, this chat workspace's cache folder outside the worktree, removed with it. Put build output and caches there, never in the worktree: DerivedData (-derivedDataPath "$${CACHE_VARIABLE}/DerivedData"), test results, browser profiles, logs.`;
const INSTRUCTIONS_LINE = /\nWorkspace cache folder: [^\n]*\n/g;
/** A prompt as hosts before workspace caches built it, for proving an older agent's stored prompt. */
export const withoutCacheInstructions = (text: string) => text.replace(INSTRUCTIONS_LINE, "");
export const workspaceCacheInstructions = (dir: string) =>
  `\nWorkspace cache folder: ${dir} ($${CACHE_VARIABLE}), outside the worktree and removed with it. Put build output and caches there, never in the worktree: DerivedData (-derivedDataPath "$${CACHE_VARIABLE}/DerivedData"), test results, browser profiles, logs.\n`;

/** One project's caches: the resolver every execution path uses, and the sweep cleanup runs. */
export function workspaceCaches(input: {
  projectId: string;
  controlRoot: string;
  root: () => Conversation | undefined;
  cacheRoot: () => string | null;
}) {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  /** Workspaces that still exist: allocated, or preserved after a refused removal. Released ones are gone. */
  async function existing() {
    const root = input.root();
    if (!root) return [];
    return (await workspaceReceipts(root))
      .filter((receipt) => receipt.state === "allocated" || receipt.state === "preserved")
      .map((receipt) => ({ intentId: receipt.intentId, workspacePath: real(receipt.workspacePath ?? receipt.scope.workspacePath) }));
  }
  /** One workspace's cache, created on first use. Frozen prompts use this: it needs no committed receipt. */
  function forIntent(intentId: string): string {
    const dir = workspaceCacheDir({ ...input, intentId, cacheRoot: input.cacheRoot() });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The folder's mtime is its last use: cleanup removes caches unused for days (src/workspace-cleanup.ts).
    const now = new Date();
    utimesSync(dir, now, now);
    return dir;
  }
  /** The cache of the workspace `cwd` is in; none outside a workspace. */
  async function forCwd(cwd: string): Promise<string | undefined> {
    const intentId = workspaceIntentFor(await existing(), real(cwd));
    return intentId ? forIntent(intentId) : undefined;
  }
  async function sweep(): Promise<string[]> {
    const live = new Set((await existing()).map((item) => item.intentId));
    const set = input.cacheRoot();
    return sweepWorkspaceCaches({
      roots: [cacheRoots({ ...input, cacheRoot: null }), ...(set === null ? [] : [cacheRoots({ ...input, cacheRoot: set })])],
      live,
    });
  }
  /** Workspaces that still exist with their cache folder under the current root (which may not exist yet). */
  async function live(): Promise<{ intentId: string; workspacePath: string; cache: string }[]> {
    const cacheRoot = input.cacheRoot();
    return (await existing()).map((item) => ({ ...item, cache: workspaceCacheDir({ ...input, intentId: item.intentId, cacheRoot }) }));
  }
  return { forIntent, forCwd, sweep, live };
}
export type WorkspaceCaches = ReturnType<typeof workspaceCaches>;
