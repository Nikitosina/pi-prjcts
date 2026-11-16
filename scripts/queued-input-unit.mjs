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
const { ATTACHMENT_LIMIT, readDraft, persistText, beginSend, finishSend, failSend, recoverSends, restoreInto } =
  await import("../web/queued-input.js");

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
  const sent = beginSend("chat:p:main", { requestId: "r1", text: "one\n\ntyped and more" });
  assert.equal(readDraft("chat:p:main").text, "");
  failSend("chat:p:main", "r1");
  assert.equal(readDraft("chat:p:main").text, "one\n\ntyped and more", "a refused send keeps the text");
  assert.deepEqual(readDraft("chat:p:main").sending, []);
  const again = beginSend("chat:p:main", { requestId: "r2", text: "one\n\ntyped and more" });
  finishSend("chat:p:main", again.requestId);
  assert.equal(readDraft("chat:p:main").text, "");
  void sent;
}

// R1: a send is kept, with its request id, from the moment it starts until the host accepted it. A reload (or the tab closing) while the
// request is lost or rejected finds it again: it is sent once more under the same id (the host takes an id once), or its text is given back.
{
  storage.clear();
  persistText("chat:p:main", "hello");
  beginSend("chat:p:main", { requestId: "r1", text: "hello" });
  // The page is gone; a new page reads what is left.
  const left = readDraft("chat:p:main");
  assert.equal(left.text, "");
  assert.deepEqual(
    left.sending.map((record) => [record.requestId, record.text]),
    [["r1", "hello"]],
  );
  // A new page is a new module instance: nothing is in flight there, whatever the old page had started.
  const { recoverSends: reload } = await import("../web/queued-input.js?page2");
  const seen = [];
  const resent = await reload("chat:p:main", async (record) => void seen.push(record.requestId));
  assert.deepEqual(seen, ["r1"], "the same request id goes out again");
  assert.equal(resent, 1);
  // The page that started a send does not resend it behind its own back.
  beginSend("chat:p:main", { requestId: "r0", text: "pending here" });
  assert.equal(await recoverSends("chat:p:main", async () => assert.fail("an in-flight send is not resent")), 0);
  finishSend("chat:p:main", "r0");
  assert.deepEqual(readDraft("chat:p:main").sending, [], "an accepted resend is done");
  assert.equal(readDraft("chat:p:main").text, "");
  // The host refuses it now: the owner gets the text back in the editor draft instead of losing it.
  beginSend("chat:p:main", { requestId: "r2", text: "again" });
  await reload("chat:p:main", async () => Promise.reject(new Error("offline")));
  assert.equal(readDraft("chat:p:main").text, "again");
  assert.deepEqual(readDraft("chat:p:main").sending, []);
}

// R2: each send owns its text, uploads and origin. A restore that lands while the first send is pending belongs to the next send; finishing or
// failing one send touches only its own.
{
  storage.clear();
  const writeAttachments = (attachments, origin) =>
    localStorage.setItem("pi-ui2-draft:chat:p:main", JSON.stringify({ ...readDraft("chat:p:main"), attachments, origin }));
  persistText("chat:p:main", "first");
  writeAttachments(["f1"], "o1");
  const one = beginSend("chat:p:main", { requestId: "r1", text: "first" });
  assert.deepEqual(one.attachments, ["f1"]);
  assert.equal(one.origin, "o1");
  assert.deepEqual(readDraft("chat:p:main").attachments, [], "the pending send took its uploads with it");
  writeAttachments(["g1"], "o2");
  persistText("chat:p:main", "second");
  const two = beginSend("chat:p:main", { requestId: "r2", text: "second" });
  assert.deepEqual(two.attachments, ["g1"], "the second send does not inherit the first's uploads");
  assert.equal(two.origin, "o2");
  finishSend("chat:p:main", "r1");
  assert.deepEqual(
    readDraft("chat:p:main").sending.map((record) => record.requestId),
    ["r2"],
    "finishing r1 leaves r2 alone",
  );
  failSend("chat:p:main", "r2");
  const draft = readDraft("chat:p:main");
  assert.equal(draft.text, "second");
  assert.deepEqual(draft.attachments, ["g1"], "a failed send gets its own uploads back, only those");
  assert.equal(draft.origin, "o2");
}

// R3: overlapping Alt+Up: the second response carries what the first already restored and acknowledged. One composer restores one at a time and
// remembers what it restored, so the text is added once, also after a reload.
{
  storage.clear();
  const { box, editor } = live();
  const stale = [item("a", "one")];
  const [first, second] = await Promise.all([run({ restored: stale, editor }), run({ restored: stale, editor })]);
  assert.equal(box.value, "one", "R3 the same input is not added twice");
  assert.equal(first.count + second.count, 1);
  assert.equal(readDraft("chat:p:main").text, "one");
  const reloaded = live(readDraft("chat:p:main").text);
  const later = await run({ restored: stale, editor: reloaded.editor });
  assert.equal(reloaded.box.value, "one", "R3 a stale response after a reload adds nothing either");
  assert.equal(later.count, 0);
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
