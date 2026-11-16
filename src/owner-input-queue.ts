// The owner's queued inputs to a Worker or the Host agent, taken back with Pi's Alt+Up. The Coordinator's chat-dequeue follows the same two steps:
// the host withdraws and returns the text, the page acknowledges once the text is in the editor, and until then the text stays recoverable.
// The Durable runtime owns the queue itself; this module only keeps what the owner typed (the runtime does not keep the text of a queued input)
// and decides what a withdrawal means for each input. See scripts/chat-queue-failures.md, W1-W16.
// One rule keeps the withdraw/submit boundary safe: an input is the page's only once the runtime can no longer run it. While its producer may still
// submit it (status `unsent`), the producer's own check and its submission are two steps, so it is never withdrawn; it stays queued and Alt+Up
// takes it back when the runtime holds it.

export type InputState = "queued" | "withdrawn";
export type InputDelivery = "steer" | "followUp";
export type QueuedInput = { id: string; text: string; delivery: InputDelivery; at: number; state: InputState };
export type RestoredInput = Pick<QueuedInput, "id" | "text" | "delivery">;
/** What the runtime knows of one input: waiting in its queue, taken by a turn, aborted, or not submitted to it yet. */
export type InputStatus = "queued" | "taken" | "aborted" | "unsent";

/** Where an agent keeps its owner inputs and how the runtime answers about them. */
export type InputPort = {
  list(): Promise<QueuedInput[]>;
  setState(ids: readonly string[], state: InputState): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  status(ids: readonly string[]): Promise<Map<string, InputStatus>>;
  /** Which of these inputs a producer may still submit (a delivery task not finished, a send in flight); a producer that is gone is not listed. */
  producing(ids: readonly string[]): Promise<Set<string>>;
  /** Aborts the inputs the runtime still queues, and says which of them it aborted. Inputs not submitted yet are left alone. */
  abort(ids: readonly string[]): Promise<string[]>;
};

const order = (a: QueuedInput, b: QueuedInput) => (a.delivery === b.delivery ? a.at - b.at : a.delivery === "steer" ? -1 : 1);

/** The owner took this input back: the producer must not submit it (or must take its submission out again). */
export const isWithdrawn = (entry: Pick<QueuedInput, "state"> | undefined): boolean => entry?.state === "withdrawn";

/**
 * Reconciles the ledger with what the runtime really did. A withdrawal the runtime never finished (a crash between the mark and the abort, or a
 * submission that arrived after it) is finished here, so an input is never offered for the editor while it still waits to run.
 */
async function settle(port: InputPort): Promise<QueuedInput[]> {
  const entries = await port.list();
  if (!entries.length) return [];
  const status = await port.status(entries.map((entry) => entry.id));
  const lingering = entries.filter((entry) => entry.state !== "queued" && status.get(entry.id) === "queued").map((entry) => entry.id);
  if (lingering.length) {
    await port.abort(lingering);
    for (const [id, now] of await port.status(lingering)) status.set(id, now);
  }
  const drop = new Set<string>(),
    withdraw = new Set<string>(),
    requeue = new Set<string>();
  for (const entry of entries) {
    const now = status.get(entry.id);
    if (now === "taken") drop.add(entry.id);
    else if (entry.state === "queued") {
      if (now === "aborted") withdraw.add(entry.id);
    } else if (now === "queued") requeue.add(entry.id);
  }
  if (drop.size) await port.remove([...drop]);
  if (withdraw.size) await port.setState([...withdraw], "withdrawn");
  if (requeue.size) await port.setState([...requeue], "queued");
  return entries
    .filter((entry) => !drop.has(entry.id))
    .map((entry) =>
      withdraw.has(entry.id)
        ? { ...entry, state: "withdrawn" as const }
        : requeue.has(entry.id)
          ? { ...entry, state: "queued" as const }
          : entry,
    )
    .sort(order);
}

/** The inputs still waiting (steering first) and the withdrawn ones nobody acknowledged. Settles what the runtime already decided. */
export const pendingInputs = settle;

/**
 * Alt+Up: takes every queued input back. An input a turn already took is reported as kept and answered once, never restored. The withdrawn
 * mark is written before the runtime aborts, so a crash in between leaves the text recoverable; inputs withdrawn earlier and never
 * acknowledged come back again, once the runtime really dropped them.
 */
export async function withdrawInputs(port: InputPort): Promise<{ restored: RestoredInput[]; kept: string[] }> {
  const listed = (await settle(port)).filter((entry) => entry.state === "queued").map((entry) => entry.id);
  const status0 = listed.length ? await port.status(listed) : new Map<string, InputStatus>();
  const unsent = listed.filter((id) => status0.get(id) === "unsent");
  const producing = unsent.length ? await port.producing(unsent) : new Set<string>();
  // Not the page's yet: the producer may still submit it.
  const queued = listed.filter((id) => !producing.has(id));
  if (queued.length) {
    await port.setState(queued, "withdrawn");
    await port.abort(queued);
    const status = await port.status(queued);
    // Still in the runtime's queue or already taken: the input is not ours to give back.
    const stays = queued.filter((id) => status.get(id) === "queued" || status.get(id) === "taken");
    const taken = stays.filter((id) => status.get(id) === "taken");
    if (taken.length) await port.remove(taken);
    const stillQueued = stays.filter((id) => !taken.includes(id));
    if (stillQueued.length) await port.setState(stillQueued, "queued");
  }
  const entries = await port.list();
  const restored = entries
    .filter((entry) => entry.state === "withdrawn")
    .sort(order)
    .map(({ id, text, delivery }) => ({ id, text, delivery }));
  const kept = listed.filter((id) => !restored.some((item) => item.id === id));
  return { restored, kept };
}

/** The page has the text safe: forget it. Only withdrawn inputs go; a repeated or unknown id changes nothing. */
export async function acknowledgeInputs(port: InputPort, ids: readonly string[]): Promise<string[]> {
  const withdrawn = (await port.list()).filter((entry) => entry.state === "withdrawn" && ids.includes(entry.id)).map((entry) => entry.id);
  if (withdrawn.length) await port.remove(withdrawn);
  return withdrawn;
}
