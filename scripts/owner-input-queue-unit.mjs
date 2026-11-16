// Unit: the withdraw / acknowledge protocol for the owner's queued inputs (scripts/chat-queue-failures.md, W3-W5). A fake runtime, no host.
import assert from "node:assert/strict";
import { acknowledgeInputs, afterSubmit, pendingInputs, withdrawInputs } from "../src/owner-input-queue.ts";

const make = (entries, runtime) => {
  const ledger = new Map(entries.map((entry) => [entry.id, { at: 1, state: "queued", delivery: "followUp", ...entry }]));
  const port = {
    list: async () => [...ledger.values()].map((entry) => ({ ...entry })),
    setState: async (ids, state) => ids.forEach((id) => ledger.has(id) && (ledger.get(id).state = state)),
    remove: async (ids) => ids.forEach((id) => ledger.delete(id)),
    status: async (ids) => new Map(ids.map((id) => [id, runtime.get(id) ?? "unsent"])),
    abort: async (ids) => {
      const done = ids.filter((id) => runtime.get(id) === "queued");
      for (const id of done) runtime.set(id, "aborted");
      return done;
    },
  };
  return { ledger, port, runtime };
};

// Steering first, then follow-up by time; restored text is the ledger's, not the runtime's.
{
  const { port } = make(
    [
      { id: "a", text: "one", at: 1 },
      { id: "b", text: "two", delivery: "steer", at: 2 },
    ],
    new Map([
      ["a", "queued"],
      ["b", "queued"],
    ]),
  );
  const result = await withdrawInputs(port);
  assert.deepEqual(
    result.restored.map((item) => item.text),
    ["two", "one"],
  );
}

// W3: a lost response: the same inputs come back until acknowledged.
{
  const { port, ledger } = make([{ id: "a", text: "one" }], new Map([["a", "queued"]]));
  const first = await withdrawInputs(port),
    again = await withdrawInputs(port);
  assert.deepEqual(again.restored, first.restored);
  assert.equal(ledger.get("a").state, "withdrawn");
  // W4: an unknown or repeated acknowledgment removes nothing else.
  assert.deepEqual(await acknowledgeInputs(port, ["zzz"]), []);
  assert.deepEqual(await acknowledgeInputs(port, ["a"]), ["a"]);
  assert.deepEqual(await acknowledgeInputs(port, ["a"]), []);
  assert.equal((await withdrawInputs(port)).restored.length, 0);
}

// W4: an acknowledgment never removes a queued input.
{
  const { port, ledger } = make([{ id: "a", text: "one" }], new Map([["a", "queued"]]));
  assert.deepEqual(await acknowledgeInputs(port, ["a"]), []);
  assert.equal(ledger.size, 1);
}

// W5: an input a turn already took is kept, dropped from the ledger and never restored.
{
  const { port, ledger } = make(
    [
      { id: "a", text: "one" },
      { id: "b", text: "two" },
    ],
    new Map([
      ["a", "taken"],
      ["b", "queued"],
    ]),
  );
  const result = await withdrawInputs(port);
  assert.deepEqual(
    result.restored.map((item) => item.id),
    ["b"],
  );
  assert.equal(ledger.has("a"), false);
}

// A runtime that aborted it by itself (crash between the mark and the abort) is settled as withdrawn, never lost.
{
  const { port } = make([{ id: "a", text: "one" }], new Map([["a", "aborted"]]));
  assert.equal((await pendingInputs(port))[0].state, "withdrawn");
  assert.equal((await withdrawInputs(port)).restored.length, 1);
}

// Not submitted to the runtime yet (a worker still preparing): the withdrawal marks it, and the submission that follows is taken back out.
{
  const { port, runtime, ledger } = make([{ id: "a", text: "one" }], new Map());
  const result = await withdrawInputs(port);
  assert.equal(result.restored.length, 1);
  runtime.set("a", "queued");
  await afterSubmit(port, "a");
  assert.equal(runtime.get("a"), "aborted");
  assert.equal(ledger.get("a").state, "withdrawn");
  // An input that was not withdrawn is left alone.
  const other = make([{ id: "b", text: "two" }], new Map([["b", "queued"]]));
  await afterSubmit(other.port, "b");
  assert.equal(other.runtime.get("b"), "queued");
}
// W9: the acknowledgment of a withdrawn input the producer has not submitted yet keeps a cancellation marker, so the later submission is taken back
// out (the page already has the text; the agent must not run it as well).
{
  const { port, runtime, ledger } = make([{ id: "a", text: "one" }], new Map());
  assert.equal((await withdrawInputs(port)).restored.length, 1);
  assert.deepEqual(await acknowledgeInputs(port, ["a"]), ["a"]);
  assert.equal(ledger.get("a")?.state, "cancelled");
  assert.deepEqual(await pendingInputs(port), [], "a cancellation marker is not a pending input");
  assert.equal((await withdrawInputs(port)).restored.length, 0, "a cancelled input is never restored again");
  runtime.set("a", "queued");
  await afterSubmit(port, "a");
  assert.equal(runtime.get("a"), "aborted");
  assert.equal(ledger.has("a"), false, "the marker goes once the producer can no longer resurrect the input");
}

// W9: a marker whose input the runtime never took stays; one the runtime already aborted is swept.
{
  const { port, ledger } = make([{ id: "a", text: "one", state: "cancelled" }], new Map());
  await pendingInputs(port);
  assert.equal(ledger.has("a"), true);
  const done = make([{ id: "b", text: "two", state: "cancelled" }], new Map([["b", "aborted"]]));
  await pendingInputs(done.port);
  assert.equal(done.ledger.has("b"), false);
}

// W10: a crash between the withdrawn mark and the abort leaves the runtime queue holding the input; recovery finishes the abort before it
// offers the text, so it is never restored and executing at once.
{
  const { port, runtime } = make([{ id: "a", text: "one", state: "withdrawn" }], new Map([["a", "queued"]]));
  const pending = await pendingInputs(port);
  assert.equal(runtime.get("a"), "aborted");
  assert.equal(pending[0].state, "withdrawn");
  assert.equal((await withdrawInputs(port)).restored.length, 1);
}
{
  // The abort lost the race to a turn: the input was taken, so it is kept, not restored.
  const { port, ledger } = make([{ id: "a", text: "one", state: "withdrawn" }], new Map([["a", "queued"]]));
  port.abort = async () => (runtime0.set("a", "taken"), []);
  const runtime0 = new Map([["a", "queued"]]);
  port.status = async (ids) => new Map(ids.map((id) => [id, runtime0.get(id) ?? "unsent"]));
  const result = await withdrawInputs(port);
  assert.deepEqual(result.restored, []);
  assert.equal(ledger.has("a"), false);
}
{
  // The runtime refuses to abort it: it stays queued, not restored.
  const { port, ledger } = make([{ id: "a", text: "one", state: "withdrawn" }], new Map([["a", "queued"]]));
  port.abort = async () => [];
  const result = await withdrawInputs(port);
  assert.deepEqual(result.restored, []);
  assert.equal(ledger.get("a").state, "queued");
}
console.log("owner-input-queue-unit: ok");
