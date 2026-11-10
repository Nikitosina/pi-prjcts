// Browser E2E with an isolated host and a local fake model. No real providers, no network.
// Failure cases recorded in multi-chat-failures.md before implementation.
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const artifacts = join(repo, "artifacts", `multi-chat-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `multi-chat-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace"),
  agentDir = join(root, "agent"),
  userHome = join(root, "userhome");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error("Clear runtime overrides first");
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, "report.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
writeFileSync(join(workspace, "README.md"), "fixture\n");

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
const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : JSON.stringify(content ?? "");
// Coordinator turns are scripted by marker; each step sees earlier tool results.
const scripts = {
  "MARK-DELEG": [
    [
      "agents",
      {
        action: "spawn",
        role: "scout",
        title: "MARK-SCOUTJOB look around",
        brief: "MARK-SCOUTJOB look around",
        requestId: "multi-chat-scout",
      },
    ],
    ["agents", { action: "status" }],
  ],
  "MARK-ASK": [["projects_question", { question: "Pick a colour for chat two?", choices: ["red", "blue"] }]],
};
const model = createServer((req, res) => {
  req.setEncoding("utf8");
  let body = "";
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", async () => {
    const input = JSON.parse(body),
      msgs = input.messages;
    const tools = (input.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
    const coordinator = tools.includes("agents");
    const lastUser = msgs.findLastIndex((m) => m.role === "user");
    const userText = contentText(msgs[lastUser]?.content);
    const history = msgs
      .filter((m) => m.role === "user")
      .map((m) => contentText(m.content))
      .join("\n");
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? "none";
    const results = msgs
      .slice(lastUser + 1)
      .filter((m) => m.role === "tool")
      .map((m) => contentText(m.content));
    result.calls.push({
      coordinator,
      marker,
      stage: results.length,
      tools,
      user: userText.slice(0, 600),
      history: history.slice(-3000),
      results,
    });
    const reply = (text) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(text);
    };
    if (!coordinator) return reply(say(marker === "MARK-SCOUTJOB" ? "SCOUT-RESULT-42" : `Worker ${marker}`));
    if (/^\[(worker|scout|reviewer) /.test(userText))
      return reply(say(`REPORT-ACK ${userText.includes("SCOUT-RESULT-42") ? "with-result" : "no-result"}`));
    if (userText.startsWith("Owner answered your question")) return reply(say("ANSWER-ACK"));
    if (marker === "MARK-SLOW") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "" }, null));
      for (let i = 0; i < 12; i++) {
        await delay(500);
        if (res.destroyed) return;
        res.write(chunk({ content: `STREAM-LINE-${i}\n\n` }, null));
      }
      res.end(chunk({ content: "STREAM-END" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
      return;
    }
    const steps = scripts[marker] ?? [];
    if (results.length < steps.length) return reply(call(...steps[results.length]));
    return reply(say(`Done ${marker}.`));
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
const env = {
  ...process.env,
  HOME: userHome,
  PI_PROJECTS_HOME: home,
  PI_PROJECTS_HOST: "1",
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
};
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const log = createWriteStream(join(artifacts, "host.log"), { flags: "wx", mode: 0o600 });
let host,
  hostEnded = true,
  hostExit = Promise.resolve();
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
async function startHost() {
  host = spawn(process.execPath, [join(repo, "src/host.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.pipe(log, { end: false });
  host.stderr.pipe(log, { end: false });
  hostEnded = false;
  hostExit = new Promise((ok) =>
    host.once("exit", () => {
      hostEnded = true;
      ok();
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
}
async function stopHost() {
  await rpc({ action: "shutdown" });
  await Promise.race([hostExit, delay(15000)]);
  if (!hostEnded) throw Error("Host did not stop");
}
const rejects = async (input, pattern, label) => {
  try {
    await rpc(input);
  } catch (error) {
    if (pattern.test(error.message)) return error.message;
    throw Error(`${label}: wrong error ${error.message}`);
  }
  throw Error(`${label}: accepted`);
};

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

const settle = async (id, chatId, job) =>
  eventually(async () => {
    const view = await rpc({ action: "show", id, chatId });
    const found = view.jobs.find((j) => j.id === job.id);
    return ["done", "failed", "interrupted"].includes(found?.state) && found;
  }, "Job did not settle");
const ask = async (id, chatId, text) => {
  const job = await rpc({ action: "message", id, text, ...(chatId ? { chatId } : {}) });
  const done = await settle(id, chatId, job);
  if (done.state !== "done") throw Error(`${text} failed: ${done.error}`);
  return done;
};
const turns = (marker) => result.calls.filter((call) => call.coordinator && call.marker === marker);
const transcript = async (id, chatId) => (await rpc({ action: "show", id, chatId })).messages.map((m) => m.text).join("\n");
const chatButtons = (s) =>
  evaluate(
    `[...document.querySelectorAll('#tree .tree-project.selected [data-chat]')].map(n => ({ id: n.dataset.chat, title: n.querySelector('.name')?.innerText ?? '', on: n.classList.contains('current') }))`,
    s,
  );
const setComposer = (s, value) =>
  evaluate(
    `(() => { const t = document.querySelector('#composer-input'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    s,
  );
const click = (s, selector) =>
  evaluate(
    `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw Error('missing ' + ${JSON.stringify(selector)}); n.click(); })()`,
    s,
  );
try {
  await startHost();
  const project = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "Chats fixture",
    cwd: workspace,
    objective: "Disposable multi-chat fixture",
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

  // F1: an existing project (no stored chat list) opens with exactly Main, the root conversation; no chatId means Main.
  await ask(id, undefined, "MARK-MAIN hello main");
  const first = await rpc({ action: "show", id });
  if (
    !Array.isArray(first.chats) ||
    first.chats.length !== 1 ||
    first.chats[0].id !== "main" ||
    first.chats[0].title !== "Main" ||
    first.chatId !== "main"
  )
    throw Error("Default chat list wrong: " + JSON.stringify(first.chats));
  if (!first.messages.some((m) => m.text === "Done MARK-MAIN.")) throw Error("Main is not the root transcript");
  result.checks.push("F1 a project without a chat list opens with one chat, Main, on the existing root conversation and transcript");
  await rejects({ action: "show", id, chatId: randomUUID() }, /Unknown chat/, "unknown chat");
  await rejects({ action: "message", id, chatId: randomUUID(), text: "x" }, /Unknown chat/, "unknown chat message");
  result.checks.push("F4 unknown chat IDs are refused for show and message");

  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", id);
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  // A headless page has no window focus, so :focus-within never matches without this.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  const feed = `document.querySelector('#feed').innerText`,
    chats = `document.querySelectorAll('#tree .tree-project.selected [data-chat]')`,
    current = `document.querySelector('#tree .tree-project.selected [data-chat].current')`,
    live = `(document.querySelector('#live-turn')?.innerText.trim() ?? '')`;
  await waitFor(`document.body.dataset.ready === "1" && ${feed}.includes('Done MARK-MAIN')`, s, "project loaded");
  const initial = await chatButtons(s);
  if (initial.length !== 1 || initial[0].title !== "Main" || !initial[0].on) throw Error("Chat list wrong: " + JSON.stringify(initial));

  // F2/F12: a new chat is its own conversation, selected, with an empty transcript; the URL carries it.
  await click(s, "#tree [data-new-chat]");
  await waitFor(`${chats}.length === 2 && ${current}?.dataset.chat !== 'main'`, s, "new chat selected");
  const chatId = await evaluate(`${current}.dataset.chat`, s);
  await waitFor(`!${feed}.includes('MARK-MAIN') && !!document.querySelector('#feed .empty-chat')`, s, "empty new chat");
  if (new URL(await evaluate("location.href", s)).searchParams.get("chat") !== chatId) throw Error("URL does not carry the chat");
  result.checks.push("F2/F12/F15 New chat creates and selects an empty chat; the URL names it");
  await shot("01-new-chat", s);

  // F5/F6/F8: delegate from the new chat; the report returns there and only there; coordinator-only tools work there.
  await setComposer(s, "MARK-DELEG please scout");
  await evaluate(`document.querySelector('#composer').requestSubmit()`, s);
  await waitFor(`${feed}.includes('REPORT-ACK')`, s, "report in chat two", 400);
  const deleg = turns("MARK-DELEG").at(-1),
    mainTurn = turns("MARK-MAIN")[0];
  if (JSON.stringify([...deleg.tools].sort()) !== JSON.stringify([...mainTurn.tools].sort()))
    throw Error("Chat tools differ from Main: " + JSON.stringify({ chat: deleg.tools, main: mainTurn.tools }));
  if (deleg.history.includes("MARK-MAIN")) throw Error("Chat two saw Main history");
  const [receipt, workers] = deleg.results;
  if (/coordinator-only|Error/.test(receipt + workers) || !/MARK-SCOUTJOB/.test(workers))
    throw Error("Coordinator tools refused in chat two: " + receipt + workers);
  result.checks.push("F5/F6 a new chat gets the same coordinator tools and they are authorized there; history is separate");
  const report = result.calls.find((c) => c.coordinator && /^\[(worker|scout|reviewer) /.test(c.user));
  if (!report.user.includes("SCOUT-RESULT-42") || !report.history.includes("MARK-DELEG") || report.history.includes("MARK-MAIN"))
    throw Error("Report reached the wrong conversation: " + report.history.slice(-400));
  // Ended workers sit in the collapsed history; open it first.
  await waitFor(
    `(document.querySelector('#workers [data-worker-history][aria-expanded="false"]')?.click(), !!document.querySelector('#workers [data-open-worker]'))`,
    s,
    "the scout in chat two's Workers list",
  );
  await click(s, "#workers [data-open-worker]");
  await waitFor(
    `(document.querySelector('#focus-view')?.innerText ?? '').includes('SCOUT-RESULT-42')`,
    s,
    "scout evidence in the worker view",
  );
  await click(s, '#focus-view [data-cmd="leave-focus"]');
  await waitFor(`${feed}.includes('REPORT-ACK')`, s, "back to chat two");
  const mainText = await transcript(id, "main");
  if (/\[(worker|scout|reviewer) [0-9a-f-]{36} /.test(mainText) || mainText.includes("REPORT-ACK")) throw Error("Report also went to Main");
  result.checks.push("F8 the worker report goes to the delegating chat only while its details remain reachable in the worker view");
  await shot("02-report-in-chat", s);

  // F6/F16: the shared pool of agents is one list for the project.
  const snap = await rpc({ action: "jobs-snapshot", id });
  if (snap.agents.length !== 1 || !snap.agents[0].title.includes("MARK-SCOUTJOB"))
    throw Error("Agents wrong: " + JSON.stringify(snap.agents));
  result.checks.push("F6/F16 work delegated from a chat lands in the one shared Jobs snapshot");

  // F12: switching chats swaps the transcript and the Workers list (per-chat drafts and the classic tab strip are retired).
  await click(s, '#tree [data-chat="main"]');
  await waitFor(`${feed}.includes('Done MARK-MAIN') && !${feed}.includes('REPORT-ACK')`, s, "main selected");
  await waitFor(`!(document.querySelector('#workers')?.innerText ?? '').includes('MARK-SCOUTJOB')`, s, "Main's Workers list");
  await click(s, `#tree [data-chat="${chatId}"]`);
  await waitFor(`${feed}.includes('REPORT-ACK') && !${feed}.includes('Done MARK-MAIN')`, s, "chat two selected");
  await waitFor(
    `(document.querySelector('#workers [data-worker-history][aria-expanded="false"]')?.click(), (document.querySelector('#workers')?.innerText ?? '').includes('MARK-SCOUTJOB'))`,
    s,
    "chat two's Workers list",
  );
  result.checks.push("F12 switching chats swaps the transcript and the Workers list shows only that chat's work");
  // Other projects' rows in the tree are drawn from the host's list: it must carry each chat's own activity.
  await new Promise((done) => setTimeout(done, 1700));
  const listed = (await rpc({ action: "list" })).find((project) => project.id === id);
  const perChat = listed?.activity?.chats;
  if (!perChat || !perChat.main || !perChat[chatId] || typeof perChat[chatId].working !== "boolean")
    throw Error("List lacks per-chat activity: " + JSON.stringify(listed?.activity));
  result.checks.push("The project list carries each chat's own activity, so the tree shows each chat's state");

  // F13: the live turn belongs to its chat.
  const slow = await rpc({ action: "message", id, chatId, text: "MARK-SLOW stream please" });
  await waitFor(`${live}.includes('STREAM-LINE')`, s, "live turn in chat two");
  await click(s, '#tree [data-chat="main"]');
  await waitFor(`${feed}.includes('Done MARK-MAIN')`, s, "main selected during stream");
  for (let i = 0; i < 6; i++) {
    if (await evaluate(live, s)) throw Error("Chat two stream shown in Main");
    await delay(250);
  }
  const busyList = (await rpc({ action: "show", id })).chats;
  if (!busyList.find((c) => c.id === chatId)?.busy || busyList.find((c) => c.id === "main").busy)
    throw Error("Chat busy flags wrong: " + JSON.stringify(busyList));
  await shot("03-main-while-chat-streams", s);
  result.checks.push("F13 the live stream of one chat never shows in another; the host marks the busy chat");
  await settle(id, chatId, slow);
  await click(s, `#tree [data-chat="${chatId}"]`);
  await waitFor(`${feed}.includes('STREAM-END')`, s, "stream committed");

  // F10: an answer to a question asked in chat two wakes chat two.
  await ask(id, chatId, "MARK-ASK need a decision");
  const question = (await rpc({ action: "show", id })).inbox.find((item) => item.kind === "question" && !item.result);
  await rpc({ action: "answer", id, entry: question.id, text: "blue" });
  await eventually(async () => (await transcript(id, chatId)).includes("ANSWER-ACK"), "Answer did not reach chat two");
  if ((await transcript(id, "main")).includes("Owner answered")) throw Error("Answer went to Main");
  result.checks.push("F10 an owner answer wakes the chat that asked");

  // F14: rename with /name persists and shows; reload keeps chat and title (F15).
  await setComposer(s, "/name Research");
  await evaluate(`document.querySelector('#composer').requestSubmit()`, s);
  await waitFor(`${current}?.innerText.includes('Research')`, s, "renamed");
  await send("Page.reload", {}, s);
  await waitFor(
    `document.body.dataset.ready === "1" && ${current}?.dataset.chat === ${JSON.stringify(chatId)} && ${current}.innerText.includes('Research') && ${feed}.includes('ANSWER-ACK')`,
    s,
    "reload keeps chat",
  );
  result.checks.push("F14/F15 /name renames; reload keeps the selected chat");
  await shot("04-renamed", s);

  // F20-F29: archive from the row's button and Mod+Shift+E. Spare is a third chat after Research.
  const spare = (await rpc({ action: "chat-create", id, title: "Spare" })).id;
  await waitFor(`${chats}.length === 3 && ${current}?.dataset.chat === ${JSON.stringify(chatId)}`, s, "spare chat listed");
  const archived = async (chat) => (await rpc({ action: "show", id })).chats.find((c) => c.id === chat)?.archived === true;
  const archiveButton = (chat) => `document.querySelector('#tree [data-archive-chat="${chat}"]')`;
  const mac = await evaluate(`/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)`, s);
  const shortcut = mac ? "⌘⇧E" : "Ctrl+Shift+E";
  const press = async (key, code, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers }, s);
  };
  const MOD = mac ? 4 : 2,
    SHIFT = 8;
  const archiveKey = () => press("E", "KeyE", MOD | SHIFT);
  const hover = async (selector) => {
    const box = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      s,
    );
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box }, s);
  };
  const shown = (chat) => `getComputedStyle(${archiveButton(chat)}).opacity === '1'`;
  const rowFacts = await evaluate(
    `[...document.querySelectorAll('#tree .tree-project.selected [data-chat]')].map((row) => { const b = document.querySelector('#tree [data-archive-chat="' + row.dataset.chat + '"]'); return { id: row.dataset.chat, has: !!b, nested: !!row.querySelector('button'), label: b?.getAttribute('aria-label') ?? '', title: b?.title ?? '', opacity: b ? getComputedStyle(b).opacity : '' }; })`,
    s,
  );
  const research = rowFacts.find((row) => row.id === chatId);
  if (
    rowFacts.find((row) => row.id === "main").has ||
    rowFacts.some((row) => row.nested) ||
    !research?.has ||
    !research.label.includes("Research") ||
    !research.title.includes(shortcut) ||
    research.opacity !== "0"
  )
    throw Error("Archive buttons wrong: " + JSON.stringify(rowFacts));
  await hover(`#tree [data-chat="${spare}"]`);
  await waitFor(shown(spare), s, "archive button on hover");
  await shot("05-archive-hover", s);
  // F31: hovering the tree shows no 1–9 badges; the digits still switch chats of the selected project in tree order.
  if (await evaluate(`!!document.querySelector('#tree kbd')`, s)) throw Error("Tree rows still show shortcut badges");
  await evaluate(`document.activeElement?.blur()`, s);
  for (const [key, chat] of [
    ["3", spare],
    ["1", "main"],
    ["2", chatId],
  ]) {
    await press(key, `Digit${key}`);
    await waitFor(`${current}?.dataset.chat === ${JSON.stringify(chat)}`, s, `digit ${key} opens its chat`);
  }
  await hover(`#tree [data-chat="${spare}"]`);
  result.checks.push("F31 hovering the tree shows no shortcut badges; digits 1–9 still switch chats");
  await evaluate(`document.querySelector('#tree [data-chat="main"]').focus()`, s);
  await press("ArrowDown", "ArrowDown");
  if ((await evaluate(`document.activeElement?.dataset.chat ?? document.activeElement?.className`, s)) !== chatId)
    throw Error("Arrow down left the chat rows");
  await waitFor(shown(chatId), s, "archive button on keyboard focus");
  result.checks.push(
    "F20/F21/F29 non-Main rows get a sibling archive button named for the chat with the shortcut; hover and focus show it",
  );

  // F30: the button opens a confirmation naming the chat; Cancel and Escape change nothing and give focus back.
  const dialogOpen = `!!document.querySelector('#archive-chat')?.open`;
  const confirmArchive = async () => {
    await waitFor(dialogOpen, s, "archive confirmation");
    await click(s, "#archive-chat [data-archive-confirm]");
  };
  await evaluate(`${archiveButton(chatId)}.focus()`, s);
  await click(s, `#tree [data-archive-chat="${chatId}"]`);
  await waitFor(
    `${dialogOpen} && document.querySelector('#archive-chat').innerText.includes('Research') && document.querySelector('#archive-chat').contains(document.activeElement)`,
    s,
    "dialog names the chat and takes focus",
  );
  await shot("06-archive-confirm", s);
  if (await archived(chatId)) throw Error("Archived before confirmation");
  await click(s, "#archive-chat [data-archive-cancel]");
  await waitFor(`!${dialogOpen} && document.activeElement === ${archiveButton(chatId)}`, s, "cancel returns focus");
  await click(s, `#tree [data-archive-chat="${chatId}"]`);
  await waitFor(dialogOpen, s, "dialog again");
  await press("Escape", "Escape");
  await waitFor(`!${dialogOpen}`, s, "escape closes the dialog");
  await delay(300);
  if ((await archived(chatId)) || (await evaluate(`${current}?.dataset.chat`, s)) !== chatId || (await chatButtons(s)).length !== 3)
    throw Error("Cancel or Escape changed the chat");
  result.checks.push("F30 the archive button asks first, naming the chat; Cancel and Escape keep chat, selection and focus");

  // F22: a busy chat is refused with a reason; its turn keeps running.
  const spareTurn = await rpc({ action: "message", id, chatId: spare, text: "MARK-SLOW busy spare" });
  await eventually(async () => (await rpc({ action: "show", id })).chats.find((c) => c.id === spare)?.busy, "Spare did not start");
  await click(s, `#tree [data-archive-chat="${spare}"]`);
  await confirmArchive();
  await waitFor(`/stop/i.test(document.querySelector('#toasts .toast.error')?.innerText ?? '')`, s, "busy chat refused");
  if ((await archived(spare)) || (await settle(id, spare, spareTurn)).state !== "done") throw Error("Busy chat was archived or aborted");
  result.checks.push("F22 archiving a chat with a running turn is refused with a reason and the turn finishes");

  // F25: a failed request keeps the row and the selection and shows the error.
  await evaluate(
    `(() => { window.__archiveCalls = 0; window.__fail = true; const real = window.fetch; window.fetch = (url, init) => { if (String(init?.body ?? '').includes('"chat-update"')) { window.__archiveCalls++; if (window.__fail) { window.__fail = false; return Promise.reject(new TypeError('MARK-OFFLINE')); } } return real(url, init); }; })()`,
    s,
  );
  await click(s, `#tree [data-archive-chat="${chatId}"]`);
  await confirmArchive();
  await waitFor(`(document.querySelector('#toasts')?.innerText ?? '').includes('MARK-OFFLINE')`, s, "archive error shown");
  if ((await evaluate(`${current}?.dataset.chat`, s)) !== chatId || (await chatButtons(s)).length !== 3 || (await archived(chatId)))
    throw Error("Failed archive changed the tree");
  result.checks.push("F25 a failed archive keeps the chat and the selection and shows the error");

  // F23/F24/F26: archiving the selected chat once selects the next chat; Undo restores it with its transcript.
  await click(s, `#tree [data-archive-chat="${chatId}"]`);
  await waitFor(dialogOpen, s, "dialog before double confirm");
  await evaluate(
    `(() => { window.__archiveCalls = 0; const b = document.querySelector('#archive-chat [data-archive-confirm]'); b.click(); b.click(); })()`,
    s,
  );
  await waitFor(`${chats}.length === 2 && ${current}?.dataset.chat === ${JSON.stringify(spare)}`, s, "next chat selected");
  await waitFor(`!!document.querySelector('#toasts .toast:not(.leaving) button:not(.toast-x)')`, s, "undo offered");
  if (!(await archived(chatId)) || (await evaluate(`window.__archiveCalls`, s)) !== 1) throw Error("Archive not stored once");
  if (new URL(await evaluate("location.href", s)).searchParams.get("chat") !== spare) throw Error("URL kept the archived chat");
  await shot("06-archived-undo", s);
  await click(s, "#toasts .toast:not(.leaving) button:not(.toast-x)");
  await waitFor(
    `${chats}.length === 3 && ${current}?.dataset.chat === ${JSON.stringify(chatId)} && ${feed}.includes('ANSWER-ACK')`,
    s,
    "undo",
  );
  if (await archived(chatId)) throw Error("Undo not stored");
  result.checks.push("F23/F24/F26 one archive request; the next chat is selected; Undo restores the chat and its transcript");

  // F21/F27: the shortcut stays out of text fields, the worker view, Settings and Main; it shows on the Hotkeys page.
  const stays = async (label) => {
    await delay(400);
    if ((await archived(chatId)) || (await chatButtons(s)).length !== 3) throw Error(`Shortcut archived ${label}`);
  };
  await evaluate(`document.querySelector('#composer-input').focus()`, s);
  await archiveKey();
  await stays("while typing");
  await evaluate(`document.activeElement.blur()`, s);
  await press("e", "KeyE", MOD);
  await stays("on Mod+E");
  await waitFor(
    `(document.querySelector('#workers [data-worker-history][aria-expanded="false"]')?.click(), !!document.querySelector('#workers [data-open-worker]'))`,
    s,
    "worker in the list",
  );
  await click(s, "#workers [data-open-worker]");
  await waitFor(`document.querySelector('#center').dataset.focus === 'worker'`, s, "worker view");
  await archiveKey();
  await stays("in the worker view");
  await click(s, '#focus-view [data-cmd="leave-focus"]');
  await press(",", "Comma", MOD);
  await waitFor(`document.querySelector('#settings').open`, s, "settings open");
  await archiveKey();
  await stays("with settings open");
  if ((await evaluate(dialogOpen, s)) === true) throw Error("Shortcut opened the dialog over Settings");
  await click(s, '#settings nav [data-section="hotkeys"]');
  await waitFor(
    `/Archive chat\\s*${shortcut.replaceAll("+", "\\\\+")}/.test(document.querySelector('#settings').innerText)`,
    s,
    "hotkeys page row",
  );
  await press("Escape", "Escape");
  await press("Escape", "Escape");
  await waitFor(`!document.querySelector('#settings').open`, s, "settings closed");
  await click(s, '#tree [data-chat="main"]');
  await waitFor(`${current}?.dataset.chat === 'main'`, s, "main selected");
  await archiveKey();
  await waitFor(`/Main/.test(document.querySelector('#toasts')?.innerText ?? '')`, s, "Main refused");
  if (await archived("main")) throw Error("Main archived");
  await click(s, `#tree [data-chat="${chatId}"]`);
  await waitFor(`${current}?.dataset.chat === ${JSON.stringify(chatId)} && ${feed}.includes('ANSWER-ACK')`, s, "research selected");
  await archiveKey();
  await waitFor(`${dialogOpen} && document.querySelector('#archive-chat').innerText.includes('Research')`, s, "shortcut asks first");
  await archiveKey();
  await archiveKey();
  if ((await evaluate(`document.querySelectorAll('dialog[open]').length`, s)) !== 1 || (await archived(chatId)))
    throw Error("Repeated shortcut stacked dialogs or archived");
  await press("Escape", "Escape");
  await waitFor(`!${dialogOpen}`, s, "escape after shortcut");
  await stays("after Escape");
  await archiveKey();
  await confirmArchive();
  await waitFor(`${chats}.length === 2 && ${current}?.dataset.chat === ${JSON.stringify(spare)}`, s, "shortcut archived");
  if (!(await archived(chatId)) || (await rpc({ action: "list" })).find((p) => p.id === id)?.archived)
    throw Error("Shortcut archive wrong");
  result.checks.push(
    "F21/F27/F30 Mod+Shift+E asks once, then archives the selected chat only from the chat view, never Main, and is listed under Hotkeys",
  );

  // Touch screens have no hover: the button shows on a narrow touch viewport.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }, s);
  await evaluate(`document.querySelector('[data-cmd="toggle-list"]')?.click()`, s);
  await waitFor(
    `document.querySelector('#app').dataset.sheet === 'list' && matchMedia('(hover: none)').matches && ${shown(spare)}`,
    s,
    "touch button",
  );
  await shot("07-archive-touch", s);
  await send("Emulation.setTouchEmulationEnabled", { enabled: false }, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await evaluate(`document.querySelector('#app').dataset.sheet = ''`, s);
  result.checks.push("F20 the archive button is visible without hover on a narrow touch screen");

  // F23/F28: archiving another chat keeps the selection; archives survive a reload.
  await click(s, '#tree [data-chat="main"]');
  await waitFor(`${feed}.includes('Done MARK-MAIN')`, s, "main before archive");
  await click(s, `#tree [data-archive-chat="${spare}"]`);
  await confirmArchive();
  await waitFor(`${chats}.length === 1 && ${current}?.dataset.chat === 'main'`, s, "archived chat leaves the tree");
  await send("Page.reload", {}, s);
  await waitFor(
    `document.body.dataset.ready === "1" && ${chats}.length === 1 && ${current}?.dataset.chat === 'main'`,
    s,
    "reload keeps archives",
  );
  result.checks.push("F23/F28 archiving another chat keeps the selection; archived chats stay hidden after reload");
  await rejects({ action: "message", id, chatId, text: "MARK-NOPE" }, /archived/i, "archived chat message");
  await rejects({ action: "chat-update", id, chatId: "main", archived: true }, /Main/, "archive main");
  result.checks.push("F14/F18 archive hides the chat and refuses its messages; Main cannot be archived");
  await shot("05-archived", s);

  // F3: restart keeps chats, titles, transcripts and coordinator tools.
  await send("Browser.close").catch(() => {});
  for (let i = 0; i < 500 / 20 && !cdpEnded; i++) await delay(20);
  if (!cdpEnded) chrome.kill("SIGTERM");
  await stopHost();
  await startHost();
  const restarted = await rpc({ action: "show", id, chatId });
  const restored = restarted.chats.find((c) => c.id === chatId);
  if (!restored || restored.title !== "Research" || !restored.archived || !restarted.messages.some((m) => m.text?.includes("ANSWER-ACK")))
    throw Error("Chat lost on restart: " + JSON.stringify(restarted.chats));
  await rpc({ action: "chat-update", id, chatId, archived: false });
  await ask(id, chatId, "MARK-AFTER restart");
  const after = turns("MARK-AFTER").at(-1);
  if (!["agents", "projects_question", "projects_knowledge_write"].every((n) => after.tools.includes(n)))
    throw Error("Chat lost tools after restart: " + JSON.stringify(after.tools));
  if (!after.history.includes("MARK-DELEG") || after.history.includes("MARK-MAIN")) throw Error("Chat history wrong after restart");
  result.checks.push("F3 after restart chats keep titles, archive state, transcripts and coordinator tools; restore works");

  // F17: project pause stops every chat.
  const held = await rpc({ action: "message", id, chatId, text: "MARK-SLOW then pause" });
  await eventually(async () => (await rpc({ action: "show", id, chatId })).chats.find((c) => c.id === chatId)?.busy, "Chat did not start");
  await rpc({ action: "pause", id });
  const paused = await settle(id, chatId, held);
  if (paused.state !== "interrupted") throw Error("Pause did not stop chat two: " + paused.state);
  await rejects({ action: "message", id, chatId, text: "MARK-NOPE" }, /paused/i, "paused chat message");
  result.checks.push("F17/F18 project pause interrupts a running non-Main chat and blocks its messages");
  // A6 (jobs-failures.md): a paused project reports paused, not working.
  let listedActivity;
  await eventually(
    async () => {
      listedActivity = (await rpc({ action: "list" })).find((project) => project.id === id)?.activity;
      return listedActivity?.paused === true && listedActivity.working === false;
    },
    "List does not show the project paused and idle",
    100,
  ).catch((error) => {
    throw Error(`${error.message}: ${JSON.stringify(listedActivity)}`);
  });
  result.checks.push("A6 a paused project is listed as paused, not working");

  result.httpErrors = result.httpErrors.filter((e) => !e.url.endsWith("/live"));
  if (result.errors.length || result.httpErrors.length)
    throw Error("Browser errors captured: " + JSON.stringify({ errors: result.errors, http: result.httpErrors }));
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) {
    try {
      await send("Browser.close");
    } catch {}
    for (let i = 0; i < 500 / 20 && !cdpEnded; i++) await delay(20);
    if (!cdpEnded) chrome.kill("SIGTERM");
  }
  try {
    if (!hostEnded) await stopHost();
  } catch {
    host?.kill("SIGKILL");
  }
  model.closeAllConnections();
  model.close();
  log.end();
  save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== "passed") process.exitCode = 1;
