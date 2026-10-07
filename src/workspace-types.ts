import { Type, type Static } from "typebox";

const uuid = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$" });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const revision = Type.String({ pattern: "^[0-9a-f]{40,64}$" });
const provider = Type.Union([Type.Literal("git"), Type.Literal("arc")]);

/** Host configuration, never model input. Empty authorization grants nothing. */
export const AuthorizedRepository = Type.Object({
  repositoryId: Type.String({ minLength: 1, maxLength: 256 }), provider, approvedRoot: path, ownerCheckout: path,
  fileOwnershipPrefix: Type.String({ minLength: 1, maxLength: 1024 }),
}, { additionalProperties: false });
export type AuthorizedRepository = Static<typeof AuthorizedRepository>;

/** Frozen by Durable attempt admission before a provider effect. */
export const WorkspaceScope = Type.Object({
  projectId: uuid, repositoryId: Type.String({ minLength: 1, maxLength: 256 }), provider,
  ownerCheckout: path, approvedRoot: path, workspacePath: path, workspaceName: Type.String({ minLength: 1, maxLength: 512 }),
  branch: Type.String({ minLength: 1, maxLength: 256 }), baseRevision: revision, headRevision: revision,
  owner: Type.String({ minLength: 1, maxLength: 512 }), leaseReason: Type.String({ minLength: 1, maxLength: 1024 }),
  sharedObjectStore: Type.Union([path, Type.Null()]),
  fileOwnership: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 1024, uniqueItems: true }),
  capabilityProfileRevision: Type.String({ minLength: 1, maxLength: 256 }),
  /** Whole-repository scopes start from owner HEAD and leave uncommitted owner edits behind. */
  allowDirtyOwner: Type.Optional(Type.Literal(true)),
}, { additionalProperties: false });
export type WorkspaceScope = Static<typeof WorkspaceScope>;

export const WorkspaceIntent = Type.Object({ id: uuid, attemptId: uuid, action: Type.Union([Type.Literal("allocate"), Type.Literal("release")]), scope: WorkspaceScope }, { additionalProperties: false });
export type WorkspaceIntent = Static<typeof WorkspaceIntent>;
export const WorkspaceLease = Type.Object({ name: Type.String({ minLength: 1, maxLength: 512 }), owner: Type.String({ minLength: 1, maxLength: 512 }), renewedAt: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false });
export type WorkspaceLease = Static<typeof WorkspaceLease>;
export const WorkspaceReceipt = Type.Object({
  intentId: uuid, attemptId: uuid,
  state: Type.Union([Type.Literal("prepared"), Type.Literal("allocated"), Type.Literal("uncertain"), Type.Literal("preserved"), Type.Literal("released"), Type.Literal("blocked")]),
  scope: WorkspaceScope, providerFacts: Type.Record(Type.String(), Type.String()), workspacePath: Type.Union([path, Type.Null()]), lease: Type.Union([WorkspaceLease, Type.Null()]), reason: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
}, { additionalProperties: false });
export type WorkspaceReceipt = Static<typeof WorkspaceReceipt>;
export type WorkspaceSnapshot = { receipts: WorkspaceReceipt[] };
