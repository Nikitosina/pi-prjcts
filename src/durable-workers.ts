import { Type } from "typebox";
import {
  AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool,
  type Conversation, type ConversationId, type EntryId, type ModelRef,
  type TaskId, type ToolRegistration, type Tx,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";

export const Workers = defineDoc<{
  agents: Record<string, { conversationId: ConversationId; reported: EntryId[] }>;
  reporters: Record<string, TaskId>;
}>({ kind: "projects.workers", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ agents: {}, reporters: {} }) });

const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "projects.worker-anchor", version: 1, initial: () => ({ phase: "done" }),
  phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type ReporterInput = { name: string; conversationId: ConversationId; text: string; steer: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; text: string | null };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "projects.worker-reporter", version: 1, initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const child = await runtime.conversation(task.input.conversationId, context);
      if (!child) throw new Error("Worker conversation is missing");
      const submission = await child.submit({ type: "input", content: task.input.text, whenBusy: task.input.steer ? "steer" : "followUp", requestId: `worker:${task.id}` }, context);
      const answer = await submission.wait(context);
      await runtime.commit(async tx => {
        let text: string | null = null;
        if (answer.status === "unanswered") {
          if (answer.reason !== "aborted") text = `[worker ${task.input.name} failed: ${answer.reason}]`;
        } else if (answer.type === "input") {
          const state = await tx.doc(Workers, runtime.conversationId);
          const worker = state.agents[task.input.name];
          if (!worker) throw new Error("Worker registry is missing");
          if (!worker.reported.includes(answer.answer)) {
            const entry = await tx.entry(AssistantEntry, answer.answer);
            const message = entry?.model?.[0];
            const body = message?.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") : "";
            worker.reported.push(answer.answer);
            text = `[worker ${task.input.name} result; inspect evidence before accepting] ${body}`;
          }
        }
        return { status: "running", checkpoint: { phase: "report", text } };
      }, context);
    },
    report: async (task, runtime, context) => {
      const text = task.state.checkpoint.text;
      if (text !== null) {
        const parent = await runtime.conversation(runtime.conversationId, context);
        if (!parent) throw new Error("Coordinator conversation is missing");
        await parent.submit({ type: "input", content: text, whenBusy: "followUp", requestId: `worker-report:${task.id}` }, context);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export function backgroundWorkers(options: { model: ModelRef; tools: readonly ToolRegistration[]; instructions: string }) {
  const Name = Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" });
  const delegate = defineTool({
    name: "projects_delegate", description: "Start a named persistent worker conversation in the background. Results arrive separately; the coordinator stays available.",
    parameters: Type.Object({ name: Name, task: Type.String({ minLength: 1, maxLength: 32000 }) }),
    replay: "unsafe",
    async execute(args, api, context) {
      const id = await api.commit(tx => spawn(tx, api.conversationId, args.name, args.task), context);
      return { content: [{ type: "text", text: JSON.stringify({ name: args.name, conversationId: id }) }], details: { name: args.name, conversationId: id } };
    },
  });
  const extension = defineExtension({ name: "projects.background-workers", tools: [delegate], tasks: [Anchor, Reporter] });
  async function spawn(tx: Tx, parent: ConversationId, name: string, text: string): Promise<ConversationId> {
    const state = await tx.doc(Workers, parent);
    if (Object.hasOwn(state.agents, name)) throw new Error(`Worker ${name} already exists; send a follow-up instead`);
    const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
    await configure(tx, child.id, { model: options.model, thinkingLevel: "medium", tools: options.tools, extensions: { remove: [extension] }, instructions: options.instructions });
    state.agents[name] = { conversationId: child.id, reported: [] };
    state.reporters[`spawn:${name}`] = await tx.createTask(Reporter, { name, conversationId: child.id, text, steer: false }, { ownership: { kind: "conversation" }, background: true });
    return child.id;
  }
  async function send(parent: Conversation, name: string, text: string, requestId: string, steer: boolean, context: Context = BACKGROUND_CONTEXT) {
    return parent.commit(async tx => {
      const state = await tx.doc(Workers, parent.id);
      if (Object.hasOwn(state.reporters, requestId)) return state.reporters[requestId];
      const child = Object.hasOwn(state.agents, name) ? state.agents[name] : undefined;
      if (!child) throw new Error(`No worker named ${name}`);
      const id = await tx.createTask(Reporter, { name, conversationId: child.conversationId, text, steer }, { ownership: { kind: "conversation" }, background: true });
      state.reporters[requestId] = id;
      return id;
    }, context);
  }
  return { extension, delegate, send };
}
