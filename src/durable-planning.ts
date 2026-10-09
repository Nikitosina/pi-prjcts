import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool, UsageDoc, type Conversation, type ConversationId, type ModelRef, type TaskId, type ToolRegistration, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import type { DurablePlan, DurablePlanSnapshot, DurablePlanWork, DurablePlanWorkSnapshot, DurablePrepareWorkerEnvironment, DurablePublishWorkerEnvironment, DurableResolvedAttempt, DurableRole, DurableWorkerToolBindings, DurableWorkspaceInstructions } from "./durable-plan-types.ts";
import type { WorkspaceCatalogEntry } from "./workspace-authorization.ts";

export { type DurablePlan, type DurablePlanSnapshot, type DurablePlanWork, type DurablePlanWorkSnapshot, type DurableResolvedAttempt, type DurableRole, type DurableGenerationLifecycle, type DurableGenerationLifecycleObserver } from "./durable-plan-types.ts";

const PAUSE_BLOCKER = "Interrupted by project pause";
const WORKER_PAUSE_BLOCKER = "Interrupted by worker pause";
const PREDECESSOR_BLOCKER = "A predecessor did not complete";
const planUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StoredUsage = { baseline: Record<string, number>; final: Record<string, number>; delta: Record<string, number> };
type StoredAttempt = { id: string; projectId: string; model: string; thinking: "low" | "medium" | "high"; instructions: string; cwd: string; toolNames: string[]; /** Tools actually configured (observability only; toolNames stays the frozen requiredTools). */ boundTools?: string[]; bindingRevision: string; capabilityBindingRevision?: string; standingRevision: string; startedAt: number | null; endedAt: number | null; usage: StoredUsage };
type AttemptResult = { status: "completed" | "failed" | "interrupted"; reason: string | null; text?: string };
function isAttemptResult(value: unknown): value is AttemptResult { return typeof value === "object" && value !== null && "status" in value && (value.status === "completed" || value.status === "failed" || value.status === "interrupted"); }
function usageNumbers(value: unknown): Record<string, number> { const numbers: Record<string, number> = {}; const visit = (item: unknown, path: string): void => { if (typeof item === "number" && Number.isFinite(item)) { numbers[path] = item; return; } if (Array.isArray(item)) item.forEach((child, index) => visit(child, `${path}.${index}`)); else if (typeof item === "object" && item !== null) for (const [key, child] of Object.entries(item)) visit(child, path ? `${path}.${key}` : key); }; visit(value, ""); return numbers; }
function usageDelta(baseline: Record<string, number>, final: Record<string, number>): Record<string, number> { const delta: Record<string, number> = {}; for (const key of new Set([...Object.keys(baseline), ...Object.keys(final)])) delta[key] = (final[key] ?? 0) - (baseline[key] ?? 0); return delta; }
function canonicalIntent(work: Pick<StoredWork, "id" | "threadId" | "role" | "text" | "dependsOn" | "requestId" | "requiredTools" | "workspaceScopeId">): string { return JSON.stringify({ id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...new Set(work.dependsOn)].sort(), requestId: work.requestId, requiredTools: [...new Set(work.requiredTools)].sort(), workspaceScopeId: work.workspaceScopeId }); }
function sameIntent(left: Pick<StoredWork, "id" | "threadId" | "role" | "text" | "dependsOn" | "requestId" | "requiredTools" | "workspaceScopeId">, right: Pick<StoredWork, "id" | "threadId" | "role" | "text" | "dependsOn" | "requestId" | "requiredTools" | "workspaceScopeId">, includeId: boolean): boolean { return includeId ? canonicalIntent(left) === canonicalIntent(right) : canonicalIntent({ ...left, id: "" }) === canonicalIntent({ ...right, id: "" }); }
function profileHash(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }
function profileMismatches(first: StoredAttempt, next: StoredAttempt): string[] { const values: Array<[string, string, string]> = [["model", first.model, next.model], ["thinking", first.thinking, next.thinking], ["bindingRevision", first.bindingRevision, next.bindingRevision], ["capabilityBindingRevision", first.capabilityBindingRevision ?? first.bindingRevision, next.capabilityBindingRevision ?? next.bindingRevision], ["standingRevision", first.standingRevision, next.standingRevision], ["cwd", first.cwd, next.cwd], ["instructions", first.instructions, next.instructions], ["toolNames", first.toolNames.join("\u0000"), next.toolNames.join("\u0000")]]; return values.filter(([, left, right]) => left !== right).map(([name, left, right]) => `${name}:${profileHash(left)}!=${profileHash(right)}`); }
type StoredWork = { id: string; threadId: string; role: DurableRole; text: string; dependsOn: string[]; requestId: string | null; steering?: true; /** Hidden from default views; record, thread and report are retained. */ archivedAt?: number; retryOf?: string; priority?: number; requiredTools: string[]; workspaceScopeId: string | null; workspaceBindingRevision: string | null; workspaceConfigured: boolean; status: "queued" | "running" | "blocked" | "completed" | "failed" | "interrupted" | "stopped"; blocker: string | null; /** Count of resumes after a pause interruption; each retry needs a fresh submission requestId. */ resumes?: number; startedAt?: number | null; endedAt?: number | null; conversationId: ConversationId | null; taskId: TaskId | null; attempt: StoredAttempt | null; settlementTaskId?: TaskId; report?: { requestId: string; text: string; delivered: boolean }; /** Coordinator chat that admitted this work and receives its report; absent means the root (Main). */ chatConversationId?: ConversationId; /** Child work: its report goes to this parent worker thread as a follow-up, not to a chat. */ parentThreadId?: string };
export type PlanningState = { paused: boolean; pausing: boolean; workerCap: number | null; configuredWorkerCap?: number; work: Record<string, StoredWork>; threads: Record<string, { conversationId: ConversationId; activeWorkId: string | null; /** Scout/reviewer code root: a PR-head snapshot (readSha) or the parent worker's worktree. */ readRoot?: string; readSha?: string; workspaceScopeId: string | null; workspaceBindingRevision: string | null; workspaceConfigured: boolean; paused?: true; stopping?: true | string; /** Set on child threads (one level); children cannot delegate. */ parentThreadId?: string }>; dispatcherTaskIds: TaskId[] }; 

export const DurablePlanning = defineDoc<PlanningState>({ kind: "projects.durable-planning", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ paused: false, pausing: false, workerCap: null, work: {}, threads: {}, dispatcherTaskIds: [] }) });

type AttemptInput = { workId: string; conversationId: ConversationId; /** Root planning document ID, frozen for child-bound scoped tasks. */ planConversationId?: ConversationId; /** Legacy persisted v1 name. */ parentConversationId?: ConversationId; text: string; requestId: string; threadId?: string; role?: DurableRole; workspaceScopeId?: string };
function planConversationId(task: { input: AttemptInput }, runtime: { conversationId: ConversationId }): ConversationId { return task.input.planConversationId ?? task.input.parentConversationId ?? runtime.conversationId; }
type AttemptState = { phase: "submit" };
const Attempt = defineTask<AttemptInput, AttemptState, { status: "completed" | "failed" | "interrupted"; reason: string | null }>({
  name: "projects.plan-attempt", version: 1, initial: () => ({ phase: "submit" }),
  phases: {
    submit: async (task, runtime, context) => {
      const child = await runtime.conversation(task.input.conversationId, context);
      if (!child) throw new Error("Planned worker conversation is missing");
      await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, planConversationId(task, runtime)); if (state.paused || state.pausing) throw new Error("Project plan is paused; worker submission is not authorized"); }, context);
      const baseline = usageNumbers(await runtime.snapshot(UsageDoc, task.input.conversationId, context));
      await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, runtime.conversationId); const work = state.work[task.input.workId]; if (work?.attempt) work.attempt.usage.baseline = baseline; }, context);
      let result: AttemptResult = { status: "failed", reason: "Attempt did not settle" };
      try {
        const submission = await child.submit({ type: "input", content: task.input.text, requestId: task.input.requestId, whenBusy: "followUp" }, context);
        const answer = await submission.wait(context);
        result = answer.status === "unanswered" ? { status: answer.reason === "aborted" ? "interrupted" : "failed", reason: answer.reason } : { status: "completed", reason: null };
        if (answer.status === "done" && answer.type === "input") {
          await runtime.commit(async tx => {
            const entry = await tx.entry(AssistantEntry, answer.answer);
            const message = entry?.model?.[0];
            result.text = message?.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").slice(0, 16000) : "";
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

export function planningRuntime(options: { projectId: string; models: Record<DurableRole, ModelRef>; resolveModel?: (model: string, role: DurableRole) => ModelRef; cwd: string; instructions: Record<DurableRole, string>; standingRevision: string; workspaceInstructions?: DurableWorkspaceInstructions; knowledgeTools: readonly ToolRegistration[]; /** Scout and reviewer only: read-only checkout tools and their extension. */ readOnlyCode?: { tools: readonly ToolRegistration[]; extension: ReturnType<typeof defineExtension> }; /** Reviewer only: the review-verdict tool and its extension. */ reviewerTools?: { tools: readonly ToolRegistration[]; extension: ReturnType<typeof defineExtension> }; workerPolicy: ReturnType<typeof defineExtension>; /** Every role: the profile-restricted skill reader. */ skillFiles?: { tool: ToolRegistration; extension: ReturnType<typeof defineExtension> }; /** Every role: the MCP gateway tools (servers are filtered per role at call time). */ mcp?: { tools: readonly ToolRegistration[]; extension: ReturnType<typeof defineExtension> }; workerTools?: DurableWorkerToolBindings; workerCap: number; workspaceCatalog?: () => readonly WorkspaceCatalogEntry[]; /** Host-only scoped-worker preparation; absent means every workspace scope is denied. */ prepareWorkerEnvironment?: DurablePrepareWorkerEnvironment; /** Host-only registry publication, invoked after post-preparation authorization validation. */ publishWorkerEnvironment?: DurablePublishWorkerEnvironment; beforeScopedSubmit?: () => Promise<void>; /** Root conversation owning the shared plan, so delegation from any chat admits into one pool. */ planRoot?: () => ConversationId | undefined; /** Host-only: fetch a ref into a read-only snapshot for scout/reviewer threads. */ readHead?: (ref: string) => Promise<{ root: string; sha: string }>; /** Host-only: short listing of a thread's artifacts folder for its report (empty when none). */ artifactSummary?: (threadId: string) => string }) {
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
    await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, rootPlanConversationId); const work = state.work[task.input.workId]; if (!work || work.taskId !== Number(runtime.taskId) || work.status !== "running" || state.paused || work.threadId !== task.input.threadId || work.role !== task.input.role || work.workspaceScopeId !== task.input.workspaceScopeId || work.conversationId !== task.input.conversationId || state.threads[work.threadId]?.activeWorkId !== work.id) throw new Error("Scoped attempt identity/active authorization no longer matches its frozen plan work"); const profile = work.attempt; if (!profile) throw new Error("Scoped attempt has no frozen profile"); const model = frozenModel(profile, work.role); if ( profile.model !== `${model.provider}/${model.modelId}` || profile.thinking !== "medium" || profile.standingRevision !== options.standingRevision || (profile.capabilityBindingRevision ?? profile.bindingRevision) !== bindingRevision) throw new Error("Scoped attempt frozen profile differs from current host settings"); frozen = { instructions: profile.instructions, configured: work.workspaceConfigured }; }, context);
    if (frozen.configured && (await runtime.agent(context)).instructions !== frozen.instructions) throw new Error("Scoped thread instruction text no longer matches its frozen profile");
    const publish = options.publishWorkerEnvironment; let environment; try { environment = await options.prepareWorkerEnvironment?.({ conversationId: Number(task.input.conversationId), workId: task.input.workId, threadId: task.input.threadId, role: task.input.role, workspaceScopeId: task.input.workspaceScopeId }); if (!environment || !publish) throw new Error("Scoped worker environment was not prepared/publishable by the host"); } catch (error) { return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "failed", reason: error instanceof Error ? error.message : String(error) } } }), context); }
    await runtime.commit(async tx => { const state = await tx.doc(DurablePlanning, rootPlanConversationId); const work = state.work[task.input.workId]; if (!work || work.taskId !== Number(runtime.taskId) || work.status !== "running" || state.paused || state.threads[work.threadId]?.activeWorkId !== work.id || work.workspaceScopeId !== task.input.workspaceScopeId) throw new Error("Scoped worker binding/active authorization changed before configuration"); if (work.workspaceBindingRevision !== null && work.workspaceBindingRevision !== environment.bindingRevision) throw new Error("Scoped worker binding revision changed"); publish(environment.extension); const needsConfigure = !work.workspaceConfigured || work.attempt?.cwd !== environment.cwd; if (needsConfigure) { const profile = work.attempt; if (!profile) throw new Error("Scoped worker lost its frozen profile before configuration"); if (!frozen.configured && environment.repositoryStanding && !options.workspaceInstructions) throw new Error("Selected repository standing instructions require the host instruction factory"); const baseInstructions = !frozen.configured && environment.repositoryStanding && options.workspaceInstructions ? options.workspaceInstructions(work.role, environment.repositoryStanding) : profile.instructions; const instructions = `${baseInstructions}${environment.workerInstructions ?? ""}`; await configure(tx, task.input.conversationId, { model: work.attempt ? frozenModel(work.attempt, work.role) : options.models[work.role], thinkingLevel: "medium", cwd: environment.cwd, tools: [...options.knowledgeTools, ...work.requiredTools.map(name => bindings.get(name)!), ...environment.tools, ...(nests(work) ? [delegateChild] : []), ...(options.skillFiles ? [options.skillFiles.tool] : []), ...(options.mcp?.tools ?? [])], extensions: [options.workerPolicy, capabilities, environment.extension, ...(nests(work) ? [delegation] : []), ...(options.skillFiles ? [options.skillFiles.extension] : []), ...(options.mcp ? [options.mcp.extension] : [])], instructions }); profile.instructions = instructions; if (work.attempt) { work.attempt.boundTools = [...options.knowledgeTools, ...work.requiredTools.map(name => bindings.get(name)!), ...environment.tools, ...(nests(work) ? [delegateChild] : []), ...(options.skillFiles ? [options.skillFiles.tool] : []), ...(options.mcp?.tools ?? [])].map(tool => tool.name); work.attempt.cwd = environment.cwd; work.attempt.bindingRevision = environment.bindingRevision; } work.workspaceConfigured = true; work.workspaceBindingRevision = environment.bindingRevision; const thread = state.threads[work.threadId]; if (thread) { thread.workspaceConfigured = true; thread.workspaceBindingRevision = environment.bindingRevision; } } }, context);
    await options.beforeScopedSubmit?.(); const baseline = usageNumbers(await runtime.snapshot(UsageDoc, task.input.conversationId, context)); await runtime.commit(async tx => { const work = (await tx.doc(DurablePlanning, rootPlanConversationId)).work[task.input.workId]; if (work?.attempt) work.attempt.usage.baseline = baseline; }, context); let result: AttemptResult;
    try { const submission = await child.submit({ type: "input", content: task.input.text, requestId: task.input.requestId, whenBusy: "followUp" }, context); const answer = await submission.wait(context); result = answer.status === "unanswered" ? { status: answer.reason === "aborted" ? "interrupted" : "failed", reason: answer.reason } : { status: "completed", reason: null }; if (answer.status === "done" && answer.type === "input") { await runtime.commit(async tx => { const entry = await tx.entry(AssistantEntry, answer.answer); const message = entry?.model?.[0]; result.text = message?.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").slice(0, 16000) : ""; }, context); } } catch (error) { result = { status: runtime.signal.aborted ? "interrupted" : "failed", reason: error instanceof Error ? error.message : String(error) }; }
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
          if (state.paused || state.pausing || !work?.report || work.report.delivered) return;
          target = work.chatConversationId ?? runtime.conversationId;
          const receipt = await tx.submissionByRequest(target, work.report.requestId);
          if (receipt?.status === "unanswered" && receipt.reason === "aborted") work.report.requestId += ":resume";
          pending = { ...work.report };
        }, context);
        if (pending) {
          const parent = await runtime.conversation(target, context) ?? await runtime.conversation(runtime.conversationId, context);
          if (!parent) throw new Error("Coordinator conversation is missing");
          const submission = await parent.submit({ type: "input", content: pending.text, requestId: pending.requestId, whenBusy: "followUp" }, context);
          const answer = await submission.wait(context);
          await runtime.commit(async tx => {
            const work = (await tx.doc(DurablePlanning, runtime.conversationId)).work[task.input.workId];
            if (work?.report && work.report.requestId === pending?.requestId && (answer.status !== "unanswered" || answer.reason !== "aborted")) work.report.delivered = true;
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
        await runtime.commit(async tx => {
          const state = await tx.doc(DurablePlanning, runtime.conversationId);
          const work = state.work[task.input.workId];
          // A paused, stopped, or resumed attempt must not replace the newer thread state.
          if (work?.status === "running" && work.taskId === Number(task.input.attemptTaskId)) {
            work.status = result?.status === "completed" ? "completed" : result?.status === "interrupted" ? "interrupted" : "failed";
            work.endedAt = Date.now();
            work.blocker = work.status === "completed" ? null : result?.reason ?? `Durable task ${outcome?.status ?? "missing"}`;
            work.attempt &&= { ...work.attempt, endedAt: work.endedAt };
            const thread = state.threads[work.threadId];
            if (thread?.activeWorkId === work.id) thread.activeWorkId = null;
            const resultText = result?.text ?? work.blocker ?? "No text result.";
            if (work.status !== "interrupted" && !(work.parentThreadId && await reportToParent(tx, runtime.conversationId, state, work, String(task.input.attemptTaskId), resultText))) {
              const active = (other: StoredWork) => other.id !== work.id && (other.status === "queued" || other.status === "running");
              // A parent's answer while its children still run (or a later child result waits on its thread) is held: only its last answer reports.
              if (work.status === "completed" && nests(work) && Object.values(state.work).some(other => active(other) && (other.parentThreadId === work.threadId || other.threadId === work.threadId && other.requestId?.startsWith("child-report:")))) work.report = { requestId: `held:${work.id}:${task.input.attemptTaskId}`, delivered: true, text: resultText.slice(0, 2000) };
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
            work.blocker = work.status === "completed" ? null : result?.reason ?? `Durable task ${outcome?.status ?? "missing"}`;
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

  const delegate = defineTool({ name: "projects_delegate", description: "Admit bounded durable worker work. Choose role worker, scout, or reviewer for the task. For an owner-authorized workspace, pass workspaceScopeId and omit requiredTools; a worker without one uses the project's only whole-repository scope when exactly one exists, and the receipt names the scope used. Roles select model/instructions; scout and reviewer also get read-only code tools (code_read, code_grep, code_find, code_ls) and ignore workspaceScopeId. Their code root is the project checkout unless you pass a target: threadId of an existing worker thread (they read that worker's worktree, including its uncommitted edits; use this to review a worker's PR or work), or ref: a branch (e.g. a project PR branch pi/...), pull/<number> or a commit SHA; the host fetches it from origin or Arcadia into a read-only snapshot so they read the PR head, not the owner's checkout. They also get code_diff (changed files and unified diff against the merge-base). Give every reviewer of a PR or worker's change a threadId or ref. An unknown threadId or unresolvable ref fails the call. Independent delegations run concurrently up to the project worker cap. Completion or failure sends a result back to this coordinator. The host supplies exact scoped read/write and authorized publication tools after allocation. requiredTools selects only additional global tool names explicitly advertised by the host; never invent aliases such as workspace_read, workspace_write or projects_github. Missing capabilities remain blocked.", parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 32000 }), role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")])), requiredTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })), workspaceScopeId: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$" })), ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Scout/reviewer only: branch, pull/<number> or commit SHA to read instead of the project checkout." })), threadId: Type.Optional(Type.String({ pattern: "^[a-f0-9-]{36}$", description: "Scout/reviewer only: UUID of an existing worker thread whose worktree to read (read-only)." })) }), replay: "unsafe", async execute(args, api, context) {
    const role = args.role ?? "worker";
    if (args.ref !== undefined && role === "worker") throw new Error("ref is for scout and reviewer; a worker continuing a branch fetches it itself (say the branch in the task)");
    if (args.threadId !== undefined && role === "worker") throw new Error("threadId is for scout and reviewer; a worker is continued with a follow-up to its thread");
    if (args.threadId !== undefined && args.ref !== undefined) throw new Error("Pass either threadId or ref, not both");
    if (args.ref !== undefined && !options.readHead) throw new Error("PR-head reads are unavailable for this project");
    const head = args.ref === undefined ? undefined : await options.readHead!(args.ref);
    const ignoredScope = role !== "worker" && args.workspaceScopeId !== undefined;
    // Every chat shares the root's plan and worker pool; the delegating chat receives the report.
    const owner = options.planRoot?.() ?? api.conversationId;
    const receipt = await api.commit(async tx => {
      // A thread target is resolved against the plan in the same transaction, so an unknown or worktree-less thread fails the call instead of reading trunk.
      const threadRoot = args.threadId === undefined ? undefined : threadReadRoot(await tx.doc(DurablePlanning, owner), args.threadId);
      return workReceipt(await admit(tx, owner, { id: crypto.randomUUID(), threadId: crypto.randomUUID(), role, text: args.task, requiredTools: args.requiredTools, workspaceScopeId: role === "worker" ? args.workspaceScopeId ?? defaultWorkerScope(role, args.requiredTools) : undefined, ...(head ? { readRoot: head.root, readSha: head.sha } : threadRoot ? { readRoot: threadRoot } : {}) }, true, api.conversationId));
    }, context);
    return { content: [{ type: "text", text: JSON.stringify({ ...receipt, ...(head ? { reads: { ref: args.ref, sha: head.sha } } : {}), ...(args.threadId !== undefined ? { reads: { threadId: args.threadId } } : {}), ...(ignoredScope ? { note: "workspaceScopeId ignored: scouts and reviewers are read-only" } : {}) }) }] };
  } });
  // One level of nesting: top-level worker threads may delegate children; children never get this tool and are refused if they call it.
  const MAX_ACTIVE_CHILDREN = 2;
  const delegateChild = defineTool({ name: "projects_delegate_child", description: `Delegate a bounded sub-task to a child thread: worker (gets your workspace scope), scout or reviewer (read-only code tools on your worktree, so they see your current changes). Children share the project worker pool and cannot delegate further. Delegate only genuinely independent work that should run in parallel with yours; do small reads, checks and status questions yourself. Use at most one reviewer per head. A child's result comes back to you as a new message in this thread after it finishes, not to the coordinator: end your turn after delegating if you need the result, then continue when it arrives. Only your answer after the last child result reaches the coordinator. At most ${MAX_ACTIVE_CHILDREN} of your children may be queued or running.`, parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 32000 }), role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")])) }), replay: "unsafe", async execute(args, api, context) {
    const owner = options.planRoot?.();
    if (owner === undefined) throw new Error("Project plan is unavailable");
    const receipt = await api.commit(async tx => {
      const state = await tx.doc(DurablePlanning, owner), entry = Object.entries(state.threads).find(([, thread]) => Number(thread.conversationId) === Number(api.conversationId));
      if (!entry) throw new Error("Only worker threads can delegate child work");
      const [parentThreadId, thread] = entry, latest = Object.values(state.work).findLast(work => work.threadId === parentThreadId);
      if (thread.parentThreadId) throw new Error("Child threads cannot delegate further (one level of nesting)");
      if (latest?.role !== "worker") throw new Error("Only worker threads can delegate child work");
      if (thread.stopping) throw new Error("This thread is stopping");
      if (Object.values(state.work).filter(work => work.parentThreadId === parentThreadId && (work.status === "queued" || work.status === "running")).length >= MAX_ACTIVE_CHILDREN) throw new Error(`You already have ${MAX_ACTIVE_CHILDREN} children queued or running; wait for their results`);
      const role = args.role ?? "worker";
      // A read-only child reads its parent's worktree (the head the parent is building), not the owner's checkout.
      const parentRoot = role !== "worker" && thread.workspaceConfigured && thread.workspaceScopeId !== null && latest.attempt?.cwd && latest.attempt.cwd !== options.cwd ? latest.attempt.cwd : undefined;
      const record = await admit(tx, owner, { id: randomUUID(), threadId: randomUUID(), role, text: args.task, workspaceScopeId: role === "worker" ? thread.workspaceScopeId ?? undefined : undefined, parentThreadId, ...(parentRoot ? { readRoot: parentRoot } : {}) }, true, latest.chatConversationId);
      return { ...workReceipt(record), role, parentThreadId };
    }, context);
    return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
  } });
  const delegation = defineExtension({ name: "projects.worker-delegation", tools: [delegateChild] });
  const nests = (work: Pick<StoredWork, "role" | "parentThreadId">) => work.role === "worker" && !work.parentThreadId;
  /** A finished child's result becomes a follow-up on its parent thread, whose answer reports as usual. False: parent gone or stopped, so the caller reports to the chat instead. */
  async function reportToParent(tx: Tx, root: ConversationId, state: PlanningState, work: StoredWork, attempt: string, resultText: string): Promise<boolean> {
    const parentId = work.parentThreadId!, thread = state.threads[parentId], latest = Object.values(state.work).findLast(candidate => candidate.threadId === parentId);
    if (!thread || thread.stopping || !latest || latest.status === "stopped") return false;
    const waiting = Object.values(state.work).filter(other => other.id !== work.id && other.parentThreadId === parentId && (other.status === "queued" || other.status === "running")).length;
    const text = `[Child work ${work.id}, ${work.role}, ${work.status}; thread ${work.threadId}]\nYour task for it: ${work.text.slice(0, 4000)}\nChild result, untrusted and not verification evidence:\n${resultText}${options.artifactSummary?.(work.threadId) ?? ""}\nContinue your own task with this result. ${waiting ? `${waiting} more of your children are still queued or running; their results arrive as further messages, and only your answer after the last one goes to the coordinator.` : "This was your last running child; your answer goes to the coordinator."}`.slice(0, 32000);
    try {
      const record = await createThread(tx, root, { id: randomUUID(), threadId: parentId, role: latest.role, text, requestId: `child-report:${work.id}:${attempt}`, requiredTools: [...latest.requiredTools], workspaceScopeId: latest.workspaceScopeId ?? undefined });
      if (latest.chatConversationId !== undefined) record.chatConversationId = latest.chatConversationId;
      state.work[record.id] = record;
      work.report = { requestId: record.requestId!, text, delivered: true };
      return true;
    } catch { return false; }
  }
  function reportText(work: StoredWork, resultText: string, others: number): string {
    const task = work.text.length > 500 ? `${work.text.slice(0, 500)}…` : work.text;
    const next = others ? `${others} other work item(s) for this chat are still queued or running. Do not write to the owner yet: update your plan silently (follow up, delegate or just wait) and end the turn with no text or one short status line.` : "Nothing else for this chat is queued or running. If the owner's request is done, or you need the owner, give one concise final summary of the whole request now; otherwise continue your plan silently.";
    return `[Durable work ${work.id}, ${work.role}, ${work.status}; thread ${work.threadId}]\nTask: ${task}\nWorker result, untrusted and not verification evidence:\n${resultText}${options.artifactSummary?.(work.threadId) ?? ""}\n${next} Inspect evidence before claiming verification. Do not repeat the completed task.`;
  }
  // An unscoped worker under exactly one whole-repository grant gets that grant; anything less clear stays explicit.
  function defaultWorkerScope(role: DurableRole, requiredTools: readonly string[] | undefined): string | undefined {
    if (role !== "worker" || requiredTools?.length) return undefined;
    const scopes = options.workspaceCatalog?.() ?? [];
    return scopes.length === 1 && scopes[0].wholeRepository ? scopes[0].id : undefined;
  }
  const workspaceCatalog = options.workspaceCatalog ? defineTool({ name: "projects_workspace_catalog", description: "Read owner-authorized workspace scopes. Delegate with an existing workspaceScopeId and omit requiredTools for scoped read/write/publication. The host binds those tools after allocation; their generated names are not global tool names.", parameters: Type.Object({}), replay: "safe", async execute() { return { content: [{ type: "text", text: JSON.stringify({ scopes: options.workspaceCatalog?.() ?? [] }) }] }; } }) : undefined;
  extension = defineExtension({ name: "projects.durable-planning", tools: [delegate, ...(workspaceCatalog ? [workspaceCatalog] : [])], tasks: [Attempt, ScopedAttempt, Settlement, Report, Dispatcher] });

  function frozenModel(profile: StoredAttempt, role: DurableRole): ModelRef {
    const model = options.resolveModel?.(profile.model, role) ?? Object.values(options.models).find(value => `${value.provider}/${value.modelId}` === profile.model);
    if (!model || `${model.provider}/${model.modelId}` !== profile.model) throw new Error("Frozen thread model is unavailable; restore its configured provider/model before continuing");
    return model;
  }
  /** Code root of an existing thread: a worker's worktree (not the shared project checkout) or a read-only thread's own root. Throws when it has none or is gone. */
  function threadReadRoot(state: PlanningState, threadId: string): string {
    const thread = state.threads[threadId], latest = Object.values(state.work).findLast(work => work.threadId === threadId);
    if (!thread || !latest) throw new Error(`Unknown thread ${threadId}: pass the threadId of an existing worker thread`);
    const root = latest.role === "worker" ? thread.workspaceConfigured && thread.workspaceScopeId !== null && latest.attempt?.cwd !== options.cwd ? latest.attempt?.cwd : undefined : thread.readRoot;
    if (!root) throw new Error(`Thread ${threadId} has no worktree to read yet (it has not started or has no workspace); wait for it to start or pass a ref`);
    if (!existsSync(root)) throw new Error(`The worktree of thread ${threadId} no longer exists (cleaned up); pass the PR ref instead`);
    return root;
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
    let model = options.models[work.role];
    const instructions = options.instructions[work.role];
    let profile: StoredAttempt = { id: crypto.randomUUID(), projectId: options.projectId, model: `${model.provider}/${model.modelId}`, thinking: "medium", instructions, cwd: options.cwd, toolNames: selected, bindingRevision, capabilityBindingRevision: bindingRevision, standingRevision: options.standingRevision, startedAt: null, endedAt: null, usage: { baseline: {}, final: {}, delta: {} } };
    if (missing.length) return { id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...new Set(work.dependsOn ?? [])], requestId: work.requestId ?? null, requiredTools: selected, workspaceScopeId, workspaceBindingRevision: null, workspaceConfigured: false, status: "blocked", blocker: `Missing required tool bindings: ${missing.join(", ")}`, conversationId: null, taskId: null, attempt: profile };
    let conversationId: ConversationId; let continuationAttempt: StoredAttempt | undefined;
    if (existing) {
      conversationId = existing.conversationId;
      const history = Object.values(state.work).filter(candidate => candidate.threadId === work.threadId);
      if (history.some(candidate => candidate.role !== work.role)) throw new Error("Existing durable thread role does not match its frozen role");
      // A failed pre-configuration attempt has only source cwd/global bindings. Scoped continuation may inherit only a proven configured attempt.
      continuationAttempt = (workspaceScopeId === null ? history[0]?.attempt : history.filter(candidate => candidate.workspaceScopeId === workspaceScopeId && candidate.workspaceConfigured && candidate.workspaceBindingRevision === existing.workspaceBindingRevision && candidate.attempt !== null).at(-1)?.attempt) ?? undefined;
      if (continuationAttempt) { model = frozenModel(continuationAttempt, work.role); profile.model = continuationAttempt.model; profile.instructions = continuationAttempt.instructions; if (continuationAttempt.boundTools) profile.boundTools = [...continuationAttempt.boundTools]; }
      if (continuationAttempt && workspaceScopeId !== null) profile = { ...profile, cwd: continuationAttempt.cwd, bindingRevision: continuationAttempt.bindingRevision };
      if (continuationAttempt) { const mismatches = profileMismatches(continuationAttempt, profile).filter(value => workspaceScopeId === null || (!value.startsWith("bindingRevision:") && !value.startsWith("cwd:"))); if (mismatches.length) throw new Error(`Existing durable thread profile does not match frozen role/settings/tool bindings (${mismatches.join(", ")})`); }
    } else {
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      conversationId = child.id;
      const readOnly = work.role === "worker" ? undefined : options.readOnlyCode, review = work.role === "reviewer" ? options.reviewerTools : undefined, nested = nests(work);
      const exactTools = [...options.knowledgeTools, ...(readOnly?.tools ?? []), ...(review?.tools ?? []), ...(nested ? [delegateChild] : []), ...(options.skillFiles ? [options.skillFiles.tool] : []), ...(options.mcp?.tools ?? []), ...selected.map(name => bindings.get(name)! )];
      profile.boundTools = exactTools.map(tool => tool.name);
      if (workspaceScopeId === null) await configure(tx, child.id, { model, thinkingLevel: "medium", cwd: options.cwd, tools: exactTools, extensions: [options.workerPolicy, capabilities, ...(readOnly ? [readOnly.extension] : []), ...(review ? [review.extension] : []), ...(nested ? [delegation] : []), ...(options.skillFiles ? [options.skillFiles.extension] : []), ...(options.mcp ? [options.mcp.extension] : [])], instructions });
      state.threads[work.threadId] = { conversationId, activeWorkId: null, workspaceScopeId, workspaceBindingRevision: null, workspaceConfigured: workspaceScopeId === null };
    }
    if (work.role !== "worker" && work.readRoot) { const thread = state.threads[work.threadId]!; thread.readRoot = work.readRoot; if (work.readSha) thread.readSha = work.readSha; else delete thread.readSha; }
    if (existing?.stopping) throw new Error("Thread stop is still draining");
    if (existing && existing.workspaceScopeId !== workspaceScopeId) throw new Error("Existing durable thread workspace scope does not match frozen scope binding");
    return { id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...new Set(work.dependsOn ?? [])], requestId: work.requestId ?? null, requiredTools: selected, workspaceScopeId, workspaceBindingRevision: existing?.workspaceBindingRevision ?? null, workspaceConfigured: workspaceScopeId === null ? (existing?.workspaceConfigured ?? true) : Boolean(existing?.workspaceConfigured && continuationAttempt), status: "queued", blocker: null, conversationId, taskId: null, attempt: profile };
  }
  async function admit(tx: Tx, parent: ConversationId, work: DurablePlanWork, kick: boolean, chat?: ConversationId): Promise<StoredWork> {
    const state = await tx.doc(DurablePlanning, parent);
    if (state.paused) throw new Error("Project plan is paused; new worker admission is denied");
    if (state.workerCap === null) state.workerCap = options.workerCap;
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
  async function dispatch(tx: Tx, parent: ConversationId): Promise<TaskId[]> {
    const state = await tx.doc(DurablePlanning, parent);
    if (state.paused) return [];
    if (state.workerCap === null) throw new Error("Worker cap was not frozen by an admitted plan");
    const active = Object.values(state.work).filter(work => work.status === "running").length;
    const slots = Math.max(0, state.workerCap - active);
    const started: TaskId[] = [];
    // Equal priorities keep admission order, including follow-ups interrupted by a pause.
    const queue = Object.values(state.work).map((work, order) => ({ work, order })).filter(item => item.work.status === "queued").sort((a, b) => (b.work.priority ?? 0) - (a.work.priority ?? 0) || a.order - b.order);
    for (const { work } of queue) {
      if (started.length >= slots) break;
      if (state.threads[work.threadId]?.activeWorkId !== null || state.threads[work.threadId]?.stopping || state.threads[work.threadId]?.paused) continue;
      const parents = work.dependsOn.map(id => state.work[id]);
      if (parents.some(parentWork => !parentWork || parentWork.status === "failed" || parentWork.status === "blocked" || parentWork.status === "stopped" || parentWork.status === "interrupted")) { work.status = "blocked"; work.blocker = PREDECESSOR_BLOCKER; continue; }
      if (!parents.every(parentWork => parentWork?.status === "completed")) continue;
      const scoped = work.workspaceScopeId !== null; const id = await tx.createTask(scoped ? ScopedAttempt : Attempt, { workId: work.id, conversationId: work.conversationId!, planConversationId: parent, text: work.resumes ? `The project was paused and has resumed. Continue this task from where it stopped:\n\n${work.text}` : work.text, requestId: `${work.requestId ?? `plan:${work.id}`}${work.resumes ? `:resume-${work.resumes}` : ""}`, threadId: work.threadId, role: work.role, workspaceScopeId: work.workspaceScopeId ?? undefined }, { ownership: { kind: "conversation" }, background: true, ...(scoped ? { conversationId: work.conversationId! } : {}) });
      work.settlementTaskId = await tx.createTask(Settlement, { workId: work.id, attemptTaskId: id }, { ownership: { kind: "conversation" }, background: true });
      work.taskId = id; work.status = "running"; work.startedAt ??= Date.now(); work.attempt &&= { ...work.attempt, startedAt: work.startedAt };
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
  async function followUp(root: Conversation, threadId: string, text: string, requestId: string, chat?: ConversationId): Promise<string> {
    if (!text || text.length > 32000 || !requestId) throw new Error("Follow-up text and requestId are required");
    const id = crypto.randomUUID();
    return root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); if (!state.threads[threadId]) throw new Error("Unknown durable thread UUID"); const prior = Object.values(state.work).find(work => work.requestId === requestId); if (prior) { if (prior.threadId !== threadId || prior.text !== text || prior.steering) throw new Error("Conflicting duplicate follow-up requestId"); return prior.id; } const thread = Object.values(state.work).find(work => work.threadId === threadId); if (!thread) throw new Error("Durable thread has no frozen role"); const record = await admit(tx, root.id, { id, threadId, role: thread.role, text, requestId, requiredTools: [...thread.requiredTools], workspaceScopeId: thread.workspaceScopeId ?? undefined }, true, chat); return record.id; }, BACKGROUND_CONTEXT);
  }
  async function steer(root: Conversation, threadId: string, text: string, requestId: string, chat?: ConversationId) {
    if (!text || text.length > 32000 || !requestId) throw new Error("Steering text and requestId are required");
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), thread = state.threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      const prior = Object.values(state.work).find(work => work.requestId === requestId);
      if (prior) {
        if (prior.threadId !== threadId || prior.text !== text || !prior.steering) throw new Error("Conflicting duplicate steering requestId");
        return { attemptId: prior.id, stop: null };
      }
      if (thread.stopping) throw new Error("Thread stop is still draining");
      if (thread.paused) throw new Error("Worker is paused; resume it before steering");
      const previous = Object.values(state.work).find(work => work.threadId === threadId);
      if (!previous) throw new Error("Durable thread has no frozen role");
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
  async function completePause(root: Conversation): Promise<void> { await root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); state.pausing = false; for (const thread of Object.values(state.threads)) delete thread.stopping; }, BACKGROUND_CONTEXT); }
  /** Re-enumerate persisted pause targets after a crash, before reopening dispatch. */
  async function recoverPause(root: Conversation): Promise<{ taskIds: TaskId[]; conversationIds: ConversationId[] }> {
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
      return { taskIds: [...new Set(taskIds)], conversationIds: [...new Set(conversationIds)] };
    }, BACKGROUND_CONTEXT);
  }
  /** Resume continues work the pause (or restart recovery) interrupted, on the same thread, and unblocks its dependents. */
  function requeuePauseInterrupted(state: PlanningState): void {
    const requeue = (work: StoredWork): void => { work.status = "queued"; work.blocker = null; work.taskId = null; work.startedAt = null; work.endedAt = null; work.resumes = (work.resumes ?? 0) + 1; work.attempt &&= { ...work.attempt, startedAt: null, endedAt: null }; };
    for (const work of Object.values(state.work)) if (work.status === "interrupted" && work.blocker === PAUSE_BLOCKER && !state.threads[work.threadId]?.paused) requeue(work);
    for (let changed = true; changed;) {
      changed = false;
      for (const work of Object.values(state.work)) if (work.status === "blocked" && work.blocker === PREDECESSOR_BLOCKER && work.dependsOn.every(id => ["queued", "running", "completed"].includes(state.work[id]?.status ?? ""))) { requeue(work); changed = true; }
    }
  }
  async function resume(root: Conversation): Promise<DurablePlanSnapshot> { await root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); if (state.pausing) throw new Error("Project pause is still aborting background work"); state.paused = false; requeuePauseInterrupted(state); for (const work of Object.values(state.work)) if (work.report && !work.report.delivered) await tx.createTask(Report, { workId: work.id }, { ownership: { kind: "conversation" }, background: true }); state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true })); }, BACKGROUND_CONTEXT); return snapshot(root); }
  async function stop(root: Conversation, threadId: string): Promise<{ stopId: string; taskIds: TaskId[]; conversationIds: ConversationId[] }> {
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), thread = state.threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      if (thread.stopping) throw new Error("Thread stop is still draining");
      const stopId = randomUUID();
      // Stopping a parent stops its children too (one level).
      const targets = [threadId, ...Object.entries(state.threads).filter(([id, child]) => child.parentThreadId === threadId && !child.stopping && id !== threadId).map(([id]) => id)];
      const taskIds: TaskId[] = [], conversationIds: ConversationId[] = [];
      for (const target of targets) {
        const current = state.threads[target]!;
        current.stopping = stopId;
        delete current.paused;
        for (const work of Object.values(state.work)) if (work.threadId === target && (work.status === "queued" || work.status === "running" || work.status === "interrupted")) {
          if (work.taskId !== null) taskIds.push(work.taskId);
          work.status = "stopped"; work.blocker = target === threadId ? "Stopped explicitly" : "Stopped with its parent worker";
        }
        current.activeWorkId = null;
        conversationIds.push(current.conversationId);
      }
      return { stopId, taskIds: [...new Set(taskIds)], conversationIds };
    }, BACKGROUND_CONTEXT);
  }
  async function completeStop(root: Conversation, threadId: string, stopId: string): Promise<void> {
    await root.commit(async tx => {
      const thread = (await tx.doc(DurablePlanning, root.id)).threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      if (thread.stopping !== stopId) return;
      delete thread.stopping;
      const state = await tx.doc(DurablePlanning, root.id);
      for (const child of Object.values(state.threads)) if (child.parentThreadId === threadId && child.stopping === stopId) delete child.stopping;
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
      const state = await tx.doc(DurablePlanning, root.id), thread = state.threads[threadId];
      if (!thread) throw new Error("Unknown durable thread UUID");
      if (state.paused || state.pausing) throw new Error("Project plan is paused; worker resume is denied");
      if (thread.stopping) throw new Error("Thread stop is still draining");
      if (!thread.paused) return;
      delete thread.paused;
      for (const work of Object.values(state.work)) if (work.threadId === threadId && work.status === "interrupted" && work.blocker === WORKER_PAUSE_BLOCKER) {
        work.status = "queued"; work.blocker = null; work.taskId = null;
        work.startedAt = null; work.endedAt = null; work.resumes = (work.resumes ?? 0) + 1;
        work.attempt &&= { ...work.attempt, startedAt: null, endedAt: null };
      }
      requeuePauseInterrupted(state);
      state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
    }, BACKGROUND_CONTEXT);
  }
  async function retryWorker(root: Conversation, workId: string, requestId: string, chat?: ConversationId): Promise<{ attemptId: string; threadId: string }> {
    if (!requestId || requestId.length > 32000) throw new Error("Retry requestId is required");
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), previous = state.work[workId];
      if (!previous) throw new Error("Unknown durable work UUID");
      const duplicate = Object.values(state.work).find(work => work.requestId === requestId);
      if (duplicate) {
        if (duplicate.retryOf !== workId) throw new Error("Conflicting duplicate retry requestId");
        return { attemptId: duplicate.id, threadId: duplicate.threadId };
      }
      if (previous.status === "queued" || previous.status === "running") throw new Error("Only terminal work can be retried; steer running work instead");
      if (state.threads[previous.threadId]?.paused) throw new Error("Worker is paused; resume it instead of retrying");
      const record = await admit(tx, root.id, { id: randomUUID(), threadId: previous.threadId, role: previous.role, text: previous.text, requestId, dependsOn: [...previous.dependsOn], requiredTools: [...previous.requiredTools], workspaceScopeId: previous.workspaceScopeId ?? undefined }, true, chat);
      state.work[record.id].retryOf = workId;
      state.work[record.id].priority = previous.priority;
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
  async function configureWorkerCap(root: Conversation, cap: number): Promise<void> {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 32) throw new Error("Worker cap must be between 1 and 32");
    await root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      if (state.paused || state.pausing) throw new Error("Project plan is paused");
      state.configuredWorkerCap ??= options.workerCap;
      state.workerCap = cap;
      if (Object.values(state.work).some(work => work.status === "queued")) state.dispatcherTaskIds.push(await tx.createTask(Dispatcher, null, { ownership: { kind: "conversation" }, background: true }));
    }, BACKGROUND_CONTEXT);
  }
  async function workerSnapshot(root: Conversation, pageOptions: { offset?: number; limit?: number } = {}) {
    const offset = pageOptions.offset ?? 0, limit = pageOptions.limit ?? 30;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid worker list page");
    return root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), all = Object.values(state.work), page = all.slice(offset, offset + limit);
      const threadIds = [...new Set(page.map(work => work.threadId))];
      return {
        projectId: options.projectId, paused: state.paused, pausing: state.pausing, workerCap: state.workerCap,
        work: page.map(work => ({ ...workReceipt(work), id: work.id, role: work.role, text: work.text.slice(0, 1000), dependsOn: [...work.dependsOn], priority: work.priority ?? 0, workspaceScopeId: work.workspaceScopeId, model: work.attempt?.model ?? null, toolNames: [...(work.attempt?.toolNames ?? [])], startedAt: work.startedAt ?? null, endedAt: work.endedAt ?? null, archived: work.archivedAt !== undefined, parentThreadId: work.parentThreadId ?? null, report: work.report ? work.report.delivered ? work.report.requestId.startsWith("held:") ? "held until children finish" : work.parentThreadId && work.report.requestId.startsWith("child-report:") ? "delivered to parent" : "delivered" : "pending" : "none" })),
        threads: threadIds.flatMap(threadId => { const thread = state.threads[threadId]; return thread ? [{ threadId, paused: Boolean(thread.paused), stopping: Boolean(thread.stopping), activeWorkId: thread.activeWorkId, workspaceScopeId: thread.workspaceScopeId, parentThreadId: thread.parentThreadId ?? null }] : []; }),
        offset, total: all.length, nextOffset: offset + page.length < all.length ? offset + page.length : null, observedAtMs: Date.now(),
      };
    }, BACKGROUND_CONTEXT);
  }
  function workReceipt(work: StoredWork): { workId: string; threadId: string; status: StoredWork["status"]; blocker: string | null; workspaceScopeId: string | null } { return { workId: work.id, threadId: work.threadId, status: work.status, blocker: work.blocker, workspaceScopeId: work.workspaceScopeId }; }
  function numberRecord(source: Record<string, number>): Record<string, number> { return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value])); }
  function attemptSnapshot(work: StoredWork): DurableResolvedAttempt | null { const attempt = work.attempt; return attempt === null ? null : { id: attempt.id, projectId: attempt.projectId, threadId: work.threadId, role: work.role, model: attempt.model, thinking: attempt.thinking, instructions: attempt.instructions, cwd: attempt.cwd, toolNames: [...(attempt.boundTools ?? attempt.toolNames)], bindingRevision: attempt.bindingRevision, standingRevision: attempt.standingRevision, startedAt: attempt.startedAt, endedAt: attempt.endedAt, usage: { baseline: numberRecord(attempt.usage.baseline), final: numberRecord(attempt.usage.final), delta: numberRecord(attempt.usage.delta) } }; }
  function projectSnapshot(state: PlanningState): DurablePlanSnapshot { return { paused: state.paused, pausing: state.pausing, workerCap: state.workerCap, work: Object.values(state.work).map(work => ({ id: work.id, threadId: work.threadId, role: work.role, text: work.text, dependsOn: [...work.dependsOn], status: work.status, blocker: work.blocker, startedAt: work.startedAt ?? work.attempt?.startedAt ?? null, endedAt: work.endedAt ?? work.attempt?.endedAt ?? null, archived: work.archivedAt !== undefined, chatConversationId: work.chatConversationId === undefined ? null : Number(work.chatConversationId), parentThreadId: work.parentThreadId ?? null, attempt: attemptSnapshot(work), ...(work.steering ? { steering: true } : {}) })) }; }
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
  async function threadIdentities(root: Conversation): Promise<Array<{ threadId: string; conversationId: ConversationId; stopping: boolean }>> {
    return root.commit(async tx => Object.entries((await tx.doc(DurablePlanning, root.id)).threads).map(([threadId, thread]) => ({ threadId, conversationId: thread.conversationId, stopping: thread.stopping !== undefined })), BACKGROUND_CONTEXT);
  }
  async function configureCap(root: Conversation, cap: number): Promise<void> {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 32) throw new Error("Configured worker cap must be between 1 and 32");
    await root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      if ((state.configuredWorkerCap ?? state.workerCap) === cap) { state.configuredWorkerCap = cap; return; }
      if (state.pausing || Object.values(state.work).some(work => work.status === "queued" || work.status === "running")) throw new Error("Worker cap cannot change while work is admitted");
      state.workerCap = cap;
      state.configuredWorkerCap = cap;
    }, BACKGROUND_CONTEXT);
  }
  return { readTarget, delegation, archiveWork, pauseWorker, resumeWorker, retryWorker, prioritizeWorker, configureWorkerCap, workerSnapshot, configureCap, extension, capabilities, delegate, workspaceCatalog, assertAdmitting, plan, followUp, steer, pause, completePause, recoverPause, resume, stop, completeStop, snapshot, threadIdentities };
}
