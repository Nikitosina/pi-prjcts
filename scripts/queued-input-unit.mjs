// Unit: the page side of Alt+Up (web/queued-input.js). The host withdraws and returns the text; the page keeps it in a per-surface draft that
// survives navigation, reload and a lost acknowledgment, and only then acknowledges (scripts/chat-queue-failures.md, W2-W3, W13-W14).
import assert from "node:assert/strict";

const storage = new Map();
let failWrites = false;
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => {
    if (failWrites) throw new Error("QuotaExceededError");
    storage.set(key, String(value));
  },
  removeItem: (key) => storage.delete(key),
};
const { ATTACHMENT_LIMIT, readDraft, persistText, beginSend, finishSend, failSend, restoreInto } = await import("../web/queued-input.js");

const item = (id, text, attachments = []) => ({ id, text, delivery: "followUp", attachments });
const toasts = [];
const run = async ({ surface = "chat:p:main", restored, editor, acknowledge, kept = [] }) => {
  const acked = [];
  const count = await restoreInto({
    surface,
    editor,
    toast: (message) => toasts.push(message),
    dequeue: async () => ({ restored, kept }),
    acknowledge: async (ids) => {
      if (acknowledge) await acknowledge(ids);
      acked.push(...ids);
    },
  });
  return { count, acked };
};
const live = (value = "") => {
  const box = { value };
  return { box, editor: { live: () => true, read: () => box.value, show: (text) => (box.value = text) } };
};
const gone = { live: () => false, read: () => "stale", show: () => assert.fail("a detached editor must never be written") };

// W13: the response arrives after the owner left the surface: the text is in the draft store before the host forgets it, and the next visit has it.
{
  const { acked } = await run({ restored: [item("a", "one"), item("b", "two")], editor: gone });
  assert.equal(readDraft("chat:p:main").text, "one\n\ntwo");
  assert.deepEqual(acked, ["a", "b"]);
  // A reload: nothing but localStorage is left.
  assert.equal(readDraft("chat:p:main").text, "one\n\ntwo");
  assert.equal(readDraft("chat:p:other").text, "", "another surface has its own draft");
}

// W13: a successful acknowledgment on a live editor still leaves the draft in the store, so a reload keeps it; sending clears it.
{
  storage.clear();
  const { box, editor } = live("typed");
  await run({ restored: [item("a", "one")], editor });
  assert.equal(box.value, "one\n\ntyped");
  assert.equal(readDraft("chat:p:main").text, "one\n\ntyped");
  persistText("chat:p:main", "one\n\ntyped and more");
  assert.equal(readDraft("chat:p:main").text, "one\n\ntyped and more");
  const sent = beginSend("chat:p:main");
  assert.equal(readDraft("chat:p:main").text, "");
  failSend("chat:p:main", "one\n\ntyped and more");
  assert.equal(readDraft("chat:p:main").text, "one\n\ntyped and more", "a refused send keeps the text");
  beginSend("chat:p:main");
  finishSend("chat:p:main", sent);
  assert.equal(readDraft("chat:p:main").text, "");
}

// W3: a lost acknowledgment: the same item offered again is not added twice, and the acknowledgment is retried.
{
  storage.clear();
  const { box, editor } = live();
  let lose = true;
  await assert.rejects(
    run({
      restored: [item("a", "one")],
      editor,
      acknowledge: async () => {
        if (lose) throw new Error("offline");
      },
    }),
    /offline/,
  );
  assert.equal(box.value, "one");
  assert.deepEqual(readDraft("chat:p:main").unacked, ["a"]);
  lose = false;
  const { acked } = await run({ restored: [item("a", "one")], editor, acknowledge: async () => {} });
  assert.equal(box.value, "one", "no duplicate restoration");
  assert.deepEqual(acked, ["a"]);
  assert.deepEqual(readDraft("chat:p:main").unacked, []);
}

// W14: uploads of every restored message ride along; more than one message can send stays queued, never truncated or acknowledged.
{
  storage.clear();
  const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  persistText("chat:p:main", "draft");
  const { editor } = live("draft");
  const first = await run({
    restored: [item("a", "one", ids("x", 4)), item("b", "two", ids("y", 5)), item("c", "three", ids("z", 3))],
    editor,
  });
  const draft = readDraft("chat:p:main");
  assert.deepEqual(first.acked, ["a", "b"]);
  assert.equal(draft.attachments.length, 9);
  assert.equal(draft.attachments.length <= ATTACHMENT_LIMIT, true);
  assert.match(toasts.at(-1), /send the editor first/i, "the held message is told, not dropped");
  assert.equal(draft.text.includes("three"), false);
  // One more message that does not fit: held back and told, nothing acknowledged for it.
  const second = await run({ restored: [item("d", "four", ids("w", 3))], editor });
  assert.deepEqual(second.acked, []);
  assert.equal(readDraft("chat:p:main").attachments.length, 9);
  assert.match(toasts.at(-1), /send the editor first/i);
  assert.equal(readDraft("chat:p:main").text.includes("four"), false);
  // Emptying the editor drops the uploads of the restored messages with their text.
  persistText("chat:p:main", "");
  assert.deepEqual(readDraft("chat:p:main").attachments, []);
}

// A full or blocked store: nothing is acknowledged, so the host keeps the text.
{
  storage.clear();
  failWrites = true;
  const { acked } = await run({ restored: [item("a", "one")], editor: gone });
  failWrites = false;
  assert.deepEqual(acked, []);
  assert.match(toasts.at(-1), /not removed|still queued|kept/i);
}
console.log("queued-input-unit: ok");
