import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CommandProfile, CommandProfileInput } from "./command-profile-types.ts";
import { SkillProfiles } from "./skill-profiles.ts";
import { McpSettings } from "./mcp-profiles.ts";
import { ProfileIdSchema, ProfileSettings, Profiles, Tier } from "./profiles.ts";
import { UiPatch } from "./ui-settings.ts";
import { ThreadReference } from "./transcript-reader.ts";
export const PROMPT_ROLES = ["coordinator", "worker", "scout", "reviewer"] as const;
const promptText = Type.String({ minLength: 1, maxLength: 24000 });
export const PromptOverrides = Type.Object(
  {
    coordinator: Type.Optional(promptText),
    worker: Type.Optional(promptText),
    scout: Type.Optional(promptText),
    reviewer: Type.Optional(promptText),
    /** Retired with the verifier role; kept so older project files still load. */
    verifier: Type.Optional(promptText),
  },
  { additionalProperties: false },
);

const text = Type.String({ minLength: 1, maxLength: 32000 });
export const DEFAULT_VERIFY_ROUNDS = 3;
/** Host-wide "deploy when idle" opt-in: hours of the local day, end exclusive (see deploy.ts). */
export const DeploySettings = Type.Object(
  { idle: Type.Boolean(), startHour: Type.Integer({ minimum: 0, maximum: 23 }), endHour: Type.Integer({ minimum: 0, maximum: 23 }) },
  { additionalProperties: false },
);
export type DeploySettings = Static<typeof DeploySettings>;
export const DEFAULT_DEPLOY_SETTINGS: DeploySettings = { idle: false, startHour: 2, endHour: 7 };
export const DEFAULT_STALL_MINUTES = 20;
export const VerificationSettings = Type.Object(
  { enabled: Type.Boolean(), skill: Type.String({ maxLength: 128 }), rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) },
  { additionalProperties: false },
);
export type VerificationSettings = Static<typeof VerificationSettings>;
/** Per-project context/compaction settings; absent fields use the model catalog window and pi-durable's default policy. */
export const ContextSettings = Type.Object(
  {
    contextWindow: Type.Optional(Type.Integer({ minimum: 4096, maximum: 10_000_000 })),
    autoCompact: Type.Boolean(),
    /** Share of the window at which compaction starts. */
    thresholdPercent: Type.Optional(Type.Integer({ minimum: 10, maximum: 95 })),
    keepRecentTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);
export type ContextSettings = Static<typeof ContextSettings>;
const knowledgePath = Type.String({ minLength: 1, maxLength: 1024 });
const revision = Type.String({ minLength: 1, maxLength: 128 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const Role = Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")]);
export type Role = Static<typeof Role>;
export const Id = Type.String({ pattern: "^[a-f0-9-]{36}$" });
/** "github" or the id of a provider plugin. */
export const Provider = Type.String({ minLength: 1, maxLength: 64 });
export const WorkspaceRepositoryAuthorization = Type.Object(
  {
    repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
    provider: Provider,
    ownerCheckout: Type.String({ minLength: 1, maxLength: 4096 }),
    approvedRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    fileOwnershipPrefix: Type.String({ minLength: 1, maxLength: 1024 }),
    sharedObjectStore: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()])),
    /** Checkout providers whose project folder sits below the checkout root: that folder (empty or absent = the root). */ subpath:
      Type.Optional(Type.String({ maxLength: 4096 })),
  },
  { additionalProperties: false },
);
export const WorkspaceScopeAuthorization = Type.Object(
  {
    id: Id,
    repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
    files: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 1024, uniqueItems: true }),
    baseRevision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
    evidenceCapture: Type.Optional(Type.Literal(true)),
    wholeRepository: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export const WorkspaceAuthorization = Type.Object(
  {
    version: Type.Literal(1),
    provider: Provider,
    owner: Type.String({ minLength: 1, maxLength: 512 }),
    repositories: Type.Array(WorkspaceRepositoryAuthorization, { minItems: 1, maxItems: 64 }),
    scopes: Type.Array(WorkspaceScopeAuthorization, { minItems: 1, maxItems: 1024 }),
  },
  { additionalProperties: false },
);
export type WorkspaceAuthorization = Static<typeof WorkspaceAuthorization>;
export const WorkspaceAuthorizationHistory = Type.Array(
  Type.Object(
    {
      revokedAt: Type.String(),
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      repositorySha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      scopeId: Id,
      scopeSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      baseRevision: Type.String({ pattern: "^[0-9a-f]{40,64}$" }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 2048 },
);
export const GithubAuthorization = Type.Object(
  {
    repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
    numericId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    branchPrefix: Type.String({ minLength: 1, maxLength: 128 }),
    baseBranch: Type.String({ minLength: 1, maxLength: 1024 }),
    owner: Type.String({ minLength: 1, maxLength: 512 }),
    workspaceRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    at: Type.String(),
    readInspection: Type.Optional(Type.Literal(true)),
    reviewReplies: Type.Optional(Type.Literal(true)),
    localPublication: Type.Optional(Type.Literal(true)),
    oneClick: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export type GithubAuthorization = Static<typeof GithubAuthorization>;
export const GithubAuthorizationHistory = Type.Array(
  Type.Object({ revokedAt: Type.String(), authorization: GithubAuthorization }, { additionalProperties: false }),
  { maxItems: 64 },
);
export const Project = Type.Object(
  {
    version: Type.Literal(1),
    id: Id,
    name: text,
    cwd: text,
    objective: Type.String({ maxLength: 32000 }),
    runtime: Type.Literal("durable"),
    creation: Type.Optional(
      Type.Object({ requestId: Id, fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
    ),
    archived: Type.Optional(Type.Boolean()),
    deleted: Type.Optional(Type.Boolean()),
    knowledgeAccess: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("maintain")])),
    libraryAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])),
    decisionAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])),
    /** Coordinator gh access; absent means full. */
    githubCli: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("none")])),
    /** Optional host-only workspace grant. Projects without it receive no workspace scope. */
    workspaceAuthorization: Type.Optional(WorkspaceAuthorization),
    workspaceAuthorizationHistory: Type.Optional(WorkspaceAuthorizationHistory),
    githubAuthorization: Type.Optional(Type.Array(GithubAuthorization, { maxItems: 64 })),
    githubAuthorizationHistory: Type.Optional(GithubAuthorizationHistory),
    /** Minutes without progress before a stall notice; absent = DEFAULT_STALL_MINUTES. */
    stallMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240 })),
    commandProfiles: Type.Optional(Type.Array(CommandProfile, { maxItems: 32 })),
    /** Skill names per profile; absent = repository skills for every profile (skill-profiles.ts). */
    skillProfiles: Type.Optional(SkillProfiles),
    /** Per-profile tier, thinking level and switched-off tools; an absent profile keeps the legacy model fields and medium thinking. */
    profiles: Type.Optional(Profiles),
    /** MCP servers per profile and the servers whose write tools are allowed; absent = none (mcp-profiles.ts). */
    mcp: Type.Optional(McpSettings),
    /** Owner overrides of the editable role instructions, per role (this project only). Absent = the built-in text. */
    prompts: Type.Optional(PromptOverrides),
    /** Shell command run once in each fresh whole-repository worktree (e.g. `bun run worktree:setup`). */
    worktreeSetup: Type.Optional(Type.String({ maxLength: 4000 })),
    contextSettings: Type.Optional(ContextSettings),
    createdAt: text,
    model: text,
    /** Role models; an absent role inherits the coordinator model when each worker is admitted. */
    models: Type.Object({
      worker: Type.Optional(text),
      scout: Type.Optional(text),
      reviewer: Type.Optional(text),
      /** Retired with the verifier role; kept so older project files still load. */
      verifier: Type.Optional(text),
    }),
    /** Opt-in verification: the worker runs this skill itself and records each run with projects_verify_run. */
    verification: Type.Optional(VerificationSettings),
    /** Explicit quota fallback per role; absent means wait for the selected model's quota to reset. */
    fallbackModels: Type.Optional(Type.Object({ worker: Type.Optional(text), scout: Type.Optional(text), reviewer: Type.Optional(text) })),
    /** Exact provider/model references the owner cycles through; absent = Pi's enabledModels. */
    scopedModels: Type.Optional(Type.Array(text, { minItems: 1, maxItems: 64, uniqueItems: true })),
    phase: Type.Union([Type.Literal("ready"), Type.Literal("busy"), Type.Literal("attention")]),
    problem: Type.Union([Type.String(), Type.Null()]),
    // Top-level records owned by provider plugins (e.g. a publication authorization) are kept verbatim, also while no plugin understands them.
  },
  { additionalProperties: Type.Unknown() },
);
export type Project = Static<typeof Project>;
export const Note = Type.Object({ id: Id, at: text, author: text, text }, { additionalProperties: false });
export type Note = Static<typeof Note>;
const messageOrigin = Type.Optional(Type.Literal("telegram"));
export const Job = Type.Object(
  {
    id: Id,
    text,
    at: text,
    state: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
    ]),
    error: Type.Union([Type.String(), Type.Null()]),
    /** Coordinator chat the message went to; absent on older jobs and for Main. */
    chatId: Type.Optional(Id),
    /** Owner uploads attached to the message. */
    attachments: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 10, uniqueItems: true })),
    /** When the host first saw the job settle (done or failed); drives the chat tab's "finished" dot. */
    settledAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);
export type Job = Static<typeof Job>;
export const ChatId = Type.Union([Type.Literal("main"), Id]);
/** `<entry id>.<message>` (text) or `<entry id>.<message>.<part>` (image) of a transcript page item. */
const TranscriptRef = Type.String({ pattern: "^\\d{1,15}\\.\\d{1,6}(\\.\\d{1,6})?$" });
/** A folder name in an old host's home. */
const ArchiveProjectId = Type.String({ pattern: "^[A-Za-z0-9-]{1,64}$" });
/** Owner change to Follow PRs / webhook opt-ins (see project-automations.ts). */
export const AutomationChange = Type.Object(
  {
    eventChat: Type.Optional(Type.String({ pattern: "^(main|[a-f0-9-]{36})$" })),
    follow: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          everyMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 86_400_000 })),
          autoFix: Type.Optional(Type.Boolean()),
          fixCap: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
        },
        { additionalProperties: false },
      ),
    ),
    webhook: Type.Optional(Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);
const answer = Type.Union([
  Type.Object({ at: text, text, job: Id }, { additionalProperties: false }),
  Type.Object({ at: text, text, delivery: Type.Literal("manual") }, { additionalProperties: false }),
]);
export const InboxEntry = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("question"),
      id: Id,
      at: text,
      title: text,
      question: text,
      choices: Type.Array(text, { maxItems: 4 }),
      native: Type.Optional(
        Type.Object(
          {
            projectId: Id,
            conversationId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            taskId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            callId: text,
          },
          { additionalProperties: false },
        ),
      ),
      result: Type.Union([Type.Null(), answer]),
    },
    { additionalProperties: false },
  ),
]);
export type InboxEntry = Static<typeof InboxEntry>;
const evidenceNativeIdentity = {
  projectId: Id,
  scopeId: Id,
  workId: Id,
  conversationId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  taskId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  callId: text,
};
const evidenceNative = Type.Union([
  Type.Object({ ...evidenceNativeIdentity, sourcePath: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false }),
  Type.Object(
    { ...evidenceNativeIdentity, sourceKind: Type.Literal("command-output"), commandKey: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
    { additionalProperties: false },
  ),
]);
export const Evidence = Type.Object(
  {
    id: Id,
    at: text,
    title: text,
    filename: text,
    size: Type.Number(),
    sha256: text,
    sessionFile: Type.Union([text, Type.Null()]),
    native: Type.Optional(evidenceNative),
  },
  { additionalProperties: false },
);
export type Evidence = Static<typeof Evidence>;
export const WebInfo = Type.Object({ url: text });
const DurableGenerationOutcome = Type.Union([
  Type.Object(
    {
      status: Type.Literal("completed"),
      successful: Type.Literal(true),
      result: Type.Object({ entryId: Type.Integer() }, { additionalProperties: false }),
      diagnostic: Type.Null(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("failed"),
      successful: Type.Literal(false),
      result: Type.Null(),
      diagnostic: Type.Object(
        {
          hint: Type.Union([
            Type.Literal("authentication"),
            Type.Literal("rate-limit"),
            Type.Literal("tool-context"),
            Type.Literal("timeout"),
            Type.Literal("other"),
          ]),
          fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal("aborted"), Type.Literal("orphaned"), Type.Literal("faulted")]),
      successful: Type.Literal(false),
      result: Type.Null(),
      diagnostic: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);
const DurableGenerationTask = Type.Object(
  {
    taskId: Type.Integer(),
    kind: Type.Literal("pi.generation"),
    conversationId: Type.Integer(),
    phase: Type.Union([
      Type.Literal("prepare"),
      Type.Literal("request"),
      Type.Literal("retry"),
      Type.Literal("poll"),
      Type.Literal("tools"),
      Type.Null(),
    ]),
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("waiting"),
      Type.Literal("completing"),
      Type.Literal("sleeping"),
      Type.Literal("terminal"),
    ]),
    terminal: Type.Boolean(),
    outcome: Type.Union([DurableGenerationOutcome, Type.Null()]),
  },
  { additionalProperties: false },
);
const DurableConversationInspection = Type.Object(
  {
    conversationId: Type.Integer(),
    messages: Type.Array(
      Type.Object(
        { id: Type.Integer(), role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), at: Type.Number(), text: Type.String() },
        { additionalProperties: false },
      ),
    ),
    submissions: Type.Array(
      Type.Object(
        {
          id: Type.Integer(),
          requestId: Type.Union([Type.String(), Type.Null()]),
          status: Type.Union([Type.Literal("queued"), Type.Literal("placed"), Type.Literal("done"), Type.Literal("unanswered")]),
          answerId: Type.Union([Type.Integer(), Type.Null()]),
          reason: Type.Union([Type.String(), Type.Null()]),
          detail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          text: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    generationTasks: Type.Array(DurableGenerationTask),
  },
  { additionalProperties: false },
);
export const DurableInspection = Type.Object(
  {
    identity: Type.Object({ projectId: Id, coordinatorConversationId: Type.Integer() }, { additionalProperties: false }),
    coordinator: DurableConversationInspection,
    workers: Type.Optional(
      Type.Array(Type.Object({ threadId: Id, conversation: DurableConversationInspection }, { additionalProperties: false })),
    ),
  },
  { additionalProperties: false },
);
export type DurableInspection = Static<typeof DurableInspection>;
export const CoordinatorAccess = Type.Object(
  {
    chatId: ChatId,
    conversationId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    toolNames: Type.Array(Type.String()),
    trust: Type.Literal("trusted-local"),
    workspace: Type.Union([
      Type.Object({ state: Type.Literal("unallocated") }, { additionalProperties: false }),
      Type.Object({ state: Type.Literal("unavailable"), reason: Type.String() }, { additionalProperties: false }),
      Type.Object(
        { state: Type.Literal("ready"), cwd: Type.String(), provider: Type.String(), branch: Type.String() },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type CoordinatorAccess = Static<typeof CoordinatorAccess>;
export const Snapshot = Type.Object({
  coordinatorAccess: Type.Optional(CoordinatorAccess),
  project: Project,
  busy: Type.Boolean(),
  paused: Type.Optional(Type.Boolean()),
  jobs: Type.Array(Job),
  /** The newest page of the chat's transcript (`TranscriptItem`s, oldest first); `before` is the cursor of the next older page, null at the start. */
  messages: Type.Array(Type.Unknown()),
  before: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  inbox: Type.Array(InboxEntry),
  notes: Type.Array(Note),
  evidence: Type.Array(Evidence),
  context: Type.Optional(
    Type.Object(
      { tokens: Type.Integer({ minimum: 0 }), window: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) },
      { additionalProperties: false },
    ),
  ),
  chatId: Type.Optional(ChatId),
  /** Owner uploads (metadata, newest first) and failed/interrupted jobs across every chat. */
  uploads: Type.Optional(Type.Array(Type.Unknown())),
  failedJobs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Setup cards of workspace provider plugins (Owner setup steps) and the provider id of a grant whose plugin is not loaded. */
  providerCards: Type.Optional(Type.Array(Type.Unknown())),
  unloadedProvider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  chats: Type.Optional(
    Type.Array(
      Type.Object(
        {
          id: ChatId,
          title: Type.String(),
          conversationId: Type.Integer(),
          createdAt: Type.Number(),
          archived: Type.Boolean(),
          busy: Type.Boolean(),
          attention: Type.Optional(Type.Boolean()),
          finishedAt: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    ),
  ),
});
export type Snapshot = Static<typeof Snapshot>;
export const Request = Type.Union([
  Type.Object({ action: Type.Literal("remote-reload") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("remote-status") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("remote-devices") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("remote-pair-start") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("remote-pair-cancel") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("remote-revoke"),
      deviceId: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
      confirm: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("remote-rename"),
      deviceId: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
      name: Type.String({ minLength: 1, maxLength: 80 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("command-intent-inspect"), id: Id, confirm: Id, key: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("command-intents-snapshot"),
      id: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("coordinator-skills"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("prompts-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ref-candidates"), id: Id, refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("ref-preview"),
      id: Id,
      kind: Type.Union([Type.Literal("file"), Type.Literal("issue"), Type.Literal("skill")]),
      value: Type.String({ minLength: 1, maxLength: 1024 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("mcp-catalog"), id: Id }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("mcp-probe"), id: Id, server: Type.String({ minLength: 1, maxLength: 128 }) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("command-profiles-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("command-profile-read"), id: Id, profileId: Id }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("command-profile-set"),
      id: Id,
      confirm: Id,
      expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      profile: CommandProfileInput,
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("web") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ui-get") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ui-set"), revision: sha256, patch: UiPatch }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("tiers-get") }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("tiers-set"), revision: sha256, tiers: Type.Array(Tier, { maxItems: 64 }) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("profiles-get"), projectId: Id }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("profiles-set"), projectId: Id, revision: sha256, profile: ProfileIdSchema, patch: ProfileSettings },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("profile-tools"), projectId: Id, profile: ProfileIdSchema }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("prompt-render"), projectId: Id, profile: ProfileIdSchema, chatId: Type.Optional(ChatId) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("memory-index"), projectId: Id, includeArchive: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("memory-undo"), projectId: Id, path: knowledgePath, revision }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("answer"), id: Id, entry: Id, text, origin: messageOrigin }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("create"),
      requestId: Type.Optional(Id),
      name: text,
      cwd: text,
      objective: Type.Optional(Type.String({ maxLength: 32000 })),
      model: Type.Optional(text),
      knowledgeAccess: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("maintain")])),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("models-snapshot"),
      provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("model-picker-snapshot"), id: Type.Optional(Id) }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("usage-snapshot"),
      id: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("event-log"),
      id: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("host-health"), id: Id }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("library-import"),
      id: Id,
      confirm: Id,
      importId: Id,
      filename: Type.String({ minLength: 1, maxLength: 240 }),
      title: Type.String({ minLength: 1, maxLength: 1000 }),
      encoding: Type.Literal("base64"),
      data: Type.String({ maxLength: 43692 }),
      expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("library-list"),
      id: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("library-read"),
      id: Id,
      evidenceId: Id,
      expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10485760 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 131072 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("settings-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("settings-update"),
      id: Id,
      confirm: Id,
      expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      changes: Type.Object(
        {
          name: Type.Optional(text),
          objective: Type.Optional(Type.String({ maxLength: 32000 })),
          model: Type.Optional(text),
          /** null returns a role to inheriting the coordinator model. */
          models: Type.Optional(
            Type.Object(
              {
                worker: Type.Optional(Type.Union([text, Type.Null()])),
                scout: Type.Optional(Type.Union([text, Type.Null()])),
                reviewer: Type.Optional(Type.Union([text, Type.Null()])),
                verifier: Type.Optional(Type.Union([text, Type.Null()])),
              },
              { additionalProperties: false },
            ),
          ),
          /** null turns the verification loop off and forgets its skill. */
          verification: Type.Optional(Type.Union([VerificationSettings, Type.Null()])),
          /** Explicit quota fallback per role; null removes it and restores reset waiting. */
          fallbackModels: Type.Optional(
            Type.Object(
              {
                worker: Type.Optional(Type.Union([text, Type.Null()])),
                scout: Type.Optional(Type.Union([text, Type.Null()])),
                reviewer: Type.Optional(Type.Union([text, Type.Null()])),
              },
              { additionalProperties: false },
            ),
          ),
          /** null restores Pi's enabledModels as the scope. */
          scopedModels: Type.Optional(Type.Union([Type.Array(text, { minItems: 1, maxItems: 64, uniqueItems: true }), Type.Null()])),
          knowledgeAccess: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("maintain")])),
          libraryAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])),
          decisionAccess: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("coordinator")])),
          githubCli: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("none")])),
          stallMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 240 })),
          /** null restores the default (repository skills for every profile). */
          skills: Type.Optional(Type.Union([SkillProfiles, Type.Null()])),
          /** null removes every MCP server. */
          mcp: Type.Optional(Type.Union([McpSettings, Type.Null()])),
          /** A role set to null returns to the built-in text. */
          prompts: Type.Optional(
            Type.Object(
              {
                coordinator: Type.Optional(Type.Union([promptText, Type.Null()])),
                worker: Type.Optional(Type.Union([promptText, Type.Null()])),
                scout: Type.Optional(Type.Union([promptText, Type.Null()])),
                reviewer: Type.Optional(Type.Union([promptText, Type.Null()])),
                verifier: Type.Optional(Type.Union([promptText, Type.Null()])),
              },
              { additionalProperties: false },
            ),
          ),
          /** A profile set to null returns to the legacy model fields and medium thinking. */
          profiles: Type.Optional(
            Type.Object(
              {
                coordinator: Type.Optional(Type.Union([ProfileSettings, Type.Null()])),
                worker: Type.Optional(Type.Union([ProfileSettings, Type.Null()])),
                scout: Type.Optional(Type.Union([ProfileSettings, Type.Null()])),
                reviewer: Type.Optional(Type.Union([ProfileSettings, Type.Null()])),
              },
              { additionalProperties: false },
            ),
          ),
          /** "" removes the worktree setup command. */
          worktreeSetup: Type.Optional(Type.String({ maxLength: 4000 })),
          /** null restores the defaults (catalog window, pi-durable compaction policy). */
          context: Type.Optional(Type.Union([ContextSettings, Type.Null()])),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("compact"), id: Id, chatId: Type.Optional(ChatId) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("chat-reload"), id: Id, chatId: Type.Optional(ChatId) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("chat-reset"), id: Id, chatId: Type.Optional(ChatId) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("artifacts-list"), id: Id, threadId: Type.Optional(Id) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("worktrees-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("worktrees-cleanup"), id: Id, confirm: Id }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("show"),
      id: Id,
      chatId: Type.Optional(ChatId),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("search"),
      id: Id,
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("chat-create"), id: Id, title: Type.Optional(Type.String({ maxLength: 120 })) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("chat-update"),
      id: Id,
      chatId: ChatId,
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      archived: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("pause"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("jobs-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("job-approve"), id: Id, jobId: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("resume"), id: Id, confirm: Type.Optional(Id) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("archive"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("restore"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("delete"), id: Id, confirm: Type.Optional(Id) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("owner-setup-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("github-repository-inspect"), id: Id, repositoryId: Type.String({ minLength: 1, maxLength: 256 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("github-authorize"),
      id: Id,
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      branchPrefix: Type.String({ minLength: 1, maxLength: 128 }),
      confirm: Id,
      expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      reviewReplies: Type.Optional(Type.Boolean()),
      localPublication: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("github-revoke"),
      id: Id,
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      confirm: Id,
      expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("provider-pr-inspect"),
      id: Id,
      provider: Provider,
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      expectedHead: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("provider-conflict-inspect"),
      id: Id,
      provider: Type.Literal("github"),
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
      expectedBase: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("provider-ci-job-inspect"),
      id: Id,
      provider: Type.Literal("github"),
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
      jobId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("provider-ci-detail"),
      id: Id,
      provider: Type.Literal("github"),
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      expectedHead: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
      checkRunId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("provider-review-inspect"),
      id: Id,
      provider: Provider,
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      expectedHead: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("provider-ci-inspect"),
      id: Id,
      provider: Provider,
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      pullRequest: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      expectedHead: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("github-read-snapshot"),
      id: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("github-write-inspect"),
      id: Id,
      key: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      expectedRepositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("github-write-snapshot"),
      id: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("workspace-catalog"), id: Id }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("github-quick-authorize"), id: Id, confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("workspace-quick-grant"), id: Id, confirm: Id, expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("workspace-grant"),
      id: Id,
      confirm: Id,
      expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      repositoryId: Type.String({ minLength: 1, maxLength: 256 }),
      provider: Type.Literal("github"),
      ownerCheckout: text,
      approvedRoot: text,
      fileOwnershipPrefix: Type.String({ minLength: 1, maxLength: 1024 }),
      files: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 1024, uniqueItems: true }),
      baseRevision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
      evidenceCapture: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("workspace-revoke"),
      id: Id,
      confirm: Id,
      scopeId: Id,
      expectedRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("thread-dismiss"), id: Id, threadId: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("thread-steer"), id: Id, threadId: Id, requestId: Id, text }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("thread-stop"), id: Id, threadId: Id, reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("thread-history"),
      id: Id,
      /** An agent id, or `<job id>/<conversation id>` for a subagent of a Job. */
      threadId: ThreadReference,
      before: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      context: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("chat-history"),
      id: Id,
      chatId: Type.Optional(ChatId),
      before: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("transcript-text"),
      id: Id,
      chatId: Type.Optional(ChatId),
      threadId: Type.Optional(ThreadReference),
      ref: TranscriptRef,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("transcript-image"),
      id: Id,
      chatId: Type.Optional(ChatId),
      threadId: Type.Optional(ThreadReference),
      ref: TranscriptRef,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("archive-config"), home: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("archive-projects") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("archive-project"), projectId: ArchiveProjectId }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("archive-history"),
      projectId: ArchiveProjectId,
      conversationId: Type.Integer({ minimum: 1 }),
      before: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("archive-text"),
      projectId: ArchiveProjectId,
      conversationId: Type.Integer({ minimum: 1 }),
      ref: TranscriptRef,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("archive-image"),
      projectId: ArchiveProjectId,
      conversationId: Type.Integer({ minimum: 1 }),
      ref: TranscriptRef,
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("thread-send"), id: Id, threadId: Id, requestId: Id, text }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("worker-contexts"), id: Id, threadIds: Type.Array(Id, { maxItems: 40, uniqueItems: true }) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("limits-snapshot"), visit: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("limits-refresh") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("limits-visibility"),
      provider: Type.Union([
        Type.Literal("claude"),
        Type.Literal("codex"),
        Type.Literal("cursor"),
        Type.Literal("eliza"),
        Type.Literal("kimi"),
      ]),
      visible: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("machine-status") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cursor-connect") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("message"),
      id: Id,
      text,
      origin: messageOrigin,
      chatId: Type.Optional(ChatId),
      requestId: Type.Optional(Id),
      attachments: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 10, uniqueItems: true })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("upload-list"), id: Id }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("upload-read"),
      id: Id,
      uploadId: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("upload-delete"), id: Id, uploadId: Id }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("schedule-create"),
      id: Id,
      scheduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      atMs: Type.Integer({ minimum: 0 }),
      everyMs: Type.Optional(Type.Integer({ minimum: 60000, maximum: 31536000000 })),
      calendar: Type.Optional(
        Type.Union([
          Type.Object(
            {
              kind: Type.Literal("daily"),
              timezone: Type.String({ minLength: 1, maxLength: 256 }),
              time: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              kind: Type.Literal("weekly"),
              timezone: Type.String({ minLength: 1, maxLength: 256 }),
              time: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }),
              days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, uniqueItems: true }),
            },
            { additionalProperties: false },
          ),
        ]),
      ),
      text,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("schedule-enable"), id: Id, scheduleId: Type.String({ minLength: 1, maxLength: 256 }), enabled: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("schedule-snapshot"), id: Id, includeHistory: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("schedule-history"),
      id: Id,
      kind: Type.Union([Type.Literal("events"), Type.Literal("intents")]),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      textOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
      textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("event-opt-in"), id: Id, enabled: Type.Boolean() }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("event-ingest"),
      id: Id,
      eventId: Type.String({ minLength: 1, maxLength: 256 }),
      kind: Type.String({ minLength: 1, maxLength: 128 }),
      payload: Type.String({ maxLength: 32000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("automation-snapshot"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("automation-update"), id: Id, change: AutomationChange }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("webhook-rotate"), id: Id, confirm: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("follow-poll"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("prs"), id: Id, refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("pr-watch"),
      id: Id,
      provider: Provider,
      pr: Type.String({ minLength: 1, maxLength: 200 }),
      watch: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("pr-hide"),
      id: Id,
      provider: Provider,
      pr: Type.String({ minLength: 1, maxLength: 200 }),
      hide: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("plugins") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("plugin"),
      plugin: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
      method: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
      id: Type.Optional(Id),
      params: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("work-submit"), id: Id, threadId: Id, requestId: Id, workspaceScopeId: Id, text },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("notes"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("knowledge-list"), id: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("knowledge-read"), id: Id, path: knowledgePath }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("knowledge-write"),
      id: Id,
      path: knowledgePath,
      text: Type.String({ maxLength: 32000 }),
      expectedRevision: Type.Union([revision, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("knowledge-history"), id: Id, path: knowledgePath }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("shutdown") }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("deploy-shutdown"), sha: Type.String({ pattern: "^[0-9a-f]{40}$" }) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("deploy-snapshot") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("deploy-settings"), settings: DeploySettings }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("deploy-start") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("notify-feed"), after: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("telegram-snapshot") }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("telegram-token"), token: Type.String({ pattern: "^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$" }) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("telegram-pair") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("telegram-unpair") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("telegram-remove"), confirm: Type.Literal("remove") }, { additionalProperties: false }),
]);
export type Request = Static<typeof Request>;
export const Reply = Type.Union([
  Type.Object({ ok: Type.Literal(true), data: Type.Unknown() }),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }),
]);
export type Reply = Static<typeof Reply>;

export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value))
    throw new Error(
      `Invalid data: ${[...Value.Errors(schema, value)]
        .map((e) => `${e.instancePath}: ${e.message}`)
        .join("; ")
        .slice(0, 1500)}`,
    );
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

const deploySettingsPath = () => join(home(), "deploy-settings.json");
/** Defaults when the file is missing or invalid: an unreadable window must never turn into "always". */
export function loadDeploySettings(): DeploySettings {
  try {
    return parse(DeploySettings, JSON.parse(readFileSync(deploySettingsPath(), "utf8")));
  } catch {
    return DEFAULT_DEPLOY_SETTINGS;
  }
}
export const saveDeploySettings = (settings: DeploySettings): void => saveJson(deploySettingsPath(), settings);

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A project record written by the removed legacy (pi-subagents) runtime. It is never opened or modified. */
export class LegacyProjectError extends Error {}

export function loadProject(id: string): Project {
  const value = readJson(join(projectDir(id), "project.json"));
  if (typeof value === "object" && value !== null && (value as { runtime?: unknown }).runtime !== "durable") {
    const name = (value as { name?: unknown }).name;
    throw new LegacyProjectError(
      `Project ${typeof name === "string" ? JSON.stringify(name.slice(0, 120)) : id} (${id}) uses the removed legacy runtime and cannot be opened. Only Durable projects are supported; its files in ${projectDir(id)} are left untouched.`,
    );
  }
  return parse(Project, value);
}

export function saveProject(project: Project): void {
  saveJson(join(projectDir(project.id), "project.json"), parse(Project, project));
}

/** Durable projects only; legacy records are skipped (see `legacyProjectIds`). */
export function listProjects(): Project[] {
  return projectIds().flatMap((id) => {
    try {
      return [loadProject(id)];
    } catch (error) {
      if (error instanceof LegacyProjectError) return [];
      throw error;
    }
  });
}

export function legacyProjectIds(): string[] {
  return projectIds().filter((id) => {
    try {
      loadProject(id);
      return false;
    } catch (error) {
      return error instanceof LegacyProjectError;
    }
  });
}

function projectIds(): string[] {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  return readdirSync(home()).filter((id) => Value.Check(Id, id));
}

export function addNote(dir: string, author: string, text: string): Note {
  const note = parse(Note, { id: randomUUID(), at: new Date().toISOString(), author, text });
  saveJson(join(dir, "notes", `${note.at.replaceAll(":", "-")}-${note.id}.json`), note);
  return note;
}

export function notes(dir: string): Note[] {
  const path = join(dir, "notes");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parse(Note, readJson(join(path, name))));
}

export function jobs(id: string): Job[] {
  const dir = join(projectDir(id), "inbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => parse(Job, readJson(join(dir, name))))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function saveJob(id: string, job: Job): void {
  saveJson(join(projectDir(id), "inbox", `${job.id}.json`), parse(Job, job));
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
