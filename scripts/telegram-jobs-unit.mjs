import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  editFault = null,
  gate = null,
  commandFaults = ["502", "429", "network"],
  topicsFlag = false,
  nextThread = 900;
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
  const entry = { method, input };
  calls.push(entry);
  if (method === "setMyCommands" && commandFaults.length) {
    const fault = commandFaults.shift();
    if (fault === "network") return req.socket.destroy();
    return reply(
      fault === "429"
        ? { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 0 } }
        : { ok: false, error_code: 502, description: "Bad Gateway" },
      Number(fault),
    );
  }
  if (method === "editMessageText" && editFault === "network") {
    editFault = null;
    return req.socket.destroy();
  }
  if (method === "editMessageText" && editFault) {
    const description = editFault;
    editFault = null;
    return reply({ ok: false, error_code: 400, description }, 400);
  }
  if (gate?.method === method) {
    const { run } = gate;
    gate = null;
    await run();
  }
  if (method === "getMe") return reply({ ok: true, result: { id: 1, username: "b", has_topics_enabled: topicsFlag } });
  if (method === "createForumTopic") return reply({ ok: true, result: { message_thread_id: ++nextThread } });
  entry.id = method === "sendMessage" ? ++nextId : undefined;
  reply({ ok: true, result: method === "sendMessage" ? { message_id: entry.id } : true });
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
let dispatch = async () => ({}),
  chatList = [];
const bridge = startTelegram({
  dispatch: (input) => dispatch(input),
  chats: async () => chatList,
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
  // Slash command suggestions: registered for private chats only, retried after Bot API failures, then left alone (idempotent).
  const registered = () => calls.filter((c) => c.method === "setMyCommands");
  await until(() => registered().length >= 4);
  await sleep(400);
  assert.equal(registered().length, 4, "three failures are retried, then exactly one success and no repeat");
  const { commands, scope } = registered().at(-1).input;
  assert.deepEqual(scope, { type: "all_private_chats" });
  assert.deepEqual(
    commands.map((c) => c.command),
    ["projects", "project", "chats", "chat", "status", "models", "model"],
  );
  for (const c of commands) assert.ok(c.description.length >= 1 && c.description.length <= 256, c.command);
  assert.ok(!calls.some((c) => c.method === "sendMessage"), "registering commands never messages anyone");
  calls = [];

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
  // 46: a network failure never rejects progress (the host calls it fire-and-forget); the next update edits again.
  editFault = "network";
  await bridge.progress(plan(["done", "done", "todo"]));
  await bridge.progress(plan(["done", "done", "doing"]));
  assert.deepEqual(
    calls.slice(-2).map((c) => c.method),
    ["editMessageText", "editMessageText"],
  );
  assert.equal((await bridge.snapshot()).deliveryErrors.at(-1)?.method, "editMessageText");
  // A replaced owner never gets an edit of the old account's progress message, and a send in flight for the old owner is not attributed to the new one.
  let pairingUpdate = 10;
  const repair = async (chatId, name) => {
    bridge.unpair();
    const { code } = (await bridge.pair()).pairing;
    updates.push({
      update_id: ++pairingUpdate,
      message: {
        message_id: pairingUpdate,
        chat: { id: chatId, type: "private", first_name: name },
        from: { id: chatId },
        text: `/start ${code}`,
      },
    });
    await until(() => JSON.parse(readFileSync(join(root, "telegram.json"))).owner?.chatId === chatId);
    await until(() => calls.some((c) => c.input.chat_id === chatId && String(c.input.text).startsWith("Paired")));
  };
  const progressFor = (jobId, title) => ({
    projectId: "p",
    chatId: "main",
    jobId,
    title,
    steps: [{ title: "Step", status: "doing", estimateMin: 5 }],
  });
  calls = [];
  const idBeforePairing = nextId;
  await repair(77, "Second");
  const routedAfterPairing = JSON.parse(readFileSync(join(root, "telegram.json"))).messages;
  assert(
    Object.keys(routedAfterPairing).every((id) => Number(id) > idBeforePairing),
    "old account routes are dropped on a new pairing",
  );
  calls = [];
  await bridge.progress(plan(["done", "done", "todo", "todo"]));
  assert.deepEqual(
    calls.map((c) => [c.method, c.input.chat_id]),
    [["sendMessage", 77]],
    "the old account's message id is never edited in the new chat",
  );
  const progressed = JSON.parse(readFileSync(join(root, "telegram.json")));
  assert.equal(progressed.progress.j1.chatId, 77);
  gate = { method: "sendMessage", run: () => repair(88, "Third") };
  calls = [];
  await bridge.progress(progressFor("j2", "Stale job"));
  const afterStale = JSON.parse(readFileSync(join(root, "telegram.json")));
  assert.equal(afterStale.owner.chatId, 88);
  assert.equal(afterStale.progress.j2, undefined, "a completion for the old owner records no progress for the new one");
  const staleId = calls.find((c) => c.method === "sendMessage" && c.input.text.includes("Stale job"));
  assert.equal(staleId.input.chat_id, 77);
  assert.equal(afterStale.messages[String(staleId.id)], undefined, "its message id is not routed for the new account");
  await repair(OWNER, "Owner");
  calls = [];
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

  // /status: the route (or its absence) plus one owner-requested limits refresh through dispatch.
  const now = Date.now(),
    dispatched = [],
    provider = (id, label, extra) => ({
      provider: id,
      label,
      samples: [],
      status: "no-data",
      reason: null,
      lastAttemptAt: null,
      nextAttemptAt: null,
      ...extra,
    });
  let snapshot = {
    providers: [
      provider("claude", "Claude", {
        status: "ok",
        samples: [
          {
            provider: "claude",
            window: "5h",
            usedPercent: 41.6,
            resetsAt: now + (2 * 60 + 10) * 60_000,
            observedAt: now,
            source: "endpoint",
          },
          { provider: "claude", window: "7d", usedPercent: 12, resetsAt: null, observedAt: now, source: "endpoint" },
        ],
      }),
      provider("codex", "Codex", {
        status: "ok",
        samples: [{ provider: "codex", window: "7d", usedPercent: 88, resetsAt: null, observedAt: now - 45 * 60_000, source: "endpoint" }],
        reason: "Codex rate limited the usage request",
        nextAttemptAt: now + 3 * 60_000,
      }),
      provider("cursor", "Cursor", { reason: "x".repeat(6000) }),
      provider("eliza", "Eliza", {
        status: "ok",
        usage: { amountUsd: 12.3, periodStartAt: now - 86400e3, periodEndAt: now + 86400e3, account: "a", pool: null, observedAt: now },
      }),
      provider("kimi", "Kimi", { status: "unavailable", reason: "Kimi rejected the sign-in (HTTP 401)" }),
    ],
    visibility: { claude: true, codex: true, cursor: true, eliza: true, kimi: false },
    observedAt: now,
  };
  dispatch = async (input) => {
    dispatched.push(input.action);
    if (input.action === "limits-refresh" || input.action === "limits-snapshot") return snapshot;
    return {};
  };
  let updateId = 100;
  const status = async () => {
    const before = calls.length;
    updates.push({ update_id: ++updateId, message: { message_id: updateId, chat: { id: OWNER, type: "private" }, text: "/status" } });
    const sent = await until(() => calls.slice(before).find((c) => c.method === "sendMessage"));
    return sent.input;
  };
  calls = [];
  let reply = await status();
  assert.deepEqual(dispatched, ["limits-refresh"], "one explicit refresh per /status");
  assert.equal(reply.parse_mode, undefined);
  assert.ok(reply.text.length <= 4096);
  assert.match(reply.text, /No project picked: \/projects\./);
  assert.match(reply.text, /Claude: 5h 42% · resets in 2h 1\dm; 7d 12%/);
  assert.match(reply.text, /Codex: 7d 88% \(45m old\) · Codex rate limited the usage request · retry in 3m/);
  assert.match(reply.text, /Cursor: no data · x+…/);
  assert.match(reply.text, /Eliza: \$12\.30 this period · resets in 1d/);
  assert.doesNotMatch(reply.text, /Kimi/);
  assert.doesNotMatch(reply.text, /Cursor[^\n]*\d%|Cursor[^\n]*\$/);

  // With a route: the route line stays first. Hidden-everything and a failed refresh still answer.
  chatList = [{ id: "main", title: "Main" }];
  updates.push({ update_id: ++updateId, message: { message_id: updateId, chat: { id: OWNER, type: "private" }, text: "/project Notify" } });
  await until(() => texts().some((t) => t.startsWith("Now talking to Notify")));
  snapshot = { ...snapshot, visibility: { claude: false, codex: false, cursor: false, eliza: false, kimi: false } };
  reply = await status();
  assert.match(reply.text, /^Text goes to Notify · Main\./);
  assert.match(reply.text, /hidden/i);
  dispatched.length = 0;
  dispatch = async (input) => {
    dispatched.push(input.action);
    if (input.action === "limits-refresh") throw new Error("host busy");
    return { ...snapshot, visibility: { ...snapshot.visibility, kimi: true } };
  };
  reply = await status();
  assert.deepEqual(dispatched, ["limits-refresh", "limits-snapshot"]);
  assert.match(reply.text, /Refresh failed: host busy/);
  assert.match(reply.text, /Kimi: unavailable · Kimi rejected the sign-in/);
  dispatch = async () => {
    throw new Error("host down");
  };
  reply = await status();
  assert.match(reply.text, /^Text goes to Notify · Main\./);
  assert.match(reply.text, /Limits unavailable: host down/);
  // 62: with topics on, a Job's progress message and the reply to a button pressed in a topic stay in that chat's topic.
  topicsFlag = true;
  await bridge.setToken("1:fake-token-for-tests-only");
  assert.equal((await bridge.snapshot()).topics, true);
  calls = [];
  await bridge.progress(progressFor("j9", "Topic job"));
  assert.deepEqual(
    calls.map((c) => c.method),
    ["createForumTopic", "sendMessage"],
  );
  assert.equal(calls[0].input.name, "p · Main");
  assert.equal(calls[1].input.message_thread_id, nextThread);
  const progressThread = nextThread;
  notices.push(notice(3, { jobId: "j2", mergeable: true }));
  await bridge.flush();
  const topicNotice = calls.at(-1);
  assert.equal(topicNotice.input.message_thread_id, progressThread, "the notice shares its chat's topic with the progress message");
  assert.equal(calls.filter((c) => c.method === "createForumTopic").length, 1);
  calls = [];
  // The aborted poll of setToken may still be answered by the fake server; let it drain so it does not swallow the update.
  await sleep(200);
  updates.push({
    update_id: ++updateId,
    callback_query: {
      id: "c9",
      from: { id: OWNER },
      message: { message_id: topicNotice.id, message_thread_id: progressThread, chat: { id: OWNER, type: "private" } },
      data: topicNotice.input.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  const pressed = await until(() => calls.find((c) => c.method === "sendMessage"));
  assert.equal(pressed.input.message_thread_id, progressThread, "the reply to a press stays in the topic");
  console.log("telegram-jobs-unit ok");
} finally {
  bridge.close();
  server.close();
  server.closeAllConnections();
}
