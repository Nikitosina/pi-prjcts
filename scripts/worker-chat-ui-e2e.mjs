// Browser E2E with an isolated host, Git fixture and local fake model. No real providers or GitHub.
// Failure cases written before UI implementation:
// C1 worker successful/error tool calls lack green/red backgrounds or safe expandable arguments/results.
// C2 pending worker tools lack gray backgrounds.
// C3 workers do not use chat bubbles/Markdown, or the composer precedes messages.
// C4 opened conversations do not refresh, or refresh destroys a typed follow-up.
// C5 closing/switching a worker lets stale responses reopen or overwrite it.
// C6 worker follow-ups cannot be sent with Enter, or history/controls disappear.
// C7 the dispatcher cannot run two independently delegated workers with cap 2.
// C8 long histories open at the oldest page, or older messages are inaccessible.
import { execFileSync, spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const stamp = new Date().toISOString().replaceAll(":", "-");
const artifacts = join(repo, "artifacts", `worker-chat-ui-${stamp}`),
  root = join(realpathSync(tmpdir()), `worker-chat-ui-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace"),
  agentDir = join(root, "agent");
const result = {
  scope: "Worker chat, tool states and Durable parallel dispatch",
  root,
  home,
  checks: [],
  errors: [],
  httpErrors: [],
  modelCalls: [],
};
const save = () => writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Unsafe runtime override; refused without clearing");
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
mkdirSync(root, { recursive: true, mode: 0o700 });
for (const dir of [home, workspace, agentDir]) mkdirSync(dir, { mode: 0o700 });

const click = (s, selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, s);
// The inbox at `/`: a worker opens from the Workers list into the center worker view.
const openWorker = async (s, id) => {
  await waitFor(`!!document.querySelector('#workers [data-open-worker="${id}"]')`, s, "worker listed");
  await evaluate(`document.querySelector('#workers [data-open-worker="${id}"]').click()`, s);
  await waitFor(`!!document.querySelector('#focus-view #worker-feed')`, s, "worker view");
};
let hold = true;
const held = new Set();
const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const model = createServer((req, res) => {
  let body = "";
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", () => {
    const input = JSON.parse(body);
    const coordinator = (input.tools ?? []).some((tool) => tool.function?.name === "agents");
    const lastUser = input.messages.findLast((m) => m.role === "user"),
      marker = /MARK-[A-Z]+/.exec(coordinator ? JSON.stringify(lastUser?.content ?? "") : body)?.[0] ?? "none";
    result.modelCalls.push({ at: Date.now(), marker, coordinator });
    if (hold && marker === "MARK-HOLD") {
      held.add(res);
      res.on("close", () => held.delete(res));
      return;
    }
    const stage = (coordinator ? input.messages.slice(input.messages.lastIndexOf(lastUser) + 1) : input.messages).filter(
      (m) => m.role === "tool",
    ).length;
    let tool;
    if (coordinator && (marker === "MARK-SPAWNHOLD" || marker === "MARK-SPAWNCHAT")) {
      const text = marker === "MARK-SPAWNHOLD" ? "MARK-HOLD Parallel companion" : "MARK-CHAT Inspect README";
      if (stage === 0)
        tool = {
          name: "agents",
          arguments: { action: "spawn", role: "worker", title: text, brief: text, acceptance: ["it works"], requestId: marker },
        };
    } else if (coordinator && marker === "MARK-COORD") {
      if (stage === 0) tool = { name: "projects_workspace_catalog", arguments: {} };
      if (stage === 1) tool = { name: "agents", arguments: { action: "bogus" } };
    } else if (marker === "MARK-CHAT") {
      if (stage === 0) tool = { name: "read", arguments: { path: "README.md" } };
      if (stage === 1) tool = { name: "read", arguments: { path: "missing.txt" } };
      if (stage === 2) tool = { name: "bash", arguments: { command: "sleep 6" } };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      tool
        ? chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-" + stage,
                  type: "function",
                  function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                },
              ],
            },
            null,
          ) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n"
        : chunk({ role: "assistant", content: "**Done** with \`chat\`." }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
    );
  });
});
await new Promise((ok) => model.listen(0, "127.0.0.1", ok));
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: "fake-key",
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
result.socket = socket;
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: "1", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const log = createWriteStream(join(artifacts, "host.log"), { flags: "wx", mode: 0o600 });
const host = spawn(process.execPath, [join(repo, "src/host.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.pipe(log, { end: false });
host.stderr.pipe(log, { end: false });
let hostEnded = false;
const hostExit = new Promise((resolve) =>
  host.once("exit", (code, signal) => {
    hostEnded = true;
    result.hostExit = { code, signal };
    save();
    resolve();
  }),
);
function rpc(input) {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath: socket,
        method: input ? "POST" : "GET",
        path: input ? "/api" : "/health",
        headers: input ? { "content-type": "application/json" } : {},
        timeout: 90000,
      },
      (response) => {
        let text = "";
        response.on("data", (part) => {
          text += part;
        });
        response.on("end", () => {
          try {
            const reply = JSON.parse(text);
            if (!reply.ok) throw new Error(reply.error);
            resolve(reply.data);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    call.on("error", reject);
    call.end(input ? JSON.stringify(input) : undefined);
  });
}

// Minimal CDP over pipe.
let chromeSession,
  chrome,
  cdpEnded = false,
  id = 0,
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
  chrome.stdio[4].on("data", (chunk) => {
    buffer += chunk.toString();
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
    const key = ++id;
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
async function shot(name, session, full = false) {
  if (process.env.E2E_SHOTS !== "1") return;
  const params = { format: "png" };
  if (full) {
    const m = await send("Page.getLayoutMetrics", {}, session);
    params.clip = { x: 0, y: 0, width: 1440, height: Math.min(2400, Math.ceil(m.cssContentSize.height)), scale: 1 };
    params.captureBeyondViewport = true;
  }
  const image = await send("Page.captureScreenshot", params, session);
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
}
async function waitFor(expression, session, label) {
  for (let i = 0; i < 60 * 2.5; i++) {
    if (
      await evaluate(expression, session).catch((error) => {
        if (i > 100) throw error;
        return false;
      })
    )
      return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const git = (...args) => execFileSync("/usr/bin/git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
try {
  git("init", "-b", "main");
  git("config", "user.email", "e2e@example.invalid");
  git("config", "user.name", "E2E");
  writeFileSync(join(workspace, "README.md"), "base\\n");
  git("add", ".");
  git("commit", "-m", "c1");
  let health;
  for (let i = 0; i < 150; i++) {
    if (hostEnded) throw Error("Host exited");
    try {
      health = await rpc();
      break;
    } catch {
      await delay(200);
    }
  }
  if (health?.pid !== host.pid || health.home !== home) throw Error("Owned host readiness failed");
  const project = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "Worker chat UI",
    cwd: workspace,
    objective: "Disposable.",
    model: "fake/fake-model",
  });
  result.projectId = project.id;
  const settings = await rpc({ action: "settings-snapshot", id: project.id });
  await rpc({
    action: "settings-update",
    id: project.id,
    confirm: project.id,
    expectedRevision: settings.revision,
    changes: { models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" } },
  });
  const jobIdOf = async (title) => {
    for (let i = 0; i < 200; i++) {
      const job = (await rpc({ action: "jobs-snapshot", id: project.id })).jobs.find((item) => item.title.startsWith(title));
      if (job) return job.id;
      await delay(100);
    }
    throw Error(`Job ${title} was not started`);
  };
  await rpc({ action: "message", id: project.id, text: "MARK-SPAWNHOLD" });
  const heldThread = await jobIdOf("MARK-HOLD");
  await rpc({ action: "message", id: project.id, text: "MARK-SPAWNCHAT" });
  const threadId = await jobIdOf("MARK-CHAT");
  await rpc({ action: "message", id: project.id, text: "MARK-COORD Inspect scope then try an invalid scoped scout." });
  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", project.id);
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  chromeSession = s;
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  // The inbox at `/` (classic inbox retired 2026-11-04). C9 is retired: the new client shows tool rows and thoughts on purpose.
  const feed = `document.querySelector('#feed')`,
    wfeed = `document.querySelector('#worker-feed')`,
    wtext = `document.querySelector('#focus-view .worker-send textarea')`;
  await waitFor(
    `${feed}?.innerText.includes('Inspect scope then try an invalid scoped scout.') && !!document.querySelector('#feed .msg.agent strong')`,
    s,
    "coordinator answer",
  );
  const ownerInput = (await rpc({ action: "show", id: project.id })).messages.find(
    (message) => message.role === "user" && message.text === "MARK-COORD Inspect scope then try an invalid scoped scout.",
  );
  if (ownerInput?.origin !== "owner") throw Error("C14 real owner admission lacks owner origin: " + JSON.stringify(ownerInput));
  result.checks.push("C14 real owner API transcript carries owner origin");
  await shot("01-coordinator", s);
  const active = await rpc({ action: "jobs-snapshot", id: project.id });
  if (active.jobs.filter((job) => job.status === "running").length !== 2) throw Error("Jobs were not concurrent");
  result.checks.push("C7 two Jobs run concurrently");
  await openWorker(s, threadId);
  await waitFor(`!!document.querySelector('#worker-feed .tool-row')`, s, "worker tool row");
  const pending = await evaluate(`[...document.querySelectorAll('#worker-feed .tool-row')].map(n => n.dataset.status)`, s);
  if (!pending.includes("running"))
    throw Error("C2 the worker's unfinished tool call does not show as running: " + JSON.stringify(pending));
  result.checks.push("C2 the worker's unfinished tool call shows as running");
  if (
    !(await evaluate(
      `!!document.querySelector('#worker-feed .msg.owner') && ${wfeed}.compareDocumentPosition(document.querySelector('#focus-view .worker-send')) & Node.DOCUMENT_POSITION_FOLLOWING`,
      s,
    ))
  )
    throw Error("Chat bubbles or composer order wrong");
  result.checks.push("C3 worker chat layout: the task above, the composer below the conversation");
  await evaluate(`${wtext}.value = 'Keep this draft'; ${wtext}.dispatchEvent(new Event('input', { bubbles: true }))`, s);
  await waitFor(`!!document.querySelector('#worker-feed .msg.agent strong')`, s, "live worker answer");
  if ((await evaluate(`${wtext}.value`, s)) !== "Keep this draft") throw Error("Refresh lost draft");
  result.checks.push("C4 live refresh preserves draft");
  // A finished turn folds its run of calls into one group line; open it.
  await evaluate(`document.querySelectorAll('#worker-feed .tool-group:not(.open) .group-head').forEach(n => n.click())`, s);
  await waitFor(`!document.querySelector('#worker-feed .tool-group:not(.open)')`, s, "tool groups open");
  const statuses = await evaluate(`[...document.querySelectorAll('#worker-feed .tool-row')].map(n => n.dataset.status)`, s);
  if (!statuses.includes("ok") || !statuses.includes("error")) throw Error("Worker tool states wrong: " + JSON.stringify(statuses));
  await evaluate(`document.querySelector('#worker-feed .tool-row[data-status="ok"] .tool-head').click()`, s);
  await waitFor(`!!document.querySelector('#worker-feed .tool-row.open')`, s, "expanded tool row");
  if (
    !(await evaluate(
      `document.querySelector('#worker-feed .tool-row.open').innerText.length > document.querySelector('#worker-feed .tool-row.open .tool-head').innerText.length`,
      s,
    ))
  )
    throw Error("Missing expanded worker tool result");
  result.checks.push("C1 worker tool rows show ok and failed and expand to their result");
  let reportInput;
  for (let attempt = 0; attempt < 100; attempt++) {
    reportInput = (await rpc({ action: "show", id: project.id })).messages.find(
      (message) => message.role === "user" && message.text.startsWith(`[worker ${threadId} `),
    );
    if (reportInput) break;
    await delay(100);
  }
  if (reportInput?.origin !== "internal") throw Error("C15 real agent report lacks internal origin: " + JSON.stringify(reportInput));
  result.apiOrigins = { owner: ownerInput.origin, report: reportInput.origin };
  await click(s, '#focus-view [data-cmd="leave-focus"]');
  await waitFor(`!!${feed}?.offsetParent`, s, "back to the chat");
  await delay(250);
  if (await evaluate(`[...document.querySelectorAll('#feed .msg.owner')].some(n => n.innerText.includes('[worker ${threadId}'))`, s))
    throw Error("C15/C17 real internal report rendered as owner speech");
  result.checks.push("C15/C17 the agent report carries internal origin and never shows as the owner's message");

  await openWorker(s, threadId);
  await evaluate(`${wtext}.value = 'Keep this draft'; ${wtext}.focus()`, s);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, s);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, s);
  await waitFor(`${wfeed}.innerText.includes('Keep this draft') && ${wtext}.value === ''`, s, "follow-up");
  result.checks.push("C6 Enter sends worker follow-up");
  await shot("02-worker-chat", s);
  await click(s, '#focus-view [data-cmd="leave-focus"]');
  await delay(2500);
  if (!(await evaluate(`!document.querySelector('#worker-feed') && !!${feed}.offsetParent`, s))) throw Error("Closed worker reopened");
  result.checks.push("C5 close remains closed after refresh");
  for (let i = 0; i < 34; i++) {
    await rpc({ action: "thread-send", id: project.id, threadId, requestId: randomUUID(), text: "History turn " + i });
    for (let j = 0; j < 100; j++) {
      const p = await rpc({ action: "jobs-snapshot", id: project.id });
      if (!p.jobs.some((job) => job.id === threadId && job.working)) break;
      await delay(50);
    }
  }
  await openWorker(s, threadId);
  await waitFor(`${wfeed}?.innerText.includes('History turn 33')`, s, "latest history");
  if (!(await evaluate(`${wfeed}.innerText.includes('History turn 0')`, s))) throw Error("Older history not shown");
  result.checks.push("C8 the worker view shows the latest turns with the older history above");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, s);
  await delay(300);
  if ((await evaluate(`document.scrollingElement.scrollWidth`, s)) > 391) throw Error("Worker view overflows at 390 px");
  await shot("03-worker-mobile", s, true);
  if (result.errors.length || result.httpErrors.length) throw Error("Browser errors captured");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
  try {
    result.diagnostic = await evaluate(
      `(document.querySelector('#workers')?.innerText ?? '') + '\\n---\\n' + (document.querySelector('#focus-view')?.innerText ?? '').slice(0, 2000)`,
      chromeSession,
    );
  } catch {}
} finally {
  if (chrome && !cdpEnded) {
    try {
      await send("Browser.close");
    } catch {}
    for (let i = 0; i < 1000 / 20 && !cdpEnded; i++) await delay(20);
    if (!cdpEnded) chrome.kill("SIGTERM");
  }
  save();
}
if (!hostEnded) {
  try {
    await rpc({ action: "shutdown" });
  } catch (e) {
    result.shutdownError = String(e);
  }
  await Promise.race([hostExit, delay(10000)]);
}
if (!hostEnded) host.kill("SIGTERM");
for (const res of held) res.destroy();
model.close();
save();
log.end();
console.log(
  JSON.stringify(
    {
      status: result.status,
      checks: result.checks,
      failure: result.failure,
      errors: result.errors,
      httpErrors: result.httpErrors,
      artifact: artifacts,
    },
    null,
    2,
  ),
);
if (result.status !== "passed") process.exitCode = 1;
