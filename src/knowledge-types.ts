import { Type, type Static } from "typebox";

export const KnowledgePath = Type.String({ minLength: 1, maxLength: 240, pattern: "^(?:MEMORY\\.md|preferences\\.md|(?:architecture|research|decisions|runbooks|plans)/(?:legacy/)?[A-Za-z0-9][A-Za-z0-9._-]{0,119}\\.md)$" });
export const KnowledgeMetadata = Type.Object({
  path: KnowledgePath,
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  updatedAt: Type.String(),
  author: Type.String({ minLength: 1, maxLength: 200 }),
  size: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type KnowledgeMetadata = Static<typeof KnowledgeMetadata>;

export const KnowledgeDocument = Type.Object({
  ...KnowledgeMetadata.properties,
  text: Type.String(),
}, { additionalProperties: false });
export type KnowledgeDocument = Static<typeof KnowledgeDocument>;

export const KnowledgeWrite = Type.Object({
  dir: Type.String({ minLength: 1 }),
  path: KnowledgePath,
  text: Type.String({ maxLength: 32000 }),
  expectedRevision: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  author: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type KnowledgeWrite = Static<typeof KnowledgeWrite>;

export const KnowledgeRevision = Type.Object({
  ...KnowledgeMetadata.properties,
  id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
  priorRevision: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  text: Type.String(),
  priorText: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type KnowledgeRevision = Static<typeof KnowledgeRevision>;
