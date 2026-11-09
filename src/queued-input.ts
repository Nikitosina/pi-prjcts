import type { Context } from "@earendil-works/chord";
import { InboxDoc, type ConversationId, type InboxItem, type ToolExecutionApi } from "@earendil-works/pi-durable";

/** How a message waits for the agent: a steer is placed after the current tool round, a follow-up after the turn ends. */
export type QueuedInputMode = Exclude<InboxItem["mode"], "write">;
export type QueuedInputWatch = {
  /** Aborts once a message is queued for the conversation. */
  readonly signal: AbortSignal;
  /** The mode of the message that ended the wait, if one did. */
  arrived(): QueuedInputMode | undefined;
  stop(): void;
};

const POLL_MS = 500;

/**
 * Watch the calling conversation's inbox while a tool waits, so a long wait returns when the owner or the Coordinator sends a
 * message. Any queued steer counts; a follow-up counts only when it arrives after the watch began, since one already queued
 * would otherwise end every later wait at once.
 */
export function watchQueuedInput(
  api: Pick<ToolExecutionApi, "snapshot">,
  conversationId: ConversationId,
  context: Context,
  pollMs = POLL_MS,
): QueuedInputWatch {
  const controller = new AbortController();
  let mode: QueuedInputMode | undefined,
    stopped = false,
    timer: NodeJS.Timeout | undefined,
    known: Set<number> | undefined;
  const check = async () => {
    // A conversation that never queued anything has no inbox document yet.
    const items = (await api.snapshot(InboxDoc, conversationId, context))?.items ?? [];
    known ??= new Set(items.filter((item) => item.mode === "followUp").map((item) => Number(item.id)));
    const found = items.find((item) => item.mode === "steer" || (item.mode === "followUp" && !known!.has(Number(item.id))));
    if (found && found.mode !== "write") {
      mode = found.mode;
      controller.abort();
    }
  };
  const tick = () => {
    if (stopped) return;
    check().then(
      () => {
        if (!stopped && mode === undefined) timer = setTimeout(tick, pollMs);
      },
      () => undefined, // the invocation ended under us; the waiting call returns on its own
    );
  };
  tick();
  return {
    signal: controller.signal,
    arrived: () => mode,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** The note a wait returns with when a message ended it early. */
export function queuedInputNote(mode: QueuedInputMode): string {
  return mode === "steer"
    ? "Ended early: a message for you arrived and is shown after this call. Read it, then wait again if it still applies."
    : "Ended early: a follow-up message for you is queued and is shown when you end your turn.";
}
