import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CommandProfile, CommandProfileInput } from "./command-profile-types.ts";
import { WorkerSkillGrant } from "./worker-skill-types.ts";

const text = Type.String({ minLength: 1, maxLength: 32000 });
const knowledgePath = Type.String({ minLength: 1, maxLength: 1024 });
const revision = Type.String({ minLength: 1, maxLength: 128 });
export const Role = Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")]);
export type Role = Static<typeof Role>;
export const Id = Type.String({ pattern: "^[a-f0-9-]{36}$" });
export const WorkspaceRepositoryAuthorization = Type.Object({ repositoryId: Type.String({ minLength: 1, maxLength: 256 }), provider: Type.Union([Type.Literal("github"), Type.Literal("arc")]), ownerCheckout: Type.String({ minLength: 1, maxLength: 4096 }), approvedRoot: Type.String({ minLength: 1, maxLength: 4096 }), fileOwnershipPrefix: Type.String({ minLength: 1, maxLength: 1024 }), sharedObjectStore: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()])) }, { additionalProperties: false });
export const WorkspaceScopeAuthorization = Type.Object({ id: Id, repositoryId: Type.String({ minLength: 1, maxLength: 256 }), files: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 1024, uniqueItems: true }), baseRevision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }), evidenceCapture: Type.Optional(Type.Literal(true)), wholeRepository: Type.Optional(Type.Literal(true)) }, { additionalProperties: false });
export const WorkspaceAuthorization = Type.Object({ version: Type.Literal(1), provider: Type.Union([Type.Literal("github"), Type.Literal("arc")]), owner: Type.String({ minLength: 1, maxLength: 512 }), repositories: Type.Array(WorkspaceRepositoryAuthorization, { minItems: 1, maxItems: 64 }), scopes: Type.Array(WorkspaceScopeAuthorization, { minItems: 1, maxItems: 1024 }) }, { additionalProperties: false });
export type WorkspaceAuthorization = Static<typeof WorkspaceAuthorization>;
export const WorkspaceAuthorizationHistory = Type.Array(Type.Object({ revokedAt: Type.String(), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), repositorySha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), scopeId: Id, scopeSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), baseRevision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }) }, { additionalProperties: false }), { maxItems: 2048 });
export const OperationSpec = Type.Union([Type.Object({
  provider: Type.Union([Type.Literal("github"), Type.Literal("arc")]),
  kind: Type.Union([Type.Literal("merge"), Type.Literal("auto-merge")]),
  repositoryId: Type.String({ minLength: 1, maxLength: 256 }), scopeId: Id,
  pullRequest: Type.Integer({ minimum: 1 }), expectedHead: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
}, { additionalProperties: false }), Type.Object({
  provider: Type.Union([Type.Literal("github"), Type.Literal("arc")]), kind: Type.Literal("command"),
  repositoryId: Type.String({ minLength: 1, maxLength: 256 }), scopeId: Id, threadId: Id,
  profileId: Id, profileRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  effect: Type.Union([Type.Literal("destructive"), Type.Literal("deployment")]),
  receiptId: Id, allocationAttemptId: Id, requestId: Id,
}, { additionalProperties: false })]);
export type OperationSpec = Static<typeof OperationSpec>;
export const GithubAuthorization = Type.Object({
  repositoryId: Type.String({ minLength: 1, maxLength: 256 }), numericId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  branchPrefix: Type.String({ minLength: 1, maxLength: 128 }), baseBranch: Type.String({ minLength: 1, maxLength: 1024 }),
  owner: Type.String({ minLength: 1, maxLength: 512 }), workspaceRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), at: Type.String(),
  readInspection: Type.Optional(Type.Literal(true)),
  reviewReplies: Type.Optional(Type.Literal(true)),
  localPublication: Type.Optional(Type.Literal(true)),
  oneClick: Type.Optional(Type.Literal(true)),
}, { additionalProperties: false });
export type GithubAuthorization = Static<typeof GithubAuthorization>;
export const GithubAuthorizationHistory = Type.Array(Type.Object({ revokedAt: Type.String(), authorization: GithubAuthorization }, { additionalProperties: false }), { maxItems: 64 });
export const Project = Type.Object({
  version: Type.Literal(1), id: Id, name: text, cwd: text, objective: Type.String({ maxLength: 32000 }),
  runtime: Type.Optional(Type.Literal("durable")),
  creation: Type.Optional(Type.Object({ requestId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false })),
  archived: Type.Optional(Type.Boolean()),
  deleted: Type.Optional(Type.Boolean()),
  knowledgeAccess: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("maintain")])),
  libraryAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])),
  decisionAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])),
  /** Optional host-only workspace grant. Legacy projects without it receive no workspace scope. */
  workspaceAuthorization: Type.Optional(WorkspaceAuthorization),
  workspaceAuthorizationHistory: Type.Optional(WorkspaceAuthorizationHistory),
  githubAuthorization: Type.Optional(Type.Array(GithubAuthorization, { maxItems: 64 })),
  githubAuthorizationHistory: Type.Optional(GithubAuthorizationHistory),
  workerCap: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  commandProfiles: Type.Optional(Type.Array(CommandProfile, { maxItems: 32 })),
  /** Explicit owner-issued worker skill grants; absent on legacy projects means no access. */
  workerSkillGrants: Type.Optional(Type.Array(WorkerSkillGrant, { maxItems: 128 })), 
  createdAt: text, model: text,
  models: Type.Object({ worker: text, scout: text, reviewer: text }),
  sessionFile: Type.Union([text, Type.Null()]),
  phase: Type.Union([Type.Literal("ready"), Type.Literal("busy"), Type.Literal("attention")]),
  problem: Type.Union([Type.String(), Type.Null()]),
  runs: Type.Array(Type.Object({ id: Id, role: Role, dir: text, task: text, createdAt: text, receipt: Type.Union([text, Type.Null()]) })),
}, { additionalProperties: false });
export type Project = Static<typeof Project>;
export const Note = Type.Object({ id: Id, at: text, author: text, text }, { additionalProperties: false });
export type Note = Static<typeof Note>;
export const Job = Type.Object({
  id: Id, text, at: text,
  state: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("interrupted")]),
  error: Type.Union([Type.String(), Type.Null()]),
  /** Coordinator chat the message went to; absent on older jobs and for Main. */
  chatId: Type.Optional(Id),
}, { additionalProperties: false });
export type Job = Static<typeof Job>;
export const ChatId = Type.Union([Type.Literal("main"), Id]);
const answer = Type.Union([
  Type.Object({ at: text, text, job: Id }, { additionalProperties: false }),
  Type.Object({ at: text, text, delivery: Type.Literal("manual") }, { additionalProperties: false }),
]);
export const InboxEntry = Type.Union([
  Type.Object({ kind: Type.Literal("question"), id: Id, at: text, title: text, question: text, choices: Type.Array(text, { maxItems: 4 }), native: Type.Optional(Type.Object({ projectId: Id, conversationId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), taskId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), callId: text }, { additionalProperties: false })), result: Type.Union([Type.Null(), answer]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("review"), id: Id, at: text, title: text, run: Id, outcome: text, result: Type.Union([
    Type.Null(),
    Type.Object({ action: Type.Literal("accept"), at: text, text: Type.String({ maxLength: 32000 }) }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("revise"), at: text, text, job: Id }, { additionalProperties: false }),
    Type.Object({ action: Type.Literal("revise"), at: text, text, delivery: Type.Literal("manual") }, { additionalProperties: false }),
  ]) }, { additionalProperties: false }),
]);
export type InboxEntry = Static<typeof InboxEntry>;
const evidenceNativeIdentity = { projectId: Id, scopeId: Id, workId: Id, conversationId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), taskId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), callId: text };
const evidenceNative = Type.Union([
  Type.Object({ ...evidenceNativeIdentity, sourcePath: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false }),
  Type.Object({ ...evidenceNativeIdentity, sourceKind: Type.Literal("command-output"), commandKey: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
]);
export const Evidence = Type.Object({ id: Id, at: text, title: text, filename: text, size: Type.Number(), sha256: text, sessionFile: Type.Union([text, Type.Null()]), native: Type.Optional(evidenceNative) }, { additionalProperties: false });
export type Evidence = Static<typeof Evidence>;
export const WebInfo = Type.Object({ url: text });
const DurableGenerationOutcome = Type.Union([
  Type.Object({
    status: Type.Literal("completed"), successful: Type.Literal(true),
    result: Type.Object({ entryId: Type.Integer() }, { additionalProperties: false }), diagnostic: Type.Null(),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("failed"), successful: Type.Literal(false), result: Type.Null(),
    diagnostic: Type.Object({
      hint: Type.Union([Type.Literal("authentication"), Type.Literal("rate-limit"), Type.Literal("tool-context"), Type.Literal("timeout"), Type.Literal("other")]),
      fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Union([Type.Literal("aborted"), Type.Literal("orphaned"), Type.Literal("faulted")]),
    successful: Type.Literal(false), result: Type.Null(), diagnostic: Type.Null(),
  }, { additionalProperties: false }),
]);
const DurableGenerationTask = Type.Object({
  taskId: Type.Integer(), kind: Type.Literal("pi.generation"), conversationId: Type.Integer(),
  phase: Type.Union([Type.Literal("prepare"), Type.Literal("request"), Type.Literal("retry"), Type.Literal("poll"), Type.Literal("tools"), Type.Null()]),
  state: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("waiting"), Type.Literal("completing"), Type.Literal("terminal")]),
  terminal: Type.Boolean(), outcome: Type.Union([DurableGenerationOutcome, Type.Null()]),
}, { additionalProperties: false });
const DurableConversationInspection = Type.Object({
  conversationId: Type.Integer(),
  messages: Type.Array(Type.Object({ id: Type.Integer(), role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), at: Type.Number(), text: Type.String() }, { additionalProperties: false })),
  submissions: Type.Array(Type.Object({ id: Type.Integer(), requestId: Type.Union([Type.String(), Type.Null()]), status: Type.Union([Type.Literal("queued"), Type.Literal("placed"), Type.Literal("done"), Type.Literal("unanswered")]), answerId: Type.Union([Type.Integer(), Type.Null()]), reason: Type.Union([Type.String(), Type.Null()]), detail: Type.Optional(Type.Union([Type.String(), Type.Null()])), text: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false })),
  generationTasks: Type.Array(DurableGenerationTask),
}, { additionalProperties: false });
export const DurableInspection = Type.Object({
  identity: Type.Object({ projectId: Id, coordinatorConversationId: Type.Integer() }, { additionalProperties: false }),
  coordinator: DurableConversationInspection,
  workers: Type.Optional(Type.Array(Type.Object({ threadId: Id, conversation: DurableConversationInspection }, { additionalProperties: false }))),
}, { additionalProperties: false });
export type DurableInspection = Static<typeof DurableInspection>;
export const Snapshot = Type.Object({
  project: Project, busy: Type.Boolean(), paused: Type.Optional(Type.Boolean()), jobs: Type.Array(Job),
  messages: Type.Array(Type.Object({ role: Type.String(), at: Type.Number(), text: Type.String(), thinking: Type.Optional(Type.String({ maxLength: 300 })), kind: Type.Optional(Type.Literal("tool")), name: Type.Optional(Type.String()), argsPreview: Type.Optional(Type.String({ maxLength: 500 })), status: Type.Optional(Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("pending")])), resultPreview: Type.Optional(Type.String({ maxLength: 500 })) })), 
  activeRuns: Project.properties.runs,
  inbox: Type.Array(InboxEntry), notes: Type.Array(Note), evidence: Type.Array(Evidence),
  runStates: Type.Array(Type.Object({ id: Id, state: text, summary: Type.String(), sessionFile: Type.Union([text, Type.Null()]) })),
  durableInspection: Type.Optional(DurableInspection),
  context: Type.Optional(Type.Object({ tokens: Type.Integer({ minimum: 0 }), window: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) }, { additionalProperties: false })),
  chatId: Type.Optional(ChatId),
  chats: Type.Optional(Type.Array(Type.Object({ id: ChatId, title: Type.String(), conversationId: Type.Integer(), createdAt: Type.Number(), archived: Type.Boolean(), busy: Type.Boolean() }, { additionalProperties: false }))),
});
export type Snapshot = Static<typeof Snapshot>;
export const Delegation = Type.Object({ runId: Id, role: Role, dir: text });
export const Request = Type.Union([
  Type.Object({ action: Type.Literal("command-intent-inspect"), id: Id, confirm: Id, key: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("command-intents-snapshot"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("coordinator-skills"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("worker-skills-catalog"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("worker-skills-grants"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("worker-skills-grant-read"), id: Id, grantId: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("worker-skills-grant-set"), id: Id, confirm: Id, expectedCatalogRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), expectedGrantsRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), selection: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("worker-skills-grant-revoke"), id: Id, confirm: Id, grantId: Id, expectedGrantsRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("command-profiles-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("command-profile-read"), id: Id, profileId: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("command-profile-set"), id: Id, confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), profile: CommandProfileInput }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("web") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("answer"), id: Id, entry: Id, text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("review"), id: Id, entry: Id, operation: Type.Union([Type.Literal("accept"), Type.Literal("revise")]), text: Type.Optional(text) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("create"), requestId: Type.Optional(Id), name: text, cwd: text, objective: Type.Optional(Type.String({ maxLength: 32000 })), model: Type.Optional(text), knowledgeAccess: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("maintain")])) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("models-snapshot"), provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("usage-snapshot"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("event-log"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("host-health"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("library-import"), id: Id, confirm: Id, importId: Id, filename: Type.String({ minLength: 1, maxLength: 240 }), title: Type.String({ minLength: 1, maxLength: 1000 }), encoding: Type.Literal("base64"), data: Type.String({ maxLength: 43692 }), expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("library-list"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("library-read"), id: Id, evidenceId: Id, expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10485760 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 131072 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("settings-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("settings-update"), id: Id, confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), changes: Type.Object({
    name: Type.Optional(text), objective: Type.Optional(Type.String({ maxLength: 32000 })), model: Type.Optional(text),
    models: Type.Optional(Type.Object({ worker: Type.Optional(text), scout: Type.Optional(text), reviewer: Type.Optional(text) }, { additionalProperties: false })),
    knowledgeAccess: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("maintain")])), libraryAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])), decisionAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])), workerCap: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 }))
  }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("show"), id: Id, chatId: Type.Optional(ChatId) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("chat-create"), id: Id, title: Type.Optional(Type.String({ maxLength: 120 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("chat-update"), id: Id, chatId: ChatId, title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), archived: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("pause"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("plan-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("resume"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("resume"), id: Id, recovery: Type.Literal("leave-interrupted"), confirm: Type.Optional(Id) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("archive"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("restore"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("delete"), id: Id, confirm: Type.Optional(Id) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("owner-setup-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("github-repository-inspect"), id: Id, repositoryId: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("github-authorize"), id: Id, repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), branchPrefix: Type.String({ minLength: 1, maxLength: 128 }), confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), reviewReplies: Type.Optional(Type.Boolean()), localPublication: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("github-revoke"), id: Id, repositoryId: Type.String({ minLength: 1, maxLength: 256 }), confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("provider-pr-inspect"), id: Id, provider: Type.Union([Type.Literal("github"), Type.Literal("arc")]), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), expectedHead: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("provider-conflict-inspect"), id: Id, provider: Type.Literal("github"), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), expectedBase: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("provider-ci-job-inspect"), id: Id, provider: Type.Literal("github"), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), jobId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("provider-ci-detail"), id: Id, provider: Type.Literal("github"), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }), checkRunId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("provider-review-inspect"), id: Id, provider: Type.Union([Type.Literal("github"), Type.Literal("arc")]), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), expectedHead: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" })), page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("provider-ci-inspect"), id: Id, provider: Type.Union([Type.Literal("github"), Type.Literal("arc")]), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), expectedHead: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" })), page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("operation-request"), id: Id, requestId: Id, operation: OperationSpec }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("github-read-snapshot"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("github-write-inspect"), id: Id, key: Type.String({ pattern: "^[a-f0-9]{64}$" }), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("github-write-snapshot"), id: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("operation-execute"), id: Id, operationId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), confirm: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("operation-inspect"), id: Id, operationId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), confirm: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("operation-snapshot"), id: Id, status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected")])), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("operation-decide"), id: Id, operationId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), decision: Type.Literal("approve"), confirm: Id, execution: Type.Optional(Type.Literal(true)) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("operation-decide"), id: Id, operationId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }), decision: Type.Literal("reject") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("workspace-catalog"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("github-quick-authorize"), id: Id, confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("workspace-quick-grant"), id: Id, confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("workspace-grant"), id: Id, confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), provider: Type.Literal("github"), ownerCheckout: text, approvedRoot: text, fileOwnershipPrefix: Type.String({ minLength: 1, maxLength: 1024 }), files: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 1024, uniqueItems: true }), baseRevision: Type.String({ pattern: "^[0-9a-f]{40}$" }), evidenceCapture: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("workspace-revoke"), id: Id, confirm: Id, scopeId: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("thread-steer"), id: Id, threadId: Id, requestId: Id, text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("thread-stop"), id: Id, threadId: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("work-archive"), id: Id, workIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 64 })), terminal: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("legacy-thread-history"), id: Id, name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), textOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("thread-history"), id: Id, threadId: Id, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), textOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("thread-send"), id: Id, threadId: Id, requestId: Id, text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("message"), id: Id, text, chatId: Type.Optional(ChatId) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("schedule-create"), id: Id, scheduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), atMs: Type.Integer({ minimum: 0 }), everyMs: Type.Optional(Type.Integer({ minimum: 60000, maximum: 31536000000 })), calendar: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal("daily"), timezone: Type.String({ minLength: 1, maxLength: 256 }), time: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("weekly"), timezone: Type.String({ minLength: 1, maxLength: 256 }), time: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }), days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, uniqueItems: true }) }, { additionalProperties: false })
  ])), text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("schedule-enable"), id: Id, scheduleId: Type.String({ minLength: 1, maxLength: 256 }), enabled: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("schedule-snapshot"), id: Id, includeHistory: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("schedule-history"), id: Id, kind: Type.Union([Type.Literal("events"), Type.Literal("intents")]), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), textOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("monitor-create"), id: Id, monitorId: Type.Optional(Id), repositoryId: Type.String({ minLength: 1, maxLength: 256 }), expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), kind: Type.Union([Type.Literal("pr"), Type.Literal("ci"), Type.Literal("review")]), everyMs: Type.Integer({ minimum: 60000, maximum: 86400000 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("monitor-enable"), id: Id, monitorId: Id, enabled: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("monitor-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("event-opt-in"), id: Id, enabled: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("event-ingest"), id: Id, eventId: Type.String({ minLength: 1, maxLength: 256 }), kind: Type.String({ minLength: 1, maxLength: 128 }), payload: Type.String({ maxLength: 32000 }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("delegate"), id: Id, role: Role, task: text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("work-submit"), id: Id, threadId: Id, requestId: Id, workspaceScopeId: Id, text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("workers"), id: Id, run: Type.Optional(text) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("control"), id: Id, run: text, operation: Type.Union([Type.Literal("steer"), Type.Literal("stop")]), message: Type.Optional(text) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("notes"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("knowledge-list"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("knowledge-read"), id: Id, path: knowledgePath }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("knowledge-write"), id: Id, path: knowledgePath, text: Type.String({ maxLength: 32000 }), expectedRevision: Type.Union([revision, Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("knowledge-history"), id: Id, path: knowledgePath }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("shutdown") }, { additionalProperties: false }),
]);
export type Request = Static<typeof Request>;
export const Reply = Type.Union([
  Type.Object({ ok: Type.Literal(true), data: Type.Unknown() }),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }),
]);
export type Reply = Static<typeof Reply>;

export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) throw new Error(`Invalid data: ${[...Value.Errors(schema, value)].map(e => `${e.instancePath}: ${e.message}`).join("; ").slice(0, 1500)}`);
  return value;
}

export function home(): string {
  return resolve(process.env.PI_PROJECTS_HOME ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "projects"));
}

export function socketPath(): string {
  const hash = createHash("sha256").update(home()).digest("hex").slice(0, 12);
  return join(tmpdir(), `pi-projects-${process.getuid?.() ?? "user"}-${hash}.sock`);
}

export function projectDir(id: string): string {
  return join(home(), parse(Id, id));
}

export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadProject(id: string): Project {
  return parse(Project, readJson(join(projectDir(id), "project.json")));
}

export function saveProject(project: Project): void {
  saveJson(join(projectDir(project.id), "project.json"), parse(Project, project));
}

export function listProjects(): Project[] {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  return readdirSync(home()).filter(id => Value.Check(Id, id)).map(loadProject);
}

export function addNote(dir: string, author: string, text: string): Note {
  const note = parse(Note, { id: randomUUID(), at: new Date().toISOString(), author, text });
  saveJson(join(dir, "notes", `${note.at.replaceAll(":", "-")}-${note.id}.json`), note);
  return note;
}

export function notes(dir: string): Note[] {
  const path = join(dir, "notes");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return readdirSync(path).filter(name => name.endsWith(".json")).sort().map(name => parse(Note, readJson(join(path, name))));
}

export function jobs(id: string): Job[] {
  const dir = join(projectDir(id), "inbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return readdirSync(dir).filter(name => name.endsWith(".json")).map(name => parse(Job, readJson(join(dir, name)))).sort((a, b) => a.at.localeCompare(b.at));
}

export function saveJob(id: string, job: Job): void {
  saveJson(join(projectDir(id), "inbox", `${job.id}.json`), parse(Job, job));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
