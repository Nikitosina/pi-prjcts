import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { createModelRuntime } from "./provider-extensions.ts";
import {
  LOCKED_TOOLS,
  PROFILE_IDS,
  Tier as TierSchema,
  disabledWithSkills,
  effectiveModel,
  resolveSelection,
  toolGroup,
  type ProfileSettings,
  type Tier,
} from "./profiles.ts";
import { DEFAULT_UI, UiSettings, type UiPatch } from "./ui-settings.ts";
import { home, listProjects, parse, saveJson, type Project, type Request } from "./state.ts";

/** Host-level documents shared by every project and browser: model tiers and the UI settings (docs/ui2-contract.md). */
const TiersFile = Type.Object(
  { version: Type.Literal(1), tiers: Type.Array(TierSchema, { maxItems: 64 }) },
  { additionalProperties: false },
);

const uiPath = () => join(home(), "ui.json"),
  tiersPath = () => join(home(), "tiers.json");
const revisionOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A missing file is the default; a damaged one is an error, never silently replaced. */
function readDocument<T>(path: string, read: (value: unknown) => T): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return read(JSON.parse(text));
  } catch (error) {
    throw new Error(`${path} is damaged; fix or remove it (${error instanceof Error ? error.message : String(error)})`.slice(0, 1500));
  }
}
// One writer at a time; the host is the only process that writes these files.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(operation: () => Promise<T> | T): Promise<T> => {
  const next = queue.then(operation, operation);
  queue = next.catch(() => {});
  return next;
};

export function readUi(): { revision: string; ui: UiSettings } {
  const ui =
    readDocument(uiPath(), (value) =>
      parse(UiSettings, typeof value === "object" && value !== null && !Array.isArray(value) ? { font: DEFAULT_UI.font, ...value } : value),
    ) ?? DEFAULT_UI;
  return { revision: revisionOf(ui), ui };
}
export const setUi = (revision: string, patch: Static<typeof UiPatch>) =>
  serial(() => {
    const current = readUi();
    if (current.revision !== revision) throw new Error("UI settings revision conflict; reread before updating");
    const ui = parse(UiSettings, {
      ...current.ui,
      ...patch,
      hotkeys: patch.hotkeys ?? current.ui.hotkeys,
      panels: { ...current.ui.panels, ...patch.panels },
    });
    saveJson(uiPath(), ui);
    return { revision: revisionOf(ui), ui };
  });

/** Today's per-role models as tiers: one per distinct chain (the role model and its quota fallback), assigned to nobody. */
export function generatedTiers(projects: readonly Project[]): Tier[] {
  const chains = new Map<string, string[]>();
  for (const project of projects) {
    if (project.deleted) continue;
    chains.set(JSON.stringify([project.model]), [project.model]);
    for (const role of ["worker", "scout", "reviewer"] as const) {
      const chain = [project.models[role] ?? project.model, project.fallbackModels?.[role]].filter((item): item is string => !!item);
      const unique = [...new Set(chain)];
      chains.set(JSON.stringify(unique), unique);
    }
  }
  const used = new Set<string>();
  return [...chains.values()].slice(0, 26).map((models, index) => {
    const name = models[0]!.slice(models[0]!.indexOf("/") + 1);
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "tier";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { id, name: models.length > 1 ? `${name} + fallback` : name, letter: String.fromCharCode(65 + index), models };
  });
}
/** The saved tiers; the first read writes the generated ones once so later reads are stable. */
export function readTiers(): { revision: string; tiers: Tier[] } {
  const saved = readDocument(tiersPath(), (value) => parse(TiersFile, value).tiers);
  if (saved) return { revision: revisionOf(saved), tiers: saved };
  const tiers = generatedTiers(listProjects());
  saveJson(tiersPath(), { version: 1, tiers });
  return { revision: revisionOf(tiers), tiers };
}

/** The tiers a project's profiles may need; read only when one of them names a tier. */
export const tiersFor = (project: Pick<Project, "profiles">): Tier[] =>
  PROFILE_IDS.some((profile) => project.profiles?.[profile]?.tier) ? readTiers().tiers : [];

export async function tierCatalog() {
  const registry = await createModelRuntime();
  return [...registry.getModels()]
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))
    .map((model) => ({
      ref: `${model.provider}/${model.id}`,
      name: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow,
      inputCost: model.cost?.input ?? 0,
      outputCost: model.cost?.output ?? 0,
      available: registry.getProviderAuthStatus(model.provider).configured,
    }));
}
export async function tiersSnapshot() {
  return { ...readTiers(), catalog: await tierCatalog() };
}

export const setTiers = (revision: string, tiers: readonly Tier[]) =>
  serial(async () => {
    const ids = new Set<string>();
    for (const tier of tiers) {
      if (ids.has(tier.id)) throw new Error(`Tier id "${tier.id}" is used twice`);
      ids.add(tier.id);
      if (new Set(tier.models).size !== tier.models.length) throw new Error(`Tier "${tier.name}" lists a model twice`);
    }
    const catalog = await tierCatalog();
    for (const tier of tiers)
      for (const model of tier.models)
        if (!catalog.some((item) => item.ref === model))
          throw new Error(`Tier "${tier.name}" names a model that is not installed: ${model}`);
    const current = readTiers();
    if (current.revision !== revision) throw new Error("Tiers revision conflict; reread before updating");
    for (const project of listProjects())
      for (const profile of PROFILE_IDS) {
        const tier = project.profiles?.[profile]?.tier;
        if (tier && !ids.has(tier) && !project.deleted)
          throw new Error(`Tier "${tier}" is in use by the ${profile} profile of ${project.name}; reassign it first`);
      }
    const saved = tiers.map((tier) => ({ ...tier, models: [...tier.models] }));
    saveJson(tiersPath(), { version: 1, tiers: saved });
    return { revision: revisionOf(saved), tiers: saved };
  });

type ProfileChanges = Extract<Request, { action: "settings-update" }>["changes"]["profiles"];
/** Before anything is saved: tiers must exist and have a usable model, and a profile's locked tools stay on. */
export async function validateProfileChanges(changes: ProfileChanges): Promise<void> {
  if (!changes) return;
  const chosen = PROFILE_IDS.flatMap((profile) => {
    const settings = changes[profile];
    return settings ? [{ profile, settings }] : [];
  });
  for (const { profile, settings } of chosen) {
    const locked = LOCKED_TOOLS[profile].flatMap((name) => [name, `group:${toolGroup(name)}`]);
    const refused = settings.tools?.disabled.find((name) => locked.includes(name));
    if (refused) throw new Error(`${refused} is locked for the ${profile} profile; it needs it to finish its work`);
  }
  if (!chosen.some(({ settings }) => settings.tier)) return;
  const tiers = readTiers().tiers,
    usable = await usableModels();
  for (const { profile, settings } of chosen) {
    if (!settings.tier) continue;
    const tier = tiers.find((item) => item.id === settings.tier);
    if (!tier) throw new Error(`Unknown tier "${settings.tier}" for the ${profile} profile`);
    if (!tier.models.some(usable)) throw new Error(`Tier "${tier.name}" has no model with configured credentials`);
  }
}
async function usableModels(): Promise<(reference: string) => boolean> {
  const configured = new Set((await tierCatalog()).filter((item) => item.available).map((item) => item.ref));
  return (reference) => configured.has(reference);
}

/** Each profile's saved settings and the model it runs now (null when its tier can no longer resolve). */
export async function profilesSnapshot(project: Project, revision: string) {
  const usable = await usableModels();
  let selection: ReturnType<typeof resolveSelection> | null;
  try {
    selection = resolveSelection(project, tiersFor(project), usable);
  } catch {
    selection = null;
  }
  const profiles = Object.fromEntries(
    PROFILE_IDS.map((profile) => [
      profile,
      {
        ...(project.profiles?.[profile] ?? {}),
        ...(disabledWithSkills(project, profile).length ? { tools: { disabled: disabledWithSkills(project, profile) } } : {}),
        effectiveModel: selection ? effectiveModel(selection, profile) : null,
      },
    ]),
  ) as Record<(typeof PROFILE_IDS)[number], ProfileSettings & { effectiveModel: string | null }>;
  return { revision, profiles };
}
