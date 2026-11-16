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
/** What the host's answer for a refusal looks like in the page (web/api.js HostError): the host recorded nothing. */
const refusal = (message) => Object.assign(new Error(message), { refused: true });
const { fresherSettings } = await import("../web/format.js");

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
  await reload("chat:p:main", async () => Promise.reject(refusal("host refused")));
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
// ui2 journey flake (found in the PR53 second pass): a settings read that began before the owner's save finished after it and put the old revision
// back on screen (thinking showed "medium" after "low" was saved). A read never replaces newer settings.
{
  const saved = { revision: 4, thinking: "low" };
  assert.equal(fresherSettings(saved, { revision: 3, thinking: "medium" }), saved, "a stale read is dropped");
  assert.equal(fresherSettings(saved, { revision: 5, thinking: "high" }).thinking, "high", "a newer read wins");
  assert.equal(fresherSettings(saved, { revision: 4, thinking: "low" }).thinking, "low");
  assert.deepEqual(fresherSettings(null, { revision: 1 }), { revision: 1 }, "nothing held yet");
}

// R4 (W20): a send whose record could not be kept is not a send: nothing is cleared, nothing is recorded, the caller sends nothing.
{
  storage.clear();
  persistText("chat:p:main", "keep me");
  failWrites = true;
  const record = beginSend("chat:p:main", { requestId: "n1", text: "keep me", delivery: "steer" });
  failWrites = false;
  assert.equal(record, null, "R4 a refused write gives no record");
  assert.equal(readDraft("chat:p:main").text, "keep me", "R4 the draft still holds the text");
  assert.deepEqual(readDraft("chat:p:main").sending, []);
  assert.equal(await recoverSends("chat:p:main", async () => assert.fail("nothing was recorded, so nothing is resent")), 0);
}

// R5 (W21): the refused send A goes back through the editor, which holds the newer text B. Typing on from the editor keeps A.
{
  storage.clear();
  persistText("chat:p:main", "A text");
  beginSend("chat:p:main", { requestId: "a1", text: "A text", delivery: "steer" });
  const { box, editor } = live("");
  box.value = "B typed meanwhile";
  persistText("chat:p:main", box.value);
  const kind = failSend("chat:p:main", "a1", refusal("paused"), editor);
  assert.equal(kind, "refused");
  assert.equal(box.value, "A text\n\nB typed meanwhile", "R5 the editor shows A in front of B");
  persistText("chat:p:main", box.value + " more");
  assert.equal(readDraft("chat:p:main").text, "A text\n\nB typed meanwhile more", "R5 the next keystroke does not drop A");
  assert.deepEqual(readDraft("chat:p:main").sending, []);
}

// R6 (W22): an unknown outcome is not a refusal. The record keeps its id and payload and goes out again; the host's id check makes it once.
{
  storage.clear();
  persistText("chat:p:main", "hello");
  beginSend("chat:p:main", { requestId: "u1", text: "hello", delivery: "followUp" });
  const { box, editor } = live("");
  for (const lost of [new TypeError("Failed to fetch"), Object.assign(new Error("HTTP 502"), { status: 502 }), new Error("timeout")])
    assert.equal(failSend("chat:p:main", "u1", lost, editor), "unknown");
  assert.equal(box.value, "", "R6 the editor is not given the text back");
  const [kept] = readDraft("chat:p:main").sending;
  assert.deepEqual([kept.requestId, kept.text, kept.delivery], ["u1", "hello", "followUp"]);
  const seen = [];
  assert.equal(
    await recoverSends(
      "chat:p:main",
      async (record) => {
        seen.push([record.requestId, record.text, record.delivery]);
        throw new TypeError("still offline");
      },
      editor,
    ),
    0,
  );
  assert.deepEqual(seen, [["u1", "hello", "followUp"]], "R6 the same id and payload are sent again");
  assert.equal(readDraft("chat:p:main").sending.length, 1, "R6 still unknown: still kept");
  assert.equal(await recoverSends("chat:p:main", async () => {}, editor), 1);
  assert.deepEqual(readDraft("chat:p:main").sending, []);
}

// R7 (W28): messages of different origins never become one message. Only the origin the draft already has (or none) joins.
{
  storage.clear();
  const { box, editor } = live();
  const tg = { ...item("a", "from telegram"), origin: "telegram" },
    web = item("b", "from the web"),
    tg2 = { ...item("c", "telegram again"), origin: "telegram" };
  const first = await run({ restored: [tg, web, tg2], editor });
  assert.deepEqual(first.acked, ["a"], "R7 only the compatible prefix is acknowledged");
  assert.equal(readDraft("chat:p:main").origin, "telegram");
  assert.equal(box.value.includes("from the web"), false);
  assert.match(toasts.at(-1), /origin|Telegram|send the editor first/i, "R7 the held message is told");
}

// R8 (W30): a refused send that cannot join the editor (uploads, origin) stays whole as a refused record; Alt+Up brings it back later.
{
  storage.clear();
  const writeDraftRaw = (patch) =>
    localStorage.setItem("pi-ui2-draft:chat:p:main", JSON.stringify({ ...readDraft("chat:p:main"), ...patch }));
  const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  persistText("chat:p:main", "A text");
  writeDraftRaw({ attachments: ids("x", 6), origin: "telegram" });
  beginSend("chat:p:main", { requestId: "a1", text: "A text", delivery: "steer" });
  persistText("chat:p:main", "B text");
  writeDraftRaw({ attachments: ids("y", 6), origin: "telegram" });
  const { box, editor } = live("B text");
  failSend("chat:p:main", "a1", refusal("nope"), editor);
  const held = readDraft("chat:p:main");
  assert.equal(box.value, "B text", "R8 the editor is not forced past the upload limit");
  assert.equal(held.attachments.length, 6);
  assert.deepEqual(
    held.sending.map((record) => [record.requestId, record.refused === true, record.attachments.length]),
    [["a1", true, 6]],
    "R8 the refused record is kept whole",
  );
  assert.equal(await recoverSends("chat:p:main", async () => assert.fail("a refused record is never resent"), editor), 0);
  // The owner sends the editor; then Alt+Up brings the held record back, with its uploads.
  const sent = beginSend("chat:p:main", { requestId: "b1", text: "B text", delivery: "steer" });
  finishSend("chat:p:main", sent.requestId);
  box.value = "";
  const back = await run({ restored: [], editor });
  assert.equal(back.count, 1, "R8 Alt+Up offers the refused record");
  assert.equal(box.value, "A text");
  assert.equal(readDraft("chat:p:main").attachments.length, 6);
  assert.deepEqual(readDraft("chat:p:main").sending, []);
}

// R9 (W31): the host offers an input whose id is still an unknown send here: it leaves `sending` in the write that puts the text in the draft.
{
  storage.clear();
  persistText("chat:p:main", "dup");
  beginSend("chat:p:main", { requestId: "d1", text: "dup", delivery: "steer" });
  failSend("chat:p:main", "d1", new TypeError("lost"), live().editor);
  const { box, editor } = live();
  const result = await run({ restored: [item("d1", "dup")], editor });
  assert.equal(result.count, 1);
  assert.equal(box.value, "dup");
  assert.deepEqual(readDraft("chat:p:main").sending, [], "R9 one owner for the text");
  assert.equal(await recoverSends("chat:p:main", async () => assert.fail("not resent: it is in the editor now")), 0);
}

// R10 (W29): one restore at a time per surface across tabs: the restore takes a Web Lock named for the surface.
{
  storage.clear();
  const names = [];
  globalThis.navigator = { locks: { request: async (name, work) => (names.push(name), work()) } };
  await run({ restored: [item("z", "locked")], editor: live().editor });
  delete globalThis.navigator;
  assert.deepEqual(names, ["pi-ui2-restore:chat:p:main"], "R10 the restore holds the surface's lock");
}

console.log("queued-input-unit: ok");
