// Unit: the withdraw / acknowledge protocol for the owner's queued inputs (scripts/chat-queue-failures.md, W3-W5). A fake runtime, no host.
import assert from "node:assert/strict";
import { acknowledgeInputs, pendingInputs, serialized, withdrawInputs } from "../src/owner-input-queue.ts";

/** `producers`: ids a producer may still submit (default: every input the runtime has not seen). */
const make = (entries, runtime, producers) => {
  const ledger = new Map(entries.map((entry) => [entry.id, { at: 1, state: "queued", delivery: "followUp", ...entry }]));
  const port = {
    list: async () => [...ledger.values()].map((entry) => ({ ...entry })),
    setState: async (ids, state) => ids.forEach((id) => ledger.has(id) && (ledger.get(id).state = state)),
    remove: async (ids) => ids.forEach((id) => ledger.delete(id)),
    status: async (ids) => new Map(ids.map((id) => [id, runtime.get(id) ?? "unsent"])),
    producing: async (ids) => new Set(ids.filter((id) => (producers ? producers.has(id) : !runtime.has(id)))),
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

// W16: an input its producer has not submitted yet is not the page's to take: the producer's check and its submission are not one step, so a
// restored input could still run. It stays queued (kept) until the runtime has it, then Alt+Up works as usual.
{
  const { port, runtime, ledger } = make([{ id: "a", text: "one" }], new Map());
  const first = await withdrawInputs(port);
  assert.deepEqual(first.restored, [], "W16 nothing is restored while the producer may still submit");
  assert.deepEqual(first.kept, ["a"]);
  assert.equal(ledger.get("a").state, "queued", "W16 the producer's check still sees a queued input and submits it");
  runtime.set("a", "queued");
  const second = await withdrawInputs(port);
  assert.deepEqual(
    second.restored.map((item) => item.id),
    ["a"],
  );
  assert.equal(runtime.get("a"), "aborted");
}
// W16: a producer that is gone (the Host agent after a crash between its ledger write and its submission) can never submit: the input is the page's.
{
  const { port, ledger } = make([{ id: "a", text: "one" }], new Map(), new Set());
  const result = await withdrawInputs(port);
  assert.deepEqual(
    result.restored.map((item) => item.id),
    ["a"],
  );
  assert.deepEqual(await acknowledgeInputs(port, ["a"]), ["a"]);
  assert.equal(ledger.has("a"), false);
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
// P1 (W25): admission, withdrawal and acknowledgment of one surface run one at a time, in call order; another surface is not held up, and a
// failure does not block the next operation.
{
  const order = [];
  const step = (name, ms, fail) => async () => {
    order.push(`start ${name}`);
    await new Promise((ok) => setTimeout(ok, ms));
    order.push(`end ${name}`);
    if (fail) throw new Error(name);
    return name;
  };
  const one = serialized("chat:p:main", step("a", 40, true)),
    two = serialized("chat:p:main", step("b", 5)),
    other = serialized("chat:p:other", step("c", 5));
  await assert.rejects(one, /a/);
  assert.equal(await two, "b");
  assert.equal(await other, "c");
  assert.deepEqual(
    order.filter((line) => /[ab]$/.test(line)),
    ["start a", "end a", "start b", "end b"],
    "P1 one surface runs one operation at a time",
  );
  assert.ok(order.indexOf("end c") < order.indexOf("end a"), "P1 another surface is not held up");
}

console.log("owner-input-queue-unit: ok");
