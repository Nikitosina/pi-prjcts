// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases: status-dots-failures.md.
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, createWriteStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const artifacts = process.env.ARTIFACT_DIR || join(repo, "artifacts", `status-dots-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `status-dots-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace"),
  agentDir = join(root, "agent");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error("Clear runtime overrides first");
for (const dir of [artifacts, root, home, workspace, agentDir, join(root, "userhome")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const fixtureAt = Date.now();
const elizaFixture = {
  account: "fixture-account",
  pool: "",
  usage: {
    all: { stats: { monthly: { requests: 8, cost: 12.34 } } },
    "chain:top_opensource": { stats: { monthly: { requests: 2, cost: 0.005 } } },
  },
};
const kimiFixture = [
  { window: "5h", usedPercent: 48.49, resetsAt: fixtureAt + 2 * 3600e3 },
  { window: "mo", usedPercent: 27.03, resetsAt: fixtureAt + 20 * 86400e3 },
];
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
let releaseHold;
const hold = new Promise((ok) => {
  releaseHold = ok;
});
let releaseHold2;
const hold2 = new Promise((ok) => {
  releaseHold2 = ok;
});
const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) =>
  chunk(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    null,
  ) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";
const say = (text) => chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
const model = createServer((req, res) => {
  req.setEncoding("utf8");
  let body = "";
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", async () => {
    const input = JSON.parse(body),
      msgs = input.messages;
    const coordinator = (input.tools ?? []).some((tool) => tool.function?.name === "agents");
    const lastUser = msgs.findLastIndex((m) => m.role === "user");
    const userText = String(
      typeof msgs[lastUser]?.content === "string" ? msgs[lastUser].content : JSON.stringify(msgs[lastUser]?.content ?? ""),
    );
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? "none";
    const stage = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length;
    result.calls.push({ at: Date.now(), coordinator, marker, stage });
    const reply = (text) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(text);
    };
    if (coordinator && /^\[(worker|scout|reviewer) /.test(userText)) return reply(say(`Scout finished. Summary of ${marker}.`));
    if (coordinator && marker === "MARK-COORDFAIL") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Fake coordinator failure" } }));
      return;
    }
    if (coordinator) {
      if (marker === "MARK-SCOUT" && stage === 0)
        return reply(
          call("agents", {
            action: "spawn",
            role: "scout",
            title: "MARK-SCOUTTASK survey the UI files",
            brief: "MARK-SCOUTTASK survey the UI files",
            acceptance: ["it works"],
            requestId: randomUUID(),
          }),
        );
      if (marker === "MARK-FAIL" && stage === 0)
        return reply(
          call("agents", {
            action: "spawn",
            role: "worker",
            title: "MARK-FAILTASK will fail",
            brief: "MARK-FAILTASK will fail",
            acceptance: ["it works"],
            requestId: randomUUID(),
          }),
        );
      if (marker === "MARK-HOLD" && stage === 0)
        return reply(
          call("agents", {
            action: "spawn",
            role: "worker",
            title: "MARK-HOLDTASK waits",
            brief: "MARK-HOLDTASK waits",
            acceptance: ["it works"],
            requestId: randomUUID(),
          }),
        );
      if (marker === "MARK-HOLDTWO" && stage === 0)
        return reply(
          call("agents", {
            action: "spawn",
            role: "worker",
            title: "MARK-HOLDTWOTASK waits",
            brief: "MARK-HOLDTWOTASK waits",
            acceptance: ["it works"],
            requestId: randomUUID(),
          }),
        );
      if (marker === "MARK-BADTOOL" && stage === 0) return reply(call("agents", { action: "bogus" }));
      return reply(say(`Answer ${marker}.`));
    }
    if (marker === "MARK-SCOUTTASK")
      return reply(say("REPORT-BODY finding one\n\n1. **First** issue `web/app.js:1`\n\n2. Second issue\n\n3. Third issue"));
    if (marker === "MARK-FAILTASK") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Fake invalid request" } }));
      return;
    }
    if (marker === "MARK-HOLDTWOTASK") {
      await hold2;
      return reply(say("Hold two done"));
    }
    if (marker === "MARK-HOLDTASK") {
      await hold;
      return reply(say("Hold done"));
    }
    return reply(say(`Worker ${marker}`));
  });
});
await new Promise((ok) => model.listen(0, "127.0.0.1", ok));
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: "fake",
        api: "openai-completions",
        models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
      },
    },
  }),
);
const socket = join(
  tmpdir(),
  `pi-projects-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}.sock`,
);
// Fake Cursor: the browser-login poll answers 404 once, then hands out a session token; the dashboard serves a usage summary.
const cursorJwt = `x.${Buffer.from(JSON.stringify({ sub: "auth0|e2e", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
const cursorSeen = { polls: [], summary: [] };
const cursor = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/auth/poll") {
    cursorSeen.polls.push(Object.fromEntries(url.searchParams));
    if (cursorSeen.polls.length < 2) {
      res.statusCode = 404;
      return res.end("{}");
    }
    return res.end(JSON.stringify({ accessToken: cursorJwt, refreshToken: "refresh-e2e" }));
  }
  if (url.pathname === "/api/usage-summary") {
    cursorSeen.summary.push(req.headers.cookie ?? "");
    return res.end(
      JSON.stringify({
        billingCycleEnd: new Date(Date.now() + 9 * 86400_000).toISOString(),
        individualUsage: { plan: { enabled: true, totalPercentUsed: 61.5 } },
      }),
    );
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((ok) => cursor.listen(0, "127.0.0.1", ok));
const env = {
  ...process.env,
  PI_PROJECTS_CURSOR_DASHBOARD: `http://127.0.0.1:${cursor.address().port}`,
  PI_PROJECTS_CURSOR_API: `http://127.0.0.1:${cursor.address().port}`,
  HOME: join(root, "userhome"),
  PI_PROJECTS_HOME: home,
  PI_PROJECTS_HOST: "1",
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_PROJECTS_LIMITS_FIXTURE: join(root, "limits.json"),
};
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const log = createWriteStream(join(artifacts, "host.log"), { flags: "wx", mode: 0o600 });
const host = spawn(process.execPath, [join(repo, "src/host.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.pipe(log, { end: false });
host.stderr.pipe(log, { end: false });
let hostEnded = false;
const hostExit = new Promise((ok) =>
  host.once("exit", () => {
    hostEnded = true;
    ok();
  }),
);
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method: input ? "POST" : "GET",
        path: input ? "/api" : "/health",
        headers: input ? { "content-type": "application/json" } : {},
        timeout: 60000,
      },
      (res) => {
        res.setEncoding("utf8");
        let text = "";
        res.on("data", (part) => {
          text += part;
        });
        res.on("end", () => {
          try {
            const reply = JSON.parse(text);
            if (!reply.ok) throw Error(reply.error);
            resolve(reply.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = 600) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw Error(description);
}

let chrome,
  cdpEnded = false,
  cdpId = 0,
  buffer = "";
const pending = new Map();
function startChrome() {
  const clog = createWriteStream(join(artifacts, "chrome.log"), { flags: "wx", mode: 0o600 });
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--user-data-dir=${join(root, "chrome-profile")}`,
      "--remote-debugging-pipe",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );
  chrome.stdout.pipe(clog);
  chrome.stderr.pipe(clog);
  chrome.once("exit", () => {
    cdpEnded = true;
  });
  chrome.stdio[4].on("data", (part) => {
    buffer += part.toString();
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!text) continue;
      const msg = JSON.parse(text);
      if (msg.id) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.method === "Runtime.exceptionThrown")
        result.errors.push(redact(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
      else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") result.errors.push(redact(msg.params.entry.text));
      else if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
        const u = new URL(msg.params.response.url);
        const entry = { url: u.origin + u.pathname, status: msg.params.response.status };
        result.httpErrors.push(entry);
        send("Network.getRequestPostData", { requestId: msg.params.requestId }, msg.sessionId).then(
          (r) => {
            const post = JSON.parse(r.postData);
            entry.action = post.action;
            entry.id = post.id;
            entry.at = Date.now() - fixtureAt;
          },
          () => {},
        );
        send("Network.getResponseBody", { requestId: msg.params.requestId }, msg.sessionId).then(
          (r) => {
            entry.body = r.body.slice(0, 200);
          },
          () => {},
        );
      }
    }
  });
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const key = ++cdpId;
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(key, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}
async function evaluate(expression, session) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.exceptionDetails) throw Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
  return r.result.value;
}
async function shot(name, session) {
  const image = await send("Page.captureScreenshot", { format: "png" }, session);
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
}
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expression, session)) return;
    await delay(250);
  }
  throw Error(`Timed out waiting for ${label}`);
}

const settle = async (id, job) =>
  eventually(async () => {
    const view = await rpc({ action: "show", id });
    const found = view.jobs.find((j) => j.id === job.id);
    return ["done", "failed", "interrupted"].includes(found?.state) && found;
  }, "Job did not settle");
const lastReply = async (id) => (await rpc({ action: "show", id })).messages.findLast((m) => m.role === "assistant")?.text ?? "";
// Jobs and loose agents (scouts, reviewers) in one list shaped like the old work items.
const workOf = async (id) => {
  const snap = await rpc({ action: "jobs-snapshot", id });
  return [
    ...snap.jobs.map((j) => ({
      text: j.title,
      status: j.status === "running" ? "running" : j.status === "failed" ? "failed" : "completed",
      threadId: j.id,
    })),
    ...snap.agents
      .filter((a) => a.jobId === null)
      .map((a) => ({ text: a.title, status: a.endedAt === null ? "running" : "completed", threadId: a.id })),
  ];
};
const workFor = async (id, task) => eventually(async () => (await workOf(id)).find((w) => w.text.startsWith(task)), `work ${task} missing`);
const terminal = async (id, task, status) =>
  eventually(async () => {
    const w = (await workOf(id)).find((w) => w.text.startsWith(task));
    return w?.status === status && w;
  }, `work ${task} not ${status}`);
const scrollInfo = (s) =>
  evaluate(
    `(() => { const t = document.querySelector('#transcript'); return { top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight, height: t.scrollHeight }; })()`,
    s,
  );
const box = (sel, s) =>
  evaluate(
    `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, visible: !!(r.width || r.height) && getComputedStyle(n).visibility !== 'hidden' }; })()`,
    s,
  );
const states = (s) =>
  evaluate(
    `Object.fromEntries([...document.querySelectorAll('#tree .tree-project.selected [data-chat]')].map(n => [n.querySelector('.name').innerText, n.querySelector('.unread') ? 'done' : (n.querySelector('.dot').className.match(/working|needs|idle/) ?? ['?'])[0]]))`,
    s,
  );
let s;
const click = (sel, s) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`, s);
try {
  writeFileSync(
    join(root, "limits.json"),
    JSON.stringify({
      claude: [
        { window: "5h", usedPercent: 42, resetsAt: fixtureAt + 2 * 3600e3 + 17 * 60e3 },
        { window: "7d", usedPercent: 24, resetsAt: fixtureAt + 3 * 86400e3 },
      ],
      codex: [{ window: "7d", usedPercent: 3, resetsAt: fixtureAt + 5 * 86400e3 }],
      eliza: elizaFixture,
      kimi: kimiFixture,
    }),
  );
  await eventually(async () => {
    if (hostEnded) throw Error("Host exited");
    try {
      return (await rpc()).pid === host.pid;
    } catch {
      return false;
    }
  }, "Owned host did not start");
  const project = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "Polish UI",
    cwd: workspace,
    objective: "Disposable status fixture",
    model: "fake/fake-model",
  });
  const id = project.id;
  result.projectId = id;
  const other = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "Other Project",
    cwd: workspace,
    objective: "Second project for the sidebar",
    model: "fake/fake-model",
  });
  const otherSettings = await rpc({ action: "settings-snapshot", id: other.id });
  await rpc({
    action: "settings-update",
    id: other.id,
    confirm: other.id,
    expectedRevision: otherSettings.revision,
    changes: { models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" } },
  });
  const settings = await rpc({ action: "settings-snapshot", id });
  await rpc({
    action: "settings-update",
    id,
    confirm: id,
    expectedRevision: settings.revision,
    changes: { models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" } },
  });
  const chatOf = (title) => rpc({ action: "chat-create", id, title });
  const scoutChat = await chatOf("Scout"),
    failChat = await chatOf("Failing");
  await chatOf("Idle");
  await rpc({ action: "message", id, chatId: failChat.id, text: "MARK-COORDFAIL" });
  await eventually(
    async () => (await rpc({ action: "show", id })).chats.find((chat) => chat.id === failChat.id)?.attention,
    "coordinator failure not flagged",
  );

  // The inbox at `/` (classic chat tabs, sidebar and limits bar retired 2026-11-04): dots live in `#tree`.
  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", id);
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true }));
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  const chatRow = (chat) => `#tree .tree-project.selected .tree-chat[data-chat="${chat}"]`;
  const headDot = (project) => `#tree .tree-head[data-project="${project}"] .dot`;
  await waitFor(`document.querySelectorAll('#tree .tree-project.selected [data-chat]').length === 4`, s, "chats loaded");
  await waitFor(`!!document.querySelector('${chatRow(failChat.id)} .dot.needs')`, s, "red dot");

  // Scout finishes while this browser is looking at Main: it is marked unread.
  await rpc({ action: "message", id, chatId: scoutChat.id, text: "MARK-SCOUT" });
  await waitFor(`!!document.querySelector('${chatRow(scoutChat.id)} .unread')`, s, "unread mark after the scout chat finished");
  // Main starts a worker that keeps running (the scout finished first: workers of other roles queue behind it).
  await settle(id, await rpc({ action: "message", id, text: "MARK-HOLD" }));
  await eventually(async () => (await workFor(id, "MARK-HOLDTASK")).status === "running", "hold not running");
  await waitFor(`!!document.querySelector('${chatRow("main")} .dot.working')`, s, "working dot");
  const dots = await states(s);
  const expected = { Main: "working", Scout: "done", Failing: "needs", Idle: "idle" };
  if (JSON.stringify(dots) !== JSON.stringify(expected)) throw Error("Chat dot states wrong: " + JSON.stringify(dots));
  result.checks.push("D1 one dot per chat: working (Main), unread (Scout), needs you (Failing), idle (Idle)");
  const labels = await evaluate(
    `[...document.querySelectorAll('#tree .tree-project.selected [data-chat] .dot:not(.idle)')].map(n => ({ cls: n.className, label: n.getAttribute('aria-label') }))`,
    s,
  );
  if (labels.length !== 2 || labels.some((item) => !/^(working|needs you)$/.test(item.label ?? "")))
    throw Error("Dot labels wrong: " + JSON.stringify(labels));
  result.checks.push("D2 working and needs-you dots say their state in words (aria-label); unread says so too");
  const pulse = await evaluate(`getComputedStyle(document.querySelector('${chatRow("main")} .dot.working')).animationName`, s);
  if (!pulse || pulse === "none") throw Error("Working dot does not pulse: " + pulse);
  result.checks.push("D4 the working dot pulses");
  await shot("01-tree-dots", s);

  // The open project's head folds its chats (red wins); another project's head comes from the list summary.
  await waitFor(`!!document.querySelector('${headDot(id)}.needs')`, s, "open project head red");
  result.checks.push("S1 the open project row shows red when any chat needs you");
  await click(`#tree .tree-head[data-project="${other.id}"]`, s);
  await waitFor(
    `document.querySelector('#tree .tree-project.selected .tree-head')?.dataset.project === '${other.id}'`,
    s,
    "switched project",
  );
  await waitFor(`!!document.querySelector('${headDot(id)}.needs')`, s, "list-summary dot on the other project");
  result.checks.push("S2 a project that is not open gets its dot from the list summary (no runtime opened)");
  // Live state survives leaving a project: start work in Other Project (A), go back to Polish UI (B); A keeps working, then turns red when a turn fails.
  await rpc({ action: "message", id: other.id, text: "MARK-HOLDTWO" });
  await eventually(
    async () => (await workOf(other.id)).find((w) => w.text.startsWith("MARK-HOLDTWOTASK"))?.status === "running",
    "second hold not running",
  );
  await waitFor(`!!document.querySelector('${headDot(other.id)}.working')`, s, "A working while open");
  await click(`#tree .tree-head[data-project="${id}"]`, s);
  await waitFor(`document.querySelector('#tree .tree-project.selected .tree-head')?.dataset.project === '${id}'`, s, "switched to B");
  await delay(1500);
  if (!(await evaluate(`!!document.querySelector('${headDot(other.id)}.working')`, s)))
    throw Error("Row of the project left behind lost its working state");
  await shot("02-other-project-working-while-away", s);
  result.checks.push("S2b a project you left keeps its working dot while another project is open");
  releaseHold2();
  await waitFor(`!document.querySelector('${headDot(other.id)}.working')`, s, "A stops working after finishing while B is open");
  result.checks.push("S2c ...and stops working when its work finishes while you are elsewhere");
  await rpc({ action: "message", id: other.id, text: "MARK-COORDFAIL" });
  await waitFor(`!!document.querySelector('${headDot(other.id)}.needs')`, s, "A turns red after a failed turn while B is open");
  result.checks.push("S2d ...and turns red when a coordinator turn fails while you are elsewhere");

  // Opening a chat clears its unread mark.
  await click(chatRow(scoutChat.id), s);
  await waitFor(`document.querySelector('#tree .tree-chat.current')?.dataset.chat === '${scoutChat.id}'`, s, "scout chat open");
  await click(chatRow("main"), s);
  await waitFor(
    `document.querySelector('#tree .tree-chat.current')?.dataset.chat === 'main' && !document.querySelector('${chatRow(scoutChat.id)} .unread')`,
    s,
    "unread cleared after opening",
  );
  result.checks.push("D5 opening a chat clears its unread mark (stays clear after leaving)");

  // Worker view: the Workers list opens the worker in the center; Back returns to the chat.
  await waitFor(`!!document.querySelector('#workers .worker.working [data-open-worker]')`, s, "running worker row");
  await click("#workers .worker.working [data-open-worker]", s);
  await waitFor(
    `!!document.querySelector('#focus-view #worker-feed') && !!document.querySelector('#focus-view .worker-send')`,
    s,
    "worker view",
  );
  const view = await evaluate(
    `(() => { const v = document.querySelector('#focus-view'); return { back: !!v.querySelector('[data-cmd="leave-focus"]'), composer: !!v.querySelector('.worker-send textarea'), title: v.querySelector('h1')?.innerText ?? '' }; })()`,
    s,
  );
  if (!view.back || !view.composer || !view.title.includes("MARK-HOLDTASK")) throw Error("Worker view incomplete: " + JSON.stringify(view));
  result.checks.push("V1 clicking a worker opens the worker view: title, Back, conversation and composer");
  await shot("05-worker-view", s);
  await click('#focus-view [data-cmd="leave-focus"]', s);
  await waitFor(`!document.querySelector('#focus-view #worker-feed') && !!document.querySelector('#feed .turn')`, s, "Back to the chat");
  result.checks.push("V2 Back returns to the coordinator chat");

  // Narrow.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  await waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#feed .turn')`, s, "narrow load");
  await delay(500);
  if ((await evaluate(`document.scrollingElement.scrollWidth`, s)) > 391) throw Error("Narrow view overflows");
  result.checks.push("N1 390px: no horizontal overflow");
  await shot("08-narrow-390", s);
  await waitFor(`!!document.querySelector('#workers .worker.working [data-open-worker]')`, s, "narrow worker row");
  await evaluate(`document.querySelector('#workers .worker.working [data-open-worker]').click()`, s);
  await waitFor(`!!document.querySelector('#focus-view #worker-feed')`, s, "narrow worker view");
  if ((await evaluate(`document.scrollingElement.scrollWidth`, s)) > 391) throw Error("Narrow worker view overflows");
  await shot("09-narrow-worker-view", s);
  result.checks.push("N2 390px worker view fits the screen");
  if (result.errors.length || result.httpErrors.length)
    throw Error("Browser errors captured: " + JSON.stringify({ errors: result.errors, http: result.httpErrors }));
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
  try {
    if (s) await shot("failure", s);
  } catch {}
  try {
    const state = await rpc({ action: "show", id: result.projectId });
    result.chatsAtFailure = state.chats;
    result.workAtFailure = (await workOf(result.projectId)).map((w) => ({
      text: w.text.slice(0, 24),
      status: w.status,
      chat: w.chatConversationId,
      endedAt: w.endedAt,
    }));
  } catch {}
} finally {
  releaseHold?.();
  if (chrome && !cdpEnded) {
    try {
      await send("Browser.close");
    } catch {}
    await delay(500);
    if (!cdpEnded) chrome.kill("SIGTERM");
  }
  try {
    if (!hostEnded) {
      await rpc({ action: "shutdown" });
      await Promise.race([hostExit, delay(10000)]);
    }
  } catch {
    host.kill("SIGKILL");
  }
  if (!hostEnded) host.kill("SIGKILL");
  model.closeAllConnections();
  model.close();
  cursor.closeAllConnections();
  cursor.close();
  log.end();
  save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== "passed") process.exitCode = 1;
