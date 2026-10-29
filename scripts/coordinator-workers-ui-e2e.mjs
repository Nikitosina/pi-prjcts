// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in coordinator-workers-ui-failures.md before implementation.
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const artifacts = join(repo, "artifacts", `coordinator-workers-ui-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `coordinator-workers-ui-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace"),
  agentDir = join(root, "agent");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error("Clear runtime overrides first");
for (const dir of [artifacts, root, home, workspace, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");

writeFileSync(join(workspace, "SECRET.txt"), "CODE-TOKEN-123 inside checkout\n");
const outside = join(root, "OUTSIDE.txt");
writeFileSync(outside, "OUTSIDE-TOKEN must stay unreadable\n");
const toolsSeen = {};
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
const toolText = (msgs) =>
  msgs
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
const model = createServer((req, res) => {
  req.setEncoding("utf8");
  let body = "";
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", async () => {
    const input = JSON.parse(body),
      msgs = input.messages;
    const names = (input.tools ?? []).map((tool) => tool.function?.name);
    const coordinator = names.includes("agents");
    const lastUser = msgs.findLastIndex((m) => m.role === "user");
    const userText = String(
      typeof msgs[lastUser]?.content === "string" ? msgs[lastUser].content : JSON.stringify(msgs[lastUser]?.content ?? ""),
    );
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? "none";
    const stage = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length;
    const after = toolText(msgs.slice(lastUser + 1));
    result.calls.push({ at: Date.now(), coordinator, marker, stage });
    if (!coordinator) toolsSeen[marker] ??= names;
    const reply = (text) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(text);
    };
    if (coordinator && /^\[(worker|scout|reviewer) /.test(userText)) return reply(say("Report acknowledged."));
    if (coordinator) {
      const delegate = {
        "MARK-SCOUT": { role: "scout", task: "MARK-SCOUTTASK read the code" },
        "MARK-REVIEW": { role: "reviewer", task: "MARK-REVIEWTASK grep the code" },
        "MARK-FAIL": { role: "worker", task: "MARK-FAILTASK will fail" },
        "MARK-HOLD": { role: "worker", task: "MARK-HOLDTASK waits" },
        "MARK-SCOPED": { role: "scout", task: "MARK-SCOPEDTASK", scopeId: randomUUID() },
      }[marker];
      if (delegate && stage === 0)
        return reply(
          call("agents", {
            action: "spawn",
            role: delegate.role,
            title: delegate.task,
            brief: delegate.task,
            ...(delegate.role === "worker" ? { acceptance: ["it works"] } : {}),
            ...(delegate.scopeId ? { scopeId: delegate.scopeId } : {}),
            requestId: randomUUID(),
          }),
        );
      if (marker === "MARK-SLOW") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: "" }, null));
        for (let i = 0; i < 16; i++) {
          await delay(500);
          res.write(chunk({ content: `STREAM-LINE-${i}\n\n` + "filler text ".repeat(20) + "\n\n" }, null));
        }
        res.end(chunk({ content: "STREAM-END" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      return reply(say(`Answer ${marker} RESULT: ${after.slice(0, 800)}`));
    }
    if (marker === "MARK-SCOUTTASK") {
      if (stage === 0) return reply(call("code_read", { path: "SECRET.txt" }));
      if (stage === 1) return reply(call("code_read", { path: outside }));
      return reply(say(`SCOUT-SAW ${after}`));
    }
    if (marker === "MARK-REVIEWTASK") {
      if (stage === 0) return reply(call("code_grep", { pattern: "CODE-TOKEN" }));
      if (stage === 1) return reply(call("code_ls", { path: ".." }));
      return reply(say(`REVIEW-SAW ${after}`));
    }
    if (marker === "MARK-FAILTASK" || marker === "MARK-FAILBTASK") {
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
  for (let i = 0; i < tries * 2; i++) {
    const value = await fn();
    if (value) return value;
    await delay(50);
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
  if (process.env.E2E_SHOTS !== "1") return;
  const image = await send("Page.captureScreenshot", { format: "png" }, session);
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, "base64"), { mode: 0o600 });
}
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries * 2.5; i++) {
    if (
      await evaluate(expression, session).catch((error) => {
        if (i > 100) throw error;
        return false;
      })
    )
      return;
    await delay(100);
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
// Jobs and loose agents (scouts, reviewers) in one list.
const workOf = async (id) => {
  const snap = await rpc({ action: "jobs-snapshot", id });
  return [
    ...snap.jobs.map((j) => ({
      text: j.title,
      status: j.status === "running" ? "running" : j.status === "failed" ? "failed" : "completed",
    })),
    ...snap.agents.filter((a) => a.jobId === null).map((a) => ({ text: a.title, status: a.endedAt === null ? "running" : "completed" })),
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
let chromeSession;
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
    name: "Workers UI",
    cwd: workspace,
    objective: "Disposable",
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
  const scoutTools = toolsSeen["MARK-SCOUTTASK"] ?? [];
  if (!["code_read", "code_grep", "code_find", "code_ls"].every((name) => scoutTools.includes(name)))
    throw Error("Scout lacks read-only code tools: " + scoutTools);
  if (scoutTools.some((name) => ["write", "edit", "bash", "read"].includes(name)))
    throw Error("Scout has mutating/unexpected tools: " + scoutTools);
  result.checks.push("R1 unscoped scout gets code_read/grep/find/ls and no write/edit/bash");
  result.scoutTools = scoutTools;
  const report = await eventually(async () => {
    const msgs = (await rpc({ action: "show", id })).messages;
    return msgs.find((m) => m.role === "user" && m.text.includes("SCOUT-SAW"))?.text;
  }, "scout report missing");
  if (!report.includes("CODE-TOKEN-123")) throw Error("Scout did not read SECRET.txt");
  if (report.includes("OUTSIDE-TOKEN") || !/outside|escape|checkout/i.test(report))
    throw Error("Scout escaped checkout: " + report.slice(0, 600));
  result.checks.push("R2 scout reads project file; path outside checkout is refused");

  await ask("MARK-REVIEW");
  await terminal(id, "MARK-REVIEWTASK", "completed");
  const review = await eventually(
    async () => (await rpc({ action: "show", id })).messages.find((m) => m.role === "user" && m.text.includes("REVIEW-SAW"))?.text,
    "review report missing",
  );
  if (!review.includes("CODE-TOKEN-123") || /OUTSIDE\.txt/.test(review)) throw Error("Reviewer grep/ls wrong: " + review.slice(0, 600));
  result.checks.push("R3 reviewer greps the checkout; listing its parent is refused");

  await ask("MARK-FAIL");
  await terminal(id, "MARK-FAILTASK", "failed");
  const workerTools = toolsSeen["MARK-FAILTASK"] ?? [];
  if (workerTools.some((name) => name.startsWith("code_"))) throw Error("Worker gained read-only code tools: " + workerTools);
  result.checks.push("R4 worker role tools unchanged (no code_* tools)");

  await ask("MARK-SCOPED");
  const scopedScout = await terminal(id, "MARK-SCOPEDTASK", "completed");
  if (scopedScout.workspaceScopeId != null || !(toolsSeen["MARK-SCOPEDTASK"] ?? []).includes("code_read"))
    throw Error("Scoped scout did not run read-only with the scope ignored: " + JSON.stringify(scopedScout).slice(0, 400));
  result.checks.push("R5 a scout given workspaceScopeId runs read-only (scope ignored, C11f)");

  // Browser: the Jobs tree lists the Jobs, and a held one finishes.
  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", id);
  launch.searchParams.set("tab", "coordinator");
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  chromeSession = s;
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  await waitFor(
    `document.querySelector('#title')?.innerText === 'Workers UI' && document.querySelector('#job-tree').innerText.includes('MARK-FAILTASK')`,
    s,
    "project loaded",
  );
  await ask("MARK-HOLD");
  await eventually(async () => (await workFor(id, "MARK-HOLDTASK")).status === "running", "hold not running");
  await waitFor(`document.querySelector('#job-tree').innerText.includes('MARK-HOLDTASK')`, s, "running Job in the tree");
  releaseHold();
  await eventually(async () => (await workFor(id, "MARK-HOLDTASK")).status !== "running", "held Job did not finish");
  result.checks.push("A1 the Jobs tree lists failed and running Jobs; a held Job finishes");
  await shot("01-jobs-tree", s);

  // Inline streaming with sticky auto-scroll.
  await waitFor(`!document.querySelector('#compose textarea').disabled`, s, "composer ready");
  const slow = await rpc({ action: "message", id, text: "MARK-SLOW" });
  await waitFor(`(document.querySelector('#live-reply')?.innerText ?? '').includes('STREAM-LINE-2')`, s, "stream started", 60);
  const inside = await evaluate(
    `(() => { const live = document.querySelector('#live-reply'), t = document.querySelector('#transcript'); return t.contains(live) && t.contains(document.querySelector('#messages')) && live.previousElementSibling === document.querySelector('#messages'); })()`,
    s,
  );
  if (!inside) throw Error("Live bubble is not inside the transcript scroll");
  const atBottom = await scrollInfo(s);
  if (atBottom.gap > 40) throw Error("Not following stream at bottom: " + JSON.stringify(atBottom));
  result.checks.push("S1 live bubble streams inside transcript and follows the bottom");
  await shot("02-inline-stream", s);
  const box = await evaluate(
    `(() => { const r = document.querySelector('#transcript').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    s,
  );
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -5000 }, s);
  await delay(300);
  const up = await scrollInfo(s);
  await waitFor(`(document.querySelector('#live-reply')?.innerText ?? '').includes('STREAM-LINE-8')`, s, "more chunks", 60);
  const stillUp = await scrollInfo(s);
  if (stillUp.top > up.top + 5 || stillUp.gap < 100) throw Error("Scrolled-up reader was yanked: " + JSON.stringify({ up, stillUp }));
  result.checks.push("S2 user scroll-up is respected while chunks arrive");
  await evaluate(`document.querySelector('[data-action="jump-latest"]').click()`, s);
  await waitFor(`(document.querySelector('#live-reply')?.innerText ?? '').includes('STREAM-LINE-12')`, s, "later chunks", 60);
  const resumed = await scrollInfo(s);
  if (resumed.gap > 40) throw Error("Auto-scroll did not resume: " + JSON.stringify(resumed));
  result.checks.push("S3 auto-scroll resumes after Jump to latest");
  await settle(id, slow);
  await waitFor(
    `document.querySelector('#messages').innerText.includes('STREAM-LINE-15') && document.querySelector('#live-reply').hidden`,
    s,
    "final message",
    40,
  );
  const final = await scrollInfo(s);
  if (final.gap > 40) throw Error("Final message not at bottom: " + JSON.stringify(final));
  result.checks.push("S4 final message replaces bubble at bottom");
  if (result.errors.length || result.httpErrors.length) throw Error("Browser errors captured");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
  try {
    result.diagnostic = await evaluate(
      `JSON.stringify({ live: document.querySelector('#live-reply')?.hidden, tail: document.querySelector('#messages').innerText.slice(-300) })`,
      chromeSession,
    );
  } catch {}
} finally {
  releaseHold?.();
  if (chrome && !cdpEnded) {
    try {
      await send("Browser.close");
    } catch {}
    for (let i = 0; i < 500 / 20 && !cdpEnded; i++) await delay(20);
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
