import { createHash } from "node:crypto";
import { DEFAULT_STALL_MINUTES, type Project, type Request } from "./state.ts";
import { PROFILE_IDS } from "./profiles.ts";
import { normalizePromptBlocks, PROJECT_PROMPT_TARGETS, type ProjectPromptBlocks } from "./prompt-blocks.ts";

type Update = Extract<Request, { action: "settings-update" }>;
export function projectSettings(project: Project) {
  const values = {
    name: project.name,
    objective: project.objective,
    model: project.model,
    models: { ...project.models },
    fallbackModels: { ...project.fallbackModels },
    knowledgeAccess: project.knowledgeAccess ?? "read-only",
    libraryAccess: project.libraryAccess ?? "none",
    decisionAccess: project.decisionAccess ?? "none",
    githubCli: project.githubCli ?? "full",
    stallMinutes: project.stallMinutes ?? DEFAULT_STALL_MINUTES,
    scopedModels: project.scopedModels ?? null,
    skills: project.skillProfiles ?? null,
    mcp: project.mcp ?? null,
    prompts: project.prompts ?? null,
    promptBlocks: project.promptBlocks ?? null,
    worktreeSetup: project.worktreeSetup ?? "",
    context: project.contextSettings ?? null,
    verification: project.verification ?? null,
    profiles: project.profiles ?? null,
  };
  return {
    values,
    revision: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
    verificationProblem: project.verification?.enabled ? verificationProviderProblem(project) : null,
  };
}
/** Why this project's workers cannot be verified whatever the settings say, or null. */
export function verificationProviderProblem(project: Project): string | null {
  const provider = project.workspaceAuthorization?.provider;
  return provider && provider !== "github"
    ? `Verification covers git workspaces. The "${provider}" workspace provider keeps its shell policy in its plugin, which verifiers cannot use, so its workers are not verified`
    : null;
}
export function updateProjectSettings(project: Project, input: Update): Project {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("Settings update requires confirmation matching project id");
  if (project.deleted || project.archived) throw new Error("Inactive project settings cannot be changed");
  if (input.expectedRevision !== projectSettings(project).revision) throw new Error("Settings revision conflict; reread before updating");
  const patch = input.changes;
  const {
    skillProfiles,
    mcp,
    worktreeSetup,
    contextSettings,
    scopedModels,
    prompts,
    promptBlocks,
    verification,
    fallbackModels,
    profiles,
    ...rest
  } = project;
  const merged: Record<string, string | null | undefined> = { ...prompts, ...patch.prompts };
  // One source per target: the later write wins, a block list over a legacy override and a legacy override over a block list.
  const blocks: ProjectPromptBlocks = { ...promptBlocks };
  for (const role of Object.keys(patch.prompts ?? {})) delete blocks[role as keyof ProjectPromptBlocks];
  for (const target of PROJECT_PROMPT_TARGETS) {
    const choice = patch.promptBlocks?.[target];
    if (choice === undefined) continue;
    const list = choice === null ? undefined : normalizePromptBlocks(target, choice);
    if (list) blocks[target] = list;
    else delete blocks[target];
    delete merged[target];
  }
  const promptValues = Object.fromEntries(
    Object.entries(merged).filter(([, text]) => typeof text === "string" && text.trim()),
  ) as NonNullable<Project["prompts"]>;
  const scope = patch.scopedModels === undefined ? scopedModels : (patch.scopedModels ?? undefined);
  const models = { ...project.models };
  for (const role of ["worker", "scout", "reviewer", "verifier"] as const) {
    const choice = patch.models?.[role];
    if (choice === null) delete models[role];
    else if (choice !== undefined) models[role] = choice;
  }
  const fallbacks = { ...fallbackModels };
  for (const role of ["worker", "scout", "reviewer"] as const) {
    const choice = patch.fallbackModels?.[role];
    if (choice === null) delete fallbacks[role];
    else if (choice !== undefined) fallbacks[role] = choice;
  }
  const context = patch.context === undefined ? contextSettings : (patch.context ?? undefined);
  if (context?.contextWindow !== undefined && (context.keepRecentTokens ?? 20_000) * 2 > context.contextWindow)
    throw new Error("Keep-recent tokens must be at most half the context window");
  const skills = patch.skills === undefined ? skillProfiles : (patch.skills ?? undefined);
  const mcpSettings = patch.mcp === undefined ? mcp : (patch.mcp ?? undefined);
  const checks = patch.verification === undefined ? verification : (patch.verification ?? undefined);
  if (checks?.enabled && !checks.skill.trim()) throw new Error("Verification needs a verification skill");
  const unsupported = patch.verification?.enabled ? verificationProviderProblem(project) : null;
  if (unsupported) throw new Error(`Verification cannot be turned on: ${unsupported}`);
  const setup = (patch.worktreeSetup ?? worktreeSetup ?? "").trim();
  const nextProfiles: NonNullable<Project["profiles"]> = { ...profiles };
  for (const id of PROFILE_IDS) {
    const choice = patch.profiles?.[id];
    if (choice === null) delete nextProfiles[id];
    else if (choice !== undefined) nextProfiles[id] = structuredClone(choice);
  }
  return {
    ...rest,
    ...(skills ? { skillProfiles: structuredClone(skills) } : {}),
    ...(mcpSettings ? { mcp: structuredClone(mcpSettings) } : {}),
    ...(Object.keys(promptValues).length ? { prompts: promptValues } : {}),
    ...(Object.keys(blocks).length ? { promptBlocks: blocks } : {}),
    ...(setup ? { worktreeSetup: setup } : {}),
    ...(context ? { contextSettings: structuredClone(context) } : {}),
    ...(checks ? { verification: { ...checks } } : {}),
    ...(Object.keys(nextProfiles).length ? { profiles: nextProfiles } : {}),
    name: patch.name ?? project.name,
    objective: patch.objective ?? project.objective,
    model: patch.model ?? project.model,
    models,
    ...(Object.keys(fallbacks).length ? { fallbackModels: fallbacks } : {}),
    ...(scope ? { scopedModels: [...scope] } : {}),
    knowledgeAccess: patch.knowledgeAccess ?? project.knowledgeAccess,
    libraryAccess: patch.libraryAccess ?? project.libraryAccess,
    decisionAccess: patch.decisionAccess ?? project.decisionAccess,
    githubCli: patch.githubCli ?? project.githubCli,
    stallMinutes: patch.stallMinutes ?? project.stallMinutes,
  };
}
