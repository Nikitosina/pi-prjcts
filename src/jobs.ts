import { objectUnion } from "./tool-schema.ts";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type AgentChange,
  type ConversationId,
  type EntryId,
  type Extension,
  type Harness,
  type Session,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import {
  emptyAnswerFailure,
  providerFailure,
  type ProviderFailure,
  QUOTA_RETRY_BASE_MS,
  QUOTA_RETRY_LIMIT,
  quotaRetryDelay,
  unansweredReason,
} from "./provider-failure.ts";
import type { AcceptanceOutcome, AcceptJob } from "./result-acceptance.ts";
import { behaviorKey, composePrompt, type PromptFrame } from "./prompt-blocks.ts";
import { busyIn } from "./durable-idle-configure.ts";
import { gluedWordsDiagnostic } from "./glued-words.ts";
import { queuedInputNote, watchQueuedInput } from "./queued-input.ts";
import { BACKGROUND_WAIT_TOOL } from "./worker-environment-tools.ts";

export const FULL_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const context = BACKGROUND_CONTEXT;

// "verifier" remains only so recorded verifier subagents still read; new turns cannot start one.
export type AgentRole = "worker" | "scout" | "reviewer" | "verifier";
export const TaskWorkspaceSchema = Type.Union([
  Type.Object({ kind: Type.Literal("shared") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("isolated"), baseCommit: Type.String({ pattern: "^[0-9a-f]{40,64}$" }) },
    { additionalProperties: false },
  ),
]);
export type TaskWorkspace = Static<typeof TaskWorkspaceSchema>;
export type JobStatus = Job["status"];
export type PlanStep = {
  title: string;
  status: "todo" | "doing" | "done";
  estimateMin: number | null;
  startedAt: number | null;
  doneAt: number | null;
};
export type CheckpointReport = {
  summary: string;
  proof: string[];
  gaps: string[];
  at: number;
};
export type ReadyReport = {
  summary: string;
  proof: string[];
  review: string;
  notFixed: { text: string; reason: string }[];
  gaps: string[];
  at: number;
};
/** One delegated request with its worker. Transcripts, instructions and tool output stay in the conversations. */
type JobFacts = {
  /** Also the id of the Job's worker agent. */
  id: string;
  /** Conversation that spawned the worker and receives its reports. */
  chat: ConversationId;
  title: string;
  /** The delegated request, verbatim. */
  request: string;
  acceptance: string[];
  workerConversation: ConversationId;
  /** Workspace scope the worker runs in (host-persisted id), or null for a plain checkout. */
  scopeId: string | null;
  /** Verifier, reviewer and scout subagents the worker started, oldest first. */
  children: { id: ConversationId; role: AgentRole; title: string }[];
  branch: string | null;
  candidate: string | null;
  plan: PlanStep[];
  /** Why the Job stopped or failed. */
  reason: string | null;
  createdAt: number;
  endedAt: number | null;
  /** Stall notices sent so far, and when the current one was raised (null: not stalled). */
  stalls: number;
  stalledAt: number | null;
  /** The owner or coordinator cleared this ended Job from view; history and files stay. A new message to it clears the mark. */
  dismissedAt?: number;
};
export type Job = JobFacts &
  (
    | {
        workspace?: null;
        status: "running" | "checkpoint" | "ready" | "ready-with-gaps" | "failed" | "stopped" | "approved";
        checkpoint?: CheckpointReport;
        pr: string | null;
        ready: ReadyReport | null;
        /** The finished state a follow-up interrupted; restored when the worker answers without a new Ready report. */
        resume: { status: "ready" | "ready-with-gaps"; ready: ReadyReport; endedAt: number | null } | null;
      }
    | {
        workspace: TaskWorkspace;
        status: "running" | "completed" | "failed" | "stopped";
        pr: null;
        ready: null;
        resume: null;
        checkpoint?: null;
      }
  );
/** An agent the coordinator spawned: a Job's worker, or a scout or reviewer answering one brief. */
export type Agent = {
  id: string;
  role: Exclude<AgentRole, "verifier">;
  conversationId: ConversationId;
  chat: ConversationId;
  jobId: string | null;
  title: string;
  createdAt: number;
  endedAt: number | null;
  /** The first message the agent gets, and whether it reached the conversation; a pause before that resends it on resume. */
  brief: string;
  briefed: boolean;
  /** Answers already reported, so steers answered together report once. */
  reported: EntryId[];
  /** Workspace scope, or a PR/commit ref a scout or reviewer reads. Set by the spawn; the host prepares them. */
  scopeId: string | null;
  readRef: string | null;
  /** The commit of the agent worktree this reader reads, recorded when its current message started. */
  readHead?: string;
  /** The host prepared this agent's environment (workspace, tools). */
  prepared: boolean;
  /** Messages sent to it since it was created; a reporter that finishes while a newer message is queued does not settle the Job. */
  sends?: number;
  /** The newest admitted delivery, so reporters can recognize a shared answer without scanning history. */
  latestInput?: { seq: number; requestId: string };
  /** Quota recovery in progress: the next automatic retry, and the model moves already made. */
  quota: { attempts: number; retryAt: number; lastError: string } | null;
  modelMoves: { at: number; from: string; to: string }[];
  /** An ended scout or reviewer cleared from view (a Job's worker is dismissed through its Job). */
  dismissedAt?: number;
};
export type JobsState = {
  paused: boolean;
  jobs: Record<string, Job>;
  agents: Record<string, Agent>;
  /** Subagent conversation id -> the Job it serves, so tools and the UI find a Job from any conversation of its tree. */
  subagents: Record<string, string>;
  /** Spawn request id -> agent id, so a retried spawn returns the same agent. */
  requests: Record<string, string>;
};

/**
 * An agent's prompt as built: the frozen frame (repository, workspace, skills, host contract) and the key of the behavior
 * it runs. Written when the agent is first prepared; a later idle turn recomposes the frame with the saved behavior.
 */
export type AgentPromptState = { frame: PromptFrame | null; behavior: string | null; unproven?: string };
export const AgentPrompt = defineDoc<AgentPromptState>({
  kind: "projects.agent-prompt",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ frame: null, behavior: null }),
});
/** Whether an agent runs the saved behavior: `pending` adopts on its next idle continued or retried turn. */
export type AgentPromptStatus = {
  state: "current" | "pending" | "legacy-unchecked" | "frozen";
  reason: string | null;
};
/** What `prepare` built an agent's instructions from: the frame (stored on first preparation, given back after) and the behavior text. */
export type PreparedPrompt = {
  frame: PromptFrame;
  behavior: string;
  /** For an agent prepared before frames: the whole instructions `frame` gives with each behavior it could have started with. */
  proofs?: { instructions: string; behavior: string; frame: PromptFrame }[];
};
const UNPROVEN =
  "Started before prompt blocks, and its stored prompt does not match one rebuilt from the current host contract, repository instructions, project settings, skills and workspace, so it keeps the prompt it started with.";

/** The project's Jobs, on the root conversation. */
export const Jobs = defineDoc<JobsState>({
  kind: "projects.jobs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ paused: false, jobs: {}, agents: {}, subagents: {}, requests: {} }),
});

export const clip = (text: string, max: number): string => {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const uuidOf = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const minutes = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);
/** Agents whose workspaces stay owned, including undismissed checkpoints that are not generating. */
export const liveAgentIds = (doc: Readonly<JobsState>, readOnly?: boolean): string[] =>
  Object.values(doc.agents)
    .filter((agent) => {
      const job = agent.jobId ? doc.jobs[agent.jobId] : undefined;
      const retained = job?.status === "checkpoint" && !job.dismissedAt;
      return (agent.endedAt === null || retained) && (readOnly === undefined || (agent.role !== "worker") === readOnly);
    })
    .map((agent) => agent.id);
/** A chat lends its shared workspace until the borrowing agent actually settles. */
export const sharedHandoff = (state: Readonly<JobsState>, chat: ConversationId, exceptAgentId?: string): Agent | undefined =>
  Object.values(state.agents).find(
    (agent) =>
      agent.id !== exceptAgentId &&
      agent.chat === chat &&
      agent.endedAt === null &&
      agent.jobId !== null &&
      state.jobs[agent.jobId]?.workspace?.kind === "shared",
  );
const isLive = (status: JobStatus) => status === "running";

/** An agent whose independent Job already ended (Ready, checkpoint, failed, stopped) but that was never marked ended. Helpers settle on their own. */
const endedJobAgent = (doc: Readonly<JobsState>, agent: Readonly<Agent>) => {
  const job = agent.jobId ? doc.jobs[agent.jobId] : undefined;
  return agent.endedAt === null && !!job && !job.workspace && !isLive(job.status);
};
/** Work that can still run: a task that is not blocked, or input waiting for a turn. A queued passive write (a compaction summary) runs nothing. */
const runsWork = (live: Awaited<ReturnType<Harness["inspect"]>>) =>
  live.tasks.some((task) => task.state.kind !== "blocked") || live.submissions.some((submission) => submission.type === "input");
/** Agents an unfinished, runnable reporter task still delivers to. */
const reportedAgents = (live: Awaited<ReturnType<Harness["inspect"]>>) =>
  new Set(
    live.tasks.flatMap((task) => {
      const input = task.record.input;
      return task.record.kind === "projects.agent-reporter" &&
        task.state.kind !== "blocked" &&
        input &&
        typeof input === "object" &&
        !Array.isArray(input)
        ? [String(input.agentId)]
        : [];
    }),
  );

/** A step in progress counts down from its start; one that overran its estimate still has a minute left. */
const remaining = (step: PlanStep, accuracy: number, now: number) =>
  step.status === "doing" && step.startedAt !== null
    ? Math.max(1, step.estimateMin! * accuracy - (now - step.startedAt) / 60_000)
    : step.estimateMin! * accuracy;
/** Whole minutes up to an hour, then 5-minute steps, so the Telegram progress message is not edited every minute. */
const roundEta = (minutes: number) => (minutes > 60 ? Math.round(minutes / 5) * 5 : Math.max(1, Math.round(minutes)));

/** Remaining estimated minutes, scaled by how accurate this plan's finished estimates were. */
export function planEta(plan: readonly PlanStep[], now = Date.now()): { done: number; total: number; etaMin: number | null } {
  const done = plan.filter((step) => step.status === "done");
  const measured = done.flatMap((step) =>
    step.estimateMin && step.startedAt !== null && step.doneAt !== null
      ? [{ estimate: step.estimateMin, actual: (step.doneAt - step.startedAt) / 60_000 }]
      : [],
  );
  const estimated = measured.reduce((sum, item) => sum + item.estimate, 0);
  const accuracy = estimated > 0 ? Math.min(4, Math.max(0.25, measured.reduce((sum, item) => sum + item.actual, 0) / estimated)) : 1;
  const open = plan.filter((step) => step.status !== "done" && step.estimateMin);
  return {
    done: done.length,
    total: plan.length,
    etaMin: open.length ? roundEta(open.reduce((sum, step) => sum + remaining(step, accuracy, now), 0)) : null,
  };
}

const reportList = (items: readonly string[]) => (items.length ? items.map((item) => `\n- ${item}`).join("") : " none");
const notificationPreview = (report: string, agentId: string, ref: EntryId): string => {
  const pointer = `Report ref: ${ref}; read agents report id=${agentId} ref=${ref}.`;
  return report.length <= 2200
    ? `${report}\n${pointer}`
    : `${report.slice(0, 1800)}\n\n[Notification preview: ${report.length - 1800} characters omitted. Read the full report before acceptance.]\n${pointer}`;
};

const jobReportDetails = (job: Job, answer: string, cost: number | null, answerId?: EntryId): string => {
  const ready = job.ready;
  const checkpoint = job.checkpoint;
  return [
    `[worker ${job.id} ${job.status}: ${job.title}]`,
    `PR: ${job.pr ?? "none"}${job.branch ? ` (branch ${job.branch})` : ""}`,
    `Candidate: ${job.candidate ?? "none"}`,
    ...(ready
      ? [
          `Summary: ${ready.summary}`,
          `Proof:${reportList(ready.proof)}`,
          `Review: ${ready.review || "none"}`,
          `Not fixed:${reportList(ready.notFixed.map((item) => `${item.text} (${item.reason})`))}`,
          `Gaps:${reportList(ready.gaps)}`,
        ]
      : []),
    ...(checkpoint
      ? [`Checkpoint: ${checkpoint.summary}`, `Proof:${reportList(checkpoint.proof)}`, `Gaps:${reportList(checkpoint.gaps)}`]
      : []),
    `Cumulative time: ${minutes((job.endedAt ?? ready?.at ?? checkpoint?.at ?? job.createdAt) - job.createdAt)}`,
    `Cumulative cost: ${cost == null ? "unknown" : `$${cost.toFixed(2)}`}`,
    `Answer ref: ${answerId === undefined ? "none" : `${job.workerConversation}/${answerId}.0`}`,
    ...(answer ? ["", answer] : []),
  ].join("\n");
};

/** Wake with decision-relevant facts; evidence and the closing answer are read on demand. */
export function readyText(job: Job): string {
  const ready = job.ready!;
  return [
    `[worker ${job.id} ${job.status}: ${job.title}]`,
    `PR: ${job.pr ?? "none"}${job.branch ? ` (branch ${job.branch})` : ""}`,
    `Candidate: ${job.candidate ?? "none"}`,
    `Summary: ${ready.summary}`,
    `Not fixed:${reportList(ready.notFixed.map((item) => `${item.text} (${item.reason})`))}`,
    `Gaps:${reportList(ready.gaps)}`,
    `Details: agents report id=${job.id}; full evidence and closing answer remain in the worker transcript.`,
  ].join("\n");
}

/** What the host supplies; everything project-specific (models, tools, prompts, workspaces, processes) lives behind it. */
export type JobsHost = {
  /** Agent setup of a new conversation: model, instructions, tools. Applied before the Jobs tools are added. */
  agentChange(spec: {
    role: AgentRole;
    id: string;
    title: string;
    jobId: string | null;
    parent: ConversationId;
    cwd?: string;
  }): AgentChange;
  /** Refresh host instructions on an explicit retry, leaving the ended agent's repository prompt frozen. */
  onRetry?(tx: Tx, conversationId: ConversationId): Promise<void>;
  /**
   * Runs before an agent's first message: allocates its workspace, builds its tools. Returns the change to apply, or nothing.
   * It must be idempotent: a restart prepares again. Throwing fails the Job with the message.
   */
  prepare?(spec: {
    agent: Agent;
    job: Job | null;
    frame: PromptFrame | null;
  }): Promise<(AgentChange & { prompt?: PreparedPrompt; readHead?: string }) | void>;
  /** For a reader of another agent's worktree: why its report does not match that worktree now, or null when it still does. */
  readDrift?(agent: Agent): Promise<string | null>;
  /** The behavior text this agent would get now, or null when its prompt is not built from blocks. */
  promptBehavior?(agent: Agent, job: Job | null): string | null;
  /** Stops the background processes and releases the leases of these conversations. */
  killProcesses?(conversationIds: readonly ConversationId[]): Promise<void>;
  /** Longest silence in ms of a live background process of these conversations; null without one. */
  backgroundSilence?(conversationIds: readonly ConversationId[]): Promise<number | null> | number | null;
  /** The next owner-configured fallback model after `from` (`moves` already made), if any; a rate limit only moves along a tier. */
  fallbackModel?(at: {
    role: AgentRole;
    from: string;
    moves: number;
    failure: ProviderFailure;
  }): { label: string; change: AgentChange } | null;
  /** Cached provider reset time for a model label, if known. */
  quotaResetAt?(model: string, now: number): number | undefined;
  /** Why these proof references cannot back a Ready report, or null. */
  checkProof?(job: Job, refs: readonly string[]): Promise<string | null> | string | null;
  /** Merge a Ready Job's candidate. */
  approver?: { approve(job: AcceptJob): Promise<AcceptanceOutcome> };
  /** Called once when a Job becomes approved (its worktree can usually go now). */
  afterApproved?(jobId: string): void;
  /** Minutes without progress before a stall notice. Default 20. */
  stallMinutes?: () => number;
  quotaRetryBaseMs?: number;
  /** Why this agent cannot take a message (e.g. a worker that never got a workspace), or null. */
  refuseSend?(agent: Agent): string | null;
  /** Workspace scope a worker runs in when its spawn names none. */
  defaultScope?(): string | undefined;
  /** Id of this host process; a delivery that settles under another id was interrupted by a restart. Tests set it to simulate one. */
  boot?: string;
  now?: () => number;
};

type Delivery = {
  agentId: string;
  conversationId: ConversationId;
  chat: ConversationId;
  message: string;
  followUp: boolean;
  prepare: boolean;
  /** The caller's id for this message; a retried send with the same id is delivered once. */
  requestId?: string;
  /** The agent's `sends` count when this message was queued. */
  seq?: number;
};
type DeliveryState =
  | { phase: "prepare" }
  | { phase: "deliver"; attempt: number; checked?: boolean; boot?: string; note?: string }
  | { phase: "settle"; report?: string; details?: string; reportRef?: EntryId }
  | { phase: "report"; report?: string; details?: string; reportRef?: EntryId; waits?: number };

const textOfAnswer = (entry: { model?: readonly unknown[] } | undefined): string => {
  const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
  return (message?.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
};

/** The background anchor that owns a spawned agent's conversation; it finishes at once. */
/** One id per host process: a delivery that settles under another id was interrupted by a restart. */
const BOOT = randomUUID();
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "projects.agent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, taskContext) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
  },
  abort: (_anchor, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

/** Total spend of these conversations, or null when none has usage yet. */
async function treeCost(
  reader: Pick<Session, "snapshot">,
  ids: readonly ConversationId[],
  taskContext: typeof context,
): Promise<number | null> {
  let total: number | null = null;
  for (const id of ids) {
    const usage = await reader.snapshot(UsageDoc, id, taskContext);
    for (const entry of [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})])
      total = (total ?? 0) + entry.cost.total;
  }
  return total;
}

/** Prepares an agent, delivers one message and reports its answer once, with large handbacks read on demand. */
const reporterTask = (host: JobsHost, discardSettledStalls: (agentId: string) => Promise<void>) =>
  defineTask<Delivery, DeliveryState, null>({
    name: "projects.agent-reporter",
    version: 1,
    initial: (input) => (input.prepare ? { phase: "prepare" } : { phase: "deliver", attempt: 0 }),
    phases: {
      prepare: async (reporter, runtime, taskContext) => {
        const { agentId, conversationId } = reporter.input;
        let change: (AgentChange & { prompt?: PreparedPrompt; readHead?: string }) | void = undefined;
        let failure: string | null = null;
        try {
          const state = await runtime.snapshot(Jobs, ROOT_CONVERSATION_ID, taskContext);
          const agent = state?.agents[agentId];
          if (agent)
            change = await host.prepare?.({
              agent: agent as Agent,
              job: agent.jobId ? ((state!.jobs[agent.jobId] as Job | undefined) ?? null) : null,
              frame: agent.prepared ? ((await runtime.snapshot(AgentPrompt, conversationId, taskContext))?.frame ?? null) : null,
            });
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          failure = error instanceof Error ? error.message : String(error);
        }
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
          const agent = state.agents[agentId];
          const job = agent?.jobId ? state.jobs[agent.jobId] : undefined;
          if (!agent || state.paused || agent.endedAt !== null || (job && job.status !== "running"))
            return { status: "running", checkpoint: { phase: "report" } } as const;
          if (!failure) {
            if (change?.readHead) agent.readHead = change.readHead;
            if (change) {
              const { prompt, readHead: _readHead, ...built } = change;
              let setup = built;
              const saved = await tx.doc(AgentPrompt, conversationId);
              // An agent prepared before frames gets one only when a rebuilt prompt equals its stored one exactly; nothing is parsed out of it.
              if (agent.prepared && !saved.frame && prompt?.proofs) {
                const stored = (await tx.doc(AgentDoc, conversationId)).instructions;
                const proof = prompt.proofs.find((item) => item.instructions === stored);
                if (proof) {
                  saved.frame = proof.frame;
                  setup = { ...setup, instructions: composePrompt(proof.frame, prompt.behavior) };
                  saved.behavior = behaviorKey(proof.behavior);
                  delete saved.unproven;
                } else saved.unproven = UNPROVEN;
              }
              // A prepared agent keeps its frame; it adopts the saved behavior only between turns, never inside a running one.
              const adopt =
                !agent.prepared || (prompt !== undefined && saved.frame !== null && (await busyIn(tx, conversationId)) === null);
              await configure(tx, conversationId, adopt ? setup : { ...setup, instructions: undefined });
              if (adopt && prompt) {
                if (!agent.prepared) saved.frame = prompt.frame;
                saved.behavior = behaviorKey(prompt.behavior);
              }
            }
            agent.prepared = true;
            return { status: "running", checkpoint: { phase: "deliver", attempt: 0 } } as const;
          }
          if (job && job.status === "running")
            Object.assign(job, { status: "failed", reason: `The worker could not start: ${failure}`, endedAt: Date.now() });
          agent.endedAt = job?.workspace ? null : Date.now();
          return {
            status: "running",
            checkpoint: {
              phase: job?.workspace ? "settle" : "report",
              report: `[${agent.role} ${agent.id} failed to start: ${agent.title}] ${failure}`,
            },
          } as const;
        }, taskContext);
      },
      deliver: async (reporter, runtime, taskContext) => {
        const { agentId, conversationId, message, followUp, requestId } = reporter.input;
        const { attempt, checked, boot, note } = reporter.state.checkpoint;
        const deliveryRequestId = requestId ? `send:${requestId}:${attempt}` : `agent:${reporter.id}:${attempt}`;
        // A quota wait is stored, so a restart waits out the rest of it instead of resending at once.
        const waiting = (await runtime.snapshot(Jobs, ROOT_CONVERSATION_ID, taskContext))?.agents[agentId]?.quota;
        if (waiting && waiting.retryAt > runtime.now()) {
          await runtime.sleepUntil(waiting.retryAt, reporter.state.checkpoint, taskContext);
          return;
        }
        // A stop or pause during prepare or a quota sleep must not start the agent: decide inside a commit, right before submitting.
        if (!checked) {
          await runtime.commit(async (tx) => {
            const state = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
            const record = state.agents[agentId];
            const job = record?.jobId ? state.jobs[record.jobId] : undefined;
            if (!record || state.paused || (job ? job.status !== "running" : record.endedAt !== null))
              return { status: "running", checkpoint: { phase: "report" } } as const;
            if (message.startsWith(record.brief)) record.briefed = true;
            if ((record.sends ?? 0) === (reporter.input.seq ?? 0))
              record.latestInput = { seq: reporter.input.seq ?? 0, requestId: deliveryRequestId };
            return {
              status: "running",
              checkpoint: { phase: "deliver", attempt, checked: true, boot: boot ?? host.boot ?? BOOT, note },
            } as const;
          }, taskContext);
          return;
        }
        const agent = (await runtime.conversation(conversationId, taskContext))!;
        const submission = await agent.submit(
          {
            type: "input",
            content: note ?? message,
            whenBusy: followUp || note ? "followUp" : "steer",
            requestId: deliveryRequestId,
          },
          taskContext,
        );
        const settled = await submission.wait(taskContext);
        const failure =
          settled.status === "unanswered"
            ? settled.reason !== "aborted"
              ? unansweredReason(settled)
              : undefined
            : settled.type === "input"
              ? emptyAnswerFailure((await runtime.context(conversationId, taskContext, { at: settled.answer })).entries)
              : undefined;
        // Quota (or a rate limit the host can route around): move to the next fallback model, otherwise wait for the allowance to recover and resend.
        const kind = failure ? providerFailure(failure) : undefined;
        if (failure && kind) {
          const record = (await runtime.snapshot(Jobs, ROOT_CONVERSATION_ID, taskContext))?.agents[agentId];
          const current = (await runtime.snapshot(AgentDoc, conversationId, taskContext))?.model;
          const from = current ? `${current.provider}/${current.modelId}` : "";
          const offered = record ? host.fallbackModel?.({ role: record.role, from, moves: record.modelMoves.length, failure: kind }) : null;
          // Never back to a model this agent already left, so a chain ends instead of cycling.
          const switched =
            offered && offered.label !== from && !record?.modelMoves.some((move) => move.from === offered.label) ? offered : null;
          const previous = record?.quota?.attempts ?? 0;
          if (record && (switched || (kind === "quota_exceeded" && previous < QUOTA_RETRY_LIMIT))) {
            const now = runtime.now();
            const retryAt = switched
              ? now
              : (host.quotaResetAt?.(from, now) ?? now + quotaRetryDelay(previous + 1, host.quotaRetryBaseMs ?? QUOTA_RETRY_BASE_MS));
            await runtime.commit(async (tx) => {
              const doc = (await tx.doc(Jobs, ROOT_CONVERSATION_ID)).agents[agentId];
              if (!doc || (doc.sends ?? 0) > (reporter.input.seq ?? 0))
                return { status: "running", checkpoint: { phase: "report" } } as const;
              doc.quota = { attempts: previous + 1, retryAt, lastError: failure.slice(0, 500) };
              if (switched) {
                doc.modelMoves.push({ at: now, from, to: switched.label });
                await configure(tx, conversationId, switched.change);
              }
              return { status: "running", checkpoint: { phase: "deliver", attempt: attempt + 1 } } as const;
            }, taskContext);
            return;
          }
        }
        // What the Job's whole tree spent so far: the worker and its subagents.
        const tree = (await runtime.snapshot(Jobs, ROOT_CONVERSATION_ID, taskContext))?.jobs[agentId]?.children ?? [];
        const cost =
          settled.status === "unanswered" ? null : await treeCost(runtime, [conversationId, ...tree.map((child) => child.id)], taskContext);
        await runtime.commit(async (tx) => {
          const next = (report?: string, details?: string) =>
            ({ status: "running", checkpoint: { phase: "report", report, details } }) as const;
          const state = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
          const record = state.agents[agentId];
          if (!record) return next();
          // A newer send owns recovery and failure reporting for a turn shared by several inputs.
          if (failure && (record.sends ?? 0) > (reporter.input.seq ?? 0)) return next();
          record.quota = null;
          const job = record.jobId ? state.jobs[record.jobId] : undefined;
          const finished = (report: string) => {
            if (!job?.workspace) return next(report);
            record.endedAt = null;
            return { status: "running", checkpoint: { phase: "settle", report } } as const;
          };
          if (job?.workspace?.kind === "shared" && job.status === "stopped") return next();
          // A done turn with a failure is an empty answer to a retried quota or rate-limit error: it failed the same way.
          if (settled.status === "unanswered" || failure) {
            if (!failure) return next();
            if (job && isLive(job.status))
              Object.assign(job, { status: "failed", reason: `The worker failed: ${failure}`, endedAt: Date.now() });
            record.endedAt = Date.now();
            return finished(`[${record.role} ${record.id} failed: ${record.title}] ${failure}`);
          }
          if (settled.type !== "input") return next();
          if (record.reported.includes(settled.answer)) return next();
          if (job && job.status === "stopped") return next();
          // Leave a shared answer to the newest reporter, which carries the final Job state and Ready payload.
          if (record.latestInput && record.latestInput.seq > (reporter.input.seq ?? 0)) {
            const latest = await tx.submissionByRequest(conversationId, record.latestInput.requestId);
            if (latest?.type === "input" && latest.status === "done" && latest.answer === settled.answer) return next();
          }
          const answer = textOfAnswer(await tx.entry(AssistantEntry, settled.answer));
          record.reported.push(settled.answer);
          // A newer message is already queued for this agent: it keeps the Job running and decides how it ends.
          if ((record.sends ?? 0) > (reporter.input.seq ?? 0))
            return next(`[${record.role} ${record.id} answered: ${record.title}]\n${answer.trim()}`);
          record.endedAt = Date.now();
          if (!job) return next(`[${record.role} ${record.id} answered: ${record.title}]\n${answer}`);
          if (isLive(job.status) && job.resume) {
            // A follow-up on a finished Job that only needed an answer: the earlier Ready report stands.
            Object.assign(job, { status: job.resume.status, ready: job.resume.ready, endedAt: job.resume.endedAt, resume: null });
            return next(`[worker ${job.id} answered: ${job.title}]\n${answer.trim()}`);
          }
          if (isLive(job.status) && boot !== undefined && boot !== (host.boot ?? BOOT)) {
            // The run was cut short by a host restart, not ended by the model: continue it instead of failing the Job.
            record.endedAt = null;
            record.reported.pop();
            return {
              status: "running",
              checkpoint: {
                phase: "deliver",
                attempt: attempt + 1,
                note: "The host restarted and interrupted your last turn. Continue where you left off.",
              },
            } as const;
          }
          if (isLive(job.status) && job.workspace) {
            const now = Date.now();
            const reason = answer.trim() ? null : "The task helper ended without an answer";
            job.status = reason ? "failed" : "completed";
            job.reason = reason;
            job.endedAt = now;
            job.stalledAt = null;
            const configured = await tx.doc(AgentDoc, conversationId);
            return finished(
              [
                `[worker ${job.id} ${job.status}: ${job.title}]`,
                "Worker-reported handback, not independently verified or accepted.",
                `Workspace: ${job.workspace.kind}`,
                `Cwd: ${configured.cwd ?? "unknown"}`,
                `Branch: ${job.branch ?? "unknown"}`,
                `Candidate: ${job.candidate ?? "none"}`,
                `Cumulative time: ${minutes(now - job.createdAt)}`,
                `Cumulative cost: ${cost == null ? "unknown" : `$${cost.toFixed(2)}`}`,
                "",
                reason ?? answer.trim(),
              ].join("\n"),
            );
          }
          if (job.status === "checkpoint" && job.checkpoint)
            return next(
              [
                `[worker ${job.id} checkpoint: ${job.title}]`,
                `Summary: ${job.checkpoint.summary}`,
                `Gaps:${reportList(job.checkpoint.gaps)}`,
                `Details: agents report id=${job.id}; this is not delivery or owner-testing readiness. Resume only with a new instruction.`,
              ].join("\n"),
              jobReportDetails(job, answer, cost, settled.answer),
            );
          if (isLive(job.status)) {
            Object.assign(job, { status: "failed", reason: "The worker ended without a Ready report", endedAt: Date.now() });
            return next(`[worker ${job.id} failed: ${job.title}]\nThe worker ended its turn without a Ready report.\n\n${answer.trim()}`);
          }
          if (job.status === "failed") return next();
          return next(readyText(job), jobReportDetails(job, answer, cost, settled.answer));
        }, taskContext);
      },
      settle: async (reporter, runtime, taskContext) => {
        // Keep the handoff until worker-owned processes and attachments have drained.
        await host.killProcesses?.([reporter.input.conversationId]);
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
          const agent = state.agents[reporter.input.agentId];
          const job = agent?.jobId ? state.jobs[agent.jobId] : undefined;
          if (agent && job?.workspace && job.status !== "running" && job.status !== "stopped") agent.endedAt = Date.now();
          return {
            status: "running",
            checkpoint: {
              ...reporter.state.checkpoint,
              phase: "report",
              report: job?.status === "stopped" ? undefined : reporter.state.checkpoint.report,
            },
          } as const;
        }, taskContext);
      },
      report: async (reporter, runtime, taskContext) => {
        const { report, details, reportRef, waits = 0 } = reporter.state.checkpoint;
        // A paused project runs no coordinator turns; the report waits for the resume.
        if (report !== undefined && (await runtime.snapshot(Jobs, ROOT_CONVERSATION_ID, taskContext))?.paused) {
          await runtime.sleepUntil(runtime.now() + 2000, { ...reporter.state.checkpoint, waits: waits + 1 }, taskContext);
          return;
        }
        if (report !== undefined && reportRef === undefined) {
          const agent = (await runtime.snapshot(Jobs, ROOT_CONVERSATION_ID, taskContext))?.agents[reporter.input.agentId];
          const drift = agent?.readHead ? await host.readDrift?.(agent as Agent) : null;
          // The warning goes right under the report's first line, so a clipped preview still shows it.
          const flagged = (text: string) =>
            drift ? text.replace(/^([^\n]*)(?:\n|$)/, (_, first: string) => `${first}\n${drift}\n`) : text;
          await runtime.commit(async (tx) => {
            const entry = await tx.appendEntry(reporter.input.conversationId, {
              kind: "projects.agent-report",
              data: { text: flagged(details ?? report), at: runtime.now() },
            });
            return { status: "running", checkpoint: { phase: "report", report: flagged(report), reportRef: entry.id } } as const;
          }, taskContext);
          return;
        }
        if (report !== undefined && reportRef !== undefined) {
          await discardSettledStalls(reporter.input.agentId);
          const chat = await runtime.conversation(reporter.input.chat, taskContext);
          await chat?.submit(
            {
              type: "input",
              content: notificationPreview(report, reporter.input.agentId, reportRef),
              entry: { kind: "projects.internal-input" },
              whenBusy: "followUp",
              requestId: `report:${reporter.id}`,
            },
            taskContext,
          );
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext);
      },
    },
    // An abort (a project pause aborts every chat with its background tasks) skips the report, so end an agent whose Job already ended here.
    abort: (reporter, runtime, taskContext) =>
      runtime.commit(async (tx) => {
        const state = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
        const agent = state.agents[reporter.input.agentId];
        if (agent && endedJobAgent(state, agent) && (agent.sends ?? 0) <= (reporter.input.seq ?? 0)) agent.endedAt = Date.now();
        return { status: "terminal", outcome: { status: "aborted" } };
      }, taskContext),
  });

const acceptanceText = (criteria: readonly string[]) =>
  criteria.length ? `\n\nAcceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}` : "";
const sha = Type.String({ pattern: "^[0-9a-f]{40}$", description: "Full 40-character commit sha" });
const reply = (text: string, details?: Record<string, string | number>) => ({
  output: [{ type: "text" as const, text }],
  ...(details ? { details } : {}),
});

export type JobsSnapshot = {
  paused: boolean;
  jobs: (Omit<Job, "children"> & {
    conversationId: ConversationId;
    working: boolean;
    /** The deepest working conversation of the Job's tree: where its live progress is. */
    leaf: ConversationId | null;
    eta: ReturnType<typeof planEta>;
    children: (Job["children"][number] & { working: boolean })[];
    quota: Agent["quota"];
    modelMoves: Agent["modelMoves"];
    /** The model the worker's conversation runs on now (`provider/model`): its tier's model or where a quota move left it. */
    model: string | null;
  })[];
  /** `working`: its conversation runs now; `active`: a runnable reporter task still delivers to it (preparing, running or reporting). */
  agents: (Agent & { working: boolean; active: boolean; model: string | null; prompt: AgentPromptStatus | null })[];
};

export type SpawnArgs = {
  role: Exclude<AgentRole, "verifier">;
  brief: string;
  title?: string;
  acceptance?: string[];
  branch?: string;
  scopeId?: string;
  readRef?: string;
  requestId?: string;
  workspace?: TaskWorkspace;
};

export function createJobs(host: JobsHost) {
  const discardQueuedStalls = async (harness: Harness, job: Pick<Job, "id" | "chat" | "stalls">) => {
    for (let end = job.stalls; end > 0; end -= 100) {
      const pending = await harness.commit(async (tx) => {
        const found = [];
        for (let episode = Math.max(1, end - 99); episode <= end; episode++) {
          const notice = await tx.submissionByRequest(job.chat, `stall:${job.id}:${episode}`);
          if (notice?.status === "queued") found.push(notice.id);
        }
        return found;
      }, context);
      // A notice placed since the read belongs to the coordinator; abortSubmission leaves it intact.
      for (const id of pending) await harness.abortSubmission(id, context, job.chat);
    }
  };
  const Reporter = reporterTask(host, async (agentId) => {
    if (!bound) return;
    const job = (await bound.snapshot(Jobs, ROOT_CONVERSATION_ID, context))?.jobs[agentId];
    if (job && !isLive(job.status)) await discardQueuedStalls(bound, job);
  });
  const clock = () => host.now?.() ?? Date.now();

  const agentModel = async (reader: Pick<Session, "snapshot">, id: ConversationId) => {
    const model = (await reader.snapshot(AgentDoc, id, context))?.model;
    return model ? `${model.provider}/${model.modelId}` : null;
  };
  const working = async (reader: Pick<Session, "snapshot">, id: ConversationId) =>
    (await reader.snapshot(LiveDoc, id, context))?.run !== undefined;

  /** Conversations owned directly by `id`, oldest first. A read-only commit: the Harness has no scan API. */
  const children = async (harness: Harness, id: ConversationId): Promise<ConversationId[]> =>
    harness.commit(async (tx) => {
      const found: ConversationId[] = [];
      let cursor: Awaited<ReturnType<typeof tx.scanConversations>>["next"];
      do {
        const page = await tx.scanConversations({ ownerConversationId: id }, 100, cursor);
        found.push(...page.items.map((item) => item.id));
        cursor = page.next;
      } while (cursor);
      return found;
    }, context);

  /** Owned conversations below `id`, transitively: a worker's verifier and reviewer children. */
  async function descendants(harness: Harness, id: ConversationId): Promise<ConversationId[]> {
    const found: ConversationId[] = [];
    for (const queue = [id]; queue.length;) {
      for (const child of await children(harness, queue.shift()!)) {
        found.push(child);
        queue.push(child);
      }
    }
    return found;
  }

  let bound: Harness | undefined;

  // ── Tools ──────────────────────────────────────────────────────────────────
  let Worker: Extension;

  /** Start a worker, scout or reviewer for `chat`. The agent's id comes from `seed`, so a repeated spawn with the same seed starts one agent. */
  async function spawn(
    session: Pick<Session, "commit">,
    chat: ConversationId,
    args: SpawnArgs,
    seed: string,
    spawnContext: typeof context,
  ): Promise<{ text: string; id?: string; conversationId?: ConversationId }> {
    const { role } = args;
    if (!args.brief.trim()) return { text: "spawn needs a role and a brief." };
    if (role === "worker" && (!args.title?.trim() || !args.acceptance?.length))
      return { text: "A worker needs a title and acceptance criteria." };
    const requestId = args.requestId?.trim();
    return session.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      if (requestId && doc.requests[requestId])
        return { text: `Already started as ${doc.requests[requestId]}.`, id: doc.requests[requestId] };
      if (args.workspace !== undefined) {
        if (!Value.Check(TaskWorkspaceSchema, args.workspace))
          return { text: "Invalid task workspace: choose shared or isolated with a full lowercase 40-64 hex baseCommit." };
        if (role !== "worker" || args.branch !== undefined || args.scopeId !== undefined || args.readRef !== undefined)
          return { text: "Explicit workspace is worker-only and cannot be combined with branch, scopeId or readRef." };
        const borrower = args.workspace.kind === "shared" ? sharedHandoff(doc, chat) : undefined;
        if (borrower) return { text: `Shared workspace is still handed to ${borrower.id}; wait for it to settle.` };
      }
      const readRef = args.readRef?.trim() || null;
      // Readers read a pinned commit or a live agent's worktree; refs are never resolved here (scripts/worktree-lifecycle-failures.md R2, R6).
      if (readRef && role !== "worker" && !doc.agents[readRef] && !FULL_COMMIT.test(readRef))
        return {
          text: "readRef must be an agent id or a full lowercase commit SHA. Resolve a branch or PR to its commit first (fetch it in your worktree, then rev-parse) and pass that SHA.",
        };
      if (doc.paused) return { text: "The project is paused; spawn again after it resumes." };
      const agentId = uuidOf(seed);
      const title = args.title?.trim() || clip(args.brief, 80);
      const background = { ownership: { kind: "conversation" }, background: true } as const;
      const anchor = await tx.createTask(Anchor, null, background);
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
      await configure(
        tx,
        child.id,
        host.agentChange({ role, id: agentId, title, jobId: role === "worker" ? agentId : null, parent: chat }),
      );
      await configure(tx, child.id, { extensions: { remove: [Coordinator], add: role === "worker" ? [Worker] : [] } });
      const now = clock();
      doc.agents[agentId] = {
        id: agentId,
        role,
        conversationId: child.id,
        chat: chat,
        jobId: role === "worker" ? agentId : null,
        title,
        createdAt: now,
        endedAt: null,
        reported: [],
        scopeId: (role === "worker" ? args.scopeId?.trim() || host.defaultScope?.() : args.scopeId?.trim()) || null,
        readRef,
        prepared: false,
        brief: "",
        briefed: false,
        quota: null,
        modelMoves: [],
      };
      if (role === "worker")
        doc.jobs[agentId] = {
          id: agentId,
          chat: chat,
          title,
          request: args.brief,
          acceptance: args.acceptance!,
          status: "running",
          workerConversation: child.id,
          scopeId: doc.agents[agentId]!.scopeId,
          children: [],
          branch: args.branch?.trim() || null,
          pr: null,
          candidate: null,
          plan: [],
          ready: null,
          reason: null,
          createdAt: now,
          endedAt: null,
          stalls: 0,
          stalledAt: null,
          resume: null,
          ...(args.workspace ? { workspace: args.workspace } : {}),
        };
      if (requestId) doc.requests[requestId] = agentId;
      const message =
        role === "worker"
          ? `Job ${agentId}: ${title}\n\n${args.brief}${acceptanceText(args.acceptance!)}${args.branch ? `\n\nContinue branch ${args.branch}.` : ""}`
          : args.brief;
      doc.agents[agentId]!.brief = message;
      await tx.createTask(Reporter, { agentId, conversationId: child.id, chat: chat, message, followUp: false, prepare: true }, background);
      return {
        text: `Queued ${role} ${agentId}. Its workspace is prepared next; if that fails the failure is reported back to you, so do not tell the owner it has started yet.`,
        id: agentId,
        conversationId: child.id,
      };
    }, spawnContext);
  }

  const agentsTool = defineTool({
    name: "agents",
    description:
      "Run background agents. spawn: role worker (needs title, acceptance criteria; optional branch to continue), scout or reviewer, with a brief; give a fresh requestId so a retry returns the same agent. A scout or reviewer reads the project checkout, or with readRef an agent's worktree (its id; refused while it has uncommitted changes) or a full commit SHA (read in its own worktree at that commit). " +
      "send: steer id with a message (followUp queues it after its current answer). stop: id and a reason. dismiss: clear an ended agent or Job from the list (not running; history and files stay). send to a failed or stopped worker retries it in the same Job. report: full Ready evidence and the latest closing answer for id, without waking it. status: live agents, or one id (also dismissed ones). wait: block up to timeoutSec until id is idle. " +
      "Choose workspace {kind:'shared'} for the chat's prepared workspace or {kind:'isolated',baseCommit:<full SHA>} for a task helper. Explicit workspace rejects branch/scopeId/readRef. Shared allows one live helper per chat. Omit workspace for the independent Job/PR workflow. Helpers return normally, not Ready; completed is not accepted delivery. Ready reports arrive as concise handbacks; read report for detailed evidence.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("spawn"),
        Type.Literal("send"),
        Type.Literal("stop"),
        Type.Literal("status"),
        Type.Literal("wait"),
        Type.Literal("dismiss"),
        Type.Literal("report"),
      ]),
      role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")])),
      brief: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      acceptance: Type.Optional(Type.Array(Type.String())),
      workspace: Type.Optional(TaskWorkspaceSchema),
      branch: Type.Optional(Type.String()),
      scopeId: Type.Optional(Type.String()),
      readRef: Type.Optional(Type.String()),
      ref: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: "Immutable report entry ref from a notification; omit for latest facts and answer.",
        }),
      ),
      requestId: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      followUp: Type.Optional(Type.Boolean()),
      reason: Type.Optional(Type.String()),
      timeoutSec: Type.Optional(Type.Number()),
    }),
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const { action, id } = args;
      const state = (await api.snapshot(Jobs, ROOT_CONVERSATION_ID, callContext)) ?? {
        paused: false,
        jobs: {},
        agents: {},
        subagents: {},
        requests: {},
      };
      if (action === "status") {
        const ids = id ? [id] : Object.keys(state.agents);
        const lines: string[] = [];
        let hidden = 0;
        for (const each of ids) {
          const agent = Object.hasOwn(state.agents, each) ? state.agents[each] : undefined;
          if (!agent) continue;
          if (!id && (agent.jobId ? state.jobs[agent.jobId]?.dismissedAt : agent.dismissedAt)) {
            hidden++;
            continue;
          }
          const job = agent.jobId ? state.jobs[agent.jobId] : undefined;
          lines.push(
            `${agent.id} ${agent.role} "${agent.title}": ${job ? job.status : agent.endedAt ? "ended" : "open"}, ${(await working(api, agent.conversationId)) ? "working" : "idle"}`,
          );
        }
        if (hidden) lines.push(`(${hidden} dismissed agent${hidden === 1 ? "" : "s"} not listed; status with an id still shows them)`);
        return reply(lines.join("\n") || "No agents.");
      }
      const agent = id && Object.hasOwn(state.agents, id) ? state.agents[id] : undefined;
      if (action !== "spawn" && !agent) return reply(`No agent ${id ?? ""}.`);
      if (action === "report") {
        const record = agent!;
        const job = record.jobId ? state.jobs[record.jobId] : undefined;
        if (args.ref !== undefined) {
          const conversation = await bound?.conversation(record.conversationId, callContext);
          if (!conversation) return reply("Report storage is not attached to this host.");
          const ref = args.ref as EntryId;
          const entry = (await conversation.entries({ minEntryId: ref, maxEntryId: ref }, 1, undefined, callContext)).items[0];
          const data = entry?.data;
          if (
            entry?.kind !== "projects.agent-report" ||
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            typeof data.text !== "string"
          )
            return reply(`No report ${args.ref} for agent ${record.id}.`);
          return reply(data.text);
        }
        const answerId = record.reported.at(-1);
        const conversation = await bound?.conversation(record.conversationId, callContext);
        const answer =
          answerId === undefined || !conversation
            ? ""
            : textOfAnswer(
                (await conversation.entries({ minEntryId: answerId, maxEntryId: answerId }, 1, undefined, callContext)).items[0],
              );
        const cost = await treeCost(api, [record.conversationId, ...(job?.children.map((child) => child.id) ?? [])], callContext);
        const ready = job?.ready;
        const checkpoint = job?.checkpoint;
        return reply(
          [
            `[${record.role} ${record.id} ${job?.status ?? "answered"}: ${record.title}]`,
            ...(job
              ? [`PR: ${job.pr ?? "none"}`, `Candidate: ${job.candidate ?? "none"}`, ...(job.reason ? [`Reason: ${job.reason}`] : [])]
              : []),
            ...(ready
              ? [
                  `Summary: ${ready.summary}`,
                  `Proof:${reportList(ready.proof)}`,
                  `Review: ${ready.review || "none"}`,
                  `Not fixed:${reportList(ready.notFixed.map((item) => `${item.text} (${item.reason})`))}`,
                  `Gaps:${reportList(ready.gaps)}`,
                ]
              : []),
            ...(checkpoint
              ? [`Checkpoint: ${checkpoint.summary}`, `Proof:${reportList(checkpoint.proof)}`, `Gaps:${reportList(checkpoint.gaps)}`]
              : []),
            `Cumulative time: ${minutes((record.endedAt ?? clock()) - record.createdAt)}`,
            `Cumulative cost: ${cost == null ? "unknown" : `$${cost.toFixed(2)}`}`,
            `Answer ref: ${answerId === undefined ? "none" : `${record.conversationId}/${answerId}.0`}`,
            ...(answer ? ["", answer] : []),
          ].join("\n"),
        );
      }
      if (action === "wait") {
        const until = clock() + Math.min(Math.max(args.timeoutSec ?? 60, 1), 900) * 1000;
        const queued = watchQueuedInput(api, api.conversationId, callContext);
        try {
          while (clock() < until && !queued.arrived() && (await working(api, agent!.conversationId))) await sleep(100);
        } finally {
          queued.stop();
        }
        const arrived = queued.arrived();
        return reply(
          (await working(api, agent!.conversationId))
            ? `${agent!.id} is still working.${arrived ? ` ${queuedInputNote(arrived)}` : ""}`
            : `${agent!.id} is idle; its answer arrives as a message.`,
        );
      }
      if (action === "stop") {
        if (!args.reason?.trim()) return reply("stop needs a reason.");
        return reply(bound ? await stopAgent(bound, agent!.id, args.reason.trim()) : "Jobs are not attached to a host.");
      }
      if (action === "dismiss") return reply(await dismissAgent(api, agent!.id));
      if (action === "send") {
        if (!args.message?.trim()) return reply("send needs a message.");
        const glued = gluedWordsDiagnostic(args.message);
        if (glued) api.diagnostic(glued);
        return reply(await sendTo(api, agent!.id, args.message, args.followUp === true, args.requestId));
      }
      // spawn
      if (!args.role) return reply("spawn needs a role and a brief.");
      const glued = gluedWordsDiagnostic([args.title, args.brief, ...(args.acceptance ?? [])].filter(Boolean).join("\n"));
      if (glued) api.diagnostic(glued);
      const result = await spawn(
        api,
        api.conversationId,
        { ...args, role: args.role, brief: args.brief ?? "" },
        `${api.taskId}:spawn`,
        callContext,
      );
      return reply(result.text, result.id && result.conversationId ? { id: result.id, conversationId: result.conversationId } : undefined);
    },
  });

  const Coordinator = defineExtension({ name: "projects.jobs-coordinator", tasks: [Anchor, Reporter], tools: [agentsTool] });

  const jobTool = defineTool({
    name: "job",
    description:
      "Your Job's record. plan: replace the plan with steps (title, status todo|doing|done, estimateMin). " +
      "Task helpers may plan or record a local candidate SHA without branch/PR; return normally instead of ready. Independent Jobs: candidate: record the pushed commit (sha, branch, PR) that your projects_verify_run runs are tied to. ready: report the finished work once the candidate is built and checked: summary, pr, candidate sha, proof refs, review result, anything not fixed with the reason, and gaps (unproven acceptance criteria). Gaps make it Ready with gaps. checkpoint: end an independent Job's current stage with a concise summary, proof and gaps when delivery is not ready; preserve its workspace and wait for a new instruction, without Ready or approval.",
    parameters: objectUnion([
      Type.Object({
        action: Type.Literal("plan"),
        steps: Type.Array(
          Type.Object({
            title: Type.String(),
            status: Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")]),
            estimateMin: Type.Optional(Type.Number()),
          }),
        ),
      }),
      Type.Object({ action: Type.Literal("candidate"), sha, branch: Type.Optional(Type.String()), pr: Type.Optional(Type.String()) }),
      Type.Object({
        action: Type.Literal("checkpoint"),
        summary: Type.String({ minLength: 1, maxLength: 2000 }),
        proof: Type.Optional(Type.Array(Type.String())),
        gaps: Type.Optional(Type.Array(Type.String())),
      }),
      Type.Object({
        action: Type.Literal("ready"),
        summary: Type.String(),
        pr: Type.Optional(Type.String()),
        branch: Type.Optional(Type.String()),
        candidate: Type.Optional(sha),
        proof: Type.Optional(Type.Array(Type.String())),
        review: Type.Optional(Type.String()),
        notFixed: Type.Optional(Type.Array(Type.Object({ text: Type.String(), reason: Type.String() }))),
        gaps: Type.Optional(Type.Array(Type.String())),
      }),
    ]),
    replay: "safe",
    execute: async (args, api, callContext) => {
      if (args.action === "ready") {
        const current = Object.values((await api.snapshot(Jobs, ROOT_CONVERSATION_ID, callContext))?.jobs ?? {}).find(
          (item) => item.workerConversation === api.conversationId,
        );
        if (current?.workspace) return reply("Task helpers return their answer normally; job ready is only for independent Jobs.");
        if (current && host.checkProof) {
          const problem = await host.checkProof({ ...current, candidate: args.candidate ?? current.candidate }, args.proof ?? []);
          if (problem) return reply(`Not recorded: ${problem}`);
        }
      }
      return reply(
        await api.commit(async (tx) => {
          const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
          const job = Object.values(doc.jobs).find((item) => item.workerConversation === api.conversationId);
          if (!job) return "This tool belongs to a worker's Job.";
          if (!isLive(job.status) && job.status !== "ready" && job.status !== "ready-with-gaps" && job.status !== "checkpoint")
            return `The Job is ${job.status}.`;
          const now = clock();
          if (args.action === "checkpoint") {
            if (job.workspace) return "Task helpers return their answer normally; checkpoint is only for independent Jobs.";
            if (!args.summary.trim()) return "checkpoint needs a summary.";
            job.checkpoint = { summary: args.summary.trim(), proof: args.proof ?? [], gaps: args.gaps ?? [], at: now };
            job.status = "checkpoint";
            job.ready = null;
            job.resume = null;
            job.endedAt = now;
            job.stalledAt = null;
            return "Checkpoint recorded. End your turn with a short acknowledgment; details are retained for the Coordinator. This is not Ready.";
          }
          if (args.action === "plan") {
            const before = new Map(job.plan.map((step) => [step.title, step]));
            job.plan = args.steps.map((step) => {
              const old = before.get(step.title);
              const startedAt = step.status === "todo" ? null : (old?.startedAt ?? now);
              return {
                title: step.title,
                status: step.status,
                estimateMin: step.estimateMin ?? null,
                startedAt,
                doneAt: step.status === "done" ? (old?.doneAt ?? now) : null,
              };
            });
            return `Plan saved: ${job.plan.filter((step) => step.status === "done").length}/${job.plan.length} done.`;
          }
          if (args.action === "candidate") {
            if (job.workspace) {
              if (args.pr !== undefined || args.branch !== undefined)
                return "Task helpers may record a local candidate SHA only; preserve the prepared branch and do not publish a PR.";
              job.candidate = args.sha;
              return `Candidate ${args.sha.slice(0, 8)} recorded.`;
            }
            job.candidate = args.sha;
            job.branch = args.branch ?? job.branch;
            job.pr = args.pr ?? job.pr;
            return `Candidate ${args.sha.slice(0, 8)} recorded.`;
          }
          if (job.workspace) return "Task helpers return their answer normally; do not call job ready.";
          if (!args.summary.trim()) return "ready needs a summary.";
          const gaps = args.gaps ?? [];
          job.ready = {
            summary: args.summary.trim(),
            proof: args.proof ?? [],
            review: args.review ?? "",
            notFixed: args.notFixed ?? [],
            gaps,
            at: now,
          };
          job.pr = args.pr ?? job.pr;
          job.branch = args.branch ?? job.branch;
          job.candidate = args.candidate ?? job.candidate;
          job.status = gaps.length ? "ready-with-gaps" : "ready";
          delete job.checkpoint;
          job.resume = null;
          job.endedAt = now;
          job.stalledAt = null;
          return `Ready recorded (${job.status}). End your turn; the report goes to the coordinator.`;
        }, callContext),
      );
    },
  });

  const subagentTool = defineTool({
    name: "subagent",
    description: "Run a fresh reviewer or scout on a task and get its answer. It cannot spawn agents and ends when it answers.",
    parameters: Type.Object({
      role: Type.Union([Type.Literal("reviewer"), Type.Literal("scout")]),
      task: Type.String(),
    }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      const glued = gluedWordsDiagnostic(args.task);
      if (glued) api.diagnostic(glued);
      const cwd = (await api.agent(callContext)).cwd;
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
        const job = Object.values(doc.jobs).find((item) => item.workerConversation === api.conversationId);
        if (!job) throw new Error("subagent belongs to a worker's Job");
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        job.children.push({ id: created.id, role: args.role, title: clip(args.task, 80) });
        doc.subagents[String(created.id)] = job.id;
        await configure(
          tx,
          created.id,
          host.agentChange({ role: args.role, id: String(created.id), title: args.role, jobId: job.id, parent: api.conversationId, cwd }),
        );
        await configure(tx, created.id, { extensions: { remove: [Worker, Coordinator] } });
        return created.id;
      }, callContext);
      await api.details({ conversationId: child }, callContext);
      const handle = (await api.conversation(child, callContext))!;
      const settled = await (
        await handle.submit({ type: "input", content: args.task, requestId: `subagent:${api.taskId}` }, callContext)
      ).wait(callContext);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`The ${args.role} did not answer: ${settled.status}`);
      const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), callContext);
      return { output: [{ type: "text" as const, text: textOfAnswer(entry) }], details: { conversationId: child } };
    },
  });

  Worker = defineExtension({ name: "projects.jobs-worker", tools: [jobTool, subagentTool] });

  // ── Operations ─────────────────────────────────────────────────────────────
  /** Send a message to an agent (steer, or queue after its answer); a finished Job runs again. */
  async function sendTo(api: Pick<Session, "commit">, id: string, message: string, followUp: boolean, requestId?: string): Promise<string> {
    return api.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      const agent = doc.agents[id];
      if (!agent) return `No agent ${id}.`;
      const key = requestId ? `send:${requestId}` : undefined;
      if (key && doc.requests[key]) return `Already sent to ${id}.`;
      const job = agent.jobId ? doc.jobs[agent.jobId] : undefined;
      const refusal = job?.workspace ? null : host.refuseSend?.(agent);
      if (refusal) return refusal;
      if (doc.paused) return "The project is paused.";
      const borrower = job?.workspace?.kind === "shared" ? sharedHandoff(doc, agent.chat, id) : undefined;
      if (borrower) return `Shared workspace is still handed to ${borrower.id}; wait for it to settle.`;
      if (job?.workspace && job.status !== "running" && agent.endedAt === null)
        return "The task helper is still draining; wait for its workspace handoff to settle.";
      if (key) doc.requests[key] = id;
      // An agent that never received its brief (it failed or was stopped while preparing) gets it first, so a send retries the task.
      if (!agent.briefed && agent.brief && message !== agent.brief) message = `${agent.brief}\n\nOwner's follow-up: ${message}`;
      if (job) {
        if (job.status === "ready" || job.status === "ready-with-gaps")
          job.resume = { status: job.status, ready: job.ready!, endedAt: job.endedAt };
        job.status = "running";
        job.ready = null;
        job.endedAt = null;
        job.reason = null;
      }
      // An explicit retry adopts current role settings; steering a running agent keeps its model and frozen prompt.
      if (agent.endedAt !== null) {
        await host.onRetry?.(tx, agent.conversationId);
        const model = host.agentChange({
          role: agent.role,
          id: agent.id,
          title: agent.title,
          jobId: agent.jobId,
          parent: agent.chat,
        }).model;
        if (model) await configure(tx, agent.conversationId, { model });
      }
      agent.endedAt = null;
      delete agent.dismissedAt;
      if (job) delete job.dismissedAt;
      agent.sends = (agent.sends ?? 0) + 1;
      const background = { ownership: { kind: "conversation" }, background: true, conversationId: agent.chat } as const;
      await tx.createTask(
        Reporter,
        {
          agentId: id,
          conversationId: agent.conversationId,
          chat: agent.chat,
          message,
          followUp,
          requestId,
          seq: agent.sends,
          prepare: true, // every message re-binds the workspace and tools, re-acquires the lease and revives a cleaned-up worktree
        },
        background,
      );
      return `Sent to ${id}.`;
    }, context);
  }

  const stops = new Map<string, Promise<string>>();

  /** Concurrent Stops join one drain; durable Agent.endedAt still owns the workspace handoff. */
  function stopAgent(harness: Harness, id: string, reason: string): Promise<string> {
    const pending = stops.get(id);
    if (pending) return pending;
    const stopping = stopAgentOnce(harness, id, reason).finally(() => stops.delete(id));
    stops.set(id, stopping);
    return stopping;
  }

  /** Mark stopped, abort the agent and everything it owns, then kill their background processes. */
  async function stopAgentOnce(harness: Harness, id: string, reason: string): Promise<string> {
    const target = await harness.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      const agent = doc.agents[id];
      if (!agent) return { text: `No agent ${id}.` };
      const job = agent.jobId ? doc.jobs[agent.jobId] : undefined;
      const helper = Boolean(job?.workspace);
      if (job && !isLive(job.status) && !(job.workspace && agent.endedAt === null)) return { text: `The Job is already ${job.status}.` };
      if (!job && agent.endedAt) return { text: `${id} already ended.` };
      const now = clock();
      if (job) Object.assign(job, { status: "stopped", reason, endedAt: now, stalledAt: null, resume: null });
      if (!helper) agent.endedAt = now;
      return { conversationId: agent.conversationId, helper };
    }, context);
    if (!target.conversationId) return target.text!;
    const owned = [target.conversationId, ...(await descendants(harness, target.conversationId))];
    // Reporters belong to the spawning chat, so a child abort alone cannot drain a helper still preparing.
    const reporters = target.helper
      ? (await harness.inspect(context)).tasks.map((task) => task.record).filter((task) => task.kind === "projects.agent-reporter")
      : [];
    const deliveries = [];
    for (const task of reporters) {
      if (task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.agentId === id) deliveries.push(task.id);
    }
    try {
      const drains = await Promise.allSettled([
        (await harness.conversation(target.conversationId, context))?.abort(context, { background: true }),
        ...deliveries.map(async (task) => {
          await harness.abortTask(task, context);
          await harness.waitForTask(task, context);
        }),
        ...(target.helper ? [host.killProcesses?.(owned)] : []),
      ]);
      const errors = drains.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length) throw new AggregateError(errors, "Agent stop drainage failed");
    } finally {
      if (!target.helper) await host.killProcesses?.(owned);
    }
    if (target.helper)
      await harness.commit(async (tx) => {
        const agent = (await tx.doc(Jobs, ROOT_CONVERSATION_ID)).agents[id];
        if (agent) agent.endedAt = clock();
      }, context);
    return `Stopped ${id}.`;
  }

  /** Clear an ended agent or Job from the lists. Not a delete: the record, transcripts and files stay. */
  async function dismissAgent(api: Pick<Session, "commit">, id: string): Promise<string> {
    return api.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      const agent = doc.agents[id];
      if (!agent) return `No agent ${id}.`;
      const job = agent.jobId ? doc.jobs[agent.jobId] : undefined;
      if (agent.jobId && !job) return `No Job ${agent.jobId}.`;
      if (job && agent.id !== job.id) return `${id} is a subagent; dismiss its Job ${job.id}.`;
      if (job ? isLive(job.status) : agent.endedAt === null) return `${id} is still running; stop it first.`;
      const target = job ?? agent;
      if (target.dismissedAt) return `${id} is already dismissed.`;
      target.dismissedAt = clock();
      return `Dismissed ${id}. Its history stays readable; send to it to bring it back.`;
    }, context);
  }

  /** Agents that should be working: running Jobs' workers and scouts or reviewers still answering. */
  const liveAgents = (doc: Readonly<JobsState>) =>
    Object.values(doc.agents).filter((agent) => (agent.jobId ? doc.jobs[agent.jobId]?.status === "running" : agent.endedAt === null));

  /** Stop admitting work and abort every live agent, keeping their Jobs running so a resume continues them. */
  async function pause(harness: Harness): Promise<void> {
    const live = await harness.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      doc.paused = true;
      return liveAgents(doc).map((agent) => agent.conversationId);
    }, context);
    const owned = (await Promise.all(live.map(async (id) => [id, ...(await descendants(harness, id))]))).flat();
    try {
      await Promise.all(live.map(async (id) => (await harness.conversation(id, context))?.abort(context, { background: true })));
    } finally {
      await host.killProcesses?.(owned);
    }
  }

  async function resume(harness: Harness): Promise<void> {
    const root = await harness.root(context);
    const live = await harness.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      doc.paused = false;
      return liveAgents(doc).map((agent) => ({ id: agent.id, brief: agent.briefed ? null : agent.brief }));
    }, context);
    for (const { id, brief } of live)
      await sendTo(root, id, brief || "The project was paused and has resumed. Continue where you left off.", true);
  }

  /** After a reopen, before the scheduler runs: let the host rebuild what live agents need (workspace tools). */
  async function recover(harness: Harness): Promise<void> {
    // An older host could abort a reporter after its Job ended without ending the agent; nothing would ever end it.
    const reported = reportedAgents(await harness.inspect(context));
    await harness.commit(async (tx) => {
      const state = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      for (const agent of Object.values(state.agents))
        if (endedJobAgent(state, agent) && !reported.has(agent.id)) agent.endedAt = Date.now();
    }, context);
    const doc = await harness.snapshot(Jobs, ROOT_CONVERSATION_ID, context);
    if (!doc) return;
    for (const agent of liveAgents(doc))
      if (agent.prepared && !(doc.paused && agent.jobId && doc.jobs[agent.jobId]?.workspace))
        await host.prepare?.({
          agent: agent as Agent,
          job: agent.jobId ? ((doc.jobs[agent.jobId] as Job | undefined) ?? null) : null,
          frame: (await harness.snapshot(AgentPrompt, agent.conversationId, context))?.frame ?? null,
        });
  }

  async function snapshot(harness: Harness): Promise<JobsSnapshot> {
    const doc = (await harness.snapshot(Jobs, ROOT_CONVERSATION_ID, context)) ?? {
      paused: false,
      jobs: {},
      agents: {},
      subagents: {},
      requests: {},
    };
    const jobs = await Promise.all(
      Object.values(doc.jobs).map(async (job) => {
        const leaf = isLive(job.status) ? await activeLeaf(harness, job.workerConversation) : null;
        return {
          ...job,
          conversationId: job.workerConversation,
          working: await working(harness, job.workerConversation),
          leaf,
          eta: planEta(job.plan, clock()),
          children: await Promise.all(job.children.map(async (child) => ({ ...child, working: await working(harness, child.id) }))),
          quota: doc.agents[job.id]?.quota ?? null,
          modelMoves: doc.agents[job.id]?.modelMoves ?? [],
          model: await agentModel(harness, job.workerConversation),
        };
      }),
    );
    const reported = reportedAgents(await harness.inspect(context));
    const agents = await Promise.all(
      Object.values(doc.agents).map(async (agent) => ({
        ...agent,
        working: await working(harness, agent.conversationId),
        active: reported.has(agent.id),
        model: await agentModel(harness, agent.conversationId),
        prompt: await promptStatus(harness, agent as Agent, agent.jobId ? ((doc.jobs[agent.jobId] as Job | undefined) ?? null) : null),
      })),
    );
    return { paused: doc.paused, jobs, agents };
  }

  async function promptStatus(harness: Harness, agent: Agent, job: Job | null): Promise<AgentPromptStatus | null> {
    const behavior = host.promptBehavior?.(agent, job);
    if (behavior == null) return null;
    // An agent not prepared yet starts with the saved behavior.
    if (!agent.prepared) return { state: "current", reason: null };
    const saved = await harness.snapshot(AgentPrompt, agent.conversationId, context);
    if (!saved?.frame)
      return saved?.unproven
        ? { state: "frozen", reason: saved.unproven }
        : {
            state: "legacy-unchecked",
            reason:
              "Started before prompt blocks: its next continued or retried turn checks whether its stored prompt can be rebuilt exactly.",
          };
    return saved.behavior === behaviorKey(behavior)
      ? { state: "current", reason: null }
      : { state: "pending", reason: "Adopts the saved behavior on its next continued or retried turn while it is idle." };
  }

  /** Something can still run. Every live agent has a reporter task, so identities alone (paused or ended without a report) are not work. */
  async function busy(harness: Pick<Harness, "inspect">): Promise<boolean> {
    return runsWork(await harness.inspect(context));
  }

  async function approve(harness: Harness, jobId: string): Promise<{ outcome: AcceptanceOutcome } | { refused: string }> {
    const job = (await harness.snapshot(Jobs, ROOT_CONVERSATION_ID, context))?.jobs[jobId];
    if (!job) return { refused: `No Job ${jobId}.` };
    if (job.workspace)
      return { refused: "A task helper reports execution only; it cannot be approved. The Coordinator owns integration and delivery." };
    if (!host.approver) return { refused: "Approve is not configured." };
    if (job.status !== "ready" && job.status !== "ready-with-gaps") return { refused: `The Job is ${job.status}, not ready.` };
    if (!job.pr || !job.candidate) return { refused: "The Job has no PR and candidate to merge." };
    const outcome = await host.approver.approve({ id: job.id, pr: job.pr, candidateSha: job.candidate });
    await markApproved(harness, jobId, outcome);
    return { outcome };
  }

  async function markApproved(harness: Harness, jobId: string, outcome: AcceptanceOutcome | null): Promise<void> {
    if (outcome?.kind !== "accepted" && outcome?.kind !== "merged-pull-skipped") return;
    const approved = await harness.commit(async (tx) => {
      const current = (await tx.doc(Jobs, ROOT_CONVERSATION_ID)).jobs[jobId];
      if (
        !current ||
        current.workspace ||
        current.candidate !== outcome.head ||
        (current.status !== "ready" && current.status !== "ready-with-gaps")
      )
        return false;
      current.status = "approved";
      return true;
    }, context);
    if (approved) host.afterApproved?.(jobId);
  }

  /** An Approve that answered `auto-merge-pending` ended later: record the merge and tell the Job's chat. */
  async function finishApproval(harness: Harness, jobId: string, outcome: AcceptanceOutcome | null, line: string): Promise<void> {
    await markApproved(harness, jobId, outcome);
    const job = (await harness.snapshot(Jobs, ROOT_CONVERSATION_ID, context))?.jobs[jobId];
    const chat = job && (await harness.conversation(job.chat, context));
    await chat?.submit(
      {
        type: "input",
        content: `[worker ${jobId} approve: ${job!.title}] ${line}`,
        entry: { kind: "projects.internal-input" },
        whenBusy: "followUp",
        requestId: `approve:${jobId}:${clock()}`,
      },
      context,
    );
  }

  // ── Stall detector ─────────────────────────────────────────────────────────
  /** The deepest working conversation below a worker: a worker waiting on its active verifier is judged by the verifier. */
  async function activeLeaf(harness: Harness, id: ConversationId): Promise<ConversationId> {
    let leaf = id;
    for (let again = true; again;) {
      again = false;
      for (const child of (await children(harness, leaf)).toReversed()) {
        if (await working(harness, child)) {
          leaf = child;
          again = true;
          break;
        }
      }
    }
    return leaf;
  }

  const seen = new Map<ConversationId, { signature: string; since: number }>();

  const REPEATS = 5;
  /** The last tool calls with their results, as comparable keys. */
  async function recentCalls(harness: Harness, id: ConversationId): Promise<{ key: string; label: string }[]> {
    const page = await (await harness.conversation(id, context))!.entries({}, 40, undefined, context);
    const calls = new Map<string, string>();
    const out: { key: string; label: string }[] = [];
    for (const entry of page.items.toReversed()) {
      const message = entry.model?.[0] as { role: string; content?: unknown; toolCallId?: string; toolName?: string } | undefined;
      if (message?.role === "assistant" && Array.isArray(message.content))
        for (const part of message.content as { type: string; id?: string; name?: string; arguments?: unknown }[])
          if (part.type === "toolCall" && part.id) calls.set(part.id, `${part.name} ${JSON.stringify(part.arguments)}`);
      if (message?.role === "toolResult") {
        const result = JSON.stringify(message.content);
        const call = calls.get(message.toolCallId ?? "") ?? message.toolName ?? "tool";
        out.push({ key: `${call}\n${result}`, label: `${clip(call, 120)} → ${clip(result, 100)}` });
      }
    }
    return out;
  }

  /** One pass over running Jobs. Raises one notice per stall to the Job's chat; never steers or stops. */
  async function stallTick(harness: Harness, now = clock()): Promise<string[]> {
    const limit = (host.stallMinutes?.() ?? 20) * 60_000;
    const doc = await harness.snapshot(Jobs, ROOT_CONVERSATION_ID, context);
    if (!doc || doc.paused) return [];
    const notified: string[] = [];
    for (const job of Object.values(doc.jobs)) {
      if (!isLive(job.status)) continue;
      const worker = job.workerConversation;
      const owned = [worker, ...(await descendants(harness, worker))];
      const background = (await host.backgroundSilence?.(owned)) ?? null;
      const running = await working(harness, worker);
      const agent = doc.agents[job.id];
      // Idle with no process: only a worker that is prepared and not waiting out a quota can be stalled.
      const idle = !running && background === null;
      if (idle && (!agent?.prepared || (agent.quota && agent.quota.retryAt > now))) {
        seen.delete(worker);
        continue;
      }
      const leaf = running ? await activeLeaf(harness, worker) : worker;
      const live = await harness.snapshot(LiveDoc, leaf, context);
      // Inside a long background wait the command's output is the progress, as a child's is for a worker waiting on it.
      const waitsOnBackground =
        background !== null &&
        [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].some(
          (slot) => slot.name === BACKGROUND_WAIT_TOOL && slot.status === "running",
        );
      const latest = (await (await harness.conversation(leaf, context))!.entries({}, 1, undefined, context)).items[0];
      const signature = `${leaf}:${latest?.id ?? ""}:${(live?.tools ?? []).map((slot) => `${slot.status}${slot.output?.length ?? 0}`).join(",")}:${live?.generation?.message ? JSON.stringify(live.generation.message).length : 0}`;
      const previous = seen.get(worker);
      if (!previous || previous.signature !== signature) seen.set(worker, { signature, since: now });
      const silent = now - seen.get(worker)!.since;
      const calls = await recentCalls(harness, leaf);
      const tail = calls.slice(-REPEATS);
      let problem: string | null = null;
      if (idle && silent >= limit) problem = `the worker is idle and has not reported for ${minutes(silent)}`;
      else if (running && silent >= limit && !waitsOnBackground) problem = `no progress for ${minutes(silent)}`;
      else if (running && tail.length === REPEATS && tail.every((call) => call.key === tail[0]!.key))
        problem = `the same tool call returned the same result ${REPEATS} times`;
      else if (background !== null && background >= limit && silent >= limit)
        problem = `no worker progress while a background process printed nothing for ${minutes(background)}`;
      if (!problem) {
        if (job.stalledAt !== null) {
          await discardQueuedStalls(harness, job);
          await harness.commit(async (tx) => void ((await tx.doc(Jobs, ROOT_CONVERSATION_ID)).jobs[job.id]!.stalledAt = null), context);
        }
        continue;
      }
      if (job.stalledAt !== null) continue;
      const episode = job.stalls + 1;
      const steps = calls
        .slice(-3)
        .map((call) => `- ${call.label}`)
        .join("\n");
      const chat = await harness.conversation(job.chat, context);
      await chat?.submit(
        {
          type: "input",
          content: `[worker ${job.id} stalled: ${job.title}] ${problem}${leaf !== worker ? ` (in its ${job.children.find((child) => child.id === leaf)?.role ?? "subagent"} conversation ${leaf})` : ""}.${steps ? `\nLast steps:\n${steps}` : ""}\nSteer or stop it if needed.`,
          whenBusy: "followUp",
          requestId: `stall:${job.id}:${episode}`,
          entry: { kind: "projects.internal-input" },
        },
        context,
      );
      await harness.commit(async (tx) => {
        const current = (await tx.doc(Jobs, ROOT_CONVERSATION_ID)).jobs[job.id]!;
        current.stalls = episode;
        current.stalledAt = now;
      }, context);
      notified.push(job.id);
    }
    return notified;
  }

  return {
    doc: Jobs,
    coordinator: Coordinator,
    worker: Worker,
    /** The tools each extension offers, for hosts that list an agent's tools explicitly. */
    tools: { coordinator: [agentsTool], worker: [jobTool, subagentTool] },
    /** Install the extensions on a registry; reporters and anchors resume after a reopen once installed. */
    install(registry: { install(extension: Extension): void }) {
      registry.install(Coordinator);
      registry.install(Worker);
    },
    /** The host's open Harness; stop needs it to abort an agent's whole tree. */
    attach(harness: Harness) {
      bound = harness;
    },
    snapshot,
    stop: (harness: Harness, id: string, reason: string) => {
      if (!reason.trim()) throw new Error("Stopping needs a reason");
      return stopAgent(harness, id, reason.trim());
    },
    steer: async (harness: Harness, id: string, message: string, followUp = false, requestId?: string) => {
      const root = await harness.root(context);
      return sendTo(root, id, message, followUp, requestId);
    },
    dismiss: async (harness: Harness, id: string) => dismissAgent(await harness.root(context), id),
    approve,
    finishApproval,
    stallTick,
    pause,
    resume,
    busy,
    recover,
    /** Start an agent from the host (Follow PRs, schedules): same dedupe as the coordinator tool, keyed by `requestId`. */
    spawn: (root: Pick<Session, "commit">, chat: ConversationId, args: SpawnArgs & { requestId: string }) =>
      spawn(root, chat, args, `host:${args.requestId}`, context),
  };
}
export type JobsRuntime = ReturnType<typeof createJobs>;
