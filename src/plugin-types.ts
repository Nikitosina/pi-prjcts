import type { Conversation, ToolExecutionApi, ToolRegistration, Tx, defineExtension } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
export type { Conversation, ToolExecutionApi, ToolRegistration, Tx, Context };
import type * as Durable from "@earendil-works/pi-durable";
import type * as Typebox from "typebox";
import type * as ChordContext from "@earendil-works/chord/context";
import type { DurablePlanning } from "./durable-planning.ts";
import type { Project, WorkspaceAuthorization } from "./state.ts";
import type { PrNotice } from "./pr-notices.ts";
import type { CliResult } from "./vcs.ts";
import type { WorkspaceIntent, WorkspaceLease, WorkspaceReceipt, WorkspaceScope } from "./workspace-types.ts";
import type { WorkspaceAuthority } from "./workspace-capabilities.ts";

/*
 * Host plugin API. A plugin is a module that exports `{ name, register(api) }` (default export or named exports); the host calls
 * `register` once at start with a HostPluginApi and the plugin hands back its capabilities through `api.provide(...)`.
 * Nothing a plugin registers is visible until `register` returns: a throwing plugin leaves no partial registrations.
 *
 * Capabilities (all optional):
 *  - vcs        a checkout kind besides git: root detection, status, diffs, PR-head snapshots, branch continuation.
 *  - workspace  a workspace-grant provider for that kind: one-click grant, worktree backend, worker binding, cleanup facts, setup cards.
 *  - prs        a pull-request provider: card data, detail, `#` refs, watch/hide, transitions for the monitor, notices.
 *  - follow     publication-receipt based Follow PRs for the provider: observe, auto-fix brief, auto-merge.
 *  - coordinatorTools  tools (and an instruction snippet) offered to the coordinator for matching projects.
 *  - rpc        namespaced host RPCs, called as { action: "plugin", plugin, method, id?, params? }.
 *  - uncertainWrites  durable "an outcome is unknown" check that blocks automatic admission.
 */

/** Libraries the plugin must use instead of importing its own copies (Durable docs and tools only work with the host's instances). */
export type PluginLib = { durable: typeof Durable; typebox: typeof Typebox; chord: typeof ChordContext; docs: { planning: typeof DurablePlanning } };
export type Extension = ReturnType<typeof defineExtension>;
export type PrId = string;

// ---- vcs ----
export type CodeDiffParts = { mergeBase: string; changed: string; diff: string; untracked: string[] };
export type ReadHeads = { ensure(ref: string): Promise<{ root: string; sha: string }>; restore(sha: string): Promise<string> };
export type ContinuationBranch = { name: string; sha: string };
export type VcsProvider = {
  /** Checkout kind reported by findVcsRoot; also the workspace grant provider id. */
  kind: string;
  /** True when `dir` itself is a checkout root of this kind. Wins over `.git` in the same directory. */
  isRoot(dir: string): boolean;
  /** Metadata folder names workers must never read or write. */
  privateDirs?: readonly string[];
  /** Uncommitted paths (status lines) of a checkout; null when unreadable. */
  changedFiles(cwd: string): Promise<string[] | null>;
  /** Diff of HEAD plus uncommitted work against the merge-base with `base` (default: provider default). */
  codeDiff(root: string, base: string | undefined, helpers: { text(result: Promise<CliResult>, what: string, tolerate?: boolean): Promise<string>; cap: number }): Promise<CodeDiffParts>;
  /** Branch, head and status lines of a worker worktree. */
  workerState(root: string): Promise<{ branch: string; head: string; status: string }>;
  /** Read-only snapshots of PR heads for scouts and reviewers. */
  readHeads(input: { checkout: string; controlRoot: string; projectId: string; project: () => Project }): ReadHeads;
  /** Entry inside a read-head snapshot that marks it as this kind. */
  readHeadMarker: string;
  /** Resolves and authorizes an existing branch (or PR) for a new worker thread to continue. */
  resolveContinuation(project: Project, ref: string, checkout: string): Promise<ContinuationBranch>;
  /** Extra worker rules (one sentence) added to every worker/scout/reviewer role text. */
  workerRule?: string;
  /** Executable names a GitHub command profile must not run (this kind's own tools). */
  executables?: readonly string[];
};

// ---- workspace ----
export type QuickWorkspacePreview =
  | { available: true; provider: string; repositoryId: string; ownerCheckout: string; approvedRoot: string; head: string; dirty: boolean; subpath?: string; sharedObjectStore?: string; login?: string; /** Rows and bullets for the confirm dialog (provider texts). */ dialog?: { checkoutLabel: string; rows?: Array<[string, string]>; bullets: string[] } }
  | { available: false; blocker: string };

export type IsolationFacts = Record<string, string>;
export type IsolationBackend = {
  /** Provider-specific checks before an allocation or reconcile (after the host's own path checks). */
  preflight(scope: WorkspaceScope, input: { owner: string; target: string }): Promise<{ facts: IsolationFacts; reason: string | null }>;
  add(intent: WorkspaceIntent, facts: IsolationFacts): Promise<{ state: "blocked" | "allocated" | "uncertain"; facts: IsolationFacts; lease: WorkspaceLease | null; reason: string | null }>;
  /** What the provider currently reports for the scope's worktree; null when absent. */
  entry(scope: WorkspaceScope): Promise<{ facts: IsolationFacts; lease: WorkspaceLease | null } | null>;
  exact(scope: WorkspaceScope, actual: { facts: IsolationFacts; lease: WorkspaceLease | null }): boolean;
  /** Status command whose output must be empty before a release. */
  statusCommand(): { file: string; args: string[] };
  /** Fenced, unforced removal after the host's activity and status checks. */
  release(intent: WorkspaceIntent, current: WorkspaceReceipt): Promise<{ ok: true; facts: IsolationFacts } | { ok: false; reason: string; facts?: IsolationFacts; lease?: WorkspaceLease | null }>;
};

export type AllocationPlan = { name: string; branch: string; baseRevision: string; headRevision: string; leaseReason: string; sharedObjectStore: string | null; continueBranch?: true };
export type BindContext = {
  project: Project;
  repository: WorkspaceAuthorization["repositories"][number];
  scopeId: string;
  whole: boolean;
  /** Base revision frozen in a folder-limited scope. */
  scopeBaseRevision: string;
  threadId: string;
  workId: string;
  conversationId: number;
  allocationThread: string;
  /** Scope frozen by an earlier allocation of the same intent, if any. */
  allocated: WorkspaceScope | undefined;
  continued: ContinuationBranch | undefined;
  root: Conversation;
  controlRoot: string;
  isClosed(): boolean;
  taskText(): Promise<string>;
};
export type AttachContext = BindContext & { receipt: WorkspaceReceipt; receipts: readonly WorkspaceReceipt[]; plan: AllocationPlan };
export type WorkerAttachment = {
  /** Folder workers run in (inside the worktree). */
  workDir: string;
  /** Runs after the worktree is ready (e.g. lease renewal); a throw refuses the dispatch. */
  start(): Promise<void>;
  tools(authority: WorkspaceAuthority): Promise<ToolRegistration[]>;
  /** Rewrites or blocks a worker shell command. */
  guard(command: string): string;
  /** Checked before every tool call of the worker; `block` refuses it. */
  beforeTool?(): Promise<{ block: string } | undefined>;
  /** Appended to the worker's frozen instructions in whole-repository mode. */
  instructions: string;
};
export type SetupCard = {
  id: string;
  state: "connected" | "available" | "blocked";
  title: string;
  /** Plain text. */
  body: string;
  /** Opaque revision the connect call must echo. */
  revision: string;
  connect?: { label: string; dialog: { title: string; subtitle?: string; intro?: string; bullets: string[]; confirmLabel: string }; rpc: { plugin: string; method: string }; success: string };
};
export type WorkerFacts = { threadId: string | null; branch: string | null; removable: boolean; reasons: string[]; pullRequests: Array<{ number: number; state: string }> };
export type WorkspaceProvider = {
  /** workspaceAuthorization.provider value and checkout kind (matches a VcsProvider.kind). */
  id: string;
  /** One-click grant facts for a project whose checkout walked up to `walkedRoot`; the host builds the grant from them. */
  quickPreview(project: Project, walkedRoot: string): QuickWorkspacePreview;
  /** Keeps provider authorizations bound to the workspace grant after it changes. */
  rebind?(project: Project): Project;
  isolation: IsolationBackend;
  /** The project folder, not the checkout root, is the standing-instructions root. */
  standingAtProjectRoot?: boolean;
  /** Lease owner of this project's worktrees (distinguishable from the owner's own sessions). */
  leaseOwner(project: Project): string;
  /** Names, branch and base of a worker worktree: frozen with the receipt on first allocation, then reused. */
  plan(context: BindContext): Promise<AllocationPlan>;
  attach(context: AttachContext): Promise<WorkerAttachment>;
  /** Cleanup inventory: facts of one allocated worker worktree and the removal. */
  workerFacts(input: { project: Project; root: Conversation; receipt: WorkspaceReceipt; busy(threadId: string): boolean }): Promise<WorkerFacts>;
  /** Removes a worker worktree or read-head snapshot (unforced, fenced). */
  remove(input: { entry: string; leaseOwner: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  readHeadEntry(project: Project, path: string): { leaseOwner: string; entry: string };
  /** Worktrees that are not plain directories (size is never measured). */
  virtualMount: boolean;
  mountLabel?: string;
  /** One sentence for the workspace catalog entry of a whole-repository scope. */
  wholeRepositoryNote?: string;
  setupCards?(project: Project): SetupCard[];
};

// ---- prs ----
export type PrCounts = { ok: number; failed: number; running: number };
/** One open PR as the card, the monitor and the `#` menu see it. All text is provider data: clipped by the provider, escaped at render. */
export type PrCardData = {
  id: PrId;
  /** What the composer inserts, e.g. "#123". */
  ref: string;
  title: string;
  url: string;
  branch: string;
  author: string;
  /** failing: a required check failed or conflicts; running: required checks unfinished; green: required checks satisfied; none: no checks yet. */
  state: "failing" | "running" | "green" | "none";
  conflicts: boolean;
  autoMerge: boolean;
  mergeFailed: boolean;
  status: string;
  counts: PrCounts;
  failedChecks: string[];
  requiredFailed: boolean;
  /** Changes when new work lands (diff-set, head): transitions are reported once per revision. */
  revision: number | string | null;
  updatedAt: string;
  /** Optional review facts (providers with reviews): the monitor reports changes-requested / approved / new unresolved threads. */
  draft?: boolean;
  review?: "approved" | "changes" | "required" | null;
  /** Unresolved review threads. */
  unresolved?: number;
};
/** Transitions the PR monitor can report. */
export type PrTransition = "ci-failed" | "ci-recovered" | "conflicts" | "merge-failed" | "merged" | "closed" | "changes-requested" | "approved" | "review-comments";
export type PrListing = { prs: PrCardData[]; fetchedAtMs: number | null; error: string | null; rateLimitedUntilMs: number | null };
export type PrDetailData = { id: PrId; title: string; status: string; url: string; conflicts: boolean; counts: PrCounts; failedChecks: string[]; draft?: boolean; review?: PrCardData["review"] };
export type PrProvider = {
  id: string;
  /** Shown as the card group and in events ("GitHub", or a plugin's label). */
  label: string;
  /** Kind of the per-project watch document (persisted; keep stable across versions). */
  watchDocKind: string;
  /** Throws for an id this provider cannot use (watch/hide requests are checked before they are stored). */
  validateId?(id: PrId): void;
  /** Link to a PR by id (also for PRs that left the open list). */
  url(id: PrId, project?: Project): string;
  /** Whether the provider serves this project at all. */
  applies(project: Project): boolean;
  /** `include`: ids the host monitors or shows regardless of authorship (watched, worker-published). */
  list(project: Project, options: { force?: boolean; include?: readonly PrId[] }): Promise<PrListing>;
  /** PRs that touch the project's own folder (monitored without being watched). */
  touching?(project: Project): Promise<PrId[]>;
  detail(project: Project, id: PrId): Promise<PrDetailData>;
  /** Ids written in an owner message (`#123`), distinct, in order, at most `max`. `project` lets a provider tell its own PR URLs from others. */
  parseRefs(text: string, max?: number, project?: Project): PrId[];
  /** Turns what the owner typed to watch or hide (`123`, `#123`, a PR URL) into an id; throws when it is not a PR of this project. */
  normalizeId?(project: Project, input: string): PrId;
  /** Transitions the monitor reports (default: ci-failed, conflicts, merge-failed, merged, closed). */
  transitions?: readonly PrTransition[];
  /** Transitions that also raise a host notice, browser and Telegram (default: ci-failed, merged). */
  noticeFor?: readonly PrTransition[];
  /** Transitions Follow PRs already reports for this provider, so the monitor stays quiet about them: `events` are coordinator event lines, `notices` host notices. */
  followCovers?: { events: readonly PrTransition[]; notices: readonly PrTransition[] };
  /** Current state of a PR that left the open list; never cached. */
  status(project: Project, id: PrId): Promise<{ status: string; merged: boolean; closed: boolean }>;
  /** PRs this project's workers opened (always monitored). */
  published(root: Conversation, project: Project): Promise<PrId[]>;
};

// ---- follow ----
export type FollowPrState = { state: "open" | "closed" | "merged"; head: string; ref: string; title: string; updatedAt: string; ci: { sha: string; result: "failed" | "passed" } | null; lastReview: number; lastComment: number; lastLineComment: number };
export type FollowItem = { id: string; line: string; notice?: Pick<PrNotice, "kind" | "text"> };
export type FollowFailure = { repo: { repositoryId: string; numericId?: number }; number: number; title: string; head: string; ref: string; checks: string[]; /** Failed-check detail for the built-in auto-fix brief (untrusted provider data, already capped). */ detail?: string; /** Set by a plugin provider: the auto-fix task text for this failure. */ brief?: (input: { attempt: number; cap: number; hasThread: boolean }) => string; provider?: string };
export type FollowRepoState = { baselined: boolean; prs: Record<string, FollowPrState> };
export type MergeReceipt = { sha: string; state: "uncertain" | "merged" | "failed"; at: number; marker: string; reviewerThreadId: string; mergeCommit: string | null; error: string | null; retryable?: boolean };
/** Helpers the host gives a provider's auto-merge (same receipts, review requests and gates as GitHub's). */
export type AutoMergeKit = {
  repositoryId: string;
  note(id: string, line: string): FollowItem | null;
  receipts(): MergeReceipt[];
  save(receipt: MergeReceipt, change: Partial<MergeReceipt>): Promise<void>;
  /** Records an `uncertain` receipt before the merge call (refuses when paused, switched off or already recorded). */
  begin(receipt: MergeReceipt): Promise<void>;
  /** The reviewer's verdict for exactly this head, if any. */
  verdict(head: string): Promise<{ verdict: string; threadId: string; summary: string } | null>;
  requestReview(pr: FollowPrState, diff: () => Promise<string>): Promise<FollowItem | null>;
  /** Pull requests this project opened (verified receipts). */
  published(): Promise<Array<{ number: number }>>;
  project(): Project;
  trustedOwner(): string;
  signal: AbortSignal;
  state: { mergeNotes?: Record<string, string> };
};
export type FollowProvider = {
  id: string;
  /** Event kind for deliveries, e.g. "<id>.follow". */
  eventKind: string;
  label: string;
  /** The current, workspace-bound provider authorization of the project, or undefined when Follow PRs should skip it. */
  repository(project: Project): { repositoryId: string } | undefined;
  observe(input: { root: Conversation; project: Project; repositoryId: string; prior: FollowRepoState | undefined; signal: AbortSignal }): Promise<{ state: FollowRepoState; items: FollowItem[]; failed: FollowFailure[] }>;
  published(root: Conversation): Promise<Array<{ number: number; conversationId: number }>>;
  autoMerge(kit: AutoMergeKit, number: number, pr: FollowPrState): Promise<FollowItem | null>;
};

// ---- coordinator tools / rpc / writes ----
export type CoordinatorToolsProvider = {
  /** Installed always (recorded calls resolve), offered only where `applies`. */
  create(input: { projectId: string; root: () => Conversation | undefined; isCoordinator: (id: Conversation["id"]) => boolean }): { tools: ToolRegistration[]; extension: Extension };
  applies(project: Project): boolean;
  /** Appended to the coordinator instructions of matching projects. */
  instructions?(project: Project): string;
};
export type PluginRpcContext = {
  params: unknown;
  projectId: string | undefined;
  /** Runs `fn` with the project's Durable root conversation (opens the project's runtime). */
  withRoot<T>(projectId: string, fn: (root: Conversation) => Promise<T>): Promise<T>;
  /**
   * Changes a project record while the project is idle: `validate` runs before and again under the lock (throw to refuse);
   * `apply` returns the new project. Refused while work is queued or running.
   */
  mutateIdle(projectId: string, change: { validate(project: Project): void; apply(project: Project): Project }): Promise<void>;
};
export type PluginRpcHandler = (context: PluginRpcContext) => Promise<unknown>;

export type PluginCapabilities = {
  vcs?: VcsProvider;
  workspace?: WorkspaceProvider;
  prs?: PrProvider;
  follow?: FollowProvider;
  coordinatorTools?: CoordinatorToolsProvider;
  rpc?: Record<string, PluginRpcHandler>;
  uncertainWrites?: (tx: Tx, root: Conversation["id"]) => Promise<boolean>;
};

export type HostPluginApi = {
  /** The plugin's own name. */
  name: string;
  /** Plugin-owned persisted state: `$PI_PROJECTS_HOME/plugins/<name>/` (created). */
  stateDir: string;
  lib: PluginLib;
  provide(capabilities: PluginCapabilities): void;
  projects: {
    load(id: string): Project;
    /** Provider-owned top-level project records (kept verbatim by the host even when no plugin understands them). */
    record<T = unknown>(project: Project, key: string): T | undefined;
    /** Digest of the project's workspace grant; provider authorizations bind to it. */
    authorizationFingerprint(project: Project): string;
    trustedOwner(): string;
  };
  exec: {
    /** Runs a binary without throwing; the exit code is data. */
    run(file: string, args: string[], cwd?: string): Promise<CliResult>;
    /** Like run but throws on failure and returns trimmed stdout (read-only probes). */
    runSync(file: string, args: string[], cwd: string): string;
    /** Spawn with the host's sanitized environment (workspace allocation commands). */
    command(file: string, args: string[], cwd?: string): Promise<CliResult>;
  };
  vcs: {
    /** Walks up from `dir` for a checkout root of any kind. */
    findRoot(dir: string): { kind: string; root: string } | null;
  };
  workspace: {
    WHOLE_REPOSITORY_PREFIX: string;
    repositoryFingerprint(repository: { repositoryId: string; provider: string; ownerCheckout: string; approvedRoot: string; fileOwnershipPrefix: string; sharedObjectStore?: string | null; subpath?: string }): string;
  };
  prs: {
    /** Shared, TTL-cached, rate-limit-aware list reads: one fetch serves every project and browser. */
    createListCache<T>(options: ListCacheOptions<T>): ListCache<T>;
    /** Thrown by a list fetch when the provider asks to back off. */
    RateLimitedError: typeof RateLimitedError;
    clip(text: unknown, max: number): string;
  };
};

export class RateLimitedError extends Error {}
export type ListCacheOptions<T> = {
  label: string;
  /** Fetches one list (key identifies the scope); throws RateLimitedError when the provider asks to back off. `backoff()`/`blocked()` let a long fetch stop early. */
  fetch(key: string, input: { force: boolean; backoff(): void; blocked(): boolean }): Promise<T[]>;
};
export type ListCache<T> = { list(key: string, options?: { force?: boolean }): Promise<{ items: T[]; fetchedAtMs: number | null; error: string | null; rateLimitedUntilMs: number | null }> };

export type PluginModule = { name: string; register(api: HostPluginApi): void | Promise<void> };
export type PluginStatus = { source: string; name: string | null; state: "loaded" | "failed"; error?: string; provides: string[]; loadedAtMs: number };
