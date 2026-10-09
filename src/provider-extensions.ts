import { DefaultPackageManager, ModelRuntime, SettingsManager, discoverAndLoadExtensions, getAgentDir, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { contentText, getCurrentSystemMessage, type Context } from "@earendil-works/pi-ai";
import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Model providers contributed by the owner's Pi packages and agent-dir extensions.
 *
 * Loading is provider-only: each enabled extension entry is loaded once per host, in isolation (its own runtime, a timeout,
 * errors recorded per extension), and only its provider / native provider / virtual model registrations are kept. Everything
 * else it registers (tools, commands, shortcuts, flags, event handlers, UI) stays in the discarded extension object and is
 * never bound to the host or to any project agent. One exception: a provider extension's own `before_agent_start` handlers are
 * kept as prompt observers and fed the system prompt of requests sent to that provider (see observeProviderPrompt). Extension code does run at import/factory time in the host process, as in Pi.
 * Nothing is installed or downloaded: only packages Pi already resolved on disk are loaded.
 */
type PromptObserver = (event: unknown, ctx: unknown) => unknown;
type Entry = { extension: string; observers: PromptObserver[]; providers: { name: string; config: Parameters<ModelRuntime["registerProvider"]>[1] }[]; native: Parameters<ModelRuntime["registerNativeProvider"]>[0][]; virtual: Parameters<ModelRuntime["registerVirtualModel"]>[0][] };
export type ExtensionLoadError = { extension: string; error: string };
export type ProviderExtensionStatus = { loaded: string[]; errors: ExtensionLoadError[]; providers: string[] };
type Loaded = { registrations: Entry[]; status: ProviderExtensionStatus };

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const selfRoot = (() => { try { return realpathSync(hostRoot); } catch { return hostRoot; } })();
const isSelf = (path: string) => { try { const real = realpathSync(path); return real === selfRoot || real.startsWith(selfRoot + sep); } catch { return false; } };
const timeoutMs = () => Number(process.env.PI_PROJECTS_EXTENSION_TIMEOUT_MS) || 15000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs()} ms`)), timeoutMs()); })]).finally(() => clearTimeout(timer)).catch(error => { throw new Error(`${label}: ${message(error)}`, { cause: error }); });
}

async function loadAll(): Promise<Loaded> {
  const agentDir = getAgentDir(), status: ProviderExtensionStatus = { loaded: [], errors: [], providers: [] }, registrations: Loaded["registrations"] = [];
  const fail = (extension: string, error: unknown) => status.errors.push({ extension, error: message(error) });
  let resolved;
  try {
    // cwd = agentDir: only the owner's global settings; the host's own cwd never contributes project-local extensions.
    resolved = await withTimeout(new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: SettingsManager.create(agentDir, agentDir) }).resolve(), "resolving packages");
  } catch (error) { fail("pi packages", error); return { registrations, status }; }
  for (const resource of resolved.extensions) {
    const label = resource.metadata.origin === "package" ? resource.metadata.source : resource.path;
    if (!resource.enabled || resource.path.startsWith("builtin:")) continue;
    if (isSelf(resource.path)) { fail(label, "skipped: the projects host never loads itself as a provider extension"); continue; }
    try {
      // Isolated pass per entry; cwd/agentDir point at nothing so only this exact path is loaded.
      const result = await withTimeout(discoverAndLoadExtensions([resource.path], agentDir, join(agentDir, ".no-extensions")), label);
      if (result.errors.length) { for (const item of result.errors) fail(label, item.error); continue; }
      const runtime = result.runtime;
      const observers = result.extensions.flatMap(extension => (extension.handlers.get("before_agent_start") ?? []) as PromptObserver[]);
      const entry: Entry = { extension: label, observers, providers: runtime.pendingProviderRegistrations.map(item => ({ name: item.name, config: item.config })), native: runtime.pendingNativeProviderRegistrations.map(item => item.provider), virtual: runtime.pendingVirtualModelRegistrations.map(item => item.definition) };
      status.loaded.push(label); status.providers.push(...entry.providers.map(item => item.name), ...entry.native.map(item => item.id)); registrations.push(entry);
    } catch (error) { fail(label, error); }
  }
  return { registrations, status };
}

let loading: Promise<Loaded> | undefined, observed: Loaded | undefined;
/** Loaded once per host (first call, normally at host start); later callers share the result. */
export function loadProviderExtensions(): Promise<Loaded> { return loading ??= loadAll(); }

/**
 * The one place that creates a model runtime: Pi's runtime plus every successfully loaded extension provider, then one offline
 * availability pass (no network) so stored credentials (api_key and oauth in auth.json), environment keys and extension
 * providers all count as configured, exactly as running sessions resolve auth. Registration failures are recorded, never thrown.
 */
export async function createModelRuntime(options: Omit<CreateModelRuntimeOptions, "refreshOnCreate" | "allowModelNetwork"> = {}): Promise<ModelRuntime> {
  const [runtime, loaded] = await Promise.all([ModelRuntime.create({ ...options, allowModelNetwork: false, refreshOnCreate: false }), loadProviderExtensions()]);
  const { registrations, status } = observed = loaded;
  const record = (extension: string, text: string) => { if (!status.errors.some(item => item.extension === extension && item.error === text)) status.errors.push({ extension, error: text }); };
  for (const entry of registrations) {
    const attempt = (what: string, apply: () => void) => { try { apply(); } catch (error) { record(entry.extension, `${what}: ${message(error)}`); } };
    for (const item of entry.providers) attempt(`provider ${item.name}`, () => runtime.registerProvider(item.name, item.config));
    for (const item of entry.native) attempt(`provider ${item.id}`, () => runtime.registerNativeProvider(item));
    for (const item of entry.virtual) attempt(`virtual model ${item.id}`, () => runtime.registerVirtualModel(item));
  }
  try { await runtime.refresh({ allowNetwork: false }); } catch (error) { record("model availability", message(error)); }
  return runtime;
}

export async function providerExtensionStatus(): Promise<ProviderExtensionStatus> { const { status } = await loadProviderExtensions(); return { loaded: [...status.loaded], errors: status.errors.map(item => ({ ...item })), providers: [...status.providers] }; }

// Pi's canonical section order, as claude-bridge re-ranks replayed sections before its exact-key prompt lookup.
const SECTION_RANK = new Map([["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4], ["project_context", 5], ["skills", 6], ["cwd", 7]]);
/** The system prompt a provider sees: Durable sends it as the leading system message(s), not as `systemPrompt`. */
function requestSystemPrompt(request: Context): string | undefined {
  if (request.systemPrompt) return request.systemPrompt;
  const message = getCurrentSystemMessage(request.messages as Parameters<typeof getCurrentSystemMessage>[0]);
  if (!message) return undefined;
  const sections = Object.entries(message.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([name, text]) => ({ text, rank: SECTION_RANK.get(name) ?? SECTION_RANK.size })).sort((a, b) => a.rank - b.rank);
  const parts = [contentText(message.content), ...sections.map(item => item.text)].filter(part => part.length > 0);
  return parts.length ? parts.join("\n\n") : undefined;
}
/**
 * Pi fires `before_agent_start` before every agent run; the durable runtime has no such event. Providers that key per-request
 * state on it (claude-bridge refuses a system prompt it never saw there) get it here, synchronously, right before dispatch to
 * that provider. The whole prompt is passed as the custom prompt: pi-projects builds it itself, with no Pi context files or
 * skills. Return values are ignored (observers cannot rewrite the prompt) and failures are swallowed.
 */
export function observeProviderPrompt(provider: string, request: Context): void {
  if (!observed) return;
  const entries = observed.registrations.filter(entry => entry.observers.length && (entry.providers.some(item => item.name === provider) || entry.native.some(item => item.id === provider)));
  const systemPrompt = entries.length ? requestSystemPrompt(request) : undefined;
  if (!systemPrompt) return;
  for (const entry of entries) {
    for (const observer of entry.observers) {
      try {
        const result = observer({ type: "before_agent_start", prompt: "", systemPrompt, systemPromptOptions: { customPrompt: systemPrompt, contextFiles: [], skills: [] } }, {});
        if (result instanceof Promise) result.catch(() => {});
      } catch {}
    }
  }
}
