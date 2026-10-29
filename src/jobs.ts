import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import {
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
} from "@earendil-works/pi-durable";
import type { AcceptanceOutcome, AcceptJob } from "./result-acceptance.ts";

const context = BACKGROUND_CONTEXT;

export type AgentRole = "worker" | "scout" | "reviewer" | "verifier";
export type JobStatus = "running" | "ready" | "ready-with-gaps" | "failed" | "stopped" | "approved";
export type PlanStep = {
  title: string;
  status: "todo" | "doing" | "done";
  estimateMin: number | null;
  startedAt: number | null;
  doneAt: number | null;
};
export type ReadyReport = {
  summary: string;
  proof: string[];
  review: string;
  notFixed: { text: string; reason: string }[];
  gaps: string[];
  at: number;
};
/** One owner request with its worker. Small facts only: transcripts, instructions and tool output stay in the conversations. */
export type Job = {
  /** Also the id of the Job's worker agent. */
  id: string;
  /** Conversation that spawned the worker and receives its reports. */
  chat: ConversationId;
  title: string;
  /** The owner's request, verbatim. */
  request: string;
  acceptance: string[];
  status: JobStatus;
  workerConversation: ConversationId;
  branch: string | null;
  pr: string | null;
  candidate: string | null;
  plan: PlanStep[];
  ready: ReadyReport | null;
  /** Why the Job stopped or failed. */
  reason: string | null;
  createdAt: number;
  endedAt: number | null;
  /** Stall notices sent so far, and when the current one was raised (null: not stalled). */
  stalls: number;
  stalledAt: number | null;
};
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
  /** Answers already reported, so steers answered together report once. */
  reported: EntryId[];
};
export type JobsState = {
  paused: boolean;
  jobs: Record<string, Job>;
  agents: Record<string, Agent>;
  /** Spawn request id -> agent id, so a retried spawn returns the same agent. */
  requests: Record<string, string>;
};

/** The project's Jobs, on the root conversation. */
export const Jobs = defineDoc<JobsState>({
  kind: "projects.jobs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paused: false, jobs: {}, agents: {}, requests: {} }),
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
const isLive = (status: JobStatus) => status === "running";

/** Remaining estimated minutes, scaled by how accurate this plan's finished estimates were. */
export function planEta(plan: readonly PlanStep[]): { done: number; total: number; etaMin: number | null } {
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
    etaMin: open.length ? Math.round(open.reduce((sum, step) => sum + step.estimateMin!, 0) * accuracy) : null,
  };
}

/** The Ready report the coordinator receives in full, followed by the worker's own closing message. */
export function readyText(job: Job, answer: string): string {
  const ready = job.ready!;
  const list = (items: readonly string[]) => (items.length ? items.map((item) => `\n- ${item}`).join("") : " none");
  return [
    `[worker ${job.id} ${job.status}: ${job.title}]`,
    `PR: ${job.pr ?? "none"}${job.branch ? ` (branch ${job.branch})` : ""}`,
    `Candidate: ${job.candidate ?? "none"}`,
    `Summary: ${ready.summary}`,
    `Proof:${list(ready.proof)}`,
    `Review: ${ready.review || "none"}`,
    `Not fixed:${ready.notFixed.length ? ready.notFixed.map((item) => `\n- ${item.text} (${item.reason})`).join("") : " none"}`,
    `Gaps:${list(ready.gaps)}`,
    `Time: ${minutes((job.endedAt ?? ready.at) - job.createdAt)}`,
    ...(answer.trim() ? ["", `Worker's closing message:`, answer.trim()] : []),
  ].join("\n");
}

/** What the host supplies; everything project-specific (models, tools, prompts, workspaces, processes) lives behind it. */
export type JobsHost = {
  /** Agent setup of a new conversation: model, instructions, tools, cwd. Applied before the Jobs tools are added. */
  agentChange(spec: { role: AgentRole; id: string; title: string; jobId: string | null; parent: ConversationId }): AgentChange;
  /** Stops the background processes of these conversations. */
  killProcesses?(conversationIds: readonly ConversationId[]): Promise<void>;
  /** Longest silence in ms of a live background process of these conversations; null without one. */
  backgroundSilence?(conversationIds: readonly ConversationId[]): number | null;
  /** Merge a Ready Job's candidate. */
  approver?: { approve(job: AcceptJob): Promise<AcceptanceOutcome> };
  /** Minutes without progress before a stall notice. Default 20. */
  stallMinutes?: () => number;
  now?: () => number;
};

type Delivery = { agentId: string; conversationId: ConversationId; chat: ConversationId; message: string; followUp: boolean };
type DeliveryState = { phase: "deliver" } | { phase: "report"; report?: string };

const textOfAnswer = (entry: { model?: readonly unknown[] } | undefined): string => {
  const message = entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
  return (message?.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
};

/** The background anchor that owns a spawned agent's conversation; it finishes at once. */
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

/** Delivers one message to an agent and reports its answer to the chat in full, once. */
const Reporter = defineTask<Delivery, DeliveryState, null>({
  name: "projects.agent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, taskContext) => {
      const { agentId, conversationId, message, followUp } = reporter.input;
      const agent = (await runtime.conversation(conversationId, taskContext))!;
      const submission = await agent.submit(
        { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer", requestId: `agent:${reporter.id}` },
        taskContext,
      );
      const settled = await submission.wait(taskContext);
      await runtime.commit(async (tx) => {
        const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
        const state = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
        const record = state.agents[agentId];
        if (!record) return next();
        const job = record.jobId ? state.jobs[record.jobId] : undefined;
        if (settled.status === "unanswered") {
          if (settled.reason === "aborted") return next();
          if (job && isLive(job.status)) {
            job.status = "failed";
            job.reason = `The worker failed: ${settled.reason}`;
            job.endedAt = Date.now();
          }
          return next(`[${record.role} ${record.id} failed: ${record.title}] ${settled.reason}`);
        }
        if (settled.type !== "input") return next();
        if (record.reported.includes(settled.answer)) return next();
        if (job && job.status === "stopped") return next();
        const answer = textOfAnswer(await tx.entry(AssistantEntry, settled.answer));
        record.reported.push(settled.answer);
        if (!job) return next(`[${record.role} ${record.id} answered: ${record.title}]\n${answer}`);
        if (isLive(job.status)) {
          job.status = "failed";
          job.reason = "The worker ended without a Ready report";
          job.endedAt = Date.now();
          return next(`[worker ${job.id} failed: ${job.title}]\nThe worker ended its turn without a Ready report.\n\n${answer.trim()}`);
        }
        if (job.status === "failed") return next();
        return next(readyText(job, answer));
      }, taskContext);
    },
    report: async (reporter, runtime, taskContext) => {
      const report = reporter.state.checkpoint.report;
      if (report !== undefined) {
        const chat = await runtime.conversation(reporter.input.chat, taskContext);
        await chat?.submit({ type: "input", content: report, whenBusy: "followUp", requestId: `report:${reporter.id}` }, taskContext);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext);
    },
  },
  abort: (_reporter, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

const acceptanceText = (criteria: readonly string[]) =>
  criteria.length ? `\n\nAcceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}` : "";
const sha = Type.String({ pattern: "^[0-9a-f]{40}$", description: "Full 40-character commit sha" });
const reply = (text: string, details?: Record<string, string | number>) => ({
  content: [{ type: "text" as const, text }],
  ...(details ? { details } : {}),
});

export type JobsSnapshot = {
  paused: boolean;
  jobs: (Job & { conversationId: ConversationId; working: boolean; leaf: ConversationId | null; eta: ReturnType<typeof planEta> })[];
  agents: (Agent & { working: boolean })[];
};

export function createJobs(host: JobsHost) {
  const clock = () => host.now?.() ?? Date.now();

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

  const agentsTool = defineTool({
    name: "agents",
    description:
      "Run background agents. spawn: role worker (needs title, acceptance criteria; optional branch to continue), scout or reviewer, with a brief; give a fresh requestId so a retry returns the same agent. " +
      "send: steer id with a message (followUp queues it after its current answer). stop: id and a reason. status: one id or all. wait: block up to timeoutSec until id is idle. " +
      "Every answer arrives in full in this chat as a message.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("spawn"), Type.Literal("send"), Type.Literal("stop"), Type.Literal("status"), Type.Literal("wait")]),
      role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("scout"), Type.Literal("reviewer")])),
      brief: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      acceptance: Type.Optional(Type.Array(Type.String())),
      branch: Type.Optional(Type.String()),
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
      const state = (await api.snapshot(Jobs, ROOT_CONVERSATION_ID, callContext)) ?? { paused: false, jobs: {}, agents: {}, requests: {} };
      if (action === "status") {
        const ids = id ? [id] : Object.keys(state.agents);
        const lines: string[] = [];
        for (const each of ids) {
          const agent = Object.hasOwn(state.agents, each) ? state.agents[each] : undefined;
          if (!agent) continue;
          const job = agent.jobId ? state.jobs[agent.jobId] : undefined;
          lines.push(
            `${agent.id} ${agent.role} "${agent.title}": ${job ? job.status : agent.endedAt ? "ended" : "open"}, ${(await working(api, agent.conversationId)) ? "working" : "idle"}`,
          );
        }
        return reply(lines.join("\n") || "No agents.");
      }
      const agent = id && Object.hasOwn(state.agents, id) ? state.agents[id] : undefined;
      if (action !== "spawn" && !agent) return reply(`No agent ${id ?? ""}.`);
      if (action === "wait") {
        const until = clock() + Math.min(Math.max(args.timeoutSec ?? 60, 1), 900) * 1000;
        while (clock() < until && (await working(api, agent!.conversationId))) await sleep(100);
        return reply(
          (await working(api, agent!.conversationId))
            ? `${agent!.id} is still working.`
            : `${agent!.id} is idle; its answer arrives as a message.`,
        );
      }
      if (action === "stop") {
        if (!args.reason?.trim()) return reply("stop needs a reason.");
        return reply(bound ? await stopAgent(bound, agent!.id, args.reason.trim()) : "Jobs are not attached to a host.");
      }
      if (action === "send") {
        if (!args.message?.trim()) return reply("send needs a message.");
        return reply(await sendTo(api, agent!.id, args.message, args.followUp === true));
      }
      // spawn
      const role = args.role;
      if (!role || !args.brief?.trim()) return reply("spawn needs a role and a brief.");
      if (role === "worker" && (!args.title?.trim() || !args.acceptance?.length))
        return reply("A worker needs a title and acceptance criteria.");
      const requestId = args.requestId?.trim();
      const result = await api.commit(async (tx) => {
        const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
        if (requestId && doc.requests[requestId])
          return { text: `Already started as ${doc.requests[requestId]}.`, id: doc.requests[requestId] };
        if (doc.paused) return { text: "The project is paused; spawn again after it resumes." };
        const agentId = uuidOf(`${api.taskId}:spawn`);
        const title = args.title?.trim() || clip(args.brief!, 80);
        const background = { ownership: { kind: "conversation" }, background: true } as const;
        const anchor = await tx.createTask(Anchor, null, background);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(
          tx,
          child.id,
          host.agentChange({ role, id: agentId, title, jobId: role === "worker" ? agentId : null, parent: api.conversationId }),
        );
        await configure(tx, child.id, { extensions: { remove: [Coordinator], add: role === "worker" ? [Worker] : [] } });
        const now = clock();
        doc.agents[agentId] = {
          id: agentId,
          role,
          conversationId: child.id,
          chat: api.conversationId,
          jobId: role === "worker" ? agentId : null,
          title,
          createdAt: now,
          endedAt: null,
          reported: [],
        };
        if (role === "worker")
          doc.jobs[agentId] = {
            id: agentId,
            chat: api.conversationId,
            title,
            request: args.brief!,
            acceptance: args.acceptance!,
            status: "running",
            workerConversation: child.id,
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
          };
        if (requestId) doc.requests[requestId] = agentId;
        const message =
          role === "worker"
            ? `Job ${agentId}: ${title}\n\n${args.brief}${acceptanceText(args.acceptance!)}${args.branch ? `\n\nContinue branch ${args.branch}.` : ""}`
            : args.brief!;
        await tx.createTask(
          Reporter,
          { agentId, conversationId: child.id, chat: api.conversationId, message, followUp: false },
          background,
        );
        return { text: `Started ${role} ${agentId}.`, id: agentId, conversationId: child.id };
      }, callContext);
      return reply(result.text, result.id && result.conversationId ? { id: result.id, conversationId: result.conversationId } : undefined);
    },
  });

  const Coordinator = defineExtension({ name: "projects.jobs-coordinator", tasks: [Anchor, Reporter], tools: [agentsTool] });

  const jobTool = defineTool({
    name: "job",
    description:
      "Your Job's record. plan: replace the plan with steps (title, status todo|doing|done, estimateMin). " +
      "ready: report the finished work once the candidate is built and checked: summary, pr, candidate sha, proof refs, review result, anything not fixed with the reason, and gaps (unproven acceptance criteria). Gaps make it Ready with gaps.",
    parameters: Type.Union([
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
    execute: async (args, api, callContext) =>
      reply(
        await api.commit(async (tx) => {
          const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
          const job = Object.values(doc.jobs).find((item) => item.workerConversation === api.conversationId);
          if (!job) return "This tool belongs to a worker's Job.";
          if (!isLive(job.status) && job.status !== "ready" && job.status !== "ready-with-gaps") return `The Job is ${job.status}.`;
          const now = clock();
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
          job.endedAt = now;
          job.stalledAt = null;
          return `Ready recorded (${job.status}). End your turn; the report goes to the coordinator.`;
        }, callContext),
      ),
  });

  const subagentTool = defineTool({
    name: "subagent",
    description: "Run a fresh verifier, reviewer or scout on a task and get its answer. It cannot spawn agents and ends when it answers.",
    parameters: Type.Object({
      role: Type.Union([Type.Literal("verifier"), Type.Literal("reviewer"), Type.Literal("scout")]),
      task: Type.String(),
    }),
    replay: "safe",
    execute: async (args, api, callContext) => {
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(
          tx,
          created.id,
          host.agentChange({ role: args.role, id: String(created.id), title: args.role, jobId: null, parent: api.conversationId }),
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
      return { content: [{ type: "text" as const, text: textOfAnswer(entry) }], details: { conversationId: child } };
    },
  });

  Worker = defineExtension({ name: "projects.jobs-worker", tools: [jobTool, subagentTool] });

  // ── Operations ─────────────────────────────────────────────────────────────
  /** Send a message to an agent (steer, or queue after its answer); a finished Job runs again. */
  async function sendTo(api: Pick<Session, "commit">, id: string, message: string, followUp: boolean): Promise<string> {
    return api.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      const agent = doc.agents[id];
      if (!agent) return `No agent ${id}.`;
      if (doc.paused) return "The project is paused.";
      const job = agent.jobId ? doc.jobs[agent.jobId] : undefined;
      if (job) {
        job.status = "running";
        job.ready = null;
        job.endedAt = null;
        job.reason = null;
        job.stalledAt = null;
      }
      agent.endedAt = null;
      const background = { ownership: { kind: "conversation" }, background: true, conversationId: agent.chat } as const;
      await tx.createTask(Reporter, { agentId: id, conversationId: agent.conversationId, chat: agent.chat, message, followUp }, background);
      return `Sent to ${id}.`;
    }, context);
  }

  /** Mark stopped, abort the agent and everything it owns, then kill their background processes. */
  async function stopAgent(harness: Harness, id: string, reason: string): Promise<string> {
    const target = await harness.commit(async (tx) => {
      const doc = await tx.doc(Jobs, ROOT_CONVERSATION_ID);
      const agent = doc.agents[id];
      if (!agent) return { text: `No agent ${id}.` };
      const job = agent.jobId ? doc.jobs[agent.jobId] : undefined;
      if (job && !isLive(job.status)) return { text: `The Job is already ${job.status}.` };
      if (!job && agent.endedAt) return { text: `${id} already ended.` };
      const now = clock();
      if (job) Object.assign(job, { status: "stopped", reason, endedAt: now, stalledAt: null });
      agent.endedAt = now;
      return { conversationId: agent.conversationId };
    }, context);
    if (!target.conversationId) return target.text!;
    const owned = [target.conversationId, ...(await descendants(harness, target.conversationId))];
    try {
      await (await harness.conversation(target.conversationId, context))?.abort(context, { background: true });
    } finally {
      await host.killProcesses?.(owned);
    }
    return `Stopped ${id}.`;
  }

  async function snapshot(harness: Harness): Promise<JobsSnapshot> {
    const doc = (await harness.snapshot(Jobs, ROOT_CONVERSATION_ID, context)) ?? { paused: false, jobs: {}, agents: {}, requests: {} };
    const jobs = await Promise.all(
      Object.values(doc.jobs).map(async (job) => {
        const leaf = isLive(job.status) ? await activeLeaf(harness, job.workerConversation) : null;
        return {
          ...job,
          conversationId: job.workerConversation,
          working: await working(harness, job.workerConversation),
          leaf,
          eta: planEta(job.plan),
        };
      }),
    );
    const agents = await Promise.all(
      Object.values(doc.agents)
        .filter((agent) => !agent.jobId)
        .map(async (agent) => ({ ...agent, working: await working(harness, agent.conversationId) })),
    );
    return { paused: doc.paused, jobs, agents };
  }

  async function approve(harness: Harness, jobId: string): Promise<{ outcome: AcceptanceOutcome } | { refused: string }> {
    if (!host.approver) return { refused: "Approve is not configured." };
    const job = (await harness.snapshot(Jobs, ROOT_CONVERSATION_ID, context))?.jobs[jobId];
    if (!job) return { refused: `No Job ${jobId}.` };
    if (job.status !== "ready" && job.status !== "ready-with-gaps") return { refused: `The Job is ${job.status}, not ready.` };
    if (!job.pr || !job.candidate) return { refused: "The Job has no PR and candidate to merge." };
    const outcome = await host.approver.approve({ id: job.id, pr: job.pr, candidateSha: job.candidate });
    if (outcome.kind === "accepted" || outcome.kind === "merged-pull-skipped")
      await harness.commit(async (tx) => {
        const current = (await tx.doc(Jobs, ROOT_CONVERSATION_ID)).jobs[jobId];
        if (current && (current.status === "ready" || current.status === "ready-with-gaps")) current.status = "approved";
      }, context);
    return { outcome };
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
      const background = host.backgroundSilence?.(owned) ?? null;
      const running = await working(harness, worker);
      if (!running && background === null) {
        seen.delete(worker);
        continue;
      }
      const leaf = running ? await activeLeaf(harness, worker) : worker;
      const live = await harness.snapshot(LiveDoc, leaf, context);
      const latest = (await (await harness.conversation(leaf, context))!.entries({}, 1, undefined, context)).items[0];
      const signature = `${leaf}:${latest?.id ?? ""}:${(live?.tools ?? []).map((slot) => `${slot.status}${slot.output?.length ?? 0}`).join(",")}:${live?.generation?.message ? JSON.stringify(live.generation.message).length : 0}`;
      const previous = seen.get(worker);
      if (!previous || previous.signature !== signature) seen.set(worker, { signature, since: now });
      const silent = now - seen.get(worker)!.since;
      const calls = await recentCalls(harness, leaf);
      const tail = calls.slice(-REPEATS);
      let problem: string | null = null;
      if (running && silent >= limit) problem = `no progress for ${minutes(silent)}`;
      else if (tail.length === REPEATS && tail.every((call) => call.key === tail[0]!.key))
        problem = `the same tool call returned the same result ${REPEATS} times`;
      else if (background !== null && background >= limit) problem = `a background process printed nothing for ${minutes(background)}`;
      if (!problem) {
        if (job.stalledAt !== null)
          await harness.commit(async (tx) => void ((await tx.doc(Jobs, ROOT_CONVERSATION_ID)).jobs[job.id]!.stalledAt = null), context);
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
          content: `[worker ${job.id} stalled: ${job.title}] ${problem}${leaf !== worker ? ` (in its ${leaf === worker ? "worker" : "subagent"} conversation ${leaf})` : ""}.${steps ? `\nLast steps:\n${steps}` : ""}\nSteer or stop it if needed.`,
          whenBusy: "followUp",
          requestId: `stall:${job.id}:${episode}`,
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
    steer: async (harness: Harness, id: string, message: string, followUp = false) => {
      const root = await harness.root(context);
      return sendTo(root, id, message, followUp);
    },
    approve,
    stallTick,
    setPaused: (harness: Harness, paused: boolean) =>
      harness.commit(async (tx) => void ((await tx.doc(Jobs, ROOT_CONVERSATION_ID)).paused = paused), context),
  };
}
export type JobsRuntime = ReturnType<typeof createJobs>;
