// Browser E2E with an isolated host and a local fake model. No real providers, no network.
// Failure cases recorded in skills-scale-chats-failures.md before implementation.
// Covers: owner worker-skills catalog with 89 configured skills (paged), usage/observability across chats,
// project attention aggregated across chats, the chat bar at 390px. (F19, the 95817c3 legacy-host fixture, was dropped with the legacy runtime.)
import { spawn, execFileSync } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const artifacts = join(repo, "artifacts", `skills-scale-chats-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `skills-chats-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace"),
  agentDir = join(root, "agent"),
  userHome = join(root, "userhome");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error("Clear runtime overrides first");
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, "report.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");

// 89 configured skills, the owner's real count; above the old 64 cap.
const SKILLS = 89;
for (let i = 0; i < SKILLS; i++) {
  const name = `owner-skill-${String(i).padStart(2, "0")}`,
    dir = join(agentDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Generated owner skill number ${i}.\n---\n\n# ${name}\n\n${"Body text for a realistic skill. ".repeat(40)}\n`,
  );
}
const git = (dir, ...args) => execFileSync("/usr/bin/git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
git(workspace, "init", "-b", "main");
git(workspace, "config", "user.email", "e2e@example.invalid");
git(workspace, "config", "user.name", "E2E");
git(workspace, "remote", "add", "origin", "https://github.com/acme/skills.git");
writeFileSync(join(workspace, "README.md"), "base\n");
git(workspace, "add", ".");
git(workspace, "commit", "-qm", "c1");

const usage = { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 };
const chunk = (delta, finish, extra = {}) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const call = (name, args) =>
  chunk(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    null,
  ) +
  chunk({}, "tool_calls", { usage }) +
  "data: [DONE]\n\n";
const say = (text) => chunk({ role: "assistant", content: text }, null) + chunk({}, "stop", { usage }) + "data: [DONE]\n\n";
const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : JSON.stringify(content ?? "");
const scripts = {
  "MARK-DELEG": [
    [
      "agents",
      {
        action: "spawn",
        role: "scout",
        title: "MARK-SCOUTJOB",
        brief: "MARK-SCOUTJOB look around",
        acceptance: ["looked"],
        requestId: "scout-1",
      },
    ],
  ],
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
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? "none";
    const results = msgs
      .slice(lastUser + 1)
      .filter((m) => m.role === "tool")
      .map((m) => contentText(m.content));
    result.calls.push({ coordinator, marker, stage: results.length, user: userText.slice(0, 300) });
    const reply = (text) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(text);
    };
    if (marker === "MARK-FAIL") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "FAKE-MODEL-BROKEN", type: "invalid_request_error" } }));
    }
    if (!coordinator) return reply(say(marker === "MARK-SCOUTJOB" ? "SCOUT-RESULT-42" : `Worker ${marker}`));
    if (/^\[(worker|scout) /.test(userText)) return reply(say("REPORT-ACK"));
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
        models: [
          {
            id: "fake-model",
            name: "Fake",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
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
        timeout: 120000,
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
async function startHost(source = repo) {
  host = spawn(process.execPath, [join(source, "src/host.ts")], { cwd: source, env, stdio: ["ignore", "pipe", "pipe"] });
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
    }, 30000);
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
const click = (s, selector) =>
  evaluate(
    `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw Error('missing ' + ${JSON.stringify(selector)}); n.click(); })()`,
    s,
  );
const settle = async (id, chatId, job) =>
  eventually(async () => {
    const view = await rpc({ action: "show", id, ...(chatId ? { chatId } : {}) });
    const found = view.jobs.find((j) => j.id === job.id);
    return ["done", "failed", "interrupted"].includes(found?.state) && found;
  }, "Job did not settle");
const ask = async (id, chatId, text) => {
  const job = await rpc({ action: "message", id, text, ...(chatId ? { chatId } : {}) });
  const done = await settle(id, chatId, job);
  if (done.state !== "done") throw Error(`${text} failed: ${done.error}`);
  return done;
};

try {
  await startHost();

  // A: 89 configured skills, paged.
  const project = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "Skills and chats",
    cwd: workspace,
    objective: "Disposable fixture",
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
  const setup = await rpc({ action: "owner-setup-snapshot", id });
  await rpc({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: setup.workspaceRevision });
  // Skills reach workers through Settings profiles now (the grant model is retired): the last of the configured skills is saved for workers.
  const last = { name: `owner-skill-${String(SKILLS - 1).padStart(2, "0")}` },
    before = await rpc({ action: "settings-snapshot", id });
  await rpc({
    action: "settings-update",
    id,
    confirm: id,
    expectedRevision: before.revision,
    changes: { skills: { all: [], coordinator: [], worker: [last.name], scout: [], reviewer: [] } },
  });
  if ((await rpc({ action: "settings-snapshot", id })).values.skills?.worker?.[0] !== last.name)
    throw Error("Worker skill profile from the last page not saved");
  result.checks.push(`F7 a skill from the last page (${last.name}) is saved in the worker skill profile`);

  // B: three chats. Main answers, "Research" delegates a scout, "Broken" fails.
  await ask(id, undefined, "MARK-MAIN hello");
  const research = await rpc({ action: "chat-create", id, title: "Research" });
  await ask(id, research.id, "MARK-DELEG scout please");
  await eventually(
    async () => (await rpc({ action: "show", id, chatId: research.id })).messages.some((m) => m.text === "REPORT-ACK"),
    "Report did not reach Research",
  );
  const broken = await rpc({ action: "chat-create", id, title: "Broken" });

  // F14/F16: fail in Broken, observe only through Main; the unsettled job in the other chat is settled.
  const failJob = await rpc({ action: "message", id, chatId: broken.id, text: "MARK-FAIL boom" });
  const failing = await eventually(
    async () => {
      const view = await rpc({ action: "show", id });
      return view.project.problem && view;
    },
    "Failure in Broken never reached Main",
    900,
  );
  if (
    !failing.project.problem.startsWith('Chat "Broken": ') ||
    failing.project.phase !== "attention" ||
    !failing.chats.find((c) => c.id === broken.id)?.attention ||
    failing.chats.find((c) => c.id === "main").attention
  )
    throw Error("Aggregated attention wrong: " + JSON.stringify({ problem: failing.project.problem, chats: failing.chats }));
  const failedRecord = (await rpc({ action: "show", id, chatId: broken.id })).jobs.find((j) => j.id === failJob.id);
  if (failedRecord?.state !== "failed") throw Error("Broken job not failed: " + JSON.stringify(failedRecord));
  const fromResearch = await rpc({ action: "show", id, chatId: research.id });
  if (fromResearch.project.problem !== failing.project.problem) throw Error("Viewing a healthy chat cleared the failure");
  const fromBroken = await rpc({ action: "show", id, chatId: broken.id });
  if (fromBroken.project.problem !== failedRecord.error) throw Error("Viewed failing chat should show its raw error");
  result.aggregatedProblem = failing.project.problem;
  result.checks.push(
    'F14/F15/F16 a failed turn in "Broken" is settled and raised as project attention while only Main is viewed; viewing a healthy chat keeps it; the failing chat is flagged',
  );

  // UI.
  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", id);
  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  const chatRows = `document.querySelectorAll('#tree .tree-project.selected [data-chat]')`;
  await waitFor(`document.querySelector('#feed')?.innerText.includes('Done MARK-MAIN') && ${chatRows}.length === 3`, s, "project loaded");
  await waitFor(`!!document.querySelector('#tree [data-chat=${JSON.stringify(broken.id)}] .dot.needs')`, s, "attention in UI");
  await shot("01-main-shows-broken-chat-attention", s);
  // The classic Main warning banner with "Open chat" was retired 2026-11-04; the tree dot is the signal.
  result.checks.push("F17 while Main is viewed, the Broken chat's tree dot shows it needs you");

  // A: the skills catalog lists all 89 (the classic Settings skills picker was retired 2026-11-04; the call it read stays).
  const catalog = await rpc({ action: "coordinator-skills", id });
  if (catalog.skills?.length !== SKILLS) throw Error(`Skills catalog lists ${catalog.skills?.length}`);
  result.checks.push("F6 the skills catalog lists all 89 skills");

  // F10-F13: Observability covers every chat.
  const usagePage = await rpc({ action: "usage-snapshot", id });
  const researchUsage = usagePage.chats?.find((c) => c.chatId === research.id);
  if (
    usagePage.chats?.length !== 2 ||
    !(researchUsage?.total.totalTokens > 0) ||
    !(usagePage.coordinator.total.totalTokens > 0) ||
    usagePage.chatTotal.totalTokens !== usagePage.chats.reduce((n, c) => n + c.total.totalTokens, 0)
  )
    throw Error(
      "Usage misses chats: " +
        JSON.stringify({
          chats: usagePage.chats?.map((c) => ({ id: c.chatId, t: c.total.totalTokens })),
          main: usagePage.coordinator.total.totalTokens,
        }),
    );
  result.usage = {
    main: usagePage.coordinator.total.totalTokens,
    chats: usagePage.chats.map((c) => ({ title: c.title, tokens: c.total.totalTokens })),
    workers: usagePage.workers.map((w) => w.total.totalTokens),
  };
  // The classic Observability tab (trace per chat, usage rows, health) was retired 2026-11-04; its data stays in the host API.
  const health = await rpc({ action: "host-health", id });
  result.health = health;
  result.checks.push("F10-F13 usage counts Main, Research and Broken with per-chat rows (usage-snapshot)");

  // F15: a later success in Broken clears the aggregated problem.
  await ask(id, broken.id, "MARK-OK recovered");
  const cleared = await rpc({ action: "show", id });
  if (cleared.project.problem || cleared.chats.some((c) => c.attention)) throw Error("Problem not cleared: " + cleared.project.problem);
  result.checks.push("F15 a later success in the failing chat clears project attention");

  // F18: the chat list at 390px (the tree in the new client).
  const mobile = await rpc({ action: "chat-create", id, title: "A rather long chat title for narrow screens" });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await waitFor(`${chatRows}.length === 4`, s, "four chats at 390px");
  await delay(500);
  const layout = await evaluate(`({ viewport: innerWidth, docWidth: document.documentElement.scrollWidth })`, s);
  result.layout390 = layout;
  if (layout.docWidth > layout.viewport) throw Error("The page overflows at 390px: " + JSON.stringify(layout));
  await shot("04-chats-390", s);
  await click(s, `#tree [data-chat="${mobile.id}"]`);
  await waitFor(
    `new URL(location.href).searchParams.get('chat') === ${JSON.stringify(mobile.id)} && !!document.querySelector('#tree [data-chat="${mobile.id}"].current')`,
    s,
    "select long chat at 390px",
  );
  await shot("05-chats-390-long-selected", s);
  result.checks.push("F18 at 390px no horizontal page scroll and the long-titled chat can be selected");

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
console.log(
  JSON.stringify(
    { status: result.status, checks: result.checks, failure: result.status === "passed" ? undefined : result.failure, artifact: artifacts },
    null,
    2,
  ),
);
if (result.status !== "passed") process.exitCode = 1;
