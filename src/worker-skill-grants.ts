import { createHash } from "node:crypto";
import type { Project } from "./state.ts";
import { parse } from "./state.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";
import { captureWorkerSkillDocument, readWorkerSkillDocument } from "./worker-skill-files.ts";
import { WorkerSkillGrant, type WorkerSkillCandidate, type WorkerSkillGrantInput, type FrozenWorkerSkill } from "./worker-skill-types.ts";

type ProtectedFiles = Parameters<typeof captureWorkerSkillDocument>[0]["protectedFiles"];
type Access = { kind: "missing" } | { kind: "granted"; project: Project; grant: WorkerSkillGrant };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function workerSkillGrantRevision(grant: Omit<WorkerSkillGrant, "revision" | "grantedAt">): string {
  return digest(JSON.stringify({ id: grant.id, scopeIds: grant.scopeIds, skills: grant.skills, enabled: grant.enabled, owner: grant.owner, workspaceRevision: grant.workspaceRevision }));
}

function scopesFor(project: Project, scopeIds: readonly string[]) {
  const authorization = project.workspaceAuthorization;
  if (!authorization || authorization.owner !== trustedOwner()) throw new Error("Skill access requires current owned workspace authorization");
  return scopeIds.map(id => {
    const scope = authorization.scopes.find(item => item.id === id);
    if (!scope || !authorization.repositories.some(repository => repository.repositoryId === scope.repositoryId && repository.provider === authorization.provider)) throw new Error("Skill grant references an unknown or mismatched workspace scope");
    return scope;
  });
}

function checkRepository(skill: Pick<FrozenWorkerSkill, "origin">, scopes: ReturnType<typeof scopesFor>) {
  if (skill.origin.kind === "repository") {
    const repositoryId = skill.origin.repositoryId;
    if (scopes.some(scope => scope.repositoryId !== repositoryId)) throw new Error("Repository skill cannot be exposed to unrelated repository scopes");
  }
}

export async function prepareWorkerSkillGrant(input: { project: Project; selection: WorkerSkillGrantInput; catalog: readonly WorkerSkillCandidate[]; protectedFiles: ProtectedFiles }): Promise<WorkerSkillGrant> {
  if (input.project.archived || input.project.deleted) throw new Error("Inactive project cannot prepare worker skill access");
  const scopes = scopesFor(input.project, input.selection.scopeIds);
  if (new Set(input.selection.skills.map(skill => skill.catalogId)).size !== input.selection.skills.length) throw new Error("Skill grant contains duplicate selections");
  const candidates = new Map<string, WorkerSkillCandidate>();
  for (const candidate of structuredClone(input.catalog)) {
    if (candidates.has(candidate.catalogId)) throw new Error("Skill catalog contains ambiguous candidate identities");
    candidates.set(candidate.catalogId, candidate);
  }
  const skills: FrozenWorkerSkill[] = [];
  let bytes = 0;
  for (const selection of input.selection.skills) {
    const candidate = candidates.get(selection.catalogId);
    if (!candidate) throw new Error("Skill selection is unavailable in its captured catalog");
    checkRepository(candidate, scopes);
    await readWorkerSkillDocument({ root: candidate.origin.root, document: candidate.main, protectedFiles: input.protectedFiles });
    bytes += candidate.main.size;
    if (bytes > 1024 * 1024) throw new Error("Skill grant exceeds its captured-document budget");
    const references: FrozenWorkerSkill["references"] = [];
    for (const path of selection.references) {
      if (path === candidate.main.relativePath) throw new Error("Skill main document is already selected");
      const document = await captureWorkerSkillDocument({ root: candidate.origin.root, relativePath: path, protectedFiles: input.protectedFiles });
      bytes += document.size;
      if (bytes > 1024 * 1024) throw new Error("Skill grant exceeds its captured-document budget");
      references.push(document);
    }
    skills.push({ ...candidate, references });
  }
  for (const skill of skills) {
    for (const document of [skill.main, ...skill.references]) await readWorkerSkillDocument({ root: skill.origin.root, document, protectedFiles: input.protectedFiles });
  }
  const value = { ...input.selection, scopeIds: [...input.selection.scopeIds], skills, owner: trustedOwner(), workspaceRevision: authorizationFingerprint(input.project) };
  return parse(WorkerSkillGrant, structuredClone({ ...value, revision: workerSkillGrantRevision(value), grantedAt: new Date().toISOString() }));
}

function grantedAccess(input: { access: Access; scopeId: string; skillId: string; documentId: string; expectedGrantId: string; expectedGrantRevision: string }) {
  if (input.access.kind === "missing") throw new Error("Worker skill access is unavailable");
  const { project, grant } = input.access;
  if (project.archived || project.deleted || !grant.enabled || grant.id !== input.expectedGrantId || grant.revision !== input.expectedGrantRevision || grant.owner !== trustedOwner() || grant.revision !== workerSkillGrantRevision(grant) || grant.workspaceRevision !== authorizationFingerprint(project) || !grant.scopeIds.includes(input.scopeId)) throw new Error("Worker skill grant is disabled, inactive or no longer authorized");
  const scopes = scopesFor(project, [input.scopeId]);
  const skill = grant.skills.find(item => item.catalogId === input.skillId);
  if (!skill) throw new Error("Skill was not selected in this worker grant");
  checkRepository(skill, scopes);
  const document = [skill.main, ...skill.references].find(item => item.id === input.documentId);
  if (!document) throw new Error("Skill document was not explicitly selected");
  return { projectId: project.id, grant, skill, document };
}

export async function readGrantedWorkerSkill(input: { access: () => Access; scopeId: string; skillId: string; documentId: string; expectedGrantId: string; expectedGrantRevision: string; textOffset: number; textLimit: number; protectedFiles: ProtectedFiles }) {
  if (!Number.isSafeInteger(input.textOffset) || input.textOffset < 0 || input.textOffset > 1000000 || !Number.isSafeInteger(input.textLimit) || input.textLimit < 1 || input.textLimit > 4000) throw new Error("Invalid skill Unicode range");
  const before = grantedAccess({ ...input, access: input.access() });
  const text = await readWorkerSkillDocument({ root: before.skill.origin.root, document: before.document, protectedFiles: input.protectedFiles });
  const after = grantedAccess({ ...input, access: input.access() });
  if (after.projectId !== before.projectId || after.grant.revision !== before.grant.revision || JSON.stringify(after.document) !== JSON.stringify(before.document)) throw new Error("Worker skill authorization changed during reading");
  const points = Array.from(text), offset = Math.min(input.textOffset, points.length), end = Math.min(offset + input.textLimit, points.length);
  return { grantId: before.grant.id, grantRevision: before.grant.revision, skillId: before.skill.catalogId, documentId: before.document.id, relativePath: before.document.relativePath, sha256: before.document.sha256, bytes: before.document.size, text: points.slice(offset, end).join(""), range: { offset, end, total: points.length, nextOffset: end < points.length ? end : null } };
}
