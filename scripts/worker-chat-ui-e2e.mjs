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

const openWorker = async (s, id) => {
  const node = `document.querySelector('[data-action="thread"][data-thread="${id}"]')`;
  if (!(await evaluate(`!!${node}`, s))) {
    await evaluate(`document.querySelector('.job-toggle[data-job="${id}"]').click()`, s);
    await waitFor(`!!${node}`, s, "job expanded");
  }
  await evaluate(`${node}.click()`, s);
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
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, s); // colour assertions below are for the light theme
  await send("Page.navigate", { url: launch.toString() }, s);
  await waitFor(
    `document.querySelector('#messages')?.innerText.includes('Inspect scope then try an invalid scoped scout.') && !!document.querySelector('#messages .msg.them strong')`,
    s,
    "coordinator answer",
  );
  if (await evaluate(`!!document.querySelector('#messages .tool-call, #messages .thought')`, s))
    throw Error("C9 coordinator exposes internal tools or thinking");
  result.checks.push("C9 coordinator hides tool diagnostics");
  const ownerInput = (await rpc({ action: "show", id: project.id })).messages.find(
    (message) => message.role === "user" && message.text === "MARK-COORD Inspect scope then try an invalid scoped scout.",
  );
  if (ownerInput?.origin !== "owner") throw Error("C14 real owner admission lacks owner origin: " + JSON.stringify(ownerInput));
  result.checks.push("C14 real owner API transcript carries owner origin");
  const rendererChecks = await evaluate(
    `(async () => {
    const { coordinatorMessageHtml, chatMessageHtml } = await import('/app/chat.js');
    const { displayMessages } = await import('/app/transcript.js');
    const base = { at: 1, index: 1, images: [], role: 'user', text: '' };
    const html = (message) => coordinatorMessageHtml({ ...base, ...message });
    const internal = { origin: 'internal', text: 'Host recovery metadata not written by the owner' };
    const thought = { role: 'assistant', thinking: 'PRIVATE-THOUGHT', text: 'Public answer' };
    const reset = displayMessages([{ kind: 'reset', entryId: 1, at: 1, handoff: 'PRIVATE-HANDOFF' }])[0];
    const ready = html({ origin: 'internal', text: '[worker 11111111-1111-1111-1111-111111111111 ready: Ready fixture]\\nSummary: finished' });
    const owner = html({ origin: 'owner', text: '[Owner-local event github.follow]\\nI actually typed this.' });
    const earlier = html({ text: 'Legacy text [history](https://example.test/history)', images: [{ ref: '1.0.0', mime: 'image/png', bytes: 12 }] });
    return {
      earlier: earlier.includes('Earlier input') && !earlier.includes('>You ') && earlier.includes('Legacy text') && earlier.includes('href="https://example.test/history"') && earlier.includes('data-ref="1.0.0"'),
      ownerLabel: html({ origin: 'owner', text: 'I wrote this' }).includes('>You '),
      workerLabel: chatMessageHtml({ ...base, text: 'Legacy worker input' }, 'Worker').includes('>You '),
      archiveLabel: chatMessageHtml({ ...base, text: 'Legacy archive input' }, 'Assistant').includes('>You '),
      legacyEvent: !html({ text: '[Owner-local event github.follow]\\n- Useful change' }),
      internal: !html(internal),
      origin: displayMessages([{ kind: 'message', entryId: 1, at: 1, role: 'user', origin: 'internal', text: 'metadata', images: [] }])[0].origin === 'internal',
      ownerReport: html({ origin: 'owner', text: '[worker 11111111-1111-1111-1111-111111111111 ready: I typed this]' }).includes('msg you'),
      report: !html({ origin: 'internal', text: '[scout 11111111-1111-1111-1111-111111111111 done: Completed scout] details' }),
      thought: html(thought).includes('Public answer') && !html(thought).includes('PRIVATE-THOUGHT'),
      reset: !html(reset),
      tools: !html({ kind: 'tool', name: 'bash', argsPreview: 'PRIVATE-ARGS' }),
      owner: owner.includes('I actually typed this.') && owner.includes('msg you') && !owner.includes('event-card'),
      image: html({ origin: 'owner', images: [{ ref: '1.0.0', mime: 'image/png', bytes: 12 }] }).includes('data-ref="1.0.0"'),
      ready: !ready,
      checkpoint: !html({ origin: 'internal', text: '[worker 11111111-1111-1111-1111-111111111111 checkpoint: Waiting] details' }),
      stalled: !html({ origin: 'internal', text: '[worker 11111111-1111-1111-1111-111111111111 stalled: Quiet] details' }),
      event: !html({ origin: 'internal', text: '[Owner-local event github.follow]\\n- Useful change' }),
      compaction: html({ kind: 'compaction' }).includes('Context compacted'),
      workerThought: chatMessageHtml({ ...base, ...thought }, 'Worker').includes('PRIVATE-THOUGHT'),
      archiveReset: chatMessageHtml(reset, 'Assistant').includes('PRIVATE-HANDOFF'),
      workerTools: chatMessageHtml({ ...base, kind: 'tool', name: 'bash', argsPreview: 'PRIVATE-ARGS' }, 'Worker').includes('tool-call'),
    };
  })()`,
    s,
  );
  if (Object.values(rendererChecks).some((ok) => !ok))
    throw Error("C10-C13 coordinator/diagnostic renderer regressions: " + JSON.stringify(rendererChecks));
  result.checks.push("C10-C13 internal reports stay out of coordinator chat while owner images and worker/archive diagnostics remain");
  result.checks.push("C16 unknown coordinator inputs get a neutral label without losing text, links or attachments");
  await shot("01-clean-coordinator", s);
  const active = await rpc({ action: "jobs-snapshot", id: project.id });
  if (active.jobs.filter((job) => job.status === "running").length !== 2) throw Error("Jobs were not concurrent");
  result.checks.push("C7 two Jobs run concurrently");
  await openWorker(s, threadId);
  await waitFor(`!!document.querySelector('#worker-messages .tool-call[data-status="pending"]')`, s, "pending worker tool");
  if (!(await evaluate(`document.querySelector('#worker-messages .tool-call[data-status="pending"] .tool-icon')?.innerText === '…'`, s)))
    throw Error("Pending tool icon wrong");
  result.checks.push("C2 pending tool background");
  if (
    !(await evaluate(
      `!!document.querySelector('#worker-messages .msg.you .text') && document.querySelector('#worker-messages').compareDocumentPosition(document.querySelector('[data-inline-thread-send]')) & Node.DOCUMENT_POSITION_FOLLOWING`,
      s,
    ))
  )
    throw Error("Chat bubbles or composer order wrong");
  result.checks.push("C3 worker chat layout");
  await evaluate(
    `document.querySelector('[data-inline-thread-send] textarea').value = 'Keep this draft'; document.querySelector('[data-inline-thread-send] textarea').dispatchEvent(new Event('input', { bubbles: true }))`,
    s,
  );
  await waitFor(`!!document.querySelector('#worker-messages .msg.them strong')`, s, "live worker answer");
  if ((await evaluate(`document.querySelector('[data-inline-thread-send] textarea').value`, s)) !== "Keep this draft")
    throw Error("Refresh lost draft");
  result.checks.push("C4 live refresh preserves draft");
  const colors = await evaluate(
    `[...document.querySelectorAll('#worker-messages .tool-call')].map(n => ({ status: n.dataset.status, color: getComputedStyle(n.querySelector('.tool-icon')).backgroundColor }))`,
    s,
  );
  if (
    !colors.some((c) => c.status === "ok" && c.color === "rgb(220, 235, 223)") ||
    !colors.some((c) => c.status === "error" && c.color === "rgb(246, 216, 211)")
  )
    throw Error("Worker tool state icon colours wrong: " + JSON.stringify(colors));
  await evaluate(`document.querySelector('#worker-messages .tool-call summary').click()`, s);
  if (!(await evaluate(`document.querySelector('#worker-messages .tool-call pre').innerText.includes('Result:')`, s)))
    throw Error("Missing expanded worker tool result");
  result.checks.push("C1 worker tool colors and expandable results");
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
  await delay(250);
  if (await evaluate(`!!document.querySelector('#messages [data-index="${reportInput.entryId}"]')`, s))
    throw Error("C17 internal report leaked into coordinator chat");
  if (await evaluate(`!!document.querySelector('#messages .msg.you[data-index="${reportInput.entryId}"]')`, s))
    throw Error("C15 real internal report rendered as owner speech");
  result.checks.push("C15 real agent report API carries internal origin and is not labeled You");
  const checkpoint = await evaluate(
    `(async () => {
    const decisions = await import('/app/decisions.js');
    const workers = await import('/app/workers.js');
    const atCheckpoint = (snap) => ({ ...snap, jobs: snap.jobs.map(job => job.id === ${JSON.stringify(threadId)} ? { ...job, status: 'checkpoint', checkpoint: { summary: 'Waiting for owner decision', proof: ['artifact:checkpoint-proof'], gaps: ['Decision needed'] }, ready: null } : job) });
    // The real worker may settle meanwhile and a live refresh would replace the injected Job: refreshes see the same checkpoint,
    // and one already in flight (its Jobs read sent before the patch) finishes first.
    const shell = await import('/app/shell.js');
    const realFetch = window.fetch;
    window.fetch = async (url, init) => {
      const response = await realFetch(url, init);
      if (url !== '/api' || JSON.parse(init.body).action !== 'jobs-snapshot' || !response.ok) return response;
      return new Response(JSON.stringify(atCheckpoint(await response.json())), { status: response.status, headers: response.headers });
    };
    const settled = async () => {
      for (let i = 0; shell.polling !== null; i++) {
        if (i > 500) throw new Error('refresh did not settle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await settled();
    decisions.setJobsSnap(atCheckpoint(decisions.jobsSnap));
    await workers.inspectThread(${JSON.stringify(threadId)});
    const pane = document.querySelector('#inline-thread');
    const answer = { intermediate: pane.innerText.includes('Intermediate checkpoint'), summary: pane.innerText.includes('Waiting for owner decision'), proof: pane.innerText.includes('checkpoint-proof'), noApprove: !pane.querySelector('[data-action="job-approve"]') };
    window.fetch = realFetch;
    await settled();
    decisions.setJobsSnap(await shell.api({ action: 'jobs-snapshot', id: ${JSON.stringify(project.id)} }));
    await workers.inspectThread(${JSON.stringify(threadId)});
    return answer;
  })()`,
    s,
  );
  if (Object.values(checkpoint).some((value) => !value)) throw Error("C18 checkpoint details wrong: " + JSON.stringify(checkpoint));
  result.checks.push("C18 checkpoint is intermediate with proof and no approval");

  await shot("02-worker-chat", s);
  await evaluate(`document.querySelector('[data-inline-thread-send] textarea').focus()`, s);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, s);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, s);
  await waitFor(
    `document.querySelector('#worker-messages').innerText.includes('Keep this draft') && document.querySelector('[data-inline-thread-send] textarea').value === ''`,
    s,
    "follow-up",
  );
  result.checks.push("C6 Enter sends worker follow-up");
  await evaluate(`document.querySelector('[data-action="thread-close"]').click()`, s);
  await delay(2500);
  if (
    !(await evaluate(
      `document.querySelector('#inline-thread').hidden && !document.querySelector('[data-panel="coordinator"]').hidden && !new URL(location.href).searchParams.has('worker')`,
      s,
    ))
  )
    throw Error("Closed worker reopened");
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
  await waitFor(`document.querySelector('#worker-messages')?.innerText.includes('History turn 33')`, s, "latest history page");
  const shown = () => `document.querySelectorAll('#worker-messages .msg.you').length`;
  const latestCount = await evaluate(shown(), s);
  await evaluate(`document.querySelector('#worker-history-pages [data-action="thread-older"]').click()`, s);
  await waitFor(`${shown()} > ${latestCount}`, s, "older history page");
  result.checks.push("C8 opens latest page with older history accessible");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, s);
  await shot("03-worker-mobile", s, true);
  if (result.errors.length || result.httpErrors.length) throw Error("Browser errors captured");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
  try {
    result.diagnostic = await evaluate(
      `document.querySelector('#job-tree').innerText + '\\n---\\n' + document.querySelector('#dialog').innerText.slice(0, 2000)`,
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
