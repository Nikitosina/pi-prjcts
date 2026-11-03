import { configure, InboxDoc, LiveDoc, type Conversation, type Tx } from "@earendil-works/pi-durable";
type Context = Parameters<Conversation["agent"]>[0];

/**
 * Swap a conversation's prompt and tools only while it is idle. Worker results, background and scheduled submissions and
 * automatic compaction do not take the owner lock, so the run, queue and compaction state is read in the same Durable
 * commit as the change: a turn that starts first makes this fail, one that starts later sees the new agent whole.
 */
export function configureWhenIdle(
  owner: Conversation,
  target: Conversation,
  change: Parameters<typeof configure>[2],
  context: Context,
  verb = "reloading",
  update?: (tx: Tx) => Promise<void>,
) {
  return owner.commit(async (tx) => {
    const busy = await busyIn(tx, target.id);
    if (busy) throw new Error(`This chat is ${busy}; wait for it to finish before ${verb}`);
    await update?.(tx);
    await configure(tx, target.id, change);
  }, context);
}

/** Why a conversation cannot take a new prompt in this commit (a run, queued input or a compaction), or null when it is idle. */
export async function busyIn(tx: Tx, id: Conversation["id"]): Promise<"working" | "compacting" | null> {
  const live = await tx.doc(LiveDoc, id),
    inbox = await tx.doc(InboxDoc, id);
  if (live.run !== undefined || inbox.items.length > 0) return "working";
  return (live.compactions?.length ?? 0) > 0 ? "compacting" : null;
}
