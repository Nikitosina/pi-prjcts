import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDoc,
  LiveDoc,
  type Conversation,
  type Harness,
  type ConversationId,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
  ConversationBusy,
} from "@earendil-works/pi-durable";
import { NETWORK_CONTINUE, networkRetryDelay, transientNetworkFailure, unansweredReason } from "./provider-failure.ts";

type Wait = { input: SubmissionId; model: string; at: number; attempt: number };
const Waits = defineDoc<{ chats: Record<string, Wait> }>({
  kind: "projects.network-waits",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ chats: {} }),
});

export function networkContinuations(
  harness: Harness,
  root: Conversation,
  storage: Storage,
  host: {
    run: (operation: () => Promise<void>) => Promise<void>;
    chat: (id: ConversationId) => Promise<Conversation | undefined>;
    report: (error: unknown) => void;
  },
) {
  const newest = new Map<ConversationId, number>();
  const tracked = new Set<ConversationId>();
  const waits = async () => (await harness.snapshot(Waits, root.id, context))?.chats ?? {};
  const timers = new Map<ConversationId, ReturnType<typeof setTimeout>>();
  let closed = false;
  const clear = (id: ConversationId) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
  const cancel = async (id: ConversationId, expected?: SubmissionId) => {
    return root.commit(async (tx) => {
      const chats = (await tx.doc(Waits, root.id)).chats;
      if (!chats[id] || (expected !== undefined && chats[id].input !== expected)) return false;
      clear(id);
      tracked.delete(id);
      delete chats[id];
      return true;
    }, context);
  };
  async function failed(id: ConversationId, model: string) {
    const inputs = (await harness.snapshot(LiveDoc, id, context))?.run?.inputs;
    const input = inputs?.at(-1);
    if (!input) return;
    const record = await storage.submission(input, context);
    const previous = /^network-retry:\d+:(\d+)$/.exec(record?.requestId ?? "");
    const attempt = Number(previous?.[1] ?? 0) + 1,
      delay = networkRetryDelay(attempt);
    if (delay === undefined) return;
    tracked.add(id);
    await root.commit(async (tx) => {
      (await tx.doc(Waits, root.id)).chats[id] = { input, model, attempt, at: Date.now() + delay };
    }, context);
  }
  async function reconcile(id: ConversationId) {
    if (closed) return;
    const wait = (await waits())[id];
    if (!wait) return;
    const record = await storage.submission(wait.input, context);
    if ((newest.get(id) ?? 0) > wait.input) {
      await cancel(id, wait.input);
      return;
    }
    if (record?.status === "placed" || record?.status === "queued") return;
    if (!record || record.type !== "input" || record.status !== "unanswered" || !transientNetworkFailure(unansweredReason(record))) {
      await cancel(id, wait.input);
      return;
    }
    if (Date.now() < wait.at) {
      clear(id);
      timers.set(id, setTimeout(() => wake(id), wait.at - Date.now()).unref());
      return;
    }
    const latest = await storage.scanSubmissions({ conversationId: id, order: "descending" }, 1, undefined, context);
    const chat = await host.chat(id),
      model = (await chat?.agent(context))?.model;
    // A report can land during the storage/model reads; check the synchronous commit watermark at admission.
    if (
      chat &&
      latest.items[0]?.id === wait.input &&
      (newest.get(id) ?? 0) <= wait.input &&
      `${model?.provider}/${model?.modelId}` === wait.model
    ) {
      await chat
        .submit(
          {
            type: "input",
            content: NETWORK_CONTINUE,
            entry: { kind: "projects.internal-input" },
            whenBusy: "reject",
            requestId: `network-retry:${wait.input}:${wait.attempt}`,
          },
          context,
        )
        .catch((error) => {
          if (!(error instanceof ConversationBusy)) throw error;
        });
    }
    await cancel(id, wait.input);
  }
  function wake(id: ConversationId) {
    if (!closed) void host.run(() => reconcile(id)).catch(host.report);
  }
  return {
    failed,
    waits,
    observe(record: SubmissionRecord) {
      newest.set(record.conversationId, Math.max(record.id, newest.get(record.conversationId) ?? 0));
      if (tracked.has(record.conversationId)) wake(record.conversationId);
    },
    cancel,
    async restore() {
      for (const key of Object.keys(await waits())) {
        const id = Number(key) as ConversationId;
        tracked.add(id);
        wake(id);
      }
    },
    close() {
      closed = true;
      for (const id of timers.keys()) clear(id);
    },
  };
}
