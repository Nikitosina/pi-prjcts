import { configure, InboxDoc, LiveDoc, type Conversation } from "@earendil-works/pi-durable";
type Context = Parameters<Conversation["agent"]>[0];

/**
 * Swap a conversation's prompt and tools only while it is idle. Worker results, background and scheduled submissions and
 * automatic compaction do not take the owner lock, so the run, queue and compaction state is read in the same Durable
 * commit as the change: a turn that starts first makes this fail, one that starts later sees the new agent whole.
 */
export function configureWhenIdle(owner: Conversation, target: Conversation, change: Parameters<typeof configure>[2], context: Context, verb = "reloading") {
  return owner.commit(async tx => {
    const live = await tx.doc(LiveDoc, target.id), inbox = await tx.doc(InboxDoc, target.id);
    if (live.run !== undefined || inbox.items.length > 0) throw new Error(`This chat is working; wait for it to finish before ${verb}`);
    if ((live.compactions?.length ?? 0) > 0) throw new Error(`This chat is compacting; wait for it to finish before ${verb}`);
    await configure(tx, target.id, change);
  }, context);
}
