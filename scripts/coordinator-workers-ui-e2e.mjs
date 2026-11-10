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
const STEPS = 4;
let releaseSteps;
const stepsSeen = new Promise((ok) => {
  releaseSteps = ok;
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
        "MARK-STEPS": { role: "worker", task: "MARK-STEPSTASK runs commands" },
        "MARK-SCOPED": { role: "scout", task: "MARK-SCOPEDTASK", scopeId: randomUUID() },
        "MARK-WEBSCOUT": { role: "scout", task: "MARK-WEBSCOUTTASK search" },
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
      if (marker === "MARK-WEB" && stage === 0) return reply(call("web_search", { query: "pi release" }));
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
    if (marker === "MARK-WEBSCOUTTASK") {
      if (stage === 0) return reply(call("web_search", { query: "pi release" }));
      return reply(say(`WEB-SCOUT ${after}`));
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
    // Several commands in a row, slow enough for the Workers panel to show each one as the current command.
    if (marker === "MARK-STEPSTASK") {
      await delay(900);
      result.steps = stage;
      if (stage < STEPS) return reply(call("bash", { command: `echo STEP-${stage}` }));
      await stepsSeen;
      return reply(say("Steps done"));
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
    `(() => { const t = document.querySelector('#feed'); return { top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight, height: t.scrollHeight }; })()`,
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

  // web_search resolves for the coordinator and a scout; this home has no openai-codex login, so it answers how to connect.
  const webAnswer = await ask("MARK-WEB");
  if (!/openai-codex login/.test(webAnswer)) throw Error("Coordinator web_search did not run: " + String(webAnswer).slice(0, 400));
  await ask("MARK-WEBSCOUT");
  await terminal(id, "MARK-WEBSCOUTTASK", "completed");
  const webScout = await eventually(
    async () => (await rpc({ action: "show", id })).messages.find((m) => m.role === "user" && m.text.includes("WEB-SCOUT"))?.text,
    "web scout report missing",
  );
  if (!/openai-codex login/.test(webScout)) throw Error("Scout web_search did not run: " + webScout.slice(0, 400));
  result.checks.push("W9 the coordinator and a scout can call web_search");

  await ask("MARK-SCOPED");
  const scopedScout = await terminal(id, "MARK-SCOPEDTASK", "completed");
  if (scopedScout.workspaceScopeId != null || !(toolsSeen["MARK-SCOPEDTASK"] ?? []).includes("code_read"))
    throw Error("Scoped scout did not run read-only with the scope ignored: " + JSON.stringify(scopedScout).slice(0, 400));
  result.checks.push("R5 a scout given workspaceScopeId runs read-only (scope ignored, C11f)");

  // Browser: the Jobs tree lists the Jobs, and a held one finishes.
  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", id);
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  chromeSession = s;
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  // A page-side spy on /api: records worker-contexts and thread-history reads, and lets a check rewrite or hold one answer.
  await send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `window.__spy = { contexts: [], history: [], rewrite: {} };
        const realFetch = window.fetch;
        window.fetch = async (url, init) => {
          const body = typeof init?.body === "string" && String(url).endsWith("/api") ? JSON.parse(init.body) : null;
          if (body?.action === "worker-contexts") window.__spy.contexts.push({ at: Date.now(), ids: body.threadIds, project: body.id });
          if (body?.action === "thread-history") window.__spy.history.push(body.threadId);
          const rewrite = body && window.__spy.rewrite[body.action];
          if (!rewrite) return realFetch(url, init);
          const response = await realFetch(url, init), reply = await response.json();
          const data = await rewrite(reply.data);
          return new Response(JSON.stringify({ ...reply, data }), { status: response.status, headers: { "content-type": "application/json" } });
        };`,
    },
    s,
  );
  await send("Page.navigate", { url: launch.toString() }, s);
  const workers = `(document.querySelector('#workers')?.innerText ?? '')`;
  const history = `document.querySelector('#workers [data-worker-history]')`;
  await waitFor(`document.body.dataset.ready === "1" && !!${history}`, s, "project loaded");
  await ask("MARK-HOLD");
  await eventually(async () => (await workFor(id, "MARK-HOLDTASK")).status === "running", "hold not running");
  await waitFor(`${workers}.includes('MARK-HOLDTASK')`, s, "running Job in the list");

  // H1-H5, C1-C5 (coordinator-workers-ui-failures.md): active workers on top, ended ones collapsed with a count, context rings.
  const snap = await rpc({ action: "jobs-snapshot", id });
  const holdId = snap.jobs.find((job) => job.title.startsWith("MARK-HOLDTASK")).id;
  const endedCount =
    snap.jobs.filter((job) => job.id !== holdId && !job.dismissedAt).length +
    snap.agents.filter((agent) => !agent.jobId && agent.endedAt !== null && !agent.dismissedAt).length;
  const panel = () =>
    evaluate(
      `(() => { const box = document.querySelector('#workers'), toggle = box.querySelector('[data-worker-history]'), list = box.querySelector('#workers-history');
        return { active: [...box.querySelectorAll(':scope > .worker')].map((n) => n.innerText), toggle: toggle?.innerText ?? null, expanded: toggle?.getAttribute('aria-expanded') ?? null,
          ended: list ? [...list.querySelectorAll('.worker')].map((n) => ({ text: n.innerText, ring: !!n.querySelector('.ctx-ring'), open: !!n.querySelector('[data-open-worker]') })) : [],
          count: document.querySelector('#workers-count').textContent }; })()`,
      s,
    );
  let seen = await panel();
  if (
    seen.active.length !== 1 ||
    !seen.active[0].includes("MARK-HOLDTASK") ||
    seen.expanded !== "false" ||
    seen.ended.length ||
    !seen.toggle?.includes(String(endedCount)) ||
    seen.count !== "1"
  )
    throw Error("H1 active worker on top, ended ones collapsed with their count: " + JSON.stringify({ seen, endedCount }));
  result.checks.push(`H1 the running Job is the one card; ${endedCount} ended workers are collapsed behind a toggle with their count`);
  if (!/1 failed/.test(seen.toggle)) throw Error("H2 collapsed history hides the failure: " + seen.toggle);
  result.checks.push("H2 the collapsed toggle still says 1 failed");
  await shot("01a-active-collapsed", s);

  // C1: the ring is the host's worker-contexts value.
  const ring = `document.querySelector('#workers .worker .ctx-ring')`;
  const hostContext = (await rpc({ action: "worker-contexts", id, threadIds: [holdId] }))[holdId];
  if (!hostContext?.window) throw Error("Fake worker has no known context window: " + JSON.stringify(hostContext));
  const pct = Math.round((100 * hostContext.tokens) / hostContext.window);
  await waitFor(`${ring}?.dataset.state === "known"`, s, "known context ring");
  const ringSeen = await evaluate(`({ pct: ${ring}.dataset.pct, label: ${ring}.getAttribute('aria-label'), title: ${ring}.title })`, s);
  if (ringSeen.pct !== String(pct) || !ringSeen.title.includes(`${pct}%`) || !/tokens/.test(ringSeen.title) || !ringSeen.label)
    throw Error("C1 ring differs from worker-contexts: " + JSON.stringify({ ringSeen, hostContext }));
  result.checks.push(`C1 the active worker's ring shows ${pct}% with tokens in its tooltip, the host's worker-contexts value`);

  // C3: a burst of jobs reads is one bounded worker-contexts request, never a transcript read of an ended agent.
  const before = await evaluate(`window.__spy.contexts.length`, s);
  await evaluate(`import('/workers.js').then((m) => Promise.all(Array.from({ length: 15 }, () => m.loadJobs())))`, s);
  await delay(1500);
  const spy = await evaluate(`window.__spy`, s);
  const endedIds = snap.jobs
    .filter((job) => job.id !== holdId)
    .map((job) => job.id)
    .concat(snap.agents.filter((agent) => !agent.jobId).map((agent) => agent.id));
  if (
    spy.contexts.length - before > 1 ||
    spy.contexts.some((item) => item.ids.length > 40 || item.ids.some((one) => endedIds.includes(one))) ||
    spy.history.some((one) => endedIds.includes(one))
  )
    throw Error("C3 context reads not bounded: " + JSON.stringify({ before, spy }));
  result.checks.push(
    `C3 15 jobs reloads made ${spy.contexts.length - before} worker-contexts request (≤ 40 active ids, no ended agent, no transcript read)`,
  );

  // C2: an unknown context reads as unknown, never 0 %.
  const reloadJobs = () => evaluate(`import('/workers.js').then((m) => m.loadJobs())`, s);
  const waitContextsCall = async (count) => waitFor(`window.__spy.contexts.length > ${count}`, s, "next worker-contexts request", 40);
  for (const [label, value] of [
    ["null entry", null],
    ["zero window", { tokens: 500, window: 0 }],
  ]) {
    await evaluate(
      `window.__spy.rewrite['worker-contexts'] = (data) => ({ ...data, ${JSON.stringify(holdId)}: ${JSON.stringify(value)} })`,
      s,
    );
    const count = await evaluate(`window.__spy.contexts.length`, s);
    await reloadJobs();
    await waitContextsCall(count);
    await waitFor(`${ring}?.dataset.state === "unknown"`, s, `unknown ring (${label})`);
    const unknown = await evaluate(
      `({ label: ${ring}.getAttribute('aria-label'), title: ${ring}.title, pct: ${ring}.dataset.pct ?? null })`,
      s,
    );
    if (/\b0\s?%/.test(unknown.label + unknown.title) || unknown.pct !== null || !/unknown/i.test(unknown.label))
      throw Error(`C2 unknown context (${label}) shown as a number: ` + JSON.stringify(unknown));
    if (label === "null entry") await shot("01b-ring-unknown", s);
  }
  result.checks.push("C2 a null entry and a zero window both read as unknown context, not 0 %");

  // C4: a held older answer (77 %) arrives after a newer one and after a chat switch; it never paints.
  const second = (await rpc({ action: "chat-create", id, title: "Second" })).id;
  await evaluate(
    `window.__spy.release = null; window.__spy.rewrite['worker-contexts'] = (data) => new Promise((ok) => { window.__spy.release = () => ok({ ...data, ${JSON.stringify(holdId)}: { tokens: 77000, window: 100000 } }); })`,
    s,
  );
  let count = await evaluate(`window.__spy.contexts.length`, s);
  await reloadJobs();
  await waitContextsCall(count);
  await waitFor(`typeof window.__spy.release === "function"`, s, "held worker-contexts answer");
  await evaluate(`(() => { const held = window.__spy.release; window.__spy.held = held; window.__spy.rewrite = {}; })()`, s);
  await evaluate(`document.querySelector('#tree [data-chat="${second}"]').click()`, s);
  await waitFor(
    `document.body.dataset.ready === "1" && !document.querySelector('#workers .worker') && new URL(location.href).searchParams.get('chat') === "${second}"`,
    s,
    "second chat",
  );
  count = await evaluate(`window.__spy.contexts.length`, s);
  await evaluate(`document.querySelector('#tree [data-chat="main"]').click()`, s);
  await waitContextsCall(count);
  await waitFor(`${ring}?.dataset.state === "known" && ${ring}.dataset.pct === "${pct}"`, s, "fresh ring on Main");
  await evaluate(`window.__spy.held()`, s);
  await delay(800);
  const afterLate = await evaluate(`${ring}?.dataset.pct ?? null`, s);
  if (afterLate !== String(pct)) throw Error("C4 a stale worker-contexts answer painted: " + afterLate);
  result.checks.push("C4 a held worker-contexts answer released after a chat switch and a newer answer is dropped");

  // H4: the Job record lags (status no longer running) while its worker still works: it stays on top.
  await evaluate(
    `window.__spy.rewrite['jobs-snapshot'] = (data) => ({ ...data, jobs: data.jobs.map((job) => job.id === ${JSON.stringify(holdId)} ? { ...job, status: "completed", working: true } : job) })`,
    s,
  );
  await reloadJobs();
  seen = await panel();
  await evaluate(`window.__spy.rewrite = {}`, s);
  if (seen.active.length !== 1 || !seen.active[0].includes("MARK-HOLDTASK") || seen.toggle?.includes(String(endedCount + 1)))
    throw Error("H4 a working agent with a lagging Job status was hidden: " + JSON.stringify(seen));
  result.checks.push("H4 a working worker whose Job status lags stays on top");
  await reloadJobs();

  // H3, H5, C5: expanding shows every ended card with its controls and no ring; it survives a jobs push and a reload.
  await evaluate(`${history}.click()`, s);
  await waitFor(`${history}.getAttribute('aria-expanded') === "true"`, s, "history expanded");
  seen = await panel();
  const failedCard = seen.ended.find((item) => item.text.includes("MARK-FAILTASK"));
  if (seen.ended.length !== endedCount || !failedCard?.open || seen.ended.some((item) => item.ring))
    throw Error("H5/C5 expanded history wrong: " + JSON.stringify(seen));
  result.checks.push(`H5 the expanded history shows all ${endedCount} ended cards with Open; C5 none carries a ring`);
  await shot("01c-history-expanded", s);
  await reloadJobs();
  await send("Page.reload", {}, s);
  await waitFor(`document.body.dataset.ready === "1" && !!${history}`, s, "reloaded");
  seen = await panel();
  if (seen.expanded !== "true" || seen.ended.length !== endedCount) throw Error("H3 expansion lost on refresh: " + JSON.stringify(seen));
  // Another chat with its own ended scout starts collapsed.
  await rpc({ action: "message", id, chatId: second, text: "MARK-SCOUT" });
  await eventually(
    async () =>
      (await rpc({ action: "jobs-snapshot", id })).agents.filter((agent) => agent.title.startsWith("MARK-SCOUTTASK") && agent.endedAt)
        .length === 2,
    "second chat scout did not end",
  );
  await evaluate(`document.querySelector('#tree [data-chat="${second}"]').click()`, s);
  await waitFor(`new URL(location.href).searchParams.get('chat') === "${second}" && !!${history}`, s, "second chat history");
  if ((await evaluate(`${history}.getAttribute('aria-expanded')`, s)) !== "false") throw Error("H3 expansion leaked into another chat");
  await evaluate(`document.querySelector('#tree [data-chat="main"]').click()`, s);
  await waitFor(
    `new URL(location.href).searchParams.get('chat') === null && ${history}?.getAttribute('aria-expanded') === "true"`,
    s,
    "Main still expanded",
  );
  result.checks.push("H3 the expanded history survives a jobs push and a reload in its chat; another chat starts collapsed");

  // Narrow: the context sheet at 390 px keeps the cards, the toggle and the ring inside the panel.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await evaluate(`document.querySelector('[data-cmd="toggle-context"]').click()`, s);
  await waitFor(`document.querySelector('#app').dataset.sheet === "context"`, s, "context sheet");
  const narrow = await evaluate(
    `(() => { const panel = document.querySelector('#context'), box = panel.getBoundingClientRect(); return { overflow: panel.scrollWidth - panel.clientWidth, outside: [...panel.querySelectorAll('.worker, [data-worker-history], .ctx-ring')].filter((n) => { const r = n.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1; }).length }; })()`,
    s,
  );
  if (narrow.overflow > 1 || narrow.outside) throw Error("Narrow context sheet overflows: " + JSON.stringify(narrow));
  await delay(500); // let the sheet's open transition finish before the screenshot
  await shot("01d-narrow-390", s);
  await evaluate(`document.querySelector('#app').dataset.sheet = ""`, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  result.checks.push("N1 at 390 px the context sheet shows the cards, toggle and ring without overflow");
  releaseHold();
  await eventually(async () => (await workFor(id, "MARK-HOLDTASK")).status !== "running", "held Job did not finish");
  result.checks.push("A1 the chat's Workers list shows failed and running Jobs; a held Job finishes");
  await shot("01-jobs-tree", s);
  // Dismiss (the classic row button was retired 2026-11-04; the call stays): a dismissed Job leaves the list by push.
  const jobs = await rpc({ action: "jobs-snapshot", id });
  const failedJob = jobs.jobs.find((job) => job.title.startsWith("MARK-FAILTASK"));
  const thread = jobs.agents.find((agent) => agent.jobId === failedJob.id)?.id;
  if (!thread) throw Error("No thread for the failed Job: " + JSON.stringify(failedJob));
  await rpc({ action: "thread-dismiss", id, threadId: thread });
  await waitFor(`!${workers}.includes('MARK-FAILTASK')`, s, "dismissed Job leaves the list");
  result.checks.push("A2 a dismissed Job leaves the Workers list");

  // F1: a worker running several commands in a row keeps one card that animates in once; only its current command changes.
  await evaluate(
    `(() => {
      const cards = (window.__cards = { enters: 0, mounts: 0, tools: [], node: null });
      const mine = (node) => node?.matches?.('#workers > .worker') && node.innerText.includes('MARK-STEPSTASK');
      document.addEventListener('animationstart', (event) => { if (event.animationName === 'row-in' && mine(event.target)) cards.enters++; });
      new MutationObserver(() => {
        const card = [...document.querySelectorAll('#workers > .worker')].find(mine);
        if (!card) return;
        if (card !== cards.node) { cards.node = card; cards.mounts++; }
        const tool = card.querySelector('.w-tool')?.innerText;
        if (tool && cards.tools.at(-1) !== tool) cards.tools.push(tool);
      }).observe(document.querySelector('#workers'), { childList: true, subtree: true, characterData: true });
    })()`,
    s,
  );
  await rpc({ action: "message", id, text: "MARK-STEPS" });
  // The keyboard stays on the card's title while its command line changes.
  await waitFor(`!!__cards.node?.querySelector('.w-tool')`, s, "steps card with its first command");
  await evaluate(`__cards.node.querySelector('.w-title').focus()`, s);
  await eventually(() => result.steps === STEPS, "steps worker did not run its commands");
  await delay(1200);
  const cards = await evaluate(
    `({ enters: __cards.enters, mounts: __cards.mounts, tools: __cards.tools, focused: document.activeElement === __cards.node.querySelector('.w-title') })`,
    s,
  );
  await shot("01e-steps-card", s);
  releaseSteps();
  result.cards = cards;
  if (cards.tools.length < 2) throw Error("F1 setup: the card never showed a changing current command: " + JSON.stringify(cards));
  if (cards.enters !== 1 || cards.mounts !== 1 || !cards.focused)
    throw Error("F1 the worker card flashed on command updates: " + JSON.stringify(cards));
  result.checks.push(`F1 one card through ${cards.tools.length} current commands: mounted once, animated in once`);
  await eventually(async () => (await workFor(id, "MARK-STEPSTASK")).status !== "running", "steps Job did not finish");

  // Inline streaming with sticky auto-scroll.
  await waitFor(`!document.querySelector('#composer-input').disabled`, s, "composer ready");
  const live = `(document.querySelector('#live-turn')?.innerText ?? '')`;
  const slow = await rpc({ action: "message", id, text: "MARK-SLOW" });
  await waitFor(`${live}.includes('STREAM-LINE-2')`, s, "stream started", 60);
  if (!(await evaluate(`document.querySelector('#feed').contains(document.querySelector('#live-turn'))`, s)))
    throw Error("Live turn is not inside the transcript scroll");
  const atBottom = await scrollInfo(s);
  if (atBottom.gap > 40) throw Error("Not following stream at bottom: " + JSON.stringify(atBottom));
  result.checks.push("S1 the live turn streams inside the transcript and follows the bottom");
  await shot("02-inline-stream", s);
  const box = await evaluate(
    `(() => { const r = document.querySelector('#feed').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    s,
  );
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -5000 }, s);
  await delay(300);
  const up = await scrollInfo(s);
  await waitFor(`${live}.includes('STREAM-LINE-8')`, s, "more chunks", 60);
  const stillUp = await scrollInfo(s);
  if (stillUp.top > up.top + 5 || stillUp.gap < 100) throw Error("Scrolled-up reader was yanked: " + JSON.stringify({ up, stillUp }));
  result.checks.push("S2 user scroll-up is respected while chunks arrive");
  // Back to the bottom (the new client has no Jump to latest button; End or scrolling down re-pins).
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 100000 }, s);
  await waitFor(`${live}.includes('STREAM-LINE-12')`, s, "later chunks", 60);
  const resumed = await scrollInfo(s);
  if (resumed.gap > 40) throw Error("Auto-scroll did not resume: " + JSON.stringify(resumed));
  result.checks.push("S3 auto-scroll resumes after scrolling back to the bottom");
  await settle(id, slow);
  await waitFor(
    `document.querySelector('#feed').innerText.includes('STREAM-LINE-15') && !document.querySelector('#feed .msg.agent.streaming')`,
    s,
    "final message",
    40,
  );
  const final = await scrollInfo(s);
  if (final.gap > 40) throw Error("Final message not at bottom: " + JSON.stringify(final));
  result.checks.push("S4 the final message replaces the live turn at the bottom");
  if (result.errors.length || result.httpErrors.length) throw Error("Browser errors captured");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
  try {
    result.diagnostic = await evaluate(
      `JSON.stringify({ live: document.querySelector('#live-turn')?.innerText.slice(-200), tail: document.querySelector('#feed').innerText.slice(-300) })`,
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
