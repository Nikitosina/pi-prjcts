import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Approve button on a mergeable Job's Ready message and the per-Job progress message, against a local fake Bot API.
const root = mkdtempSync(join(tmpdir(), "telegram-jobs-"));
process.env.PI_PROJECTS_HOME = root;
process.env.PI_PROJECTS_TELEGRAM_POLL_S = "1";
process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = "50";
const { startTelegram } = await import("../src/telegram.ts");
const OWNER = 42;
let calls = [],
  updates = [],
  nextId = 100,
  editFault = null;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const method = req.url.split("/").at(-1),
    input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const reply = (value, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(value)));
  if (method === "getUpdates") {
    await sleep(30);
    const batch = updates.splice(0);
    return reply({ ok: true, result: batch });
  }
  calls.push({ method, input });
  if (method === "editMessageText" && editFault) {
    const description = editFault;
    editFault = null;
    return reply({ ok: false, error_code: 400, description }, 400);
  }
  reply({ ok: true, result: method === "sendMessage" ? { message_id: ++nextId } : true });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
process.env.PI_PROJECTS_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
writeFileSync(
  join(root, "telegram.json"),
  JSON.stringify({
    version: 1,
    token: "1:fake-token-for-tests-only",
    bot: { id: 1, username: "b" },
    owner: { chatId: OWNER, name: "Owner" },
    pairing: null,
    offset: 0,
    sentSeq: 0,
    route: null,
    keys: {},
    messages: {},
    lastError: null,
    lastPollAt: null,
  }),
);
let notices = [],
  approvals = [],
  approveResult = async () => ({ kind: "accepted", head: "a".repeat(40) });
const bridge = startTelegram({
  dispatch: async () => ({}),
  chats: async () => [],
  notifier: { seq: () => notices.length, feed: (after) => ({ items: notices.filter((n) => n.seq > after) }) },
  approve: (projectId, jobId) => (approvals.push([projectId, jobId]), approveResult()),
  report: () => {},
});
const notice = (seq, extra) => ({
  seq,
  at: 0,
  projectId: "p",
  project: "P",
  chatId: "main",
  chat: "Main",
  kind: "result",
  title: "Finished",
  text: "Ready",
  ...extra,
});
const until = async (check) => {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("timed out");
};
const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.input.text);
try {
  // Not mergeable: plain Ready message. Mergeable: Approve button.
  notices = [notice(1, { jobId: "j1", mergeable: false })];
  await bridge.flush();
  assert.equal(calls.at(-1).input.reply_markup, undefined);
  notices.push(notice(2, { jobId: "j1", mergeable: true }));
  await bridge.flush();
  const button = calls.at(-1).input.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, "Approve");

  // Tapping it approves once, acknowledges, clears the button and reports the outcome.
  updates.push({
    update_id: 1,
    callback_query: {
      id: "c1",
      from: { id: OWNER },
      message: { message_id: 5, chat: { id: OWNER, type: "private" } },
      data: button.callback_data,
    },
  });
  await until(() => texts().some((t) => t.startsWith("Merged")));
  assert.deepEqual(approvals, [["p", "j1"]]);
  assert.ok(texts().includes("Approving…"));
  assert.ok(calls.some((c) => c.method === "editMessageReplyMarkup"));

  // A failed approval says why and offers the button again.
  approveResult = async () => {
    throw new Error("PR has conflicts");
  };
  updates.push({
    update_id: 2,
    callback_query: {
      id: "c2",
      from: { id: OWNER },
      message: { message_id: 5, chat: { id: OWNER, type: "private" } },
      data: button.callback_data,
    },
  });
  const failed = await until(() => calls.filter((c) => c.method === "sendMessage").find((c) => c.input.text.startsWith("Approve failed")));
  assert.match(failed.input.text, /conflicts/);
  assert.equal(failed.input.reply_markup.inline_keyboard[0][0].text, "Approve");

  // Progress: one message per Job, edited in place, no edit for identical text, replaced when the owner deleted it.
  calls = [];
  const plan = (statuses) => ({
    projectId: "p",
    chatId: "main",
    jobId: "j1",
    title: "Add login",
    steps: statuses.map((status, i) => ({ title: `Step ${i + 1}`, status, estimateMin: 10 })),
  });
  await bridge.progress(plan(["doing", "todo"]));
  await bridge.progress(plan(["doing", "todo"]));
  await Promise.all([bridge.progress(plan(["done", "doing"])), bridge.progress(plan(["done", "done"]))]);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendMessage", "editMessageText", "editMessageText"],
  );
  const first = calls[0].input.text;
  assert.match(first, /Add login/);
  assert.match(calls[2].input.text, /2\/2 done/);
  assert.equal(calls[1].input.message_id, calls[2].input.message_id);
  editFault = "Bad Request: message to edit not found";
  await bridge.progress(plan(["done", "todo"]));
  assert.deepEqual(
    calls.slice(3).map((c) => c.method),
    ["editMessageText", "sendMessage"],
  );
  editFault = "Bad Request: message is not modified";
  await bridge.progress(plan(["done", "doing"]));
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 2);
  // Mixed-origin batches keep a Telegram reply even when an event is the last input sharing its answer.
  const { saveProject } = await import("../src/state.ts");
  const { startNotifier } = await import("../src/notify.ts");
  const projectId = randomUUID(),
    requestId = randomUUID();
  saveProject({
    version: 1,
    id: projectId,
    name: "Notify",
    cwd: root,
    objective: "test",
    runtime: "durable",
    createdAt: new Date(Date.now() + 60000).toISOString(),
    model: "fake/fake",
    models: {},
    phase: "ready",
    problem: null,
  });
  let active = true;
  const submission = (id, requestId, answerId, text) => ({ id, requestId, answerId, text, status: "done", reason: null });
  const submissions = [
    { ...submission(1, requestId, 10, "Explicit reply"), origin: "telegram" },
    submission(2, "event:follow:latest", 10, "Explicit reply"),
    submission(3, "report:intermediate", 11, "Unsolicited update"),
    submission(4, randomUUID(), 12, "UI reply"),
  ];
  const errors = [];
  const owner = {
    chats: async () => [{ id: "main", title: "Main", conversationId: 1 }],
    prNotices: async () => [],
    jobs: async () => ({
      jobs: [
        { id: "ready", chat: 1, status: "ready", pr: "https://example.invalid/pr/1", candidate: "a".repeat(40), endedAt: 1 },
        ...(active ? [{ id: "busy", chat: 1, status: "running", plan: [] }] : []),
      ],
      agents: [],
    }),
    chatSubmissions: async (_, after) => submissions.filter((item) => item.id > after),
  };
  const openNotifier = () =>
    startNotifier({ owner: () => Promise.resolve(owner), tickMs: 25, onNotice() {}, report: (e) => errors.push(e) });
  let notifier = openNotifier();
  try {
    await until(() => notifier.feed(0).items.length === 1);
    assert.deepEqual(
      notifier.feed(0).items.map((item) => [item.text, item.jobId]),
      [["Explicit reply", undefined]],
    );
    active = false;
    submissions.push(submission(5, "report:final", 13, "Task finished"));
    await until(() => notifier.feed(0).items.length === 2);
    assert.equal(notifier.feed(0).items[1].jobId, "ready");
    await notifier.close();
    notifier = openNotifier();
    await sleep(100);
    assert.equal(notifier.feed(0).items.length, 2, "reopening retains the notice cursor");
    const idleRequest = randomUUID();
    submissions.push({ ...submission(6, idleRequest, 14, "Another explicit reply"), origin: "telegram" });
    await until(() => notifier.feed(0).items.length === 3);
    assert.equal(notifier.feed(0).items[2].jobId, undefined, "idle direct reply does not borrow an old Ready approval");
    assert.deepEqual(errors, []);
  } finally {
    await notifier.close();
  }
  console.log("telegram-jobs-unit ok");
} finally {
  bridge.close();
  server.close();
  server.closeAllConnections();
}
