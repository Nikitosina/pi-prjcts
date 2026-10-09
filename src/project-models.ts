import { SettingsManager, getAgentDir, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, providerExtensionStatus } from "./provider-extensions.ts";
import type { Request } from "./state.ts";

type Changes = Extract<Request, { action: "settings-update" }>["changes"];
const openRegistry = () => createModelRuntime();

export async function projectModelCatalog(options: { provider?: string; offset?: number; limit?: number }) {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid model catalog page");
  const registry = await openRegistry();
  const models = [...registry.getModels(options.provider)].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  const items = models.slice(offset, offset + limit).map(model => ({ reference: `${model.provider}/${model.id}`, provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, configured: registry.getProviderAuthStatus(model.provider).configured }));
  return { items, total: models.length, offset, nextOffset: offset + items.length < models.length ? offset + items.length : null, networkChecked: false };
}
/** Everything the picker needs in one offline response: all models (configured flag) plus Pi's own scoped list (settings enabledModels, resolved by Pi's resolver against configured models). */
export async function projectModelPicker() {
  const registry = await openRegistry();
  const models = [...registry.getModels()].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  const items = models.map(model => ({ reference: `${model.provider}/${model.id}`, name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning, configured: registry.getProviderAuthStatus(model.provider).configured }));
  let scoped: string[] = [];
  try {
    const patterns = SettingsManager.create(process.cwd(), getAgentDir()).getEnabledModels() ?? [];
    if (patterns.length) scoped = (await resolveModelScopeWithDiagnostics(patterns, registry)).scopedModels.map(entry => `${entry.model.provider}/${entry.model.id}`);
  } catch { scoped = []; }
  return { items, scoped: [...new Set(scoped)], networkChecked: false, extensionErrors: (await providerExtensionStatus()).errors };
}
export async function validateProjectModelChanges(changes: Changes): Promise<void> {
  const selections = [changes.model, changes.models?.worker, changes.models?.scout, changes.models?.reviewer].filter(value => value !== undefined);
  if (!selections.length) return;
  const registry = await openRegistry();
  for (const reference of selections) {
    const slash = reference.indexOf("/");
    if (slash < 1 || slash === reference.length - 1) throw new Error("Model settings require a provider/model reference");
    const provider = reference.slice(0, slash), id = reference.slice(slash + 1);
    if (!registry.getModel(provider, id) || !registry.getProviderAuthStatus(provider).configured) {
      const broken = (await providerExtensionStatus()).errors;
      throw new Error(`Model settings require an installed model with configured credentials: ${reference}${broken.length ? ` (provider extensions failed to load: ${broken.map(item => item.extension).join(", ")})` : ""}`);
    }
  }
}
