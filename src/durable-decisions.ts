import { randomUUID } from "node:crypto";
import { defineDoc, defineExtension, defineTool, type Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { DurablePlanning } from "./durable-planning.ts";
import { retainQuestion } from "./inbox.ts";
import type { InboxEntry } from "./state.ts";

type Question = Extract<InboxEntry, { kind: "question" }>;
type Intent = { key: string; entry: Question; state: "recorded" | "materialized" };
const Questions = defineDoc<{ items: Intent[] }>({ kind: "projects.decision-intents", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }) });
function copy(entry: Question): Question {
  return { kind: "question", id: entry.id, at: entry.at, title: entry.title, question: entry.question, choices: [...entry.choices], result: null,
    ...(entry.native ? { native: { projectId: entry.native.projectId, conversationId: entry.native.conversationId, taskId: entry.native.taskId, callId: entry.native.callId } } : {}) };
}
export function durableDecisions(options: { projectId: string; dir: string; enabled: boolean; root: () => Conversation | undefined }) {
  function owner(): Conversation {
    const root = options.root();
    if (!root) throw new Error("Durable decision owner is unavailable");
    return root;
  }
  const ask = defineTool({
    name: "projects_question", description: "Record a question in this project's human Decision inbox, then end this turn. An answer is not execution or publication authority. Work continues only through an explicit instruction.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }), choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 4 })) }, { additionalProperties: false }), replay: "unsafe",
    async execute(args, api, context) {
      context.abortSignal?.throwIfAborted();
      const root = owner();
      if (!options.enabled || api.conversationId !== root.id) throw new Error("Decision creation requires an explicit coordinator grant");
      const key = `${api.taskId}:${api.callId}`;
      const entry = await api.commit(async tx => {
        const planning = await tx.doc(DurablePlanning, root.id);
        if (planning.paused || planning.pausing) throw new Error("Project plan is paused; admission is denied");
        const state = await tx.doc(Questions, root.id);
        const prior = state.items.find(item => item.key === key);
        if (prior) {
          if (prior.entry.question !== args.question || JSON.stringify([...prior.entry.choices]) !== JSON.stringify(args.choices ?? [])) throw new Error("Decision request identity conflict");
          return copy(prior.entry);
        }
        if (state.items.length >= 4096) throw new Error("Decision intent limit reached");
        const entry: Question = { kind: "question", id: randomUUID(), at: new Date().toISOString(), title: args.question.split("\n")[0].slice(0, 160), question: args.question, choices: [...(args.choices ?? [])], result: null,
          native: { projectId: options.projectId, conversationId: Number(api.conversationId), taskId: Number(api.taskId), callId: api.callId } };
        state.items.push({ key, entry, state: "recorded" });
        return copy(entry);
      }, context);
      context.abortSignal?.throwIfAborted();
      const materialized = retainQuestion(options.dir, entry);
      await api.commit(async tx => {
        const intent = (await tx.doc(Questions, root.id)).items.find(item => item.key === key);
        if (!intent || intent.entry.id !== entry.id) throw new Error("Decision intent identity changed");
        intent.state = "materialized";
      }, context);
      return { content: [{ type: "text", text: JSON.stringify({ entryId: materialized.id, pending: materialized.result === null, delivery: "manual", permissionChange: false }) }], details: { entryId: materialized.id } };
    },
  });
  async function recover(): Promise<void> {
    const root = owner();
    const pending = await root.commit(async tx => (await tx.doc(Questions, root.id)).items.filter(item => item.state === "recorded").map(item => ({ key: item.key, entry: copy(item.entry) })), BACKGROUND_CONTEXT);
    for (const item of pending) {
      retainQuestion(options.dir, item.entry);
      await root.commit(async tx => {
        const intent = (await tx.doc(Questions, root.id)).items.find(intent => intent.key === item.key);
        if (!intent || intent.entry.id !== item.entry.id) throw new Error("Decision recovery identity changed");
        intent.state = "materialized";
      }, BACKGROUND_CONTEXT);
    }
  }
  return { extension: defineExtension({ name: "projects.durable-decisions", tools: options.enabled ? [ask] : [] }), tools: options.enabled ? [ask] : [], recover };
}
