import { randomUUID } from "node:crypto";
import { hasUncertainVcsOperations } from "./vcs-operation-state.ts";
import { existsSync } from "node:fs";
import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool, UsageDoc, type Conversation, type ConversationId, type ModelRef, type TaskId, type ToolRegistration, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import type { DurablePlan, DurablePlanSnapshot, DurablePlanWork, DurablePlanWorkSnapshot, DurablePrepareWorkerEnvironment, DurablePublishWorkerEnvironment, DurableResolvedAttempt, DurableRole, DurableWorkerToolBindings, DurableWorkspaceInstructions } from "./durable-plan-types.ts";
import type { WorkspaceCatalogEntry } from "./workspace-authorization.ts";
import { fitJson } from "./response-limit.ts";
import { criteriaProblem, hasAcceptanceHeader, isExhausted, EXHAUSTED_REASON, parseCriteria, nextStep, verdictText, verifierBrief, MAX_VERIFICATION_ATTEMPTS, VERIFIER_PRIORITY, summarizeVerification, type Criterion, type Verification, type VerificationSummary, type WorkerArtifacts } from "./verification-model.ts";
import type { TargetManifest } from "./verification-target.ts";

export { type DurablePlan, type DurablePlanSnapshot, type DurablePlanWork, type DurablePlanWorkSnapshot, type DurableResolvedAttempt, type DurableRole, type DurableGenerationLifecycle, type DurableGenerationLifecycleObserver } from "./durable-plan-types.ts";

const PAUSE_BLOCKER = "Interrupted by project pause";
const WORKER_PAUSE_BLOCKER = "Interrupted by worker pause";
const HELD_STOP_BLOCKER = "Stopped explicitly while waiting for its child work";
const PREDECESSOR_BLOCKER = "A predecessor did not complete";
const planUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StoredUsage = { baseline: Record<string, number>; final: Record<string, number>; delta: Record<string, number> };
type ModelTransition = DurableResolvedAttempt["modelTransitions"][number];
type StoredAttempt = { id: string; projectId: string; model: string; /** Frozen except for the audited owner-configured quota fallback. */ modelTransitions?: ModelTransition[]; quotaFallback?: string | null; thinking: "low" | "medium" | "high"; instructions: string; /** Skills this thread may read (frozen with its instructions); absent on older attempts. */ skills?: string[]; cwd: string; toolNames: string[]; /** Tools actually configured (observability only; toolNames stays the frozen requiredTools). */ boundTools?: string[]; bindingRevision: string; capabilityBindingRevision?: string; standingRevision: string; startedAt: number | null; endedAt: number | null; usage: StoredUsage };
type AttemptResult = { status: "completed" | "failed" | "interrupted"; reason: string | null; text?: string };
function isAttemptResult(value: unknown): value is AttemptResult { return typeof value === "object" && value !== null && "status" in value && (value.status === "completed" || value.status === "failed" || value.status === "interrupted"); }
function usageNumbers(value: unknown): Record<string, number> { const numbers: Record<string, number> = {}; const visit = (item: unknown, path: string): void => { if (typeof item === "number" && Number.isFinite(item)) { numbers[path] = item; return; } if (Array.isArray(item)) item.forEach((child, index) => visit(child, `${path}.${index}`)); else if (typeof item === "object" && item !== null) for (const [key, child] of Object.entries(item)) visit(child, path ? `${path}.${key}` : key); }; visit(value, ""); return numbers; }
function usageDelta(baseline: Record<string, number>, final: Record<string, number>): Record<string, number> { const delta: Record<string, number> = {}; for (const key of new Set([...Object.keys(baseline), ...Object.keys(final)])) delta[key] = (final[key] ?? 0) - (baseline[key] ?? 0); return delta; }
function canonicalIntent(work: Pick<StoredWork, "id" | "threadId" | "role" | "text" | "dependsOn" | "requestId" | "requiredTools" | "workspaceScopeId">): string { return JSON.stringify({ id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...new Set(work.dependsOn)].sort(), requestId: work.requestId, requiredTools: [...new Set(work.requiredTools)].sort(), workspaceScopeId: work.workspaceScopeId }); }
function sameIntent(left: Pick<StoredWork, "id" | "threadId" | "role" | "text" | "dependsOn" | "requestId" | "requiredTools" | "workspaceScopeId">, right: Pick<StoredWork, "id" | "threadId" | "role" | "text" | "dependsOn" | "requestId" | "requiredTools" | "workspaceScopeId">, includeId: boolean): boolean { return includeId ? canonicalIntent(left) === canonicalIntent(right) : canonicalIntent({ ...left, id: "" }) === canonicalIntent({ ...right, id: "" }); }
function profileHash(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }
function profileMismatches(first: StoredAttempt, next: StoredAttempt): string[] { const values: Array<[string, string, string]> = [["model", first.model, next.model], ["thinking", first.thinking, next.thinking], ["bindingRevision", first.bindingRevision, next.bindingRevision], ["capabilityBindingRevision", first.capabilityBindingRevision ?? first.bindingRevision, next.capabilityBindingRevision ?? next.bindingRevision], ["standingRevision", first.standingRevision, next.standingRevision], ["cwd", first.cwd, next.cwd], ["instructions", first.instructions, next.instructions], ["toolNames", first.toolNames.join("\u0000"), next.toolNames.join("\u0000")]]; return values.filter(([, left, right]) => left !== right).map(([name, left, right]) => `${name}:${profileHash(left)}!=${profileHash(right)}`); }
type RetryReceipt = { requestId: string; workId: string; attemptId: string; threadId: string };
type QuotaRecovery = { retryAt: number; attempts: number; lastError: string };
type StoredWork = { recoveredBy?: string; recoveryOf?: string[]; verificationRequest?: { revision: string; taskId: number }; id: string; threadId: string; role: DurableRole; text: string; dependsOn: string[]; requestId: string | null; steering?: true; quotaRecovery?: QuotaRecovery; /** Legacy single receipt, imported into retryReceipts before new admissions. */ manualRetryRequestId?: string; /** Hidden from default views; record, thread and report are retained. */ archivedAt?: number; retryOf?: string; priority?: number; requiredTools: string[]; workspaceScopeId: string | null; workspaceBindingRevision: string | null; workspaceConfigured: boolean; status: "queued" | "running" | "blocked" | "completed" | "failed" | "interrupted" | "stopped"; blocker: string | null; /** Count of resumes after a pause interruption; each retry needs a fresh submission requestId. */ resumes?: number; startedAt?: number | null; endedAt?: number | null; conversationId: ConversationId | null; taskId: TaskId | null; attempt: StoredAttempt | null; settlementTaskId?: TaskId; report?: { requestId: string; text: string; delivered: boolean }; /** Complete attempt result (capped at generation time), readable through projects_work_result; reports injected into chats are capped. */ result?: string; /** Coordinator chat that admitted this work and receives its report; absent means the root (Main). */ chatConversationId?: ConversationId; /** Child work: its report goes to this parent worker thread as a follow-up, not to a chat. */ parentThreadId?: string };
export type PlanningState = { retryReceipts?: RetryReceipt[]; paused: boolean; pausing: boolean; workerCap: number | null; work: Record<string, StoredWork>; threads: Record<string, { conversationId: ConversationId; activeWorkId: string | null; /** Scout/reviewer code root: a PR-head snapshot (readSha) or the parent worker's worktree. */ readRoot?: string; readSha?: string; workspaceScopeId: string | null; workspaceBindingRevision: string | null; workspaceConfigured: boolean; paused?: true; stopping?: true | string; /** What an explicit stop ended; reported once when that stop has drained. */ stopReport?: { stopId: string; workId: string; notes: string[] }; /** Set on child threads (one level); children cannot delegate. */ parentThreadId?: string; /** Takeover: the original thread whose worktree allocation (receipt identity) this thread uses. */ workspaceFrom?: string; /** Takeover: the thread that took this thread's worktree; this one may no longer run work. */ transferredTo?: string; /** Existing branch (and tip) this thread's worktree starts on. */ continueBranch?: { name: string; sha: string }; /** Automatic verification of this worker's finished work (opt-in project setting). */ verification?: Verification }>; dispatcherTaskIds: TaskId[] };

export const DurablePlanning = defineDoc<PlanningState>({ kind: "projects.durable-planning", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ paused: false, pausing: false, workerCap: null, work: {}, threads: {}, dispatcherTaskIds: [] }) });

type AttemptInput = { workId: string; conversationId: ConversationId; /** Root planning document ID, frozen for child-bound scoped tasks. */ planConversationId?: ConversationId; /** Legacy persisted v1 name. */ parentConversationId?: ConversationId; text: string; requestId: string; threadId?: string; role?: DurableRole; workspaceScopeId?: string };
/** A report injected into a coordinator or parent chat is at most REPORT_CAP characters as a whole; the complete result stays on the work record. */
const REPORT_CAP = 2000, TASK_ECHO = 200, ARTIFACT_ECHO = 800;
/** The result trimmed to `room` characters including its omission note, which holds the pointer to the full text. */
function capResult(text: string, pointer: string, room: number): string {
  if (text.length <= room) return text;
  const note = (omitted: number) => `\n… ${omitted} chars omitted; ${pointer}`;
  let end = Math.max(0, room - note(text.length).length);
  if (/[\ud800-\udbff]/.test(text[end - 1] ?? "")) end--;
  return `${text.slice(0, end)}${note(text.length - end)}`;
}
const RESULT_PAGE = 8000;
/** One page of a work item's complete result. Reports in chat are capped; this is the exact stored text. */
export function resultPage(work: StoredWork | undefined, args: { workId: string; offset?: number; limit?: number }): string {
  if (!work) throw new Error("Unknown work id");
  const text = work.result;
  if (text === undefined) return JSON.stringify({ workId: work.id, status: work.status, total: 0, text: "", nextOffset: null, note: work.status === "queued" || work.status === "running" ? "No result yet: the work has not finished." : "This work produced no text result." + (work.blocker ? ` Blocker: ${work.blocker}` : "") });
  const offset = args.offset ?? 0;
  const render = (characters: number) => { let end = Math.min(text.length, offset + characters); if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]!) && /[\udc00-\udfff]/.test(text[end]!)) end += end - offset > 1 ? -1 : 1; return { workId: work.id, status: work.status, total: text.length, offset, text: text.slice(offset, end), nextOffset: end < text.length ? end : null }; };
  // Without a limit the page is the longest one whose JSON (escapes included) fits 8 KiB.
  return args.limit !== undefined ? JSON.stringify(render(args.limit)) : fitJson(RESULT_PAGE, render, { min: 200 });
}
/** Artifact rows beyond the echo budget are left to projects_artifacts_list. */
function artifactEcho(summary: string): string {
  if (summary.length <= ARTIFACT_ECHO) return summary;
  const cut = summary.lastIndexOf("\n", ARTIFACT_ECHO);
  return `${summary.slice(0, cut > 0 ? cut : ARTIFACT_ECHO)}\n- … more files: projects_artifacts_list`;
}
function planConversationId(task: { input: AttemptInput }, runtime: { conversationId: ConversationId }): ConversationId { return task.input.planConversationId ?? task.input.parentConversationId ?? runtime.conversationId; }
/** A provider `model_error` settles with the provider's own text in `detail`; keep it so quota and throttling stay distinguishable. */
function unansweredReason(answer: { reason: string; detail?: unknown }): string { return answer.reason === "model_error" && typeof answer.detail === "string" && answer.detail ? `model_error: ${answer.detail.slice(0, 2000)}` : answer.reason; }
type ProviderFailure = "quota_exceeded" | "rate_limited";
/** Exhausted allowance only; a bare 429 or overload is transient. */
export function providerFailure(reason: string): ProviderFailure | undefined {
  if (!reason.startsWith("model_error")) return undefined;
  if (/quota exceeded|exceeded your (?:current )?quota|insufficient_quota|usage.?limit (?:reached|exceeded)|hit your .{0,20}limit|session limit|(?:five_hour|seven_day|weekly|monthly|daily) limit|credit balance (?:is )?(?:too low|exhausted|depleted|insufficient)|insufficient (?:credits|balance)|(?:not enough|no remaining) credits|out of budget|exceeded .{0,30}available balance|billing (?:hard )?limit (?:reached|exceeded)|payment required/i.test(reason)) return "quota_exceeded";
  if (/rate.?limit|too many requests|\b429\b|overloaded/i.test(reason)) return "rate_limited";
  return undefined;
}
/** Blocker text: the failure class and exact model first, then the provider's own words. Unclassified reasons stay as they were. */
function failureBlocker(reason: string, model: string | undefined): string {
  const kind = providerFailure(reason);
  return kind ? `${kind}: ${model ?? "unknown model"}: ${reason.replace(/^model_error: ?/, "")}` : reason;
}
/** Import older retry identities before accepting any new request, so later retries cannot overwrite them. */
function retryReceipts(state: PlanningState): RetryReceipt[] {
  if (state.retryReceipts === undefined) state.retryReceipts = Object.values(state.work).flatMap(work => [
    ...(work.manualRetryRequestId ? [{ requestId: work.manualRetryRequestId, workId: work.id, attemptId: work.id, threadId: work.threadId }] : []),
    ...(work.retryOf && work.requestId ? [{ requestId: work.requestId, workId: work.retryOf, attemptId: work.id, threadId: work.threadId }] : []),
  ]);
  return state.retryReceipts;
}
function rejectRetryRequest(state: PlanningState, requestId: string | undefined): void {
  if (requestId && retryReceipts(state).some(receipt => receipt.requestId === requestId)) throw new Error(`Conflicting duplicate requestId: ${requestId}`);
}
const QUOTA_RETRY_LIMIT = 8;
const QUOTA_RETRY_BASE_MS = 15 * 60_000;
const retryDelay = (attempt: number, base: number) => Math.min(6 * 60 * 60_000, base * 2 ** Math.min(attempt - 1, 8));
function quotaWaitBlocker(work: StoredWork): string | null {
  const recovery = work.quotaRecovery;
  return recovery ? `quota_reset_wait: ${work.attempt?.model} is waiting for quota recovery. Automatic retry ${recovery.attempts}/${QUOTA_RETRY_LIMIT} is due ${new Date(recovery.retryAt).toISOString()}. ${recovery.lastError.slice(0, 500)}` : null;
}
type AttemptState = { phase: "submit" };
const Attempt = defineTask<AttemptInput, AttemptState, { status: "completed" | "failed" | "interrupted"; reason: string | null }>({
  name: "projects.plan-attempt", version: 1, initial: () => ({ phase: "submit" }),
  phases: {
    submit: async (task, runtime, context) => {
      const child = await runtime.conversation(task.input.conversationId, context);
      if (!child) throw new Error("Planned worker conversation is missing");
      await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, planConversationId(task, runtime)); if (state.paused || state.pausing) throw new Error("Project plan is paused; worker submission is not authorized"); return undefined; }, context);
      const baseline = usageNumbers(await runtime.snapshot(UsageDoc, task.input.conversationId, context));
      await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, runtime.conversationId); const work = state.work[task.input.workId]; if (work?.attempt) work.attempt.usage.baseline = baseline; return undefined; }, context);
      let result: AttemptResult = { status: "failed", reason: "Attempt did not settle" };
      try {
        const submission = await child.submit({ type: "input", content: task.input.text, requestId: task.input.requestId, whenBusy: "followUp" }, context);
        const answer = await submission.wait(context);
        result = answer.status === "unanswered" ? { status: answer.reason === "aborted" ? "interrupted" : "failed", reason: unansweredReason(answer) } : { status: "completed", reason: null };
        if (answer.status === "done" && answer.type === "input") {
          await runtime.commit(async tx => {
            const entry = await tx.entry(AssistantEntry, answer.answer);
            const message = entry?.model?.[0];
            result.text = message?.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").slice(0, 16000) : "";
            return undefined;
          }, context);
        }
      } catch (error) {
        result = { status: runtime.signal.aborted ? "interrupted" : "failed", reason: error instanceof Error ? error.message : String(error) };
      }
      const final = usageNumbers(await runtime.snapshot(UsageDoc, task.input.conversationId, context));
      await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, runtime.conversationId); const work = state.work[task.input.workId]; if (work?.attempt) work.attempt.usage = { baseline, final, delta: usageDelta(baseline, final) }; return { status: "terminal", outcome: { status: "completed", result } }; }, context);
    },
  },
  abort: async (task, runtime, context) => { const final = usageNumbers(await runtime.snapshot(UsageDoc, task.input.conversationId, context)); await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, runtime.conversationId); const work = state.work[task.input.workId]; if (work?.attempt) { const baseline = work.attempt.usage.baseline; work.attempt.usage = { baseline, final, delta: usageDelta(baseline, final) }; } return { status: "terminal", outcome: { status: "completed", result: { status: "interrupted", reason: "aborted" } } }; }, context); },
});

/**
 * Planning uses a bounded Durable dispatcher, not a process-global scheduler. Each wave is admitted atomically and
 * only the dispatcher creates attempt tasks for integrated projects.
 */
const ARCHIVABLE = new Set(["completed", "failed", "stopped", "blocked"]);

export type VerificationHooks = {
  /** Read fresh at the end of each worker turn. */
  config: () => { enabled: boolean; skill: string };
  /** A problem that makes verification impossible right now (missing skill or model), or null. */
  check: () => Promise<string | null>;
  /** Why verifier commands cannot run under this worker's shell policy (e.g. a workspace provider that owns it), or null. */
  scopeCheck: (scopeId: string) => string | null;
  /** Records the exact revision of the worker's tree that one attempt verifies; idempotent per key. */
  capture: (key: string, sourcePath: string) => Promise<{ manifest: TargetManifest; proof: { paths: string[]; diff: string } }>;
  /** Content revision of a tree now, uncommitted and untracked work included. */
  revision: (sourcePath: string) => Promise<string>;
  /** Whether the author still owns background commands or leases. */
  workerBusy?: (threadId: string) => boolean;
  /** Stops verifier jobs before final target validation, without releasing its leases. */
  drain: (verifierThreadId: string) => Promise<void>;
  /** Releases leases only when no verification or stop drain still owns them. */
  release: (verifierThreadId: string) => Promise<void>;
};
type PreparedVerification =
  | { kind: "none" }
  | { kind: "revision"; current: string | null; verifierThreadId: string }
  | { kind: "escalate"; reason: string }
  | { kind: "start"; n: number; model: string; skill: string; key: string; scopeId: string; sourcePath: string; manifest: TargetManifest; proof: { paths: string[]; diff: string }; criteria: Criterion[]; task: string; artifacts?: WorkerArtifacts };

export function planningRuntime(options: { projectId: string; models: Record<DurableRole, ModelRef>; /** Owner-configured quota fallback; null waits for the frozen model. */ fallbackModels?: Record<DurableRole, string | null>; /** Test override for unknown-reset backoff. */ quotaRetryBaseMs?: number; /** Cached provider reset only; never polls or reads credentials. */ quotaResetAt?: (model: string, now: number) => number | undefined; /** Direct-runtime test rendezvous before settlement reads mutable plan state. */ testBeforeWorkSettlement?: (workId: string) => Promise<void>; resolveModel?: (model: string, role: DurableRole) => ModelRef; cwd: string; instructions: Record<DurableRole, string>; /** Host-only: rebuilds the skill index before a new thread freezes its instructions. */ refreshSkills?: () => Promise<void>; /** Host-only: names of the skills a new thread of this role may read, in step with its instructions. */ skillNames?: (role: DurableRole) => string[]; standingRevision: string; workspaceInstructions?: DurableWorkspaceInstructions; knowledgeTools: readonly ToolRegistration[]; /** Scout and reviewer only: read-only checkout tools and their extension. */ readOnlyCode?: { tools: readonly ToolRegistration[]; extension: ReturnType<typeof defineExtension> }; /** Reviewer only: the review-verdict tool and its extension. */ reviewerTools?: { tools: readonly ToolRegistration[]; extension: ReturnType<typeof defineExtension> }; workerPolicy: ReturnType<typeof defineExtension>; /** Every role: the profile-restricted skill reader. */ skillFiles?: { tool: ToolRegistration; extension: ReturnType<typeof defineExtension> }; /** Every role: the MCP gateway tools (servers are filtered per role at call time). */ mcp?: { tools: readonly ToolRegistration[]; extension: ReturnType<typeof defineExtension> }; workerTools?: DurableWorkerToolBindings; /** Host hooks of the opt-in verification loop; absent means the project cannot verify. */ verification?: VerificationHooks; /** Verifier-only tools (trusted run, verdict, leases/background), offered to verifier threads and nobody else. */ verifierTools?: { tools: readonly ToolRegistration[]; extension: ReturnType<typeof defineExtension> }; workerCap: number; workspaceCatalog?: () => readonly WorkspaceCatalogEntry[]; /** Host-only scoped-worker preparation; absent means every workspace scope is denied. */ prepareWorkerEnvironment?: DurablePrepareWorkerEnvironment; /** Host-only registry publication, invoked after post-preparation authorization validation. */ publishWorkerEnvironment?: DurablePublishWorkerEnvironment; beforeScopedSubmit?: () => Promise<void>; /** Root conversation owning the shared plan, so delegation from any chat admits into one pool. */ planRoot?: () => ConversationId | undefined; /** Host-only: fetch a ref into a read-only snapshot for scout/reviewer threads. */ readHead?: (ref: string) => Promise<{ root: string; sha: string }>; /** Host-only: resolve and authorize an existing branch / PR for a worker to continue; rejects branches the owner does not own. */ resolveBranch?: (ref: string, workspaceScopeId: string | undefined) => Promise<{ name: string; sha: string }>; /** Host-only: short listing of a thread's artifacts folder for its report (empty when none). */ artifactSummary?: (threadId: string) => string; /** Host-only: a worker's artifacts folder and its files, named in its verifier's brief. */ workerArtifacts?: (threadId: string) => WorkerArtifacts }) {
  if (!Number.isSafeInteger(options.workerCap) || options.workerCap < 1) throw new Error("workerCap must be a positive integer");
  if (options.workerTools && (!options.workerTools.revision || options.workerTools.revision.length > 256)) throw new Error("Worker capability bindings require a revision");
  const bindings = new Map((options.workerTools?.tools ?? []).map(tool => [tool.name, tool]));
  const bindingRevision = options.workerTools?.revision ?? "no-worker-capabilities";
  let extension: ReturnType<typeof defineExtension>;
  const capabilities = defineExtension({ name: "projects.worker-capability-bindings", tools: [...bindings.values()] });
  type DispatcherState = { phase: "dispatch" } | { phase: "wait"; taskIds: TaskId[] };
  const ScopedAttempt = defineTask<AttemptInput, AttemptState, { status: "completed" | "failed" | "interrupted"; reason: string | null }>({ name: "projects.scoped-plan-attempt", version: 1, initial: () => ({ phase: "submit" }), phases: { submit: async (task, runtime, context) => {
    const child = await runtime.conversation(task.input.conversationId, context); if (!child) throw new Error("Planned worker conversation is missing");
    const rootPlanConversationId = planConversationId(task, runtime); if (task.input.planConversationId !== undefined && runtime.conversationId !== task.input.conversationId) throw new Error("Scoped attempt task is not bound to its worker conversation");
    if (!task.input.threadId || !task.input.role || !task.input.workspaceScopeId) throw new Error("Scoped attempt input is incomplete");
    let frozen!: { instructions: string; configured: boolean };
    // Read-only check: a value returned from runtime.commit is a task-state transition, so capture instead of returning.
    await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, rootPlanConversationId); const work = state.work[task.input.workId]; if (!work || work.taskId !== Number(runtime.taskId) || work.status !== "running" || state.paused || work.threadId !== task.input.threadId || work.role !== task.input.role || work.workspaceScopeId !== task.input.workspaceScopeId || work.conversationId !== task.input.conversationId || state.threads[work.threadId]?.activeWorkId !== work.id) throw new Error("Scoped attempt identity/active authorization no longer matches its frozen plan work"); const profile = work.attempt; if (!profile) throw new Error("Scoped attempt has no frozen profile"); const model = frozenModel(profile, work.role); if ( profile.model !== `${model.provider}/${model.modelId}` || profile.thinking !== "medium" || profile.standingRevision !== options.standingRevision || (profile.capabilityBindingRevision ?? profile.bindingRevision) !== bindingRevision) throw new Error("Scoped attempt frozen profile differs from current host settings"); frozen = { instructions: profile.instructions, configured: work.workspaceConfigured }; return undefined; }, context);
    if (frozen.configured && (await runtime.agent(context)).instructions !== frozen.instructions) throw new Error("Scoped thread instruction text no longer matches its frozen profile");
    const publish = options.publishWorkerEnvironment; let environment; try { environment = await options.prepareWorkerEnvironment?.({ conversationId: Number(task.input.conversationId), workId: task.input.workId, threadId: task.input.threadId, role: task.input.role, workspaceScopeId: task.input.workspaceScopeId }); if (!environment || !publish) throw new Error("Scoped worker environment was not prepared/publishable by the host"); } catch (error) { return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "failed", reason: error instanceof Error ? error.message : String(error) } } }), context); }
    await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, rootPlanConversationId); const work = state.work[task.input.workId]; if (!work || work.taskId !== Number(runtime.taskId) || work.status !== "running" || state.paused || state.threads[work.threadId]?.activeWorkId !== work.id || work.workspaceScopeId !== task.input.workspaceScopeId) throw new Error("Scoped worker binding/active authorization changed before configuration"); if (work.workspaceBindingRevision !== null && work.workspaceBindingRevision !== environment.bindingRevision) throw new Error("Scoped worker binding revision changed"); publish(environment.extension); const needsConfigure = !work.workspaceConfigured || work.attempt?.cwd !== environment.cwd; if (needsConfigure) { const profile = work.attempt; if (!profile) throw new Error("Scoped worker lost its frozen profile before configuration"); if (!frozen.configured && environment.repositoryStanding && !options.workspaceInstructions) throw new Error("Selected repository standing instructions require the host instruction factory"); const rebuiltPrompt = !frozen.configured && environment.repositoryStanding && options.workspaceInstructions; const baseInstructions = rebuiltPrompt ? options.workspaceInstructions!(work.role, environment.repositoryStanding!) : profile.instructions; const verificationInstructions = !frozen.configured && work.role === "worker" ? (nests(work) ? " When verification is enabled, finish the candidate and command evidence, stop background jobs, release leases and wait for children. Call projects_request_verification, then end your turn. Read verifier feedback, repair in this same thread and request another check within the fixed budget. If blocked, report the specific blocker. A response alone does not verify the task." : " Return your evidence and result to your parent worker; only the parent can request verification.") : ""; const instructions = `${baseInstructions}${verificationInstructions}${environment.workerInstructions ?? ""}`; await configure(tx, task.input.conversationId, { model: work.attempt ? frozenModel(work.attempt, work.role) : options.models[work.role], thinkingLevel: "medium", cwd: environment.cwd, tools: [...options.knowledgeTools, ...work.requiredTools.map(name => bindings.get(name)!), ...environment.tools, ...(nests(work) ? [delegateChild, childResult, requestVerification] : []), ...(options.skillFiles ? [options.skillFiles.tool] : []), ...(options.mcp?.tools ?? [])], extensions: [options.workerPolicy, capabilities, environment.extension, ...(nests(work) ? [delegation] : []), ...(options.skillFiles ? [options.skillFiles.extension] : []), ...(options.mcp ? [options.mcp.extension] : [])], instructions }); profile.instructions = instructions; if (rebuiltPrompt && options.skillNames) profile.skills = options.skillNames(work.role); if (work.attempt) { work.attempt.boundTools = [...options.knowledgeTools, ...work.requiredTools.map(name => bindings.get(name)!), ...environment.tools, ...(nests(work) ? [delegateChild, childResult, requestVerification] : []), ...(options.skillFiles ? [options.skillFiles.tool] : []), ...(options.mcp?.tools ?? [])].map(tool => tool.name); work.attempt.cwd = environment.cwd; work.attempt.bindingRevision = environment.bindingRevision; } work.workspaceConfigured = true; work.workspaceBindingRevision = environment.bindingRevision; const thread = state.threads[work.threadId]; if (thread) { thread.workspaceConfigured = true; thread.workspaceBindingRevision = environment.bindingRevision; } } return undefined; }, context);
    await options.beforeScopedSubmit?.(); const baseline = usageNumbers(await runtime.snapshot(UsageDoc, task.input.conversationId, context)); await runtime.commit(async tx => { const work = (await tx.doc(DurablePlanning, rootPlanConversationId)).work[task.input.workId]; if (work?.attempt) work.attempt.usage.baseline = baseline; return undefined; }, context); let result: AttemptResult;
    try { const submission = await child.submit({ type: "input", content: task.input.text, requestId: task.input.requestId, whenBusy: "followUp" }, context); const answer = await submission.wait(context); result = answer.status === "unanswered" ? { status: answer.reason === "aborted" ? "interrupted" : "failed", reason: unansweredReason(answer) } : { status: "completed", reason: null }; if (answer.status === "done" && answer.type === "input") { await runtime.commit(async tx => { const entry = await tx.entry(AssistantEntry, answer.answer); const message = entry?.model?.[0]; result.text = message?.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").slice(0, 16000) : ""; return undefined; }, context); } } catch (error) { result = { status: runtime.signal.aborted ? "interrupted" : "failed", reason: error instanceof Error ? error.message : String(error) }; }
    const final = usageNumbers(await runtime.snapshot(UsageDoc, task.input.conversationId, context)); await runtime.commit(async tx => { const work = (await tx.doc(DurablePlanning, rootPlanConversationId)).work[task.input.workId]; if (work?.attempt) work.attempt.usage = { baseline, final, delta: usageDelta(baseline, final) }; return { status: "terminal", outcome: { status: "completed", result } }; }, context);
  } }, abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "interrupted", reason: "aborted" } } }), context) });
  const Report = defineTask<{ workId: string }, { phase: "report" }, null>({
    name: "projects.plan-report", version: 1, initial: () => ({ phase: "report" }),
    phases: {
      report: async (task, runtime, context) => {
        let pending: StoredWork["report"], target = runtime.conversationId;
        await runtime.commit(async tx => {
          const state = await tx.doc(DurablePlanning, runtime.conversationId);
          const work = state.work[task.input.workId];
          if (state.paused || state.pausing || !work?.report || work.report.delivered) return undefined;
          target = work.chatConversationId ?? runtime.conversationId;
          const receipt = await tx.submissionByRequest(target, work.report.requestId);
          if (receipt?.status === "unanswered" && receipt.reason === "aborted") work.report.requestId += ":resume";
          pending = { ...work.report };
          return undefined;
        }, context);
        if (pending) {
          const parent = await runtime.conversation(target, context) ?? await runtime.conversation(runtime.conversationId, context);
          if (!parent) throw new Error("Coordinator conversation is missing");
          const submission = await parent.submit({ type: "input", content: pending.text, requestId: pending.requestId, whenBusy: "followUp" }, context);
          const answer = await submission.wait(context);
          await runtime.commit(async tx => {
            const work = (await tx.doc(DurablePlanning, runtime.conversationId)).work[task.input.workId];
            if (work?.report && work.report.requestId === pending?.requestId && (answer.status !== "unanswered" || answer.reason !== "aborted")) work.report.delivered = true;
            return undefined;
          }, context);
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const Settlement = defineTask<{ workId: string; attemptTaskId: TaskId }, { phase: "wait" } | { phase: "settle" }, null>({
    name: "projects.plan-settlement", version: 1, initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, runtime, context) => runtime.commit(() => ({ status: "waiting", checkpoint: { phase: "settle" }, on: [task.input.attemptTaskId], policy: "allSettled" }), context),
      settle: async (task, runtime, context) => {
        const [outcome] = await runtime.outcomes([task.input.attemptTaskId], context);
        const result = outcome?.status === "completed" && isAttemptResult(outcome.result) ? outcome.result : undefined;
        await options.testBeforeWorkSettlement?.(task.input.workId);
        let prepared: PreparedVerification = { kind: "none" };
        try {
          prepared = await prepareVerification(runtime.conversationId, change => runtime.commit(change, context), task.input.workId, result?.status === "completed", task.input.attemptTaskId);
          await runtime.commit(async tx => {
            const state = await tx.doc(DurablePlanning, runtime.conversationId);
            const work = state.work[task.input.workId];
            // A paused, stopped, or resumed attempt must not replace the newer thread state.
            if (work?.status === "running" && work.taskId === Number(task.input.attemptTaskId)) {
              const quota = result?.status === "failed" && result.reason && providerFailure(result.reason) === "quota_exceeded" ? failureBlocker(result.reason, work.attempt?.model) : undefined;
              const recovery = work.quotaRecovery ?? { retryAt: 0, attempts: 0, lastError: "" };
              if (quota && work.role !== "verifier" && recovery.attempts < QUOTA_RETRY_LIMIT && !state.paused && !state.threads[work.threadId]?.paused && !state.threads[work.threadId]?.stopping) {
                const attempt = work.attempt;
                if (!attempt || work.conversationId === null) throw new Error("Quota recovery lost its frozen worker profile");
                const configuredFallback = attempt.quotaFallback;
                const switchModel = configuredFallback && configuredFallback !== attempt.model && !attempt.modelTransitions?.length ? configuredFallback : undefined;
                let fallbackModel: ModelRef | undefined;
                if (switchModel) {
                  try { fallbackModel = frozenModel({ ...attempt, model: switchModel }, work.role); }
                  catch { /* A removed fallback must not strand settlement; wait for the frozen model instead. */ }
                }
                if (switchModel && fallbackModel) {
                  const from = attempt.model;
                  await configure(tx, work.conversationId, { model: fallbackModel });
                  attempt.model = switchModel;
                  attempt.modelTransitions = [...(attempt.modelTransitions ?? []), { at: Date.now(), from, to: switchModel, reason: "quota_exceeded" }];
                  // Queued follow-ups share this conversation's model, but completed attempts keep their history.
                  for (const pending of Object.values(state.work)) if (pending.id !== work.id && pending.threadId === work.threadId && pending.status === "queued" && pending.attempt) {
                    pending.attempt.model = switchModel;
                    pending.attempt.modelTransitions = attempt.modelTransitions.map(item => ({ ...item }));
                  }
                }
                const attempts = recovery.attempts + 1, now = Date.now();
                const resetAt = options.quotaResetAt?.(attempt.model, now);
                const retryAt = fallbackModel ? now : resetAt ?? now + retryDelay(attempts, options.quotaRetryBaseMs ?? QUOTA_RETRY_BASE_MS);
                work.status = "queued"; work.taskId = null; work.startedAt = null; work.endedAt = null;
                work.quotaRecovery = { retryAt, attempts, lastError: quota };
                work.blocker = quotaWaitBlocker(work);
                attempt.startedAt = null; attempt.endedAt = null;
                const activeThread = state.threads[work.threadId]; if (activeThread?.activeWorkId === work.id) activeThread.activeWorkId = null;
                state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
                return { status: "terminal", outcome: { status: "completed", result: null } };
              }
              work.status = result?.status === "completed" ? "completed" : result?.status === "interrupted" ? "interrupted" : "failed";
              work.endedAt = Date.now();
              work.blocker = work.status === "completed" ? null : result?.reason ? failureBlocker(result.reason, work.attempt?.model) : `Durable task ${outcome?.status ?? "missing"}`;
              if (work.status === "failed" && recovery.attempts >= QUOTA_RETRY_LIMIT && quota) work.blocker = `quota_recovery_exhausted: ${QUOTA_RETRY_LIMIT} automatic retries did not restore quota. ${work.blocker}`;
              work.attempt &&= { ...work.attempt, endedAt: work.endedAt };
              const thread = state.threads[work.threadId];
              if (thread?.activeWorkId === work.id) thread.activeWorkId = null;
              const resultText = result?.text ?? work.blocker ?? "No text result.";
              if (result?.text) work.result = result.text;
              const active = (other: StoredWork) => other.id !== work.id && (other.status === "queued" || other.status === "running");
              // A parent's answer while its children still run (or a later child result waits on its thread) is held: only its last answer reports.
              const held = work.status === "completed" && nests(work) && Object.values(state.work).some(other => active(other) && (other.parentThreadId === work.threadId || other.threadId === work.threadId && other.requestId?.startsWith("child-report:")));
              // A repair turn that fails ends its cycle (a pause-interrupted one keeps it open for the resume); earlier completed turns stop counting as complete and their dependents block.
              if (work.status === "failed" && work.role === "worker" && state.threads[work.threadId]?.verification?.open) abandonCycle(state, work.threadId, `The worker's repair turn failed: ${work.blocker ?? "no reason recorded"}`);
              const verifying = work.status !== "interrupted" && work.role === "verifier" ? await settleVerifier(tx, runtime.conversationId, state, work, prepared, String(task.input.attemptTaskId)) : work.status === "completed" && !held && await startVerification(tx, runtime.conversationId, state, work, prepared, resultText, String(task.input.attemptTaskId));
              if (!verifying && work.status !== "interrupted" && !(work.parentThreadId && await reportToParent(tx, runtime.conversationId, state, work, String(task.input.attemptTaskId), resultText))) {
                if (held) work.report = { requestId: `held:${work.id}:${task.input.attemptTaskId}`, delivered: true, text: resultText.slice(0, 2000) };
                else {
                  const chat = work.chatConversationId === undefined ? null : Number(work.chatConversationId);
                  const others = Object.values(state.work).filter(other => active(other) && (other.chatConversationId === undefined ? null : Number(other.chatConversationId)) === chat).length;
                  work.report = { requestId: `plan-report:${work.id}:${task.input.attemptTaskId}`, delivered: false, text: reportText(work, resultText, others) };
                  await tx.createTask(Report, { workId: work.id }, { ownership: { kind: "conversation" }, background: true });
                }
              }
              if (!state.paused) state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        } finally {
          if (prepared.kind === "revision") await options.verification?.release(prepared.verifierThreadId);
        }
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const Dispatcher = defineTask<null, DispatcherState, null>({
    name: "projects.plan-dispatcher", version: 1, initial: () => ({ phase: "dispatch" }),
    phases: {
      dispatch: async (_task, runtime, context) => {
        await runtime.commit(async tx => {
          const ids = await dispatch(tx, runtime.conversationId);
          return ids.length === 0
            ? { status: "terminal", outcome: { status: "completed", result: null } }
            : { status: "waiting", checkpoint: { phase: "wait", taskIds: ids }, on: ids, policy: "allSettled" };
        }, context);
      },
      wait: async (task, runtime, context) => {
        const ids = task.state.checkpoint.taskIds;
        const outcomes = await runtime.outcomes(ids, context);
        await runtime.commit(async tx => {
          const state = await tx.doc(DurablePlanning, runtime.conversationId);
          for (let index = 0; index < ids.length; index++) {
            const work = Object.values(state.work).find(candidate => candidate.taskId === Number(ids[index]));
            if (!work || work.status !== "running" || work.settlementTaskId !== undefined) continue;
            const outcome = outcomes[index];
            const result = outcome?.status === "completed" && isAttemptResult(outcome.result) ? outcome.result : undefined;
            work.status = result?.status === "completed" ? "completed" : result?.status === "interrupted" ? "interrupted" : "failed";
            work.endedAt = Date.now();
            work.blocker = work.status === "completed" ? null : result?.reason ? failureBlocker(result.reason, work.attempt?.model) : `Durable task ${outcome?.status ?? "missing"}`;
            work.attempt &&= { ...work.attempt, endedAt: Date.now() };
            const thread = state.threads[work.threadId];
            if (thread) thread.activeWorkId = null;
          }
          return { status: "running", checkpoint: { phase: "dispatch" } };
        }, context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  const delegate = defineTool({ name: "projects_delegate", description: "Admit bounded durable worker work. Choose role worker, scout, or reviewer for the task. For an owner-authorized workspace, pass workspaceScopeId and omit requiredTools; a worker without one uses the project's only whole-repository scope when exactly one exists, and the receipt names the scope used. Roles select model/instructions; scout and reviewer also get read-only code tools (code_read, code_grep, code_find, code_ls) and ignore workspaceScopeId. Their code root is the project checkout unless you pass a target: threadId of an existing worker thread (they read that worker's worktree, including its uncommitted edits; use this to review a worker's PR or work), or ref: a branch (e.g. a project PR branch pi/...), pull/<number> or a commit SHA; the host fetches it from origin (or the project's checkout provider) into a read-only snapshot so they read the PR head, not the owner's checkout. They also get code_diff (changed files and unified diff against the merge-base). Give every reviewer of a PR or worker's change a threadId or ref. An unknown threadId or unresolvable ref fails the call. A new worker normally starts a fresh branch from trunk. To continue earlier work in a new thread (prefer a follow-up to the same thread when possible), pass fromThread (take over a settled worker thread's worktree with its commits and uncommitted changes; the old thread can no longer work) or branch (an existing branch or PR of the owner; the worker's pushes update that PR). Never move patches between threads through artifacts. Independent delegations run concurrently up to the project worker cap. Completion or failure sends a result back to this coordinator. The host supplies exact scoped read/write and authorized publication tools after allocation. requiredTools selects only additional global tool names explicitly advertised by the host; never invent aliases such as workspace_read, workspace_write or projects_github. Missing capabilities remain blocked.", parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 32000 }), role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")])), requiredTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })), workspaceScopeId: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })), ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Scout/reviewer only: branch, pull/<number> or commit SHA to read instead of the project checkout." })), threadId: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$", description: "Scout/reviewer only: UUID of an existing worker thread whose worktree to read (read-only)." })), fromThread: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$", description: "Worker only: UUID of a settled worker thread whose worktree (branch, commits and uncommitted changes) the new thread takes over. The old thread can no longer work." })), branch: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Worker only: existing branch or PR number the new thread continues, so its pushes update that PR. git: a project branch; checkout provider plugins apply their own ownership rules." })), acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20, description: "Acceptance criteria: what done means and the evidence expected. Appended to the brief; the worker keeps going until they are met or it is genuinely blocked." })) }), replay: "unsafe", async execute(args, api, context) {
    const role = args.role ?? "worker";
    await options.refreshSkills?.();
    const brief = args.acceptance?.length ? `${args.task}\n\nAcceptance criteria (done means all are met, with the evidence named; keep working until then, stop only for a real blocker):\n${args.acceptance.map(item => `- ${item.trimStart().replaceAll("\n", "\n  ")}`).join("\n")}` : args.task;
    if (brief.length > 32000) throw new Error("Task plus acceptance criteria exceed 32000 characters");
    if (args.ref !== undefined && role === "worker") throw new Error("ref is for scout and reviewer; to continue an existing branch with a worker pass branch (or fromThread to take over a worker thread's worktree)");
    if (args.threadId !== undefined && role === "worker") throw new Error("threadId is for scout and reviewer; a worker is continued with a follow-up to its thread");
    if (args.threadId !== undefined && args.ref !== undefined) throw new Error("Pass either threadId or ref, not both");
    if (args.fromThread !== undefined && args.branch !== undefined) throw new Error("Pass either fromThread or branch, not both");
    if ((args.fromThread !== undefined || args.branch !== undefined) && role !== "worker") throw new Error("fromThread and branch are for worker delegations; scouts and reviewers use threadId or ref");
    if (args.ref !== undefined && !options.readHead) throw new Error("PR-head reads are unavailable for this project");
    const head = args.ref === undefined ? undefined : await options.readHead!(args.ref);
    const ignoredScope = role !== "worker" && args.workspaceScopeId !== undefined;
    let continueBranch: { name: string; sha: string } | undefined;
    if (args.branch !== undefined) {
      if (!options.resolveBranch) throw new Error("Branch continuation is unavailable for this project");
      continueBranch = await options.resolveBranch(args.branch, args.workspaceScopeId ?? defaultWorkerScope(role, args.requiredTools));
    }
    // Every chat shares the root's plan and worker pool; the delegating chat receives the report.
    const owner = options.planRoot?.() ?? api.conversationId;
    const receipt = await api.commit(async tx => {
      // A thread target is resolved against the plan in the same transaction, so an unknown or worktree-less thread fails the call instead of reading trunk.
      const state = await tx.doc(DurablePlanning, owner);
      const threadRoot = args.threadId === undefined ? undefined : threadReadRoot(state, args.threadId);
      const source = args.fromThread === undefined ? undefined : takeoverSource(state, args.fromThread, args.workspaceScopeId);
      const threadId = crypto.randomUUID();
      const record = await admit(tx, owner, { id: crypto.randomUUID(), threadId, role, text: brief, requiredTools: args.requiredTools, workspaceScopeId: role === "worker" ? source?.scopeId ?? args.workspaceScopeId ?? defaultWorkerScope(role, args.requiredTools) : undefined, ...(head ? { readRoot: head.root, readSha: head.sha } : threadRoot ? { readRoot: threadRoot } : {}), ...(source ? { workspaceFrom: source.origin } : {}), ...(continueBranch ? { continueBranch } : {}) }, true, api.conversationId);
      // Ownership moves in the same transaction that admits the new thread, so there is no state with two owners or none.
      if (source) state.threads[args.fromThread!].transferredTo = threadId;
      return workReceipt(record);
    }, context);
    return { content: [{ type: "text", text: JSON.stringify({ ...receipt, ...(head ? { reads: { ref: args.ref, sha: head.sha } } : {}), ...(args.threadId !== undefined ? { reads: { threadId: args.threadId } } : {}), ...(args.fromThread !== undefined ? { takesOver: { threadId: args.fromThread } } : {}), ...(continueBranch ? { continues: continueBranch } : {}), ...(ignoredScope ? { note: "workspaceScopeId ignored: scouts and reviewers are read-only" } : {}) }) }] };
  } });
  // One level of nesting: top-level worker threads may delegate children; children never get this tool and are refused if they call it.
  const MAX_ACTIVE_CHILDREN = 2;
  const MAX_REVIEW_CHILDREN = 3;
  const delegateChild = defineTool({ name: "projects_delegate_child", description: `Delegate a bounded sub-task to a child thread: worker (gets your workspace scope), scout or reviewer (read-only code tools on your worktree, so they see your current changes). Children share the project worker pool and cannot delegate further. Delegate only genuinely independent work that should run in parallel with yours; do small reads, checks and status questions yourself. For coordinated review, admit independent Standards, Spec and Bugs/performance axes before awaiting results. Deduplicate identical rounds, not distinct coverage at the same head. A child's result comes back to you as a new message in this thread after it finishes, not to the coordinator: end your turn after delegating if you need the result, then continue when it arrives. Only your answer after the last child result reaches the coordinator. At most ${MAX_ACTIVE_CHILDREN} children may be queued or running, or ${MAX_REVIEW_CHILDREN} when all are independent reviewers.`, parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 32000 }), role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")])) }), replay: "unsafe", async execute(args, api, context) {
    const owner = options.planRoot?.();
    if (owner === undefined) throw new Error("Project plan is unavailable");
    // A new child sees the catalog as it is now; the parent's own frozen prompt and skill list are not touched.
    await options.refreshSkills?.();
    const receipt = await api.commit(async tx => {
      const state = await tx.doc(DurablePlanning, owner), entry = Object.entries(state.threads).find(([, thread]) => Number(thread.conversationId) === Number(api.conversationId));
      if (!entry) throw new Error("Only worker threads can delegate child work");
      const [parentThreadId, thread] = entry, latest = Object.values(state.work).findLast(work => work.threadId === parentThreadId);
      if (thread.parentThreadId) throw new Error("Child threads cannot delegate further (one level of nesting)");
      if (latest?.role !== "worker") throw new Error("Only worker threads can delegate child work");
      if (thread.stopping) throw new Error("This thread is stopping");
      if (latest?.verificationRequest) throw new Error("Verification was requested; yield this turn before delegating more work");
      const role = args.role ?? "worker";
      const activeChildren = Object.values(state.work).filter(work => work.parentThreadId === parentThreadId && (work.status === "queued" || work.status === "running"));
      const limit = role === "reviewer" && activeChildren.every(work => work.role === "reviewer") ? MAX_REVIEW_CHILDREN : MAX_ACTIVE_CHILDREN;
      if (activeChildren.length >= limit) throw new Error(`You already have ${limit} children queued or running; wait for their results`);
      // A read-only child reads its parent's worktree (the head the parent is building), not the owner's checkout.
      const parentRoot = role !== "worker" && thread.workspaceConfigured && thread.workspaceScopeId !== null && latest.attempt?.cwd && latest.attempt.cwd !== options.cwd ? latest.attempt.cwd : undefined;
      const record = await admit(tx, owner, { id: randomUUID(), threadId: randomUUID(), role, text: args.task, workspaceScopeId: role === "worker" ? thread.workspaceScopeId ?? undefined : undefined, parentThreadId, ...(parentRoot ? { readRoot: parentRoot } : {}) }, true, latest.chatConversationId);
      return { ...workReceipt(record), role, parentThreadId };
    }, context);
    return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
  } });
  const ResultArgs = Type.Object({ workId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000, description: `Characters per page (default ${RESULT_PAGE}).` })) }, { additionalProperties: false });
  const childResult = defineTool({ name: "projects_child_result", description: "Read the complete result of one of your own children (results in your messages are capped). Paged by characters; follow nextOffset.", parameters: ResultArgs, replay: "safe", async execute(args, api, context) {
    const owner = options.planRoot?.();
    if (owner === undefined) throw new Error("Project plan is unavailable");
    const page = await api.commit(async tx => {
      const state = await tx.doc(DurablePlanning, owner), entry = Object.entries(state.threads).find(([, thread]) => Number(thread.conversationId) === Number(api.conversationId)), work = state.work[args.workId];
      if (!entry || work?.parentThreadId !== entry[0]) throw new Error("Unknown work id");
      return resultPage(work, args);
    }, context);
    return { content: [{ type: "text", text: page }] };
  } });
  async function workResult(root: Conversation, args: { workId: string; offset?: number; limit?: number }): Promise<string> {
    return root.commit(async tx => resultPage((await tx.doc(DurablePlanning, root.id)).work[args.workId], args), BACKGROUND_CONTEXT);
  }
  const requestVerification = defineTool({ name: "projects_request_verification", description: "Request independent verification of the current candidate. Finish your commands and release children, background jobs and leases first. Yield this turn immediately after the request. The host selects the verifier and checks the frozen budget.", parameters: Type.Object({}, { additionalProperties: false }), replay: "unsafe", async execute(_args, api, context) {
    const root = options.planRoot?.(), hooks = options.verification;
    if (root === undefined || !hooks) throw new Error("Verification is unavailable");
    const identity = await api.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root), entry = Object.entries(state.threads).find(([, thread]) => Number(thread.conversationId) === Number(api.conversationId));
      if (!entry) throw new Error("Only the active top-level worker can request verification");
      const [threadId, thread] = entry, work = thread.activeWorkId ? state.work[thread.activeWorkId] : undefined;
      if (!work || work.role !== "worker" || thread.parentThreadId || work.status !== "running" || !work.workspaceConfigured || !work.attempt?.cwd || state.paused || state.pausing || thread.stopping) throw new Error("Only an active scoped top-level worker can request verification");
      if (work.verificationRequest) throw new Error("Verification was already requested for this turn");
      if (isExhausted(thread.verification)) throw new Error(EXHAUSTED_REASON);
      if (!thread.verification?.open && !(thread.verification?.outcome === "escalated" && thread.verification.attempts.length) && !hooks.config().enabled) throw new Error("Verification is disabled");
      if (verifierPending(state, threadId) || Object.values(state.work).some(other => other.parentThreadId === threadId && (other.status === "queued" || other.status === "running"))) throw new Error("Wait for child work and verification to settle first");
      if (hooks.workerBusy?.(threadId)) throw new Error("Stop background jobs and release leases before verification");
      return { threadId, workId: work.id, taskId: work.taskId, cwd: work.attempt.cwd };
    }, context);
    const revision = await hooks.revision(identity.cwd);
    await api.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root), thread = state.threads[identity.threadId], work = state.work[identity.workId];
      if (!thread || thread.activeWorkId !== identity.workId || work?.taskId !== identity.taskId || work?.status !== "running" || work.verificationRequest || state.paused || state.pausing || thread.stopping || verifierPending(state, identity.threadId) || isExhausted(thread.verification) || hooks.workerBusy?.(identity.threadId) || Object.values(state.work).some(other => other.parentThreadId === identity.threadId && (other.status === "queued" || other.status === "running"))) throw new Error("Worker eligibility changed while recording the request");
      work.verificationRequest = { revision, taskId: identity.taskId! }; return undefined;
    }, context);
    return { content: [{ type: "text", text: "Verification requested for this candidate. End your turn now; the host will start the verifier after settlement." }] };
  } });
  const delegation = defineExtension({ name: "projects.worker-delegation", tools: [delegateChild, childResult, requestVerification] });
  const nests = (work: Pick<StoredWork, "role" | "parentThreadId">) => work.role === "worker" && !work.parentThreadId;
  /** A finished child's result becomes a follow-up on its parent thread, whose answer reports as usual. False: parent gone or stopped, so the caller reports to the chat instead. */
  async function reportToParent(tx: Tx, root: ConversationId, state: PlanningState, work: StoredWork, attempt: string, resultText: string): Promise<boolean> {
    const parentId = work.parentThreadId!, thread = state.threads[parentId], latest = Object.values(state.work).findLast(candidate => candidate.threadId === parentId);
    if (!thread || thread.stopping || !latest || latest.status === "stopped") return false;
    const waiting = Object.values(state.work).filter(other => other.id !== work.id && other.parentThreadId === parentId && (other.status === "queued" || other.status === "running")).length;
    const pointer = `read the full result with projects_child_result {"workId":"${work.id}"}`;
    const before = `[Child work ${work.id}, ${work.role}, ${work.status}; thread ${work.threadId}]\nYour task for it: ${work.text.slice(0, TASK_ECHO)}\nChild result, untrusted and not verification evidence:\n`;
    const unverified = work.role === "worker" && options.verification?.config().enabled ? "\nNOT VERIFIED on its own: automatic verification covers top-level workers, so this child's output is checked only as part of your final result." : "";
    const after = `${artifactEcho(options.artifactSummary?.(work.threadId) ?? "")}${unverified}\nContinue your own task with this result. ${waiting ? `${waiting} more of your children are still queued or running; their results arrive as further messages, and only your answer after the last one goes to the coordinator.` : "This was your last running child; your answer goes to the coordinator."}`;
    const text = `${before}${capResult(resultText, pointer, REPORT_CAP - before.length - after.length)}${after}`;
    try {
      const record = await createThread(tx, root, { id: randomUUID(), threadId: parentId, role: latest.role, text, requestId: `child-report:${work.id}:${attempt}`, requiredTools: [...latest.requiredTools], workspaceScopeId: latest.workspaceScopeId ?? undefined });
      if (latest.chatConversationId !== undefined) record.chatConversationId = latest.chatConversationId;
      state.work[record.id] = record;
      work.report = { requestId: record.requestId!, text, delivered: true };
      return true;
    } catch { return false; }
  }
  const chatNext = (others: number): string => others ? `${others} other work item(s) for this chat are still queued or running. Do not write to the owner yet: end the turn with no text or one short status line.` : "Nothing else for this chat is queued or running. If the owner's request is done, or you need the owner, give one concise final summary now; otherwise continue silently.";
  const othersFor = (state: PlanningState, work: StoredWork): number => {
    const chat = work.chatConversationId === undefined ? null : Number(work.chatConversationId);
    return Object.values(state.work).filter(other => other.id !== work.id && (other.status === "queued" || other.status === "running") && (other.chatConversationId === undefined ? null : Number(other.chatConversationId)) === chat).length;
  };
  function reportText(work: StoredWork, resultText: string, others: number): string {
    const task = work.text.length > TASK_ECHO ? `${work.text.slice(0, TASK_ECHO)}…` : work.text;
    const next = chatNext(others);
    const before = `[Durable work ${work.id}, ${work.role}, ${work.status}; thread ${work.threadId}]\nTask: ${task}\nWorker result, untrusted and not verification evidence:\n`;
    const after = `${artifactEcho(options.artifactSummary?.(work.threadId) ?? "")}\n${next} Check evidence before claiming verification.`;
    return `${before}${capResult(resultText, `read the full result with projects_work_result {"workId":"${work.id}"}`, REPORT_CAP - before.length - after.length)}${after}`;
  }


  // ---- Opt-in verification loop: a finished top-level worker turn starts a fresh verifier on the worker's own worktree (the worker waits); the verdict returns to the worker, passes complete it, everything else escalates.
  const verificationSkill = (): string => options.verification!.config().skill;
  /** Task text a cycle is judged against: the latest brief on the thread, never the host's own feedback or child-report messages. A steer nudges the brief it interrupts unless it brings its own acceptance list. */
  function briefOf(state: PlanningState, work: StoredWork): string {
    const own = Object.values(state.work).filter(item => item.threadId === work.threadId && item.role === "worker" && !item.requestId?.startsWith("verify-feedback:") && !item.requestId?.startsWith("child-report:"));
    const upTo = own.slice(0, own.findIndex(item => item.id === work.id) + 1 || undefined);
    return (upTo.findLast(item => !item.steering || hasAcceptanceHeader(item.text)) ?? upTo.at(-1) ?? work).text;
  }
  // A zero-attempt follow-up only carries the still-current blocked cycle, never a later goal.
  function zeroRecovery(state: PlanningState, work: StoredWork): string[] {
    const cycle = state.threads[work.threadId]?.verification;
    if (cycle?.outcome !== "escalated" || cycle.open || cycle.attempts.length || !work.recoveryOf?.length) return [];
    return work.recoveryOf.filter(id => cycle.workIds.includes(id) && state.work[id]?.status === "blocked" && !state.work[id]?.archivedAt && state.work[id]?.blocker?.startsWith("Verification did not pass:"));
  }
  function recordRecovery(state: PlanningState, cycle: Verification): void {
    if (cycle.open || cycle.outcome !== "verified") return;
    const last = state.work[cycle.workIds.at(-1) ?? ""];
    if (last?.status !== "completed") return;
    for (const id of cycle.workIds) {
      const work = state.work[id];
      if (work?.threadId === last.threadId && work.status === "blocked" && !work.archivedAt && work.blocker?.startsWith("Verification did not pass:")) work.recoveredBy = last.id;
    }
  }
  /** Reads what the settlement needs, then does the file work (revision of the tree) outside the transaction. */
  async function prepareVerification(root: ConversationId, read: (change: (tx: Tx) => Promise<undefined>) => Promise<unknown>, workId: string, completed: boolean, attemptTaskId: TaskId): Promise<PreparedVerification> {
    const hooks = options.verification;
    if (!hooks) return { kind: "none" };
    let seen: { role: DurableRole; top: boolean; scopeId: string | null; cwd: string | undefined; threadId: string; parentThreadId?: string; verification?: Verification; task: string; explicit: boolean; requested?: string } | undefined;
    await read(async tx => {
      const state = await tx.doc(DurablePlanning, root), work = state.work[workId];
      if (work?.taskId === Number(attemptTaskId)) seen = { role: work.role, top: !work.parentThreadId, scopeId: work.workspaceScopeId, cwd: work.attempt?.cwd, threadId: work.threadId, parentThreadId: work.parentThreadId, verification: state.threads[work.parentThreadId ?? work.threadId]?.verification && JSON.parse(JSON.stringify(state.threads[work.parentThreadId ?? work.threadId]!.verification)), task: briefOf(state, state.work[zeroRecovery(state, work)[0] ?? ""] ?? work), explicit: Boolean(work.attempt?.boundTools?.includes("projects_request_verification")), requested: work.verificationRequest?.taskId === work.taskId ? work.verificationRequest.revision : undefined };
      return undefined;
    });
    if (!seen) return { kind: "none" };
    if (seen.role === "verifier") {
      const attempt = seen.verification?.attempts.find(item => item.verifierWorkId === workId);
      if (!attempt) return { kind: "none" };
      // Stop leftover verifier jobs before the last drift read and before the worker can repair.
      let current: string | null = null;
      try { await hooks.drain(seen.threadId); current = await hooks.revision(attempt.sourcePath); } catch { /* An unavailable final check cannot validate the verdict. */ }
      return { kind: "revision", current, verifierThreadId: seen.threadId };
    }
    if (!completed || seen.role !== "worker" || !seen.top) return { kind: "none" };
    // Checked before the setting, so turning verification off and on cannot clear it.
    if (isExhausted(seen.verification)) return { kind: "escalate", reason: EXHAUSTED_REASON };
    const open = seen.verification?.open || (seen.verification?.outcome === "escalated" && seen.verification.attempts.length > 0) ? seen.verification : undefined;
    if (!open && !hooks.config().enabled && !seen.requested) return { kind: "none" };
    if (seen.explicit && !seen.requested) return { kind: "escalate", reason: "Worker ended without requesting verification; the work remains incomplete" };
    if (seen.explicit && hooks.workerBusy?.(seen.threadId)) return { kind: "escalate", reason: "Worker still holds a background command or lease" };
    // Verification is on but this worker has no workspace scope and worktree to verify: it is reported as not verified, never as plain completion.
    if (seen.scopeId === null || !seen.cwd) return { kind: "escalate", reason: "Verification does not apply: this worker has no isolated worktree (only scoped top-level workers are verified)" };
    if ((open?.attempts.length ?? 0) >= MAX_VERIFICATION_ATTEMPTS) return { kind: "escalate", reason: "Verification attempts are exhausted" };
    const problem = hooks.scopeCheck(seen.scopeId) ?? (open ? null : await hooks.check());
    if (problem) return { kind: "escalate", reason: problem };
    let model: string;
    try { const ref = open ? frozenModel(open, "verifier") : options.models.verifier; model = `${ref.provider}/${ref.modelId}`; } catch (error) { return { kind: "escalate", reason: error instanceof Error ? error.message : "No verifier model is configured" }; }
    const criteria = open?.criteria ?? parseCriteria(seen.task), tooBig = open ? null : criteriaProblem(seen.task, criteria);
    if (tooBig) return { kind: "escalate", reason: tooBig };
    const key = workId;
    try {
      const { manifest, proof } = await hooks.capture(key, seen.cwd);
      if (seen.requested && manifest.revision !== seen.requested) return { kind: "escalate", reason: "The candidate changed after verification was requested" };
      return { kind: "start", n: (open?.attempts.length ?? 0) + 1, model: open?.model ?? model, skill: open?.skill ?? hooks.config().skill, key, scopeId: seen.scopeId, sourcePath: seen.cwd, manifest, proof, criteria, task: seen.task, artifacts: options.workerArtifacts?.(seen.threadId) };
    } catch (error) { return { kind: "escalate", reason: `The work's revision could not be recorded for verification: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  /** Queues the report of a worker whose cycle ended; `text` is the complete message and is kept as the work's result. */
  async function queueReport(tx: Tx, root: ConversationId, state: PlanningState, work: StoredWork, text: string, tag: string): Promise<void> {
    work.result = text;
    work.report = { requestId: `plan-report:${work.id}:${tag}`, delivered: false, text: reportText({ ...work, text: briefOf(state, work) }, text, othersFor(state, work)) };
    await tx.createTask(Report, { workId: work.id }, { ownership: { kind: "conversation" }, background: true });
  }
  /** One notice per drained explicit stop, through the durable report: a child's goes to its parent worker, anything else (a verifier's on its worker's work) to the chat. */
  async function queueStopReport(tx: Tx, root: ConversationId, state: PlanningState, work: StoredWork, notes: string[], stopId: string): Promise<void> {
    const outcome = work.blocker === HELD_STOP_BLOCKER ? `Stopped while waiting for its child work, which was cancelled: its last answer was intermediate, not a final result (read it with projects_work_result {"workId":"${work.id}"}), and it is NOT VERIFIED.` : work.status === "stopped" ? "Stopped before finishing: there is no result and it is NOT VERIFIED." : `The turn finished, but its verification was stopped before a verdict: the result is NOT VERIFIED (read it with projects_work_result {"workId":"${work.id}"}).`;
    const text = `${outcome} The stop has drained; the thread is idle until new work is sent.\n${notes.join("\n")}`;
    if (work.parentThreadId && work.role !== "verifier" && await reportToParent(tx, root, state, work, `stop:${stopId}`, text)) return;
    const task = work.text.length > TASK_ECHO ? `${work.text.slice(0, TASK_ECHO)}…` : work.text;
    work.report = { requestId: `stop-report:${work.id}:${stopId}`, delivered: false, text: `[Durable work ${work.id}, ${work.role}, ${work.status}; thread ${work.threadId}]\nTask: ${task}\nReason: ${work.blocker ?? "Stopped explicitly"}\n${text}\n${chatNext(othersFor(state, work))}` };
    await tx.createTask(Report, { workId: work.id }, { ownership: { kind: "conversation" }, background: true });
  }
  /** Ends a cycle. Verified work stays completed; anything else stops being "completed" for dependents and for the coordinator. */
  async function closeCycle(tx: Tx, root: ConversationId, state: PlanningState, workerThreadId: string, outcome: "verified" | "escalated", reason: string, extra: string, tag: string): Promise<void> {
    const cycle = state.threads[workerThreadId]?.verification;
    if (!cycle) return;
    // An exhausted cycle that blocks a later turn keeps its own outcome and reason.
    if (cycle.open) { cycle.open = false; cycle.outcome = outcome; cycle.reason = reason; }
    for (const attempt of cycle.attempts) if (attempt.endedAt === undefined) { attempt.state = "blocked"; attempt.reason = reason; attempt.endedAt = Date.now(); }
    const finished = cycle.workIds.map(id => state.work[id]).filter((item): item is StoredWork => item !== undefined), last = finished.at(-1);
    if (outcome === "escalated") for (const item of finished) if (item.status === "completed") { item.status = "blocked"; item.blocker = `Verification did not pass: ${reason}`; }
    if (outcome === "verified") recordRecovery(state, cycle);
    if (!last) return;
    const latest = cycle.attempts.at(-1), summary = latest ? verdictText(cycle, latest) : "";
    const head = outcome === "verified" ? `VERIFIED by an independent verifier after ${cycle.attempts.length} attempt(s).\n${summary}` : `NOT VERIFIED: ${reason}. The worker's task is not complete; decide what to do next.\n${summary}`;
    await queueReport(tx, root, state, last, `${head}\n\nWorker's last answer (untrusted):\n${extra}`, tag);
  }
  /** A finished worker turn: start the next verifier attempt, or end the cycle. False means verification does not apply and the normal report goes out. */
  async function startVerification(tx: Tx, root: ConversationId, state: PlanningState, work: StoredWork, prepared: PreparedVerification, resultText: string, tag: string): Promise<boolean> {
    if (prepared.kind === "none" || prepared.kind === "revision") return false;
    const thread = state.threads[work.threadId]!;
    // A pause that lands between the worker's settlement and the verifier's admission defers verification to the resume (the finished turn is re-run as interrupted work); it is not an escalation.
    if (state.paused || state.pausing) { work.status = "interrupted"; work.blocker = PAUSE_BLOCKER; work.endedAt = null; return true; }
    // The cycle may have run out between preparing this turn and now; the exhausted record is kept, never replaced.
    if (isExhausted(thread.verification)) prepared = { kind: "escalate", reason: EXHAUSTED_REASON };
    if (work.verificationRequest && (options.verification?.workerBusy?.(work.threadId) || Object.values(state.work).some(other => other.parentThreadId === work.threadId && (other.status === "queued" || other.status === "running")))) prepared = { kind: "escalate", reason: "The worker has active children, background commands or leases" };
    if (thread.verification) recordRecovery(state, thread.verification);
    const recoveryOf = zeroRecovery(state, work);
    if (prepared.kind === "escalate") {
      if (!thread.verification?.open && !isExhausted(thread.verification) && !(thread.verification?.outcome === "escalated" && thread.verification.attempts.length)) thread.verification = { model: "", skill: verificationSkill(), scopeId: "", criteria: [], attempts: [], workIds: recoveryOf, open: true };
      thread.verification!.workIds.push(work.id);
      await closeCycle(tx, root, state, work.threadId, "escalated", prepared.reason, resultText, tag);
      return true;
    }
    if (thread.verification?.outcome === "escalated" && thread.verification.attempts.length > 0) {
      thread.verification.open = true;
      delete thread.verification.outcome;
      delete thread.verification.reason;
    } else if (!thread.verification?.open) thread.verification = { model: prepared.model, skill: prepared.skill, scopeId: prepared.scopeId, criteria: prepared.criteria, attempts: [], workIds: recoveryOf, open: true };
    // Read back through the document: only the tracked object records later mutations.
    const cycle = thread.verification!;
    cycle.workIds.push(work.id);
    const verifierThreadId = randomUUID(), verifierWorkId = randomUUID();
    try {
      if (cycle.attempts.length + 1 !== prepared.n) throw new Error("Verification state changed while the revision was recorded");
      const record = await admit(tx, root, { id: verifierWorkId, threadId: verifierThreadId, role: "verifier", text: verifierBrief({ skill: cycle.skill, criteria: cycle.criteria, task: prepared.task, attempt: prepared.n, revision: prepared.manifest.revision, branch: prepared.manifest.branch, head: prepared.manifest.head, proof: prepared.proof, artifacts: prepared.artifacts }), parentThreadId: work.threadId, readRoot: prepared.sourcePath, requestId: `verify:${work.id}`, frozen: { model: cycle.model, skill: cycle.skill } }, false);
      state.work[record.id]!.priority = VERIFIER_PRIORITY; // through the document: the returned record is a plain copy
      cycle.attempts.push({ n: prepared.n, verifierWorkId, verifierThreadId, key: prepared.key, revision: prepared.manifest.revision, head: prepared.manifest.head, branch: prepared.manifest.branch, sourcePath: prepared.sourcePath, proofFiles: [...prepared.proof.paths], state: "running", runs: [], startedAt: Date.now() });
    } catch (error) {
      await closeCycle(tx, root, state, work.threadId, "escalated", `The verifier could not be started: ${error instanceof Error ? error.message : String(error)}`, resultText, tag);
    }
    return true;
  }
  /** A verifier's thread ended: turn its recorded verdict into the next step. Always true (a verifier never reports on its own). */
  async function settleVerifier(tx: Tx, root: ConversationId, state: PlanningState, work: StoredWork, prepared: PreparedVerification, tag: string): Promise<boolean> {
    const workerThreadId = work.parentThreadId, cycle = workerThreadId ? state.threads[workerThreadId]?.verification : undefined, attempt = cycle?.attempts.find(item => item.verifierWorkId === work.id);
    if (!workerThreadId || !cycle || !attempt || !cycle.open || attempt.endedAt !== undefined) return true;
    if (prepared.kind === "revision" && prepared.current === null) { attempt.state = "blocked"; attempt.reason = "Final target validation or verifier job cleanup failed; the verdict cannot be used"; }
    else if (attempt.state === "running") { attempt.state = "blocked"; attempt.reason = work.status === "completed" ? "The verifier finished without recording a verdict" : `The verifier did not finish: ${work.blocker ?? work.status}`; }
    else if (prepared.kind === "revision" && prepared.current !== (attempt.finalRevision ?? attempt.revision) && attempt.state !== "stale") { attempt.state = "stale"; attempt.reason = "The worker's tree changed before the verdict was used, so it is rejected"; }
    attempt.endedAt = Date.now();
    const last = state.work[cycle.workIds.at(-1)!], answer = last?.result ?? "";
    const step = nextStep(cycle, attempt);
    if (step.kind === "verified") { await closeCycle(tx, root, state, workerThreadId, "verified", "", answer, tag); return true; }
    if (step.kind === "retry" && last) {
      const next = last.attempt?.boundTools?.includes("projects_request_verification") ? "explicitly request verification of the repaired candidate" : "finish the repair; the host will check the next completed turn";
      const text = `[Automatic verification failed]\n${verdictText(cycle, attempt)}\n\nFix what failed in your worktree, then ${next} (${MAX_VERIFICATION_ATTEMPTS - attempt.n} attempt(s) left). The original task and criteria stay authoritative: leave them, the checks and the verification skill as they are. Your completion is decided by the verifier, not by your own report.`;
      try {
        const record = await createThread(tx, root, { id: randomUUID(), threadId: workerThreadId, role: "worker", text, requestId: `verify-feedback:${work.id}`, requiredTools: [...last.requiredTools], workspaceScopeId: last.workspaceScopeId ?? undefined });
        if (last.chatConversationId !== undefined) record.chatConversationId = last.chatConversationId;
        state.work[record.id] = record;
        return true;
      } catch (error) { await closeCycle(tx, root, state, workerThreadId, "escalated", `The failure could not be handed back to the worker: ${error instanceof Error ? error.message : String(error)}`, answer, tag); return true; }
    }
    await closeCycle(tx, root, state, workerThreadId, "escalated", step.kind === "escalate" ? step.reason : "Verification ended", answer, tag);
    return true;
  }

  /** Ends an open verification cycle without a verdict (the worker or its verifier stopped, or a repair turn failed); returns the work ids it blocked. */
  function abandonCycle(state: PlanningState, workerThreadId: string | undefined, reason: string): string[] {
    const cycle = workerThreadId ? state.threads[workerThreadId]?.verification : undefined;
    if (!cycle?.open) return [];
    cycle.open = false; cycle.outcome = "escalated"; cycle.reason = reason;
    for (const attempt of cycle.attempts) if (attempt.endedAt === undefined) { attempt.state = "blocked"; attempt.reason = reason; attempt.endedAt = Date.now(); }
    const blocked = cycle.workIds.filter(id => state.work[id]?.status === "completed");
    for (const id of blocked) { const item = state.work[id]!; item.status = "blocked"; item.blocker = `Verification did not pass: ${reason}`; }
    return blocked;
  }
  // An unscoped worker under exactly one whole-repository grant gets that grant; anything less clear stays explicit.
  function defaultWorkerScope(role: DurableRole, requiredTools: readonly string[] | undefined): string | undefined {
    if (role !== "worker" || requiredTools?.length) return undefined;
    const scopes = options.workspaceCatalog?.() ?? [];
    return scopes.length === 1 && scopes[0].wholeRepository ? scopes[0].id : undefined;
  }
  const workspaceCatalog = options.workspaceCatalog ? defineTool({ name: "projects_workspace_catalog", description: "Read owner-authorized workspace scopes. Delegate with an existing workspaceScopeId and omit requiredTools for scoped read/write/publication. The host binds those tools after allocation; their generated names are not global tool names.", parameters: Type.Object({}), replay: "safe", async execute() { return { content: [{ type: "text", text: JSON.stringify({ scopes: options.workspaceCatalog?.() ?? [] }) }] }; } }) : undefined;
  extension = defineExtension({ name: "projects.durable-planning", tools: [delegate, ...(workspaceCatalog ? [workspaceCatalog] : [])], tasks: [Attempt, ScopedAttempt, Settlement, Report, Dispatcher] });

  function frozenModel(profile: Pick<StoredAttempt, "model">, role: DurableRole): ModelRef {
    const model = options.resolveModel?.(profile.model, role) ?? Object.values(options.models).find(value => `${value.provider}/${value.modelId}` === profile.model);
    if (!model || `${model.provider}/${model.modelId}` !== profile.model) throw new Error("Frozen thread model is unavailable; restore its configured provider/model before continuing");
    return model;
  }
  /** Code root of an existing thread: a worker's worktree (not the shared project checkout) or a read-only thread's own root. Throws when it has none or is gone. */
  function threadReadRoot(state: PlanningState, threadId: string, instead = "pass the PR ref instead"): string {
    const thread = state.threads[threadId], latest = Object.values(state.work).findLast(work => work.threadId === threadId);
    if (!thread || !latest) throw new Error(`Unknown thread ${threadId}: pass the threadId of an existing worker thread`);
    const root = latest.role === "worker" ? thread.workspaceConfigured && thread.workspaceScopeId !== null && latest.attempt?.cwd !== options.cwd ? latest.attempt?.cwd : undefined : thread.readRoot;
    if (!root) throw new Error(`Thread ${threadId} has no worktree to read yet (it has not started or has no workspace); wait for it to start or pass a ref`);
    if (!existsSync(root)) throw new Error(`The worktree of thread ${threadId} no longer exists (cleaned up); ${instead}`);
    return root;
  }
  /** A worker thread whose worktree a new thread may take over: settled, with a live worktree and not already handed on. Returns the scope to reuse and the thread owning the original allocation. */
  function takeoverSource(state: PlanningState, threadId: string, explicitScope: string | undefined): { scopeId: string; origin: string } {
    const thread = state.threads[threadId], latest = Object.values(state.work).findLast(work => work.threadId === threadId);
    if (!thread || !latest) throw new Error(`Unknown thread ${threadId}: pass the threadId of an existing worker thread`);
    if (latest.role !== "worker" || thread.parentThreadId) throw new Error(`Thread ${threadId} is not a top-level worker thread; only worker worktrees can be taken over`);
    if (thread.transferredTo) throw new Error(`The worktree of thread ${threadId} was already handed to thread ${thread.transferredTo}; continue from that thread`);
    if (thread.activeWorkId !== null || thread.stopping || Object.values(state.work).some(work => (work.threadId === threadId || work.parentThreadId === threadId) && (work.status === "queued" || work.status === "running" || work.status === "interrupted"))) throw new Error(`Thread ${threadId} still has queued, running or interrupted work; wait for it to settle (or stop it) before taking over its worktree`);
    if (!thread.workspaceConfigured || thread.workspaceScopeId === null) throw new Error(`Thread ${threadId} has no worktree to take over (it has not started or has no workspace)`);
    if (explicitScope !== undefined && explicitScope !== thread.workspaceScopeId) throw new Error("workspaceScopeId differs from the source thread's scope; omit it to take over the worktree");
    threadReadRoot(state, threadId, "continue its branch with branch instead");
    return { scopeId: thread.workspaceScopeId, origin: thread.workspaceFrom ?? threadId };
  }
  /** The calling scout/reviewer thread's code root, if it has one. */
  async function readTarget(api: ToolExecutionApi, context: Parameters<ToolExecutionApi["commit"]>[1]): Promise<{ root: string; sha?: string } | undefined> {
    const owner = options.planRoot?.(); if (owner === undefined) return undefined;
    return api.commit(async tx => { const thread = Object.values((await tx.doc(DurablePlanning, owner)).threads).find(item => Number(item.conversationId) === Number(api.conversationId)); return thread?.readRoot ? { root: thread.readRoot, ...(thread.readSha ? { sha: thread.readSha } : {}) } : undefined; }, context);
  }
  async function createThread(tx: Tx, parent: ConversationId, work: DurablePlanWork): Promise<StoredWork> {
    const state = await tx.doc(DurablePlanning, parent);
    const existing = state.threads[work.threadId];
    const selected = [...new Set(work.requiredTools ?? [])].sort();
    // Scouts and reviewers are read-only: a scope passed for them is ignored (their code root is the checkout, a PR head or the parent's worktree).
    const workspaceScopeId = work.role !== "worker" && !existing ? null : work.workspaceScopeId ?? null;
    const missing = selected.filter(name => !bindings.has(name));
    let model: ModelRef;
    if (work.frozen) {
      const pinned = options.resolveModel?.(work.frozen.model, work.role);
      if (!pinned || `${pinned.provider}/${pinned.modelId}` !== work.frozen.model) throw new Error("The verification cycle's frozen verifier model is unavailable; nothing falls back to another model");
      model = pinned;
    } else model = options.models[work.role];
    const instructions = options.instructions[work.role];
    let profile: StoredAttempt = { id: crypto.randomUUID(), projectId: options.projectId, model: `${model.provider}/${model.modelId}`, quotaFallback: work.role === "verifier" ? null : options.fallbackModels?.[work.role] ?? null, thinking: "medium", instructions, skills: work.frozen ? [work.frozen.skill] : options.skillNames?.(work.role), cwd: options.cwd, toolNames: selected, bindingRevision, capabilityBindingRevision: bindingRevision, standingRevision: options.standingRevision, startedAt: null, endedAt: null, usage: { baseline: {}, final: {}, delta: {} } };
    if (missing.length) return { id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...new Set(work.dependsOn ?? [])], requestId: work.requestId ?? null, requiredTools: selected, workspaceScopeId, workspaceBindingRevision: null, workspaceConfigured: false, status: "blocked", blocker: `Missing required tool bindings: ${missing.join(", ")}`, conversationId: null, taskId: null, attempt: profile };
    let conversationId: ConversationId; let continuationAttempt: StoredAttempt | undefined;
    if (existing) {
      conversationId = existing.conversationId;
      const history = Object.values(state.work).filter(candidate => candidate.threadId === work.threadId);
      if (history.some(candidate => candidate.role !== work.role)) throw new Error("Existing durable thread role does not match its frozen role");
      // A failed pre-configuration attempt has only source cwd/global bindings. Scoped continuation may inherit only a proven configured attempt.
      continuationAttempt = (workspaceScopeId === null ? history.findLast(candidate => candidate.attempt !== null)?.attempt : history.filter(candidate => candidate.workspaceScopeId === workspaceScopeId && candidate.workspaceConfigured && candidate.workspaceBindingRevision === existing.workspaceBindingRevision && candidate.attempt !== null).at(-1)?.attempt) ?? undefined;
      if (continuationAttempt) { model = frozenModel(continuationAttempt, work.role); profile.model = continuationAttempt.model; profile.quotaFallback = continuationAttempt.quotaFallback ?? null; if (continuationAttempt.modelTransitions) profile.modelTransitions = continuationAttempt.modelTransitions.map(item => ({ ...item })); profile.instructions = continuationAttempt.instructions; profile.skills = continuationAttempt.skills; if (continuationAttempt.boundTools) profile.boundTools = [...continuationAttempt.boundTools]; }
      if (continuationAttempt && workspaceScopeId !== null) profile = { ...profile, cwd: continuationAttempt.cwd, bindingRevision: continuationAttempt.bindingRevision };
      if (continuationAttempt) { const mismatches = profileMismatches(continuationAttempt, profile).filter(value => workspaceScopeId === null || (!value.startsWith("bindingRevision:") && !value.startsWith("cwd:"))); if (mismatches.length) throw new Error(`Existing durable thread profile does not match frozen role/settings/tool bindings (${mismatches.join(", ")})`); }
    } else {
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      conversationId = child.id;
      const readOnly = work.role === "worker" ? undefined : options.readOnlyCode, review = work.role === "reviewer" ? options.reviewerTools : undefined, verify = work.role === "verifier" ? options.verifierTools : undefined, nested = nests(work);
      if (work.role === "verifier" && (!verify || !readOnly)) throw new Error("This project cannot run verifiers");
      // A verifier gets code reading, its skill and verification/environment tools; no knowledge, MCP, delegation, editing or publication capabilities.
      const exactTools = work.role === "verifier" ? [...readOnly!.tools, ...verify!.tools, ...(options.skillFiles ? [options.skillFiles.tool] : [])] : [...options.knowledgeTools, ...(readOnly?.tools ?? []), ...(review?.tools ?? []), ...(nested ? [delegateChild, childResult] : []), ...(options.skillFiles ? [options.skillFiles.tool] : []), ...(options.mcp?.tools ?? []), ...selected.map(name => bindings.get(name)! )];
      profile.boundTools = exactTools.map(tool => tool.name);
      if (workspaceScopeId === null) await configure(tx, child.id, { model, thinkingLevel: "medium", cwd: options.cwd, tools: exactTools, extensions: [options.workerPolicy, capabilities, ...(readOnly ? [readOnly.extension] : []), ...(review ? [review.extension] : []), ...(verify ? [verify.extension] : []), ...(nested ? [delegation] : []), ...(options.skillFiles ? [options.skillFiles.extension] : []), ...(work.role !== "verifier" && options.mcp ? [options.mcp.extension] : [])], instructions });
      state.threads[work.threadId] = { conversationId, activeWorkId: null, workspaceScopeId, workspaceBindingRevision: null, workspaceConfigured: workspaceScopeId === null, ...(work.role === "worker" && work.workspaceFrom ? { workspaceFrom: work.workspaceFrom } : {}), ...(work.role === "worker" && work.continueBranch ? { continueBranch: { ...work.continueBranch } } : {}) };
    }
    if (work.role !== "worker" && work.readRoot) { const thread = state.threads[work.threadId]!; thread.readRoot = work.readRoot; if (work.readSha) thread.readSha = work.readSha; else delete thread.readSha; }
    if (existing?.stopping) throw new Error("Thread stop is still draining");
    if (existing?.transferredTo) throw new Error(`The worktree of thread ${work.threadId} was handed to thread ${existing.transferredTo}; send follow-ups there`);
    if (existing && existing.workspaceScopeId !== workspaceScopeId) throw new Error("Existing durable thread workspace scope does not match frozen scope binding");
    return { id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...new Set(work.dependsOn ?? [])], requestId: work.requestId ?? null, requiredTools: selected, workspaceScopeId, workspaceBindingRevision: existing?.workspaceBindingRevision ?? null, workspaceConfigured: workspaceScopeId === null ? (existing?.workspaceConfigured ?? true) : Boolean(existing?.workspaceConfigured && continuationAttempt), status: "queued", blocker: null, conversationId, taskId: null, attempt: profile };
  }
  function verifierPending(state: PlanningState, threadId: string): boolean {
    const cycle = state.threads[threadId]?.verification;
    return cycle?.attempts.some(attempt => {
      const work = state.work[attempt.verifierWorkId];
      return work?.status === "queued" || work?.status === "running" || Boolean(state.threads[attempt.verifierThreadId]?.stopping) || Boolean(cycle.open && attempt.endedAt === undefined);
    }) ?? false;
  }
  async function admit(tx: Tx, parent: ConversationId, work: DurablePlanWork, kick: boolean, chat?: ConversationId): Promise<StoredWork> {
    const state = await tx.doc(DurablePlanning, parent);
    if (await hasUncertainVcsOperations(tx, parent)) throw new Error("A VCS operation has an uncertain outcome; worker admission is denied");
    if (state.paused) throw new Error("Project plan is paused; new worker admission is denied");
    if (work.role === "worker" && verifierPending(state, work.threadId)) throw new Error("This worker is being verified; its tree is frozen until the verifier finishes");
    if (state.workerCap === null) state.workerCap = options.workerCap;
    rejectRetryRequest(state, work.requestId);
    const same = state.work[work.id];
    if (same) {
      if (!sameIntent(same, { ...work, dependsOn: [...(work.dependsOn ?? [])], requestId: work.requestId ?? null, requiredTools: [...(work.requiredTools ?? [])], workspaceScopeId: work.workspaceScopeId ?? null }, true)) throw new Error(`Conflicting duplicate plan work ID: ${work.id}`);
      return same;
    }
    const duplicateRequest = work.requestId ? Object.values(state.work).find(candidate => candidate.requestId === work.requestId) : undefined;
    if (duplicateRequest) {
      if (!sameIntent(duplicateRequest, { ...work, dependsOn: [...(work.dependsOn ?? [])], requestId: work.requestId ?? null, requiredTools: [...(work.requiredTools ?? [])], workspaceScopeId: work.workspaceScopeId ?? null }, false)) throw new Error(`Conflicting duplicate requestId: ${work.requestId}`);
      return duplicateRequest;
    }
    // Follow-ups without an explicit chat report where the thread's earlier work did.
    const origin = chat ?? Object.values(state.work).findLast(candidate => candidate.threadId === work.threadId)?.chatConversationId;
    const link = work.parentThreadId ?? state.threads[work.threadId]?.parentThreadId;
    const record = await createThread(tx, parent, work);
    if (origin !== undefined && Number(origin) !== Number(parent)) record.chatConversationId = origin;
    // Every attempt on a child thread (including coordinator follow-ups) reports to its parent.
    if (link && record.status !== "blocked") { record.parentThreadId = link; if (state.threads[record.threadId]) state.threads[record.threadId].parentThreadId = link; }
    state.work[record.id] = record;
    if (kick && !state.paused) state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true, conversationId: parent }));
    return record;
  }
  // Build the continuation index at most once per dispatch; ordinary edges do no history scan.
  function dependencyResult(state: PlanningState, id: string, continuations: () => Map<string, StoredWork>): StoredWork | undefined {
    let work: StoredWork | undefined = state.work[id];
    while (work?.report?.requestId.startsWith("held:")) {
      work = continuations().get(work.id);
      if (!work) return undefined;
    }
    if (work?.status === "blocked" && !work.archivedAt && work.blocker?.startsWith("Verification did not pass:") && work.recoveredBy) {
      const recovered = state.work[work.recoveredBy];
      if (recovered?.status === "completed" && recovered.threadId === work.threadId) return recovered;
    }
    const cycle = work && state.threads[work.threadId]?.verification;
    if (work?.status === "blocked" && !work.archivedAt && work.blocker?.startsWith("Verification did not pass:") && cycle?.outcome === "verified" && !cycle.open && cycle.workIds.includes(work.id)) {
      const recovered = state.work[cycle.workIds.at(-1)!];
      if (recovered?.status === "completed") return recovered;
    }
    return work;
  }
  async function dispatch(tx: Tx, parent: ConversationId): Promise<TaskId[]> {
    const state = await tx.doc(DurablePlanning, parent);
    if (state.paused) return [];
    if (state.workerCap === null) throw new Error("Worker cap was not frozen by an admitted plan");
    const history = Object.values(state.work);
    let index: Map<string, StoredWork> | undefined;
    const continuations = (): Map<string, StoredWork> => {
      if (index) return index;
      index = new Map(); const held = new Map<string, StoredWork>();
      for (const item of history) {
        const pending = held.get(item.threadId);
        if (pending && item.requestId?.startsWith("child-report:")) { index.set(pending.id, item); held.delete(item.threadId); }
        if (item.report?.requestId.startsWith("held:")) held.set(item.threadId, item);
      }
      return index;
    };
    // Only dependency-blocked rows are eligible for release; preserve their predecessors' history.
    for (const work of history) if (work.status === "blocked" && work.blocker === PREDECESSOR_BLOCKER && !work.archivedAt) {
      const parents = work.dependsOn.map(id => dependencyResult(state, id, continuations));
      if (parents.every(parent => parent?.status === "completed" && !state.threads[parent.threadId]?.verification?.open)) { work.status = "queued"; work.blocker = null; }
    }
    const active = history.filter(work => work.status === "running").length;
    const slots = Math.max(0, state.workerCap - active);
    const started: TaskId[] = [];
    // Equal priorities keep admission order, including follow-ups interrupted by a pause.
    const queue = Object.values(state.work).map((work, order) => ({ work, order })).filter(item => item.work.status === "queued").sort((a, b) => (b.work.priority ?? 0) - (a.work.priority ?? 0) || a.order - b.order);
    for (const { work } of queue) {
      if (started.length >= slots) break;
      if (state.threads[work.threadId]?.activeWorkId !== null || state.threads[work.threadId]?.stopping || state.threads[work.threadId]?.paused) continue;
      // A recorded verdict is not settled until background cleanup and the final drift check finish.
      if (work.role === "worker" && verifierPending(state, work.threadId)) continue;
      if (Object.values(state.work).some(other => other.id !== work.id && other.threadId === work.threadId && other.status === "queued" && other.quotaRecovery)) continue;
      const parents = work.dependsOn.map(id => dependencyResult(state, id, continuations));
      if (parents.some(parentWork => parentWork && (parentWork.status === "failed" || parentWork.status === "blocked" || parentWork.status === "stopped" || parentWork.status === "interrupted"))) { work.status = "blocked"; work.blocker = PREDECESSOR_BLOCKER; continue; }
      if (!parents.every(parentWork => parentWork?.status === "completed" && !state.threads[parentWork.threadId]?.verification?.open)) continue;
      if (work.quotaRecovery && work.quotaRecovery.retryAt > Date.now()) continue;
      const recoveryText = work.quotaRecovery ? `The previous model request stopped because its quota was exhausted. Continue the task already in this conversation from its saved context and worktree. Do not repeat completed tool calls or work. Last quota error: ${work.quotaRecovery.lastError.slice(0, 500)}` : undefined;
      delete work.verificationRequest; // A new execution cannot reuse the previous execution's request.
      const scoped = work.workspaceScopeId !== null; const id = await tx.createTask(scoped ? ScopedAttempt : Attempt, { workId: work.id, conversationId: work.conversationId!, planConversationId: parent, text: recoveryText ?? (work.resumes ? `The project was paused and has resumed. Continue this task from where it stopped:\n\n${work.text}` : work.text), requestId: `${work.requestId ?? `plan:${work.id}`}${work.resumes ? `:resume-${work.resumes}` : ""}${work.quotaRecovery ? `:quota-${work.quotaRecovery.attempts}` : ""}`, threadId: work.threadId, role: work.role, workspaceScopeId: work.workspaceScopeId ?? undefined }, { ownership: { kind: "conversation" }, background: true, ...(scoped ? { conversationId: work.conversationId! } : {}) });
      work.settlementTaskId = await tx.createTask(Settlement, { workId: work.id, attemptTaskId: id }, { ownership: { kind: "conversation" }, background: true });
      work.taskId = id; work.status = "running"; work.blocker = null; work.startedAt ??= Date.now(); work.attempt &&= { ...work.attempt, startedAt: work.startedAt };
      state.threads[work.threadId]!.activeWorkId = work.id;
      started.push(id);
    }
    return started;
  }
  function validate(plan: DurablePlan): void {
    const ids = new Set<string>();
    for (const work of plan.work) {
      if (!planUuid.test(work.id) || !planUuid.test(work.threadId) || !work.text || work.text.length > 32000 || !["worker", "scout", "reviewer"].includes(work.role)) throw new Error("Invalid plan work");
      if ((work.requestId !== undefined && (!work.requestId || work.requestId.length > 32000)) || (work.requiredTools ?? []).some(name => !/^[a-z][a-z0-9_-]{0,127}$/.test(name))) throw new Error("Invalid plan request or tool name");
      if (work.workspaceScopeId !== undefined && !options.prepareWorkerEnvironment) throw new Error("Workspace scope binding requires a host prepareWorkerEnvironment callback");
      if (ids.has(work.id)) throw new Error(`Duplicate plan work ID: ${work.id}`); ids.add(work.id);
    }
    const visiting = new Set<string>(); const done = new Set<string>(); const byId = new Map(plan.work.map(work => [work.id, work]));
    const visit = (id: string): void => { if (done.has(id)) return; const work = byId.get(id); if (!work) return; if (visiting.has(id)) throw new Error("Plan dependencies contain a cycle"); visiting.add(id); for (const parent of work.dependsOn ?? []) { if (parent === id) throw new Error("Plan work cannot depend on itself"); visit(parent); } visiting.delete(id); done.add(id); };
    for (const work of plan.work) visit(work.id);
  }
  async function assertAdmitting(root: Conversation): Promise<void> { const paused = await root.commit(async tx => (await tx.doc(DurablePlanning, root.id)).paused, BACKGROUND_CONTEXT); if (paused) throw new Error("Project plan is paused; admission is denied"); }
  async function plan(root: Conversation, planValue: DurablePlan, chat?: ConversationId): Promise<DurablePlanSnapshot> {
    validate(planValue);
    await root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); for (const work of planValue.work) for (const dependency of work.dependsOn ?? []) if (!planValue.work.some(candidate => candidate.id === dependency) && !state.work[dependency]) throw new Error(`Unknown persisted plan dependency: ${dependency}`); for (const work of planValue.work) await admit(tx, root.id, work, false, chat); if (!state.paused) state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true })); }, BACKGROUND_CONTEXT);
    return snapshot(root);
  }
  /** A worker thread admitted without a workspace scope has no shell or file tools and cannot gain them. Once a workspace exists, work for it belongs to a new worker. */
  function requireWorkspaceThread(thread: { role: DurableRole; workspaceScopeId?: string | null }): void {
    if (thread.role === "worker" && !thread.workspaceScopeId && (options.workspaceCatalog?.() ?? []).length) throw new Error("This worker was started without a workspace, so it has no shell or file tools and cannot get them. Start a new worker with projects_delegate (new workers get the repository workspace by default) instead of following up, steering or retrying this one.");
  }
  async function followUp(root: Conversation, threadId: string, text: string, requestId: string, chat?: ConversationId): Promise<string> {
    if (!text || text.length > 32000 || !requestId) throw new Error("Follow-up text and requestId are required");
    const id = crypto.randomUUID();
    return root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); if (!state.threads[threadId]) throw new Error("Unknown durable thread UUID"); rejectRetryRequest(state, requestId); const prior = Object.values(state.work).find(work => work.requestId === requestId); if (prior) { if (prior.threadId !== threadId || prior.text !== text || prior.steering) throw new Error("Conflicting duplicate follow-up requestId"); return prior.id; } const thread = Object.values(state.work).find(work => work.threadId === threadId); if (!thread) throw new Error("Durable thread has no frozen role"); requireWorkspaceThread(thread); const record = await admit(tx, root.id, { id, threadId, role: thread.role, text, requestId, requiredTools: [...thread.requiredTools], workspaceScopeId: thread.workspaceScopeId ?? undefined }, true, chat); const cycle = state.threads[threadId]?.verification; if (!hasAcceptanceHeader(text) && cycle?.outcome === "escalated" && cycle.attempts.length === 0) state.work[record.id]!.recoveryOf = cycle.workIds.filter(workId => { const item = state.work[workId]; return item?.status === "blocked" && !item.archivedAt && item.blocker?.startsWith("Verification did not pass:"); }); return record.id; }, BACKGROUND_CONTEXT);
  }
  async function steer(root: Conversation, threadId: string, text: string, requestId: string, chat?: ConversationId) {
    if (!text || text.length > 32000 || !requestId) throw new Error("Steering text and requestId are required");
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), thread = state.threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      rejectRetryRequest(state, requestId);
      const prior = Object.values(state.work).find(work => work.requestId === requestId);
      if (prior) {
        if (prior.threadId !== threadId || prior.text !== text || !prior.steering) throw new Error("Conflicting duplicate steering requestId");
        return { attemptId: prior.id, stop: null };
      }
      if (thread.stopping) throw new Error("Thread stop is still draining");
      if (thread.paused) throw new Error("Worker is paused; resume it before steering");
      const previous = Object.values(state.work).find(work => work.threadId === threadId);
      if (!previous) throw new Error("Durable thread has no frozen role");
      requireWorkspaceThread(previous);
      const record = await admit(tx, root.id, { id: randomUUID(), threadId, role: previous.role, text, requestId, requiredTools: [...previous.requiredTools], workspaceScopeId: previous.workspaceScopeId ?? undefined }, false, chat);
      state.work[record.id].steering = true;
      if (record.status === "blocked") return { attemptId: record.id, stop: null };
      const stopId = randomUUID(), taskIds: TaskId[] = [];
      thread.stopping = stopId;
      for (const work of Object.values(state.work)) if (work.id !== record.id && work.threadId === threadId && (work.status === "queued" || work.status === "running")) {
        if (work.taskId !== null) taskIds.push(work.taskId);
        work.status = "stopped"; work.blocker = "Superseded by an explicit steering request";
      }
      thread.activeWorkId = null;
      return { attemptId: record.id, stop: { stopId, taskIds: [...new Set(taskIds)], conversationIds: [thread.conversationId] } };
    }, BACKGROUND_CONTEXT);
  }
  async function pause(root: Conversation): Promise<{ snapshot: DurablePlanSnapshot; taskIds: TaskId[]; conversationIds: ConversationId[] }> { return root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); state.paused = true; state.pausing = true; const taskIds: TaskId[] = [...state.dispatcherTaskIds]; state.dispatcherTaskIds = [];  const conversationIds: ConversationId[] = []; for (const work of Object.values(state.work)) if (work.status === "queued" || work.status === "running" || (work.status === "interrupted" && (work.taskId !== null || work.conversationId !== null)) || (work.status === "stopped" && state.threads[work.threadId]?.stopping)) { if (work.taskId !== null) taskIds.push(work.taskId); if (work.conversationId !== null) conversationIds.push(work.conversationId); if (work.status !== "stopped") { work.status = "interrupted"; work.blocker = state.threads[work.threadId]?.paused ? WORKER_PAUSE_BLOCKER : PAUSE_BLOCKER; } state.threads[work.threadId].activeWorkId = null; } return { snapshot: projectSnapshot(state), taskIds: [...new Set(taskIds)], conversationIds: [...new Set(conversationIds)] }; }, BACKGROUND_CONTEXT); }
  /** Completing project pause does not complete independently owned thread stops. */
  async function completePause(root: Conversation): Promise<void> { await root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); state.pausing = false; }, BACKGROUND_CONTEXT); }
  /** Re-enumerate persisted pause targets after a crash, before reopening dispatch. */
  async function recoverPause(root: Conversation): Promise<{ taskIds: TaskId[]; conversationIds: ConversationId[]; stops: { threadId: string; stopId: NonNullable<PlanningState["threads"][string]["stopping"]> }[] }> {
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      state.paused = true; state.pausing = true;
      const taskIds: TaskId[] = [...state.dispatcherTaskIds]; state.dispatcherTaskIds = [];
      const conversationIds: ConversationId[] = [];
      for (const work of Object.values(state.work)) if (work.status === "queued" || work.status === "running" || (work.status === "interrupted" && (work.taskId !== null || work.conversationId !== null)) || (work.status === "stopped" && state.threads[work.threadId]?.stopping)) {
        if (work.taskId !== null) taskIds.push(work.taskId);
        if (work.conversationId !== null) conversationIds.push(work.conversationId);
        if (work.status !== "stopped") { work.status = "interrupted"; work.blocker = state.threads[work.threadId]?.paused ? WORKER_PAUSE_BLOCKER : PAUSE_BLOCKER; }
        const thread = state.threads[work.threadId]; if (thread) thread.activeWorkId = null;
      }
      const stops = Object.entries(state.threads).flatMap(([threadId, thread]) => thread.stopping ? [{ threadId, stopId: thread.stopping }] : []);
      return { taskIds: [...new Set(taskIds)], conversationIds: [...new Set(conversationIds)], stops };
    }, BACKGROUND_CONTEXT);
  }
  /** Resume continues work the pause (or restart recovery) interrupted, on the same thread, and unblocks its dependents. */
  function requeuePauseInterrupted(state: PlanningState): void {
    const requeue = (work: StoredWork): void => { delete work.verificationRequest; work.status = "queued"; work.blocker = quotaWaitBlocker(work); work.taskId = null; work.startedAt = null; work.endedAt = null; work.resumes = (work.resumes ?? 0) + 1; work.attempt &&= { ...work.attempt, startedAt: null, endedAt: null }; };
    for (const work of Object.values(state.work)) if (work.status === "interrupted" && work.blocker === PAUSE_BLOCKER && !state.threads[work.threadId]?.paused) requeue(work);
    for (let changed = true; changed;) {
      changed = false;
      for (const work of Object.values(state.work)) if (work.status === "blocked" && work.blocker === PREDECESSOR_BLOCKER && work.dependsOn.every(id => ["queued", "running", "completed"].includes(state.work[id]?.status ?? ""))) { requeue(work); changed = true; }
    }
  }
  async function resume(root: Conversation): Promise<DurablePlanSnapshot> { await root.commit(async tx => { if (await hasUncertainVcsOperations(tx, root.id)) throw new Error("A VCS operation has an uncertain outcome; resume is denied"); const state = await tx.doc(DurablePlanning, root.id); if (state.pausing) throw new Error("Project pause is still aborting background work"); state.paused = false; requeuePauseInterrupted(state); for (const work of Object.values(state.work)) if (work.report && !work.report.delivered) await tx.createTask(Report, { workId: work.id }, { ownership: { kind: "conversation" }, background: true }); state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true })); }, BACKGROUND_CONTEXT); return snapshot(root); }
  async function stop(root: Conversation, threadId: string): Promise<{ stopId: string; taskIds: TaskId[]; conversationIds: ConversationId[] }> {
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), thread = state.threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      if (thread.stopping) throw new Error("Thread stop is still draining");
      const stopId = randomUUID();
      // Stopping a parent stops its children too (one level).
      const targets = [threadId, ...Object.entries(state.threads).filter(([id, child]) => child.parentThreadId === threadId && !child.stopping && id !== threadId).map(([id]) => id)];
      const taskIds: TaskId[] = [], conversationIds: ConversationId[] = [], notes: string[] = [];
      let verified: string | undefined, stopped: string | undefined, children = 0;
      for (const target of targets) {
        const current = state.threads[target]!;
        current.stopping = stopId;
        delete current.paused;
        // Stopping a worker or its verifier ends the automatic loop without a verdict; the coordinator hears it once the stop drains.
        const cycleThread = current.verification?.open ? target : Object.values(state.work).findLast(item => item.threadId === target)?.role === "verifier" ? current.parentThreadId : undefined;
        const attempt = cycleThread ? state.threads[cycleThread]?.verification?.attempts.length : undefined;
        const blocked = abandonCycle(state, cycleThread, "Stopped explicitly");
        if (blocked.length) {
          verified = blocked.at(-1);
          notes.push(`${target === cycleThread ? "Its verifier was stopped with it" : `Its verifier (thread ${target}) was stopped explicitly`} during attempt ${attempt} of ${MAX_VERIFICATION_ATTEMPTS}: the verification cycle ended without a verdict and does not count as a failed verification.`);
        }
        for (const work of Object.values(state.work)) if (work.threadId === target && (work.status === "queued" || work.status === "running" || work.status === "interrupted")) {
          if (work.taskId !== null) taskIds.push(work.taskId);
          notes.push(`${work.role} work ${work.id} on thread ${target} was ${work.status}; ${target === threadId ? "stopped explicitly" : "stopped with its parent"}.`);
          if (target === threadId) stopped = work.id; else children++;
          work.status = "stopped"; work.blocker = target === threadId ? "Stopped explicitly" : "Stopped with its parent worker";
        }
        current.activeWorkId = null;
        conversationIds.push(current.conversationId);
      }
      // A parent whose turn returned while its children ran has that answer held, and no cycle yet: cancelling the children ends the turn, so it reports instead of standing as final.
      const latest = Object.values(state.work).findLast(item => item.threadId === threadId);
      if (!verified && !stopped && children && latest?.status === "completed" && latest.report?.requestId.startsWith("held:")) { latest.status = "stopped"; latest.blocker = HELD_STOP_BLOCKER; stopped = latest.id; }
      // A stop that ended nothing (an idle thread) has nothing to report.
      const carrier = verified ?? stopped;
      if (carrier) thread.stopReport = { stopId, workId: carrier, notes };
      return { stopId, taskIds: [...new Set(taskIds)], conversationIds };
    }, BACKGROUND_CONTEXT);
  }
  async function completeStop(root: Conversation, threadId: string, stopId: NonNullable<PlanningState["threads"][string]["stopping"]>): Promise<void> {
    await root.commit(async tx => {
      const thread = (await tx.doc(DurablePlanning, root.id)).threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      if (thread.stopping !== stopId) return;
      delete thread.stopping;
      const state = await tx.doc(DurablePlanning, root.id);
      for (const child of Object.values(state.threads)) if (child.parentThreadId === threadId && child.stopping === stopId) delete child.stopping;
      // Reported only now: the stopped turns are aborted, background jobs killed and verifier settlements joined.
      const notice = thread.stopReport;
      if (notice?.stopId === stopId) { delete thread.stopReport; const work = state.work[notice.workId]; if (work) await queueStopReport(tx, root.id, state, work, notice.notes, stopId); }
      if (!state.paused && Object.values(state.work).some(work => work.status === "queued")) state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
    }, BACKGROUND_CONTEXT);
  }
  async function pauseWorker(root: Conversation, threadId: string) {
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), thread = state.threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      if (thread.stopping) throw new Error("Thread stop is still draining");
      if (thread.paused) return null;
      const stopId = randomUUID(), taskIds: TaskId[] = [];
      thread.paused = true;
      thread.stopping = stopId;
      for (const work of Object.values(state.work)) if (work.threadId === threadId && (work.status === "queued" || work.status === "running")) {
        if (work.taskId !== null) taskIds.push(work.taskId);
        work.status = "interrupted";
        work.blocker = WORKER_PAUSE_BLOCKER;
      }
      thread.activeWorkId = null;
      return { stopId, taskIds: [...new Set(taskIds)], conversationIds: [thread.conversationId] };
    }, BACKGROUND_CONTEXT);
  }
  async function resumeWorker(root: Conversation, threadId: string): Promise<void> {
    await root.commit(async tx => {
      if (await hasUncertainVcsOperations(tx, root.id)) throw new Error("A VCS operation has an uncertain outcome; worker resume is denied");
      const state = await tx.doc(DurablePlanning, root.id), thread = state.threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      if (state.paused || state.pausing) throw new Error("Project plan is paused; worker resume is denied");
      if (thread.stopping) throw new Error("Thread stop is still draining");
      if (!thread.paused) return;
      delete thread.paused;
      for (const work of Object.values(state.work)) if (work.threadId === threadId && work.status === "interrupted" && work.blocker === WORKER_PAUSE_BLOCKER) {
        delete work.verificationRequest; work.status = "queued"; work.blocker = quotaWaitBlocker(work); work.taskId = null;
        work.startedAt = null; work.endedAt = null; work.resumes = (work.resumes ?? 0) + 1;
        work.attempt &&= { ...work.attempt, startedAt: null, endedAt: null };
      }
      requeuePauseInterrupted(state);
      state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
    }, BACKGROUND_CONTEXT);
  }
  /** Dispatch persisted quota waits whose deadlines passed. Safe to call after any timer or restart. */
  async function recoverQuota(root: Conversation): Promise<void> {
    await root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), now = Date.now();
      if (state.paused || state.pausing || !Object.values(state.work).some(work => work.status === "queued" && work.quotaRecovery !== undefined && work.quotaRecovery.retryAt <= now && !state.threads[work.threadId]?.paused && !state.threads[work.threadId]?.stopping)) return;
      await dispatch(tx, root.id);
    }, BACKGROUND_CONTEXT);
  }
  async function retryWorker(root: Conversation, workId: string, requestId: string, chat?: ConversationId): Promise<{ attemptId: string; threadId: string }> {
    if (!requestId || requestId.length > 32000) throw new Error("Retry requestId is required");
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), receipts = retryReceipts(state);
      const receipt = receipts.find(item => item.requestId === requestId);
      if (receipt) {
        if (receipt.workId !== workId) throw new Error("Conflicting duplicate retry requestId");
        return { attemptId: receipt.attemptId, threadId: receipt.threadId };
      }
      if (Object.values(state.work).some(work => work.requestId === requestId)) throw new Error("Conflicting duplicate retry requestId");
      const previous = state.work[workId];
      if (!previous) throw new Error("Unknown durable work UUID");
      if (state.threads[previous.threadId]?.paused) throw new Error("Worker is paused; resume it instead of retrying");
      if (previous.status === "queued" && previous.quotaRecovery) {
        previous.quotaRecovery.retryAt = 0;
        state.retryReceipts = [...receipts, { requestId, workId, attemptId: previous.id, threadId: previous.threadId }];
        previous.blocker = `quota_reset_wait: manual retry requested; waiting for an available worker slot on ${previous.attempt?.model ?? "the frozen model"}.`;
        if (!state.paused && !state.pausing) state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
        return { attemptId: previous.id, threadId: previous.threadId };
      }
      if (previous.status === "queued" || previous.status === "running") throw new Error("Only terminal work can be retried; steer running work instead");
      requireWorkspaceThread(previous);
      const record = await admit(tx, root.id, { id: randomUUID(), threadId: previous.threadId, role: previous.role, text: previous.text, requestId, dependsOn: [...previous.dependsOn], requiredTools: [...previous.requiredTools], workspaceScopeId: previous.workspaceScopeId ?? undefined }, true, chat);
      state.work[record.id].retryOf = workId;
      if (previous.priority !== undefined) state.work[record.id].priority = previous.priority;
      state.retryReceipts = [...receipts, { requestId, workId, attemptId: record.id, threadId: record.threadId }];
      return { attemptId: record.id, threadId: record.threadId };
    }, BACKGROUND_CONTEXT);
  }
  async function prioritizeWorker(root: Conversation, workId: string, priority: number): Promise<void> {
    if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) throw new Error("Priority must be an integer between -100 and 100");
    await root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), work = state.work[workId];
      if (!work) throw new Error("Unknown durable work UUID");
      if (state.paused || state.pausing) throw new Error("Project plan is paused");
      if (work.status !== "queued") throw new Error("Only queued work can be reprioritized");
      work.priority = priority;
    }, BACKGROUND_CONTEXT);
  }
  /** Open work by default (completed and archived work is reported already); `all` lists the whole history. */
  async function workerSnapshot(root: Conversation, pageOptions: { offset?: number; limit?: number; all?: boolean } = {}) {
    const offset = pageOptions.offset ?? 0, limit = pageOptions.limit ?? 30;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid worker list page");
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), all = Object.values(state.work).filter(work => pageOptions.all || work.status !== "completed" && work.archivedAt === undefined), page = all.slice(offset, offset + limit);
      const threadIds = [...new Set(page.map(work => work.threadId))];
      return {
        projectId: options.projectId, paused: state.paused, pausing: state.pausing, workerCap: state.workerCap,
        work: page.map(work => ({ ...workReceipt(work), id: work.id, role: work.role, text: work.text.slice(0, 240), dependsOn: [...work.dependsOn], priority: work.priority ?? 0, workspaceScopeId: work.workspaceScopeId, model: work.attempt?.model ?? null, ...(work.quotaRecovery ? { quotaRecovery: { retryAt: work.quotaRecovery.retryAt, attempts: work.quotaRecovery.attempts } } : {}), ...(work.attempt?.modelTransitions?.length ? { modelTransitions: work.attempt.modelTransitions.map(item => ({ ...item })) } : {}), toolNames: [...(work.attempt?.toolNames ?? [])], startedAt: work.startedAt ?? null, endedAt: work.endedAt ?? null, archived: work.archivedAt !== undefined, parentThreadId: work.parentThreadId ?? null, report: work.report ? work.report.delivered ? work.report.requestId.startsWith("held:") ? "held until children finish" : work.parentThreadId && work.report.requestId.startsWith("child-report:") ? "delivered to parent" : "delivered" : "pending" : "none" })),
        threads: threadIds.flatMap(threadId => { const thread = state.threads[threadId]; return thread ? [{ threadId, paused: Boolean(thread.paused), stopping: Boolean(thread.stopping), activeWorkId: thread.activeWorkId, workspaceScopeId: thread.workspaceScopeId, parentThreadId: thread.parentThreadId ?? null }] : []; }),
        offset, total: all.length, nextOffset: offset + page.length < all.length ? offset + page.length : null, observedAtMs: Date.now(),
      };
    }, BACKGROUND_CONTEXT);
  }
  function workReceipt(work: StoredWork): { workId: string; threadId: string; status: StoredWork["status"]; blocker: string | null; workspaceScopeId: string | null } { return { workId: work.id, threadId: work.threadId, status: work.status, blocker: work.blocker, workspaceScopeId: work.workspaceScopeId }; }
  function numberRecord(source: Record<string, number>): Record<string, number> { return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value])); }
  function attemptSnapshot(work: StoredWork): DurableResolvedAttempt | null { const attempt = work.attempt; return attempt === null ? null : { id: attempt.id, projectId: attempt.projectId, threadId: work.threadId, role: work.role, model: attempt.model, modelTransitions: attempt.modelTransitions?.map(item => ({ ...item })) ?? [], thinking: attempt.thinking, instructions: attempt.instructions, cwd: attempt.cwd, toolNames: [...(attempt.boundTools ?? attempt.toolNames)], bindingRevision: attempt.bindingRevision, standingRevision: attempt.standingRevision, startedAt: attempt.startedAt, endedAt: attempt.endedAt, usage: { baseline: numberRecord(attempt.usage.baseline), final: numberRecord(attempt.usage.final), delta: numberRecord(attempt.usage.delta) } }; }
  function projectSnapshot(state: PlanningState): DurablePlanSnapshot { return { paused: state.paused, pausing: state.pausing, workerCap: state.workerCap, work: Object.values(state.work).map(work => ({ id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...work.dependsOn], status: work.status, blocker: work.blocker, startedAt: work.startedAt ?? work.attempt?.startedAt ?? null, endedAt: work.endedAt ?? work.attempt?.endedAt ?? null, archived: work.archivedAt !== undefined, chatConversationId: work.chatConversationId === undefined ? null : Number(work.chatConversationId), parentThreadId: work.parentThreadId ?? null, attempt: attemptSnapshot(work), ...(work.steering ? { steering: true } : {}) })), ...verificationSnapshot(state) }; }
  function verificationSnapshot(state: PlanningState): { verification?: Record<string, VerificationSummary> } { const cycles = Object.entries(state.threads).flatMap(([id, thread]) => thread.verification ? [[id, summarizeVerification(thread.verification)] as const] : []); return cycles.length ? { verification: Object.fromEntries(cycles) } : {}; }
  /** Hide terminal work from default views. `terminal` selects every unarchived terminal item. Nothing is deleted. */
  async function archiveWork(root: Conversation, selection: { workIds?: readonly string[]; terminal?: boolean }): Promise<{ archived: string[] }> {
    if (!selection.terminal && !selection.workIds?.length) throw new Error("Pass workIds or terminal: true");
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      const all = Object.values(state.work);
      const chosen = selection.terminal ? all.filter(work => ARCHIVABLE.has(work.status) && work.archivedAt === undefined) : selection.workIds!.map(id => {
        const work = state.work[id];
        if (!work) throw new Error(`Unknown work ID ${id}`);
        if (!ARCHIVABLE.has(work.status)) throw new Error(`Work ${id} is not terminal (${work.status}); stop it or wait for it to finish before archiving`);
        return work;
      });
      const now = Date.now();
      for (const work of chosen) work.archivedAt ??= now;
      return { archived: chosen.map(work => work.id) };
    }, BACKGROUND_CONTEXT);
  }
  async function snapshot(root: Conversation): Promise<DurablePlanSnapshot> { return root.commit(async tx => projectSnapshot(await tx.doc(DurablePlanning, root.id)), BACKGROUND_CONTEXT); }
  async function threadIdentities(root: Conversation): Promise<Array<{ threadId: string; conversationId: ConversationId; stopping: boolean; transferredTo?: string }>> {
    return root.commit(async tx => Object.entries((await tx.doc(DurablePlanning, root.id)).threads).map(([threadId, thread]) => ({ threadId, conversationId: thread.conversationId, stopping: thread.stopping !== undefined, ...(thread.transferredTo ? { transferredTo: thread.transferredTo } : {}) })), BACKGROUND_CONTEXT);
  }
  /** A worker thread's live worktree path (read-only inspection by the coordinator). */
  async function workerRoot(root: Conversation, threadId: string): Promise<string> {
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), latest = Object.values(state.work).findLast(work => work.threadId === threadId);
      if (latest?.role !== "worker") throw new Error(`Unknown worker thread ${threadId}`);
      const hint = "its commits are on its branch; ask the worker for the branch or PR instead";
      // After a takeover the worktree belongs to the newest thread of the chain, once that has started.
      let owner = threadId; for (let next = state.threads[owner]?.transferredTo; next && state.threads[next]; next = state.threads[next].transferredTo) owner = next;
      if (owner !== threadId) try { return threadReadRoot(state, owner, hint); } catch { /* not started yet: the original path is the same worktree */ }
      return threadReadRoot(state, threadId, hint);
    }, BACKGROUND_CONTEXT);
  }
  /** The owner's setting is the only source of the limit; no work is aborted when it drops, and a paused project only records it. */
  async function setWorkerCap(root: Conversation, cap: number): Promise<void> {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 32) throw new Error("Worker cap must be between 1 and 32");
    await root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      if (state.workerCap === cap) return;
      state.workerCap = cap;
      if (!state.paused && !state.pausing && Object.values(state.work).some(work => work.status === "queued")) state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
    }, BACKGROUND_CONTEXT);
  }
  return { readTarget, workResult, delegation, archiveWork, pauseWorker, resumeWorker, recoverQuota, retryWorker, prioritizeWorker, workerSnapshot, setWorkerCap, extension, capabilities, delegate, workspaceCatalog, assertAdmitting, plan, followUp, steer, pause, completePause, recoverPause, resume, stop, completeStop, snapshot, threadIdentities, workerRoot };
}
