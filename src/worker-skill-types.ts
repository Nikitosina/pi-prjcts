import { Type, type Static } from "typebox";

const uuid = Type.String({ pattern: "^[a-f0-9-]{36}$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const decimal = Type.String({ pattern: "^[0-9]+$", maxLength: 32 });
const timestamp = Type.String({ pattern: "^-?[0-9]+$", maxLength: 33 });
const relativeDocument = Type.String({ minLength: 1, maxLength: 240, pattern: "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))[^\\x00-\\x1f\\x7f]+$" });

export const WorkerSkillSelection = Type.Object({
  catalogId: digest,
  references: Type.Array(relativeDocument, { maxItems: 31, uniqueItems: true }),
}, { additionalProperties: false });
export type WorkerSkillSelection = Static<typeof WorkerSkillSelection>;

export const WorkerSkillGrantInput = Type.Object({
  id: uuid,
  scopeIds: Type.Array(uuid, { minItems: 1, maxItems: 1024, uniqueItems: true }),
  skills: Type.Array(WorkerSkillSelection, { minItems: 1, maxItems: 16 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false });
export type WorkerSkillGrantInput = Static<typeof WorkerSkillGrantInput>;

export const WorkerSkillDocument = Type.Object({
  id: digest,
  relativePath: relativeDocument,
  sha256: digest,
  size: Type.Integer({ minimum: 0, maximum: 65536 }),
  physical: Type.Object({ dev: decimal, ino: decimal, size: decimal, mtimeNs: timestamp, ctimeNs: timestamp }, { additionalProperties: false }),
}, { additionalProperties: false });
export type WorkerSkillDocument = Static<typeof WorkerSkillDocument>;

export const WorkerSkillOrigin = Type.Union([
  Type.Object({ kind: Type.Literal("repository"), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), root: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("configured"), source: Type.String({ minLength: 1, maxLength: 512 }), root: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
]);

export const FrozenWorkerSkill = Type.Object({
  catalogId: digest,
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  disableModelInvocation: Type.Boolean(),
  origin: WorkerSkillOrigin,
  main: WorkerSkillDocument,
  references: Type.Array(WorkerSkillDocument, { maxItems: 31 }),
}, { additionalProperties: false });
export type FrozenWorkerSkill = Static<typeof FrozenWorkerSkill>;
export const WorkerSkillCandidate = Type.Omit(FrozenWorkerSkill, ["references"]);
export type WorkerSkillCandidate = Static<typeof WorkerSkillCandidate>;

export const WorkerSkillCatalog = Type.Object({
  projectId: uuid,
  workspaceRevision: digest,
  revision: digest,
  candidates: Type.Array(WorkerSkillCandidate, { maxItems: 64 }),
  diagnostics: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal("repository"), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), path: relativeDocument, fingerprint: digest }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("configured"), source: Type.Union([Type.Literal("sdk"), Type.Literal("capture")]), fingerprint: digest }, { additionalProperties: false }),
  ]), { maxItems: 256 }),
  blockers: Type.Array(Type.Union([Type.Literal("owned-workspace-unavailable"), Type.Literal("loaded-configured-catalog-unavailable")]), { maxItems: 2, uniqueItems: true }),
}, { additionalProperties: false });
export type WorkerSkillCatalog = Static<typeof WorkerSkillCatalog>;

export const WorkerSkillGrant = Type.Object({
  ...WorkerSkillGrantInput.properties,
  skills: Type.Array(FrozenWorkerSkill, { minItems: 1, maxItems: 16 }),
  owner: Type.String({ minLength: 1, maxLength: 512 }),
  workspaceRevision: digest,
  revision: digest,
  grantedAt: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
export type WorkerSkillGrant = Static<typeof WorkerSkillGrant>;
