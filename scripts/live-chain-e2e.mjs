// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in live-chain-failures.md before implementation.
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const artifacts = join(repo, "artifacts", `live-chain-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `live-chain-${randomUUID()}`);
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
const think = (text) => chunk({ role: "assistant", reasoning_content: text }, null);
const text = (value) => chunk({ role: "assistant", content: value }, null);
const tool = (name, args) =>
  chunk(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    null,
  );
const end = (reason) => chunk({}, reason) + "data: [DONE]\n\n";
// Streams parts with pauses so the browser sees each step live; numbers are pauses in ms.
async function stream(res, parts) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const part of parts) {
    if (typeof part === "number") await delay(part);
    else res.write(part);
  }
  res.end();
}
const model = createServer((req, res) => {
  req.setEncoding("utf8");
  let body = "";
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", async () => {
    const input = JSON.parse(body),
      msgs = input.messages;
    const lastUser = msgs.findLastIndex((m) => m.role === "user");
    const userText = String(
      typeof msgs[lastUser]?.content === "string" ? msgs[lastUser].content : JSON.stringify(msgs[lastUser]?.content ?? ""),
    );
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? "none";
    const stage = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length;
    result.calls.push({ at: Date.now(), marker, stage });
    if (marker === "MARK-LONG" && stage < LONG) return stream(res, [tool("projects_knowledge_list", {}), end("tool_calls")]);
    if (marker === "MARK-LONG") return stream(res, [text("LONG-DONE after many steps."), end("stop")]);
    if (marker === "MARK-CHAIN" && stage === 0)
      return stream(res, [
        think("Planning the check"),
        400,
        think(" of the index"),
        400,
        text("STEP-ONE I will list knowledge."),
        600,
        tool("projects_knowledge_list", {}),
        end("tool_calls"),
      ]);
    if (marker === "MARK-CHAIN" && stage === 1)
      return stream(res, [
        800,
        think("Choosing a document"),
        600,
        text("STEP-TWO reading MEMORY.md."),
        600,
        tool("projects_knowledge_read", { path: "MEMORY.md" }),
        end("tool_calls"),
      ]);
    if (marker === "MARK-CHAIN") {
      await hold;
      return stream(res, [think("Composing the answer"), 1500, text("STEP-FINAL done."), end("stop")]);
    }
    return stream(res, [text(`Answer ${marker}.`), end("stop")]);
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
const scrollInfo = (s) =>
  evaluate(
    `(() => { const t = document.querySelector('#feed'); return { top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight, height: t.scrollHeight }; })()`,
    s,
  );
const box = (sel, s) =>
  evaluate(
    `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, visible: !!(r.width || r.height) && getComputedStyle(n).visibility !== 'hidden' }; })()`,
    s,
  );
const LONG = 36;
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
    name: "Live chain",
    cwd: workspace,
    objective: "Disposable live chain fixture",
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
  const legacy = randomUUID();
  for (const [path, body] of [
    ["decisions/issue-95-generic-flow.md", "# Flow decisions\n"],
    ["plans/issue-generic-expanded-sources.md", "# Sources plan\n"],
    ["plans/a-very-long-document-name-that-must-truncate-inside-the-rail-card-instead-of-overflowing.md", "# Long\n"],
    [`research/legacy/${legacy}.md`, "# Legacy answer\n"],
    ["research/summary.md", "# Research\n"],
  ])
    await rpc({ action: "knowledge-write", id, path, text: body, expectedRevision: null });
  const ask = async (text) => {
    const job = await rpc({ action: "message", id, text });
    const done = await settle(id, job);
    if (done.state !== "done") throw Error(`${text} failed: ${done.error}`);
  };
  await ask("MARK-LONG run a long chain");

  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", id);
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  await waitFor(
    `document.body.dataset.ready === "1" && document.querySelector('#feed').innerText.includes('LONG-DONE')`,
    s,
    "project loaded",
  );
  await delay(400);

  // Long turn: the owner's message and every step stay in the transcript (failure 5); older pages are one request away.
  const long = { you: false, tools: 0 };
  for (let before; ;) {
    const page = await rpc({ action: "chat-history", id, ...(before ? { before } : {}) });
    for (const item of page.items) {
      if (item.kind === "message" && item.text?.includes("MARK-LONG run a long chain")) long.you = true;
      if (item.kind === "tool-call") long.tools++;
    }
    if (long.you || page.before === null) break;
    before = page.before;
  }
  if (!long.you || long.tools < LONG) throw Error("Long turn truncated: " + JSON.stringify(long));
  result.checks.push(`LC5 a ${LONG}-tool turn keeps the owner's message and all ${LONG} steps`);

  // Memory (the classic rail Knowledge card and Knowledge tab tree, O1 and KT1-KT3, were retired 2026-11-04): the Memory node lists the
  // decision by title and opens it (KT4).
  await evaluate(`document.querySelector('#tree .tree-project.selected [data-memory-node]').click()`, s);
  await waitFor(
    `!!document.querySelector('#focus-view .mem-entry[data-memory="decisions/issue-95-generic-flow.md"]')`,
    s,
    "memory lists the decision",
  );
  await evaluate(`document.querySelector('#focus-view .mem-entry[data-memory="decisions/issue-95-generic-flow.md"]').click()`, s);
  await waitFor(`(document.querySelector('#focus-view')?.innerText ?? '').includes('Flow decisions')`, s, "decision opens");
  result.checks.push("KT4 Memory lists the decision and opens its document");
  await shot("01-memory", s);
  await evaluate(`document.querySelector('#tree .tree-project.selected [data-chat="main"]').click()`, s);
  await waitFor(`document.querySelector('#feed').innerText.includes('LONG-DONE')`, s, "back to Main");

  // Live chain (failures 1-4, 6): sample the DOM every 50 ms during a three-step turn.
  // `status` is the live turn's status line plus the status bar's activity item, which stays on screen while the reader scrolls.
  await evaluate(
    `(() => { window.__samples = []; window.__timer = setInterval(() => { const live = document.querySelector('#live-turn'); window.__samples.push({ t: performance.now(), messages: [...document.querySelectorAll('#feed > .turn')].map(n => n.innerText).join('\\n'), live: live?.innerText ?? '', status: document.querySelector('.sl-item[data-item="activity"]')?.innerText ?? '', pill: '' }); }, 50); const ta = document.querySelector('#composer-input'); ta.value = 'MARK-CHAIN check knowledge'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`,
    s,
  );
  await waitFor(
    `window.__samples.some(x => (x.messages + x.live).includes('STEP-TWO')) && /working|thinking/i.test(document.querySelector('.sl-item[data-item="activity"]').innerText) && document.querySelector('#feed').innerText.includes('STEP-TWO')`,
    s,
    "stage two committed",
  );
  // Held before the final answer: scroll up; the status bar must still say the coordinator is working (failure 3).
  await delay(600);
  const transcriptPoint = await evaluate(
    `(() => { const r = document.querySelector('#feed').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    s,
  );
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...transcriptPoint, deltaX: 0, deltaY: -5000 }, s);
  await delay(300);
  if (
    !(await evaluate(
      `document.querySelector('.sl-item[data-item="activity"]').innerText !== 'idle' && !!document.querySelector('.sl-item[data-item="activity"]').offsetParent`,
      s,
    ))
  )
    throw Error("No working indicator while scrolled up");
  await shot("03-scrolled-working", s);
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...transcriptPoint, deltaX: 0, deltaY: 100000 }, s);
  await waitFor(
    `(() => { const t = document.querySelector('#feed'); return t.scrollHeight - t.scrollTop - t.clientHeight < 40; })()`,
    s,
    "back at latest",
  );
  await shot("04-live-chain", s);
  releaseHold();
  await waitFor(
    `document.querySelector('#feed').innerText.includes('STEP-FINAL') && !document.querySelector('#live-turn').innerText.trim()`,
    s,
    "final answer",
  );
  await delay(300);
  const samples = await evaluate(`(clearInterval(window.__timer), window.__samples)`, s);
  result.samples = samples
    .map((x) => ({
      t: Math.round(x.t),
      steps: ["MARK-CHAIN check", "STEP-ONE", "STEP-TWO", "STEP-FINAL"].filter((k) => x.messages.includes(k)).length,
      live: x.live.replace(/\s+/g, " ").slice(0, 120),
      pill: x.pill,
    }))
    .filter((x, i, all) => !i || JSON.stringify({ ...x, t: 0 }) !== JSON.stringify({ ...all[i - 1], t: 0 }));
  const seen = (key) => samples.findIndex((x) => x.messages.includes(key) || x.live.includes(key));
  for (const key of ["STEP-ONE", "STEP-TWO"]) {
    const first = seen(key);
    if (first < 0) throw Error(`${key} never shown`);
    const gap = samples.slice(first).find((x) => !x.messages.includes(key) && !x.live.includes(key));
    if (gap) throw Error(`${key} vanished mid-turn: ` + JSON.stringify(gap).slice(0, 400));
  }
  result.checks.push("LC1/LC2 streamed step text never vanishes once shown, through tool rounds and refreshes");
  const finalAt = samples.findIndex((x) => x.messages.includes("STEP-FINAL"));
  const runStart = samples.findIndex((x) => x.messages.includes("MARK-CHAIN check knowledge"));
  const idle = samples.slice(runStart + 4, finalAt).filter((x) => !x.status || x.status === "idle");
  if (runStart < 0 || idle.length)
    throw Error(`No working indicator in ${idle.length} samples: ` + JSON.stringify(idle[0] ?? {}).slice(0, 400));
  result.checks.push("LC3 a working indicator is visible for the whole run, including while scrolled up");
  if (!samples.some((x) => x.live.includes("Planning the check of the index"))) throw Error("Live reasoning summary not shown");
  const thoughts = await evaluate(`[...document.querySelectorAll('#feed .thinking .th-preview')].map(n => n.innerText)`, s);
  if (!thoughts.some((t) => t.includes("Planning the check of the index")) || !thoughts.some((t) => t.includes("Choosing a document")))
    throw Error("Committed thoughts missing: " + JSON.stringify(thoughts));
  result.checks.push("LC4 reasoning summaries show live and stay as collapsed Thinking lines in the transcript");
  // LC6 (no raw tool names in the live status) is retired: the new client shows tool names on purpose, terminal-style.
  const order2 = await evaluate(
    `(() => { const turn = [...document.querySelectorAll('#feed > .turn')].find(n => n.innerText.includes('MARK-CHAIN check knowledge')); const parts = [...turn.querySelectorAll('.msg, .thinking, .memory-row, .tool-row, .tool-group')].map(n => n.classList.contains('thinking') ? 'thought:' + n.querySelector('.th-preview').innerText : n.matches('.memory-row, .tool-row, .tool-group') ? 'tool:' + (n.dataset.tool ?? n.innerText) : n.innerText); const want = ['MARK-CHAIN check knowledge', 'thought:Planning the check', 'STEP-ONE', 'tool:', 'thought:Choosing a document', 'STEP-TWO', 'tool:', 'STEP-FINAL']; let at = -1; return want.map(k => (at = parts.findIndex((p, i) => i > at && p.includes(k)))); })()`,
    s,
  );
  if (order2.some((v) => v < 0)) throw Error("Chain out of order: " + JSON.stringify(order2));
  result.checks.push("LC7 the full chain reads in order: message, thought, text, tool, thought, text, tool, answer");
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
