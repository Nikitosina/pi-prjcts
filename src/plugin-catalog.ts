import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_PLUGINS, isBundledPluginId, type BundledPlugin, type BundledPluginId } from "./bundled-plugins.ts";
import type { PluginStatus } from "./plugin-types.ts";
import { isPluginAt, plugins } from "./plugins.ts";
import { home, saveJson } from "./state.ts";

/** `available`: not configured. `configured`: in the host's configuration, not part of the running host (a restart loads it). */
export type CatalogState = "available" | "configured" | "loaded" | "failed";

export type CatalogEntry = {
  id: BundledPluginId;
  name: string;
  description: string;
  state: CatalogState;
  version: string | null;
  error?: string;
};

/** Pure: the state of one entry from the loader's attempt at the host's start and whether the configuration lists its directory. */
export function describeEntry(item: BundledPlugin, facts: { attempt: PluginStatus | undefined; configured: boolean }): CatalogEntry {
  const { id, name, description } = item;
  const { attempt } = facts;
  if (attempt)
    return { id, name, description, state: attempt.state, version: attempt.version, ...(attempt.error ? { error: attempt.error } : {}) };
  return { id, name, description, state: facts.configured ? "configured" : "available", version: null };
}

const configFile = () => join(home(), "plugins.json");

/** The raw `plugins.json` (`{ plugins: [...] }` or a bare array) and its list; refuses a file the loader would not read, so it is never overwritten. */
function readConfig(): { data: unknown; list: string[] } | undefined {
  if (!existsSync(configFile())) return undefined;
  try {
    const data = JSON.parse(readFileSync(configFile(), "utf8")) as unknown;
    const list = Array.isArray(data) ? data : (data as { plugins?: unknown } | null)?.plugins;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item))
      throw new Error('expected { "plugins": ["/path", ...] }');
    return { data, list: list as string[] };
  } catch (error) {
    throw new Error(`plugins.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const listsDirectory = (item: BundledPlugin) => plugins.configuredPaths().some((path) => isPluginAt(item.directory, path));

export const pluginCatalog = {
  list: (): CatalogEntry[] =>
    BUNDLED_PLUGINS.map((item) => describeEntry(item, { attempt: plugins.attempt(item.directory), configured: listsDirectory(item) })),
  /** Adds the shipped directory of one catalog id to the host's `plugins.json`; everything else in the file stays. Idempotent. Loads nothing: a restart does. */
  activate(id: string): CatalogEntry[] {
    if (!isBundledPluginId(id)) throw new Error(`"${id}" is not a bundled plugin`);
    const item = BUNDLED_PLUGINS.find((candidate) => candidate.id === id)!;
    const current = readConfig();
    if (listsDirectory(item)) return pluginCatalog.list();
    const owner = plugins.status().find((status) => status.name === id && status.state === "loaded" && !plugins.attempt(item.directory));
    if (owner) throw new Error(`A plugin named "${id}" is already loaded from ${owner.source}`);
    const list = [...(current?.list ?? []), item.directory];
    const data =
      current === undefined ? { plugins: list } : Array.isArray(current.data) ? list : { ...(current.data as object), plugins: list };
    // A symlinked plugins.json stays the owner's file: write its target, not a new file over the link.
    saveJson(existsSync(configFile()) ? realpathSync(configFile()) : configFile(), data);
    return pluginCatalog.list();
  },
};
