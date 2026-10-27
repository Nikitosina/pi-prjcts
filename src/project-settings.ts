import { createHash } from "node:crypto";
import { DEFAULT_WORKER_CAP, type Project, type Request } from "./state.ts";

type Update = Extract<Request, { action: "settings-update" }>;
export function projectSettings(project: Project) {
  const values = { name: project.name, objective: project.objective, model: project.model, models: { ...project.models }, fallbackModels: { ...project.fallbackModels }, knowledgeAccess: project.knowledgeAccess ?? "read-only", libraryAccess: project.libraryAccess ?? "none", decisionAccess: project.decisionAccess ?? "none", githubCli: project.githubCli ?? "full", workerCap: project.workerCap ?? DEFAULT_WORKER_CAP, scopedModels: project.scopedModels ?? null, skills: project.skillProfiles ?? null, mcp: project.mcp ?? null, prompts: project.prompts ?? null, worktreeSetup: project.worktreeSetup ?? "", context: project.contextSettings ?? null, verification: project.verification ?? null };
  return { values, revision: createHash("sha256").update(JSON.stringify(values)).digest("hex") };
}
export function updateProjectSettings(project: Project, input: Update): Project {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("Settings update requires confirmation matching project id");
  if (project.deleted || project.archived) throw new Error("Inactive project settings cannot be changed");
  if (input.expectedRevision !== projectSettings(project).revision) throw new Error("Settings revision conflict; reread before updating");
  const patch = input.changes;
  const { skillProfiles, mcp, worktreeSetup, contextSettings, scopedModels, prompts, verification, fallbackModels, ...rest } = project;
  const merged = { ...prompts, ...patch.prompts };
  const promptValues = Object.fromEntries(Object.entries(merged).filter(([, text]) => typeof text === "string" && text.trim())) as NonNullable<Project["prompts"]>;
  const scope = patch.scopedModels === undefined ? scopedModels : patch.scopedModels ?? undefined;
  const models = { ...project.models };
  for (const role of ["worker", "scout", "reviewer", "verifier"] as const) {
    const choice = patch.models?.[role];
    if (choice === null) delete models[role]; else if (choice !== undefined) models[role] = choice;
  }
  const fallbacks = { ...fallbackModels };
  for (const role of ["worker", "scout", "reviewer"] as const) {
    const choice = patch.fallbackModels?.[role];
    if (choice === null) delete fallbacks[role]; else if (choice !== undefined) fallbacks[role] = choice;
  }
  const context = patch.context === undefined ? contextSettings : patch.context ?? undefined;
  if (context?.contextWindow !== undefined && (context.keepRecentTokens ?? 20_000) * 2 > context.contextWindow) throw new Error("Keep-recent tokens must be at most half the context window");
  const skills = patch.skills === undefined ? skillProfiles : patch.skills ?? undefined;
  const mcpSettings = patch.mcp === undefined ? mcp : patch.mcp ?? undefined;
  const checks = patch.verification === undefined ? verification : patch.verification ?? undefined;
  if (checks?.enabled && !checks.skill.trim()) throw new Error("Verification needs a verification skill");
  if (checks?.enabled && !models.verifier) throw new Error("Verification needs its own verifier model; none is assumed");
  const setup = (patch.worktreeSetup ?? worktreeSetup ?? "").trim();
  return { ...rest, ...(skills ? { skillProfiles: structuredClone(skills) } : {}), ...(mcpSettings ? { mcp: structuredClone(mcpSettings) } : {}), ...(Object.keys(promptValues).length ? { prompts: promptValues } : {}), ...(setup ? { worktreeSetup: setup } : {}), ...(context ? { contextSettings: structuredClone(context) } : {}), ...(checks ? { verification: { ...checks } } : {}), name: patch.name ?? project.name, objective: patch.objective ?? project.objective, model: patch.model ?? project.model,
    models, ...(Object.keys(fallbacks).length ? { fallbackModels: fallbacks } : {}), ...(scope ? { scopedModels: [...scope] } : {}),
    knowledgeAccess: patch.knowledgeAccess ?? project.knowledgeAccess, libraryAccess: patch.libraryAccess ?? project.libraryAccess, decisionAccess: patch.decisionAccess ?? project.decisionAccess, githubCli: patch.githubCli ?? project.githubCli, workerCap: patch.workerCap ?? project.workerCap };
}
