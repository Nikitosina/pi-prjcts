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
console.log("owner-input-queue-unit: ok");
