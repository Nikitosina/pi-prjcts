import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { home } from "./state.ts";

const modalities = Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]));
const base = {
  id: Type.String(), provider: Type.String(), name: Type.String(), api: Type.String(), baseUrl: Type.String(), input: modalities,
  cost: Type.Object({ input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() }),
};
const model = Type.Union([
  Type.Object({ ...base, type: Type.Optional(Type.Literal("chat")), reasoning: Type.Boolean(), contextWindow: Type.Number(), maxTokens: Type.Number() }),
  Type.Object({ ...base, type: Type.Literal("image"), output: modalities }),
  Type.Object({ ...base, type: Type.Literal("classifier"), contextWindow: Type.Number() }),
]);
const catalog = Compile(Type.Record(Type.String(), Type.Object({
  models: Type.Array(model), lastModified: Type.Optional(Type.Number()), checkedAt: Type.Optional(Type.Number()), etag: Type.Optional(Type.String()),
})));

const piProviders = new Set<string>();

/** Pi owns matching provider catalogs; Projects-only providers remain available. Refresh writes stay in memory. */
export async function localModelStore(): Promise<ModelsStore> {
  const project = await readCatalog(join(home(), "models-store.json"));
  const pi = await readCatalog(join(getAgentDir(), "models-store.json"));
  for (const provider of Object.keys(pi)) piProviders.add(provider);
  const memory = new InMemoryModelsStore();
  for (const [provider, entry] of Object.entries(project)) if (!piProviders.has(provider)) await memory.write(provider, entry);
  for (const [provider, entry] of Object.entries(pi)) await memory.write(provider, entry);
  return memory;
}

async function readCatalog(path: string): Promise<Record<string, ModelsStoreEntry>> {
  try {
    const data: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (!catalog.Check(data)) throw new Error("Invalid catalog");
    return data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    // Parse errors can quote file contents, including private provider settings.
    throw new Error("Local model catalog could not be read; previous runtime kept");
  }
}
