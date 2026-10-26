import { SettingsManager, getAgentDir, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, providerExtensionStatus } from "./provider-extensions.ts";
import type { Project, Request } from "./state.ts";

type Changes = Extract<Request, { action: "settings-update" }>["changes"];
const openRegistry = () => createModelRuntime();
let lastPickerRegistry: Awaited<ReturnType<typeof openRegistry>> | undefined;

export async function projectModelCatalog(options: { provider?: string; offset?: number; limit?: number }) {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid model catalog page");
  const registry = await openRegistry();
  const models = [...registry.getModels(options.provider)].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  const items = models.slice(offset, offset + limit).map(model => ({ reference: `${model.provider}/${model.id}`, provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, configured: registry.getProviderAuthStatus(model.provider).configured }));
  return { items, total: models.length, offset, nextOffset: offset + items.length < models.length ? offset + items.length : null, networkChecked: false };
}
/** Everything the picker needs in one offline response: all models (configured flag) plus the scoped list: the project's own scope when set, else Pi's (settings enabledModels, resolved by Pi's resolver against configured models). */
export async function projectModelPicker(project?: Pick<Project, "cwd" | "scopedModels">) {
  let registry, refreshError = false;
  try { registry = await openRegistry(); lastPickerRegistry = registry; }
  catch {
    if (!lastPickerRegistry) throw new Error("Local model configuration could not be read");
    registry = lastPickerRegistry; refreshError = true;
  }
  const models = [...registry.getModels()].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  const items = models.map(model => ({ reference: `${model.provider}/${model.id}`, name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning, configured: registry.getProviderAuthStatus(model.provider).configured }));
  let scoped: string[] = [], unavailableScoped: string[] = [];
  // scopeSet tells "no scope configured" (cycle every configured model) from "a scope resolving to nothing usable" (block, never widen).
  let scopeSet = false;
  if (project?.scopedModels) {
    scopeSet = true;
    scoped = project.scopedModels.filter(reference => items.some(item => item.reference === reference && item.configured));
    unavailableScoped = project.scopedModels.filter(reference => items.some(item => item.reference === reference && !item.configured));
  }
  else try {
    const patterns = SettingsManager.create(project?.cwd ?? process.cwd(), getAgentDir()).getEnabledModels() ?? [];
    scopeSet = patterns.length > 0;
    if (patterns.length) {
      scoped = (await resolveModelScopeWithDiagnostics(patterns, registry)).scopedModels.map(entry => `${entry.model.provider}/${entry.model.id}`);
      // Use Pi's matching rules for display too, without widening the usable scope or changing auth.
      const installed = new Proxy(registry, { get: (target, key) => key === "getAvailable" ? async () => models : Reflect.get(target, key) });
      unavailableScoped = (await resolveModelScopeWithDiagnostics(patterns, installed)).scopedModels
        .filter(entry => !registry.getProviderAuthStatus(entry.model.provider).configured)
        .map(entry => `${entry.model.provider}/${entry.model.id}`);
    }
  } catch { scoped = []; }
  return { items, scoped: [...new Set(scoped)], unavailableScoped: [...new Set(unavailableScoped)], scopeSet, networkChecked: false, extensionErrors: [...(await providerExtensionStatus()).errors, ...(refreshError ? [{ extension: "local models", error: "Local model refresh failed; showing previous catalog" }] : [])] };
}
export async function validateProjectModelChanges(changes: Changes): Promise<void> {
  const selections = [changes.model, changes.models?.worker, changes.models?.scout, changes.models?.reviewer, changes.models?.verifier].filter(value => typeof value === "string");
  const scope = changes.scopedModels ?? [];
  if (!selections.length && !scope.length) return;
  const registry = await openRegistry();
  for (const reference of scope) if (!registry.getModels().some(model => `${model.provider}/${model.id}` === reference)) throw new Error(`Scoped models must be installed models: ${reference}`);
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
