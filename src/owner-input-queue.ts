// The owner's queued inputs to a Worker or the Host agent, taken back with Pi's Alt+Up. The Coordinator's chat-dequeue follows the same two steps:
// the host withdraws and returns the text, the page acknowledges once the text is in the editor, and until then the text stays recoverable.
// The Durable runtime owns the queue itself; this module only keeps what the owner typed (the runtime does not keep the text of a queued input)
// and decides what a withdrawal means for each input. See scripts/chat-queue-failures.md, W1-W8.

export type InputDelivery = "steer" | "followUp";
export type QueuedInput = { id: string; text: string; delivery: InputDelivery; at: number; state: "queued" | "withdrawn" };
export type RestoredInput = Pick<QueuedInput, "id" | "text" | "delivery">;
/** What the runtime knows of one input: waiting in its queue, taken by a turn, aborted, or not submitted to it yet. */
export type InputStatus = "queued" | "taken" | "aborted" | "unsent";

/** Where an agent keeps its owner inputs and how the runtime answers about them. */
export type InputPort = {
  list(): Promise<QueuedInput[]>;
  setState(ids: readonly string[], state: QueuedInput["state"]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  status(ids: readonly string[]): Promise<Map<string, InputStatus>>;
  /** Aborts the inputs the runtime still queues, and says which of them it aborted. Inputs not submitted yet are left to `afterSubmit`. */
  abort(ids: readonly string[]): Promise<string[]>;
};

const order = (a: QueuedInput, b: QueuedInput) => (a.delivery === b.delivery ? a.at - b.at : a.delivery === "steer" ? -1 : 1);

/** The inputs still waiting (steering first) and the withdrawn ones nobody acknowledged. Settles what the runtime already decided. */
export async function pendingInputs(port: InputPort): Promise<QueuedInput[]> {
  const entries = await port.list();
  const queued = entries.filter((entry) => entry.state === "queued");
  if (!queued.length) return entries.sort(order);
  const status = await port.status(queued.map((entry) => entry.id));
  const taken = queued.filter((entry) => status.get(entry.id) === "taken").map((entry) => entry.id);
  const aborted = queued.filter((entry) => status.get(entry.id) === "aborted").map((entry) => entry.id);
  if (taken.length) await port.remove(taken);
  if (aborted.length) await port.setState(aborted, "withdrawn");
  return entries
    .filter((entry) => !taken.includes(entry.id))
    .map((entry) => (aborted.includes(entry.id) ? { ...entry, state: "withdrawn" as const } : entry))
    .sort(order);
}

/**
 * Alt+Up: takes every queued input back. An input a turn already took is reported as kept and answered once, never restored. The withdrawn
 * mark is written before the runtime aborts, so a crash in between leaves the text recoverable; inputs withdrawn earlier and never
 * acknowledged come back again.
 */
export async function withdrawInputs(port: InputPort): Promise<{ restored: RestoredInput[]; kept: string[] }> {
  const queued = (await pendingInputs(port)).filter((entry) => entry.state === "queued").map((entry) => entry.id);
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
  const kept = queued.filter((id) => !restored.some((item) => item.id === id));
  return { restored, kept };
}

/** The page has the text in its editor: forget it. Only withdrawn inputs go; a repeated or unknown id changes nothing. */
export async function acknowledgeInputs(port: InputPort, ids: readonly string[]): Promise<string[]> {
  const withdrawn = (await port.list()).filter((entry) => entry.state === "withdrawn" && ids.includes(entry.id)).map((entry) => entry.id);
  if (withdrawn.length) await port.remove(withdrawn);
  return withdrawn;
}

/** The runtime took the input after a withdrawal marked it: take it back out at once, so it is not delivered as well as restored. */
export async function afterSubmit(port: InputPort, id: string): Promise<void> {
  const entry = (await port.list()).find((item) => item.id === id);
  if (entry?.state === "withdrawn") await port.abort([id]);
}
