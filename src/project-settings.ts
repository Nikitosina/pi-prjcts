import { createHash } from "node:crypto";
import type { Project, Request } from "./state.ts";

type Update = Extract<Request, { action: "settings-update" }>;
export function projectSettings(project: Project) {
  const values = { name: project.name, objective: project.objective, model: project.model, models: { ...project.models }, knowledgeAccess: project.knowledgeAccess ?? "read-only", libraryAccess: project.libraryAccess ?? "none", decisionAccess: project.decisionAccess ?? "none", workerCap: project.workerCap ?? 1 };
  return { values, revision: createHash("sha256").update(JSON.stringify(values)).digest("hex") };
}
export function updateProjectSettings(project: Project, input: Update): Project {
  if (input.id !== project.id || input.confirm !== project.id) throw new Error("Settings update requires confirmation matching project id");
  if (project.deleted || project.archived) throw new Error("Inactive project settings cannot be changed");
  if (project.runtime !== "durable") throw new Error("Legacy project settings require an explicit Durable migration");
  if (input.expectedRevision !== projectSettings(project).revision) throw new Error("Settings revision conflict; reread before updating");
  const patch = input.changes;
  return { ...project, name: patch.name ?? project.name, objective: patch.objective ?? project.objective, model: patch.model ?? project.model,
    models: { worker: patch.models?.worker ?? project.models.worker, scout: patch.models?.scout ?? project.models.scout, reviewer: patch.models?.reviewer ?? project.models.reviewer },
    knowledgeAccess: patch.knowledgeAccess ?? project.knowledgeAccess, libraryAccess: patch.libraryAccess ?? project.libraryAccess, decisionAccess: patch.decisionAccess ?? project.decisionAccess, workerCap: patch.workerCap ?? project.workerCap };
}
