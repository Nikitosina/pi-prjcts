// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in ui-polish-failures.md before implementation.
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const artifacts = join(repo, "artifacts", `ui-polish-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `ui-polish-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace"),
  agentDir = join(root, "agent");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error("Clear runtime overrides first");
for (const dir of [artifacts, root, home, workspace, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
let releaseHold;
const hold = new Promise((ok) => {
  releaseHold = ok;
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
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: "1", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
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
        result.httpErrors.push({ url: u.origin + u.pathname, status: msg.params.response.status });
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
try {
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
    objective: "Disposable polish fixture",
    model: "fake/fake-model",
  });
  const id = project.id;
  const settings = await rpc({ action: "settings-snapshot", id });
  await rpc({
    action: "settings-update",
    id,
    confirm: id,
    expectedRevision: settings.revision,
    changes: { models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" } },
  });
  const ask = async (text) => {
    const job = await rpc({ action: "message", id, text });
    const done = await settle(id, job);
    if (done.state !== "done") throw Error(`${text} failed: ${done.error}`);
    return lastReply(id);
  };

  await ask("MARK-SCOUT");
  const scout = await terminal(id, "MARK-SCOUTTASK", "completed");
  await eventually(
    async () => (await rpc({ action: "show", id })).messages.some((m) => m.role === "assistant" && m.text.includes("Scout finished")),
    "coordinator summary missing",
  );
  await ask("MARK-FAIL");
  await terminal(id, "MARK-FAILTASK", "failed");
  await ask("MARK-BADTOOL");
  // A user message that merely looks like a report must stay a plain message (failure 3).
  await ask("[worker but not really] MARK-FAKE");
  await ask("MARK-HOLD");
  await eventually(async () => (await workFor(id, "MARK-HOLDTASK")).status === "running", "hold not running");

  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", id);
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  // The inbox at `/` (classic inbox retired 2026-11-04; see ui-polish-failures.md for what moved and what was retired).
  await waitFor(
    `document.body?.dataset.ready === "1" && document.querySelector("#feed").innerText.includes("MARK-FAKE")`,
    s,
    "project loaded",
  );
  await delay(500);
  await shot("01-coordinator", s);

  // Conversation: the owner's text stays the owner's; internal worker reports never show as owner messages.
  const owner = await evaluate(`[...document.querySelectorAll('#feed .msg.owner')].map(n => n.innerText)`, s);
  if (!owner.some((t) => t.includes("[worker but not really] MARK-FAKE")))
    throw Error("Look-alike user message vanished: " + JSON.stringify(owner));
  if (owner.some((t) => /\[(worker|scout|reviewer) [0-9a-f-]{36}/.test(t))) throw Error("Internal report shown as an owner message");
  result.checks.push("C1-C4 the conversation keeps owner text and never shows internal reports as owner messages");
  const stamps = await evaluate(`[...document.querySelectorAll('#feed .msg-meta time')].map(n => n.innerText)`, s);
  if (!stamps.length || stamps.some((t) => /[A-Z][a-z]{2} \d/.test(t))) throw Error("Today timestamps still carry a date: " + stamps);
  result.checks.push("C5 messages from today show time only");

  // Layout
  const page = await evaluate(
    `({ scroll: document.scrollingElement.scrollHeight, inner: innerHeight, width: document.scrollingElement.scrollWidth })`,
    s,
  );
  const composer = await box("#composer", s);
  if (page.scroll > page.inner + 1 || composer.bottom > 900) throw Error("Page overflows/clips: " + JSON.stringify({ page, composer }));
  const feedScrolls = await evaluate(`['auto','scroll'].includes(getComputedStyle(document.querySelector('#feed')).overflowY)`, s);
  if (!feedScrolls) throw Error("Transcript does not scroll on its own");
  result.checks.push("L1 1440x900: no page scroll, composer in viewport, transcript scrolls on its own");

  // Composer
  const comp = await evaluate(
    `({ placeholder: document.querySelector('#composer-input').placeholder, model: document.querySelector('.sl-item[data-item="model"]')?.innerText ?? '', resize: getComputedStyle(document.querySelector('#composer-input')).resize })`,
    s,
  );
  if (/enter/i.test(comp.placeholder) || !comp.model.includes("fake-model") || comp.resize !== "none")
    throw Error("Composer copy wrong: " + JSON.stringify(comp));
  const grow = await evaluate(
    `(async () => { const t = document.querySelector('#composer-input'); const before = t.offsetHeight; t.focus(); t.value = 'line\\n'.repeat(6); t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => requestAnimationFrame(r)); const mid = t.offsetHeight; t.value = 'line\\n'.repeat(200); t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => requestAnimationFrame(r)); const big = t.offsetHeight; t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => requestAnimationFrame(r)); t.blur(); return { before, mid, big, after: t.offsetHeight }; })()`,
    s,
  );
  if (!(grow.mid > grow.before) || grow.big > 320 || grow.after > grow.before + 2)
    throw Error("Composer auto-grow wrong: " + JSON.stringify(grow));
  result.checks.push("H2 composer: short placeholder, model in the status line, no resize grip, grows up to a cap and shrinks back");

  // Workers
  // The failed worker and the scout are in the ended history; open it.
  await waitFor(
    `(document.querySelector('#workers [data-worker-history][aria-expanded="false"]')?.click(), (document.querySelector('#workers')?.innerText ?? '').includes('MARK-HOLDTASK'))`,
    s,
    "workers list",
  );
  const rail = await evaluate(`document.querySelector('#workers').innerText`, s);
  if (!rail.includes("MARK-FAILTASK") || /work items/.test(rail)) throw Error("Workers content wrong: " + JSON.stringify(rail));
  result.checks.push('R2 the Workers list shows the failed and the running worker; no "work items" grammar');
  await evaluate(`document.querySelector('#workers [data-open-worker="${scout.threadId}"]')?.click()`, s);
  await waitFor(
    `(document.querySelector('#focus-view #worker-feed')?.innerText ?? '').includes('REPORT-BODY')`,
    s,
    "scout opens in the worker view",
  );
  const opened = await evaluate(
    `({ back: !!document.querySelector('#focus-view [data-cmd="leave-focus"]'), composer: !!document.querySelector('#focus-view .worker-send textarea'), feedGone: !document.querySelector('#feed')?.offsetParent })`,
    s,
  );
  if (Object.values(opened).some((value) => value !== true)) throw Error("Worker view incomplete: " + JSON.stringify(opened));
  result.checks.push("R3/A1 a worker opens as its own view (Back, composer) in place of the chat");
  const list = await evaluate(`[...document.querySelectorAll('#focus-view #worker-feed ol')].map(n => n.children.length)`, s);
  if (!list.includes(3)) throw Error("Blank-line separated numbered list split: " + JSON.stringify(list));
  result.checks.push("M1 numbered list with blank lines stays one list");
  await shot("02-worker-view", s);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, s);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, s);
  await waitFor(
    `!document.querySelector('#focus-view #worker-feed') && !!document.querySelector('#feed')?.offsetParent`,
    s,
    "Escape returns to the chat",
  );
  result.checks.push("R3b/A2 Escape returns to the coordinator chat");

  // 1100 px: the composer hints stay on one row; the context item shows a percentage.
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, s);
  await delay(400);
  const hints = await evaluate(
    `(() => { const spans = [...document.querySelectorAll('.composer-hints > span')].filter(n => n.offsetParent); return new Set(spans.map(n => Math.round(n.getBoundingClientRect().top))).size; })()`,
    s,
  );
  if (hints > 1) throw Error("1100px composer hints wrap: " + hints);
  const ring = await evaluate(`document.querySelector('.sl-item[data-item="context"]')?.innerText ?? ''`, s);
  if (!/\d+%/.test(ring)) throw Error("Context item has no percentage: " + ring);
  result.checks.push("L3 1100px: composer hints stay on one row; the context item shows a percentage");
  // Mobile
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(500);
  const mobile = await evaluate(`document.scrollingElement.scrollWidth`, s);
  if (mobile > 391) throw Error("Mobile overflows horizontally: " + mobile);
  await shot("03-mobile", s);
  result.checks.push("L2 390px: no horizontal overflow");
  if (result.errors.length || result.httpErrors.length) throw Error("Browser errors captured");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
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
  log.end();
  save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== "passed") process.exitCode = 1;
