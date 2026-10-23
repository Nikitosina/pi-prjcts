import { createHash } from "node:crypto";
import { DEFAULT_WORKER_CAP, type Project, type Request } from "./state.ts";

type Update = Extract<Request, { action: "settings-update" }>;
export function projectSettings(project: Project) {
  const values = { name: project.name, objective: project.objective, model: project.model, models: { ...project.models }, knowledgeAccess: project.knowledgeAccess ?? "read-only", libraryAccess: project.libraryAccess ?? "none", decisionAccess: project.decisionAccess ?? "none", workerCap: project.workerCap ?? DEFAULT_WORKER_CAP, scopedModels: project.scopedModels ?? null, skills: project.skillProfiles ?? null, mcp: project.mcp ?? null, worktreeSetup: project.worktreeSetup ?? "", context: project.contextSettings ?? null };
  return { values, revision: createHash("sha256").update(JSON.stringify(values)).digest("hex") };
}
export function updateProjectSettings(project: Project, input: Update): Project {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("Settings update requires confirmation matching project id");
  if (project.deleted || project.archived) throw new Error("Inactive project settings cannot be changed");
  if (input.expectedRevision !== projectSettings(project).revision) throw new Error("Settings revision conflict; reread before updating");
  const patch = input.changes;
  const { skillProfiles, mcp, worktreeSetup, contextSettings, scopedModels, ...rest } = project;
  const scope = patch.scopedModels === undefined ? scopedModels : patch.scopedModels ?? undefined;
  const models = { ...project.models };
  for (const role of ["worker", "scout", "reviewer"] as const) {
    const choice = patch.models?.[role];
    if (choice === null) delete models[role]; else if (choice !== undefined) models[role] = choice;
  }
  const context = patch.context === undefined ? contextSettings : patch.context ?? undefined;
  if (context?.contextWindow !== undefined && (context.keepRecentTokens ?? 20_000) * 2 > context.contextWindow) throw new Error("Keep-recent tokens must be at most half the context window");
  const skills = patch.skills === undefined ? skillProfiles : patch.skills ?? undefined;
  const mcpSettings = patch.mcp === undefined ? mcp : patch.mcp ?? undefined;
  const setup = (patch.worktreeSetup ?? worktreeSetup ?? "").trim();
  return { ...rest, ...(skills ? { skillProfiles: structuredClone(skills) } : {}), ...(mcpSettings ? { mcp: structuredClone(mcpSettings) } : {}), ...(setup ? { worktreeSetup: setup } : {}), ...(context ? { contextSettings: structuredClone(context) } : {}), name: patch.name ?? project.name, objective: patch.objective ?? project.objective, model: patch.model ?? project.model,
    models, ...(scope ? { scopedModels: [...scope] } : {}),
    knowledgeAccess: patch.knowledgeAccess ?? project.knowledgeAccess, libraryAccess: patch.libraryAccess ?? project.libraryAccess, decisionAccess: patch.decisionAccess ?? project.decisionAccess, workerCap: patch.workerCap ?? project.workerCap };
}
