import { Type, type Static } from "typebox";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { McpSettings } from "./mcp-profiles.ts";
import type { OffLists, SkillProfiles } from "./skill-profiles.ts";
import type { Project } from "./state.ts";

/** The four agent profiles of a project (docs/ui2-contract.md); the verifier is gone. */
export const PROFILE_IDS = ["coordinator", "worker", "scout", "reviewer"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
export const ProfileIdSchema = Type.Union([
  Type.Literal("coordinator"),
  Type.Literal("worker"),
  Type.Literal("scout"),
  Type.Literal("reviewer"),
]);
export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export const TierId = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$" });
export const ProfileSettings = Type.Object(
  {
    tier: Type.Optional(TierId),
    thinking: Type.Optional(ThinkingLevelSchema),
    tools: Type.Optional(
      Type.Object(
        { disabled: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 256, uniqueItems: true }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ProfileSettings = Static<typeof ProfileSettings>;
export const Profiles = Type.Object(
  {
    coordinator: Type.Optional(ProfileSettings),
    worker: Type.Optional(ProfileSettings),
    scout: Type.Optional(ProfileSettings),
    reviewer: Type.Optional(ProfileSettings),
  },
  { additionalProperties: false },
);
export type Profiles = Static<typeof Profiles>;
export const Tier = Type.Object(
  {
    id: TierId,
    name: Type.String({ minLength: 1, maxLength: 60 }),
    letter: Type.String({ minLength: 1, maxLength: 2 }),
    models: Type.Array(Type.String({ minLength: 3, maxLength: 256 }), { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false },
);
export type Tier = Static<typeof Tier>;

/** Tools a profile needs to finish its contract; never switched off. */
export const LOCKED_TOOLS: Record<ProfileId, readonly string[]> = {
  // Owner approvals are the coordinator's only way to a dangerous action; switching them off would leave it nothing to ask with.
  coordinator: ["agents", "owner_approval_request"],
  worker: ["job"],
  scout: [],
  reviewer: [],
};
export const DEFAULT_THINKING: ThinkingLevel = "medium";
export const thinkingOf = (project: Pick<Project, "profiles">, profile: ProfileId): ModelThinkingLevel =>
  project.profiles?.[profile]?.thinking ?? DEFAULT_THINKING;

export type ToolGroupId = "core" | "delegation" | "job" | "knowledge" | "github" | "archive" | "library" | "skills" | "mcp";
export const GROUP_LABELS: Record<ToolGroupId, string> = {
  core: "Core",
  delegation: "Delegation",
  job: "Job",
  knowledge: "Knowledge",
  github: "GitHub",
  archive: "Archive",
  library: "Library",
  skills: "Skills",
  mcp: "MCP gateway",
};
/** The group a built-in tool belongs to, by name; plugin tools are grouped by their provider instead. */
export function toolGroup(name: string): ToolGroupId {
  if (name === "job" || name === "projects_verify_run") return "job";
  if (["agents", "subagent", "projects_worker_read", "projects_worker_diff", "projects_workspace_catalog"].includes(name))
    return "delegation";
  if (name.startsWith("projects_knowledge_")) return "knowledge";
  if (name.startsWith("projects_github_") || name === "projects_gh") return "github";
  if (name.startsWith("projects_archive_")) return "archive";
  if (name.startsWith("projects_library_")) return "library";
  if (name === "projects_skill_file") return "skills";
  if (name.startsWith("projects_mcp_")) return "mcp";
  return "core";
}

/** One group of `profile-tools`; `locked` groups cannot be switched off as a whole. */
export type ProfileToolGroup = {
  id: string;
  label: string;
  source: "core" | "plugin" | "mcp" | "skill";
  locked: boolean;
  tools: { name: string; description: string; parameters: unknown; enabled: boolean }[];
};
/** Whether a profile's disabled list switches this tool off: by name or by its group (`group:<id>`). */
export function toolDisabled(project: Pick<Project, "profiles">, profile: ProfileId, name: string, group = `group:${toolGroup(name)}`) {
  if (LOCKED_TOOLS[profile].includes(name)) return false;
  const disabled = project.profiles?.[profile]?.tools?.disabled ?? [];
  return disabled.includes(name) || disabled.includes(group);
}
/** `skill:<name>` rows of `profile-tools`: switching one off is a skill profile change, stored once in `skillProfiles.off`. */
const SKILL_TOOL = "skill:";
/** A profile's disabled list as the owner sees it: its saved tools plus the skills switched off for it (own list and "all"). */
export function disabledWithSkills(project: Pick<Project, "profiles" | "skillProfiles">, profile: ProfileId): string[] {
  const off = project.skillProfiles?.off;
  const skills = [...(off?.all ?? []), ...(off?.[profile] ?? [])].map((name) => `${SKILL_TOOL}${name}`);
  return [...new Set([...(project.profiles?.[profile]?.tools?.disabled ?? []).filter((name) => !name.startsWith(SKILL_TOOL)), ...skills])];
}
/**
 * Splits a profile's disabled list into tools and the skill profile it implies. A skill on the "all" list that the owner turned on
 * for this profile moves to the other profiles' own lists, so they stay as they were.
 */
export function splitSkillToggles(
  project: Pick<Project, "skillProfiles">,
  profile: ProfileId,
  disabled: readonly string[],
): { tools: string[]; skills: SkillProfiles | undefined } {
  const tools = disabled.filter((name) => !name.startsWith(SKILL_TOOL));
  const names = new Set(disabled.filter((name) => name.startsWith(SKILL_TOOL)).map((name) => name.slice(SKILL_TOOL.length)));
  const saved = project.skillProfiles?.off ?? {};
  const all = (saved.all ?? []).filter((name) => names.has(name)),
    released = (saved.all ?? []).filter((name) => !names.has(name));
  const off: OffLists = {};
  if (all.length) off.all = all;
  for (const role of PROFILE_IDS) {
    const list = role === profile ? [...names].filter((name) => !all.includes(name)) : [...new Set([...(saved[role] ?? []), ...released])];
    if (list.length) off[role] = list;
  }
  const unchanged = JSON.stringify(off) === JSON.stringify(saved);
  return { tools, skills: unchanged ? undefined : { ...project.skillProfiles, off } };
}
/** The tools a profile is offered after its disabled list. */
export const offeredFor = <T extends { name: string }>(
  project: Pick<Project, "profiles">,
  profile: ProfileId,
  tools: readonly T[],
  groupOf?: (name: string) => string | undefined,
): T[] => tools.filter((tool) => !toolDisabled(project, profile, tool.name, groupOf?.(tool.name)));

/** The saved MCP settings with this profile's switched-off servers (`group:mcp:<server>`) and writes (`mcp-writes:<server>`) applied. */
export function mcpForProfile(project: Pick<Project, "profiles" | "mcp">, profile: ProfileId): McpSettings | undefined {
  const disabled = project.profiles?.[profile]?.tools?.disabled ?? [];
  if (!disabled.length) return project.mcp;
  const off = disabled.flatMap((item) => (item.startsWith("group:mcp:") ? [item.slice("group:mcp:".length)] : []));
  const writes = (project.mcp?.writes ?? []).filter((server) => !disabled.includes(`mcp-writes:${server}`));
  return {
    ...project.mcp,
    off: { ...project.mcp?.off, [profile]: [...new Set([...(project.mcp?.off?.[profile] ?? []), ...off])] },
    writes,
  };
}

/** What the runtime runs with: the legacy selection with each tiered profile's first usable model, plus each tier's usable chain. */
export type ModelSelection = Pick<Project, "model" | "models" | "fallbackModels"> & {
  chains: Partial<Record<ProfileId, readonly string[]>>;
};
export function resolveSelection(
  project: Pick<Project, "model" | "models" | "fallbackModels" | "profiles">,
  tiers: readonly Tier[],
  usable: (reference: string) => boolean,
): ModelSelection {
  const chains: ModelSelection["chains"] = {};
  const models = { ...project.models };
  let model = project.model;
  for (const profile of PROFILE_IDS) {
    const tierId = project.profiles?.[profile]?.tier;
    if (!tierId) continue;
    const tier = tiers.find((item) => item.id === tierId);
    if (!tier) throw new Error(`The ${profile} profile uses tier "${tierId}", which no longer exists`);
    const chain = tier.models.filter(usable);
    if (!chain.length) throw new Error(`Tier "${tier.name}" has no model with configured credentials`);
    chains[profile] = chain;
    if (profile === "coordinator") model = chain[0]!;
    else models[profile] = chain[0]!;
  }
  return { model, models, fallbackModels: project.fallbackModels ?? {}, chains };
}
/** The model a profile runs now: its own (tier or legacy field), else the coordinator's. */
export const effectiveModel = (selection: ModelSelection, profile: ProfileId): string =>
  profile === "coordinator" ? selection.model : (selection.models[profile] ?? selection.model);
