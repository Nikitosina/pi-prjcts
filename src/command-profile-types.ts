import { Type, type Static } from "typebox";

const Id = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" });
const Decimal = Type.String({ pattern: "^[0-9]+$", maxLength: 32 });
export const CommandProfileInput = Type.Object({
  id: Id, label: Type.String({ minLength: 1, maxLength: 128 }),
  repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
  scopeIds: Type.Array(Id, { minItems: 1, maxItems: 64, uniqueItems: true }),
  executable: Type.String({ minLength: 1, maxLength: 4096 }),
  arguments: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
  effect: Type.Union([Type.Literal("workspace"), Type.Literal("destructive"), Type.Literal("deployment")]),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 300000 }),
  maxOutputBytes: Type.Integer({ minimum: 1024, maximum: 65536 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false });
export type CommandProfileInput = Static<typeof CommandProfileInput>;
export const CommandProgram = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }), dev: Decimal, ino: Decimal, size: Decimal,
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false });
export type CommandProgram = Static<typeof CommandProgram>;
export const CommandProfile = Type.Object({
  ...CommandProfileInput.properties, program: CommandProgram,
  provider: Type.String({ minLength: 1, maxLength: 64 }),
  owner: Type.String({ minLength: 1, maxLength: 512 }),
  workspaceRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }), grantedAt: Type.String(),
}, { additionalProperties: false });
export type CommandProfile = Static<typeof CommandProfile>;
