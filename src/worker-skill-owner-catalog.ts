import { createHash } from "node:crypto";
import type { Project } from "./state.ts";
import { parse } from "./state.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";
import { discoverRepositorySkills } from "./worker-skill-discovery.ts";
import { captureConfiguredSkillCatalog } from "./worker-skill-configured.ts";
import { SKILL_CATALOG_LIMITS, WorkerSkillCatalog } from "./worker-skill-types.ts";

type ConfiguredSource = Parameters<typeof captureConfiguredSkillCatalog>[0]["source"];
type ProtectedFiles = Parameters<typeof discoverRepositorySkills>[0]["protectedFiles"];

export async function captureOwnerWorkerSkillCatalog(input: { project: () => Project; configured: ConfiguredSource; protectedFiles: ProtectedFiles }): Promise<WorkerSkillCatalog> {
  const project = structuredClone(input.project());
  const workspaceRevision = authorizationFingerprint(project);
  const candidates: WorkerSkillCatalog["candidates"] = [];
  const diagnostics: WorkerSkillCatalog["diagnostics"] = [];
  const blockers: WorkerSkillCatalog["blockers"] = [];
  let bytes = 0;
  function enforceLimits() {
    if (candidates.length > SKILL_CATALOG_LIMITS.candidates || diagnostics.length > SKILL_CATALOG_LIMITS.diagnostics || bytes > SKILL_CATALOG_LIMITS.bytes) throw new Error("Owner skill catalog exceeds combined capture limits");
    if (new Set(candidates.map(item => item.catalogId)).size !== candidates.length) throw new Error("Owner skill catalog contains ambiguous candidate identities");
  }
  const authorization = project.workspaceAuthorization;
  if (!authorization || authorization.owner !== trustedOwner()) {
    blockers.push("owned-workspace-unavailable");
  } else {
    if (new Set(authorization.repositories.map(repository => repository.repositoryId)).size !== authorization.repositories.length) throw new Error("Owner skill catalog repository authorization is ambiguous");
    for (const repository of authorization.repositories) {
      if (repository.provider !== authorization.provider) throw new Error("Owner skill catalog provider does not match repository authorization");
      const found = await discoverRepositorySkills({ repositoryId: repository.repositoryId, ownerCheckout: repository.ownerCheckout, protectedFiles: input.protectedFiles });
      candidates.push(...found.candidates);
      bytes += found.candidates.reduce((total, candidate) => total + candidate.main.size, 0);
      for (const diagnostic of found.diagnostics) diagnostics.push({ kind: "repository", repositoryId: repository.repositoryId, ...diagnostic });
      enforceLimits();
    }
    switch (input.configured.kind) {
      case "unavailable": blockers.push("loaded-configured-catalog-unavailable"); break;
      case "loaded": {
        const found = await captureConfiguredSkillCatalog({ source: input.configured, protectedFiles: input.protectedFiles });
        candidates.push(...found.candidates);
        bytes += found.candidates.reduce((total, candidate) => total + candidate.main.size, 0);
        for (const diagnostic of found.diagnostics) diagnostics.push({ kind: "configured", ...diagnostic });
        enforceLimits();
        break;
      }
      default: { const unexpected: never = input.configured; throw new Error(`Unknown configured skill source: ${unexpected}`); }
    }
  }
  const current = input.project();
  if (current.id !== project.id || authorizationFingerprint(current) !== workspaceRevision) throw new Error("Workspace authorization changed during skill catalog capture");
  candidates.sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  diagnostics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const value = { projectId: project.id, workspaceRevision, candidates, diagnostics, blockers };
  const revision = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return parse(WorkerSkillCatalog, structuredClone({ ...value, revision }));
}
