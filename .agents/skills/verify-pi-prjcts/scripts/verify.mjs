#!/usr/bin/env node
// Verification helper for pi-prjcts. Run from the repo root (or any checkout root):
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch  [--evidence <dir>]
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs doctor  --run <scratch>
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc     --run <scratch> <action> [json-fields]
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive   --run <scratch> <feature>
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs cleanup --run <scratch>
// Features: message-coordinator
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, openSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.VERIFY_REPO ?? execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const CHROME = process.env.VERIFY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_TIMEOUT = Number(process.env.VERIFY_CDP_TIMEOUT_MS ?? 15000);
const PROJECT_NAME = "Verify seed";
// Read-only host actions the `rpc` command forwards; anything else (including `web`, which returns the auth token) is refused.
const RPC_ALLOWLIST = new Set([
  "list",
  "show",
  "jobs-snapshot",
  "knowledge-list",
  "knowledge-read",
  "knowledge-history",
  "search",
  "settings-snapshot",
]);

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = rest.filter((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.startsWith("--"));
const redact = (value) =>
  String(value)
    .replace(/token=[^&#\s"']+/gi, "token=[redacted]")
    .replace(/("?token"?\s*[:=]\s*"?)[A-Za-z0-9._~-]{16,}/gi, "$1[redacted]");
const out = (value) => console.log(redact(JSON.stringify(value, null, 2)));
const fail = (message) => {
  console.error(`FAIL: ${redact(message)}`);
  process.exit(1);
};
const socketFor = (home) =>
  join(tmpdir(), `pi-projects-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}.sock`);

// Process identity: a pid is ours only while its start time still matches the one recorded at spawn (pids get reused).
const psField = (pid, field) => {
  try {
    return execFileSync("/bin/ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const identityOf = async (pid) => {
  for (let i = 0; i < 20; i++) {
    const lstart = psField(pid, "lstart");
    if (lstart) return { pid, lstart };
    await delay(50);
  }
  return { pid, lstart: "" };
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
/** 'dead', 'ours' (alive with the recorded start time) or 'foreign' (alive, but a different process reused the pid). */
const ownership = ({ pid, lstart }) => (!pid || !alive(pid) ? "dead" : lstart && psField(pid, "lstart") === lstart ? "ours" : "foreign");
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

function rpc(run, input) {
  return new Promise((ok, bad) => {
    const req = request(
      {
        socketPath: run.socket,
        method: input ? "POST" : "GET",
        path: input ? "/api" : "/health",
        headers: input ? { "content-type": "application/json" } : {},
        timeout: 60000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          text += part;
        });
        res.on("end", () => {
          try {
            const reply = JSON.parse(text);
            if (!reply.ok) throw Error(reply.error);
            ok(reply.data);
          } catch (error) {
            bad(error);
          }
        });
      },
    );
    req.on("error", bad);
    req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await Promise.resolve()
      .then(fn)
      .catch((error) => {
        if (error.fatal) throw error;
        return false;
      });
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await delay(100);
  }
}
const runFile = (run) => join(run.scratch, "run.json");
const saveRun = (run) => writeFileSync(runFile(run), JSON.stringify(run, null, 2), { mode: 0o600 });
const loadRun = () => {
  const dir = flag("run") ?? fail("--run <scratch> is required (printed by launch)");
  const file = join(resolve(dir), "run.json");
  if (!existsSync(file)) fail(`no run.json in ${dir} (already cleaned up?)`);
  return JSON.parse(readFileSync(file, "utf8"));
};

/** Copy logs and run state into <evidence>/diagnostics, redacted. Safe to call repeatedly and when files are missing. */
function collectDiagnostics(run, extra = {}) {
  const dir = join(run.evidence, "diagnostics");
  mkdirSync(dir, { recursive: true });
  for (const [name, file] of [
    ["host.log", run.hostLog],
    ["fake-provider.log", run.providerLog],
    ["model-requests.jsonl", run.requestLog],
    ["run.json", runFile(run)],
  ]) {
    try {
      if (file && existsSync(file)) writeFileSync(join(dir, name), redact(readFileSync(file, "utf8")));
    } catch {}
  }
  if (Object.keys(extra).length) writeFileSync(join(dir, `notes-${Date.now()}.json`), redact(JSON.stringify(extra, null, 2)));
}

function hostEnv(run) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("PI_PROJECTS_") ||
      key.startsWith("PI_SUBAGENT") ||
      key === "PI_SESSION_FILE" ||
      key === "PI_PACKAGE_DIR" ||
      key === "PI_CODING_AGENT_DIR" ||
      key === "PI_OFFLINE"
    )
      delete env[key];
  return {
    ...env,
    HOME: run.userHome,
    PI_PROJECTS_HOME: run.home,
    PI_PROJECTS_HOST: "1",
    PI_CODING_AGENT_DIR: run.agentDir,
    PI_OFFLINE: "1",
  };
}

async function spawnTracked(run, label, file, args, options) {
  const child = spawn(file, args, { detached: true, ...options });
  child.unref();
  const exited = new Promise((ok) => child.once("exit", ok));
  run.pids[label] = { ...(await identityOf(child.pid)), pgid: child.pid };
  saveRun(run);
  return { child, exited };
}

async function launch() {
  if (process.env.NODE_OPTIONS) fail("clear NODE_OPTIONS first");
  if (!existsSync(join(repo, "node_modules"))) fail("node_modules missing: run `npm ci` in the checkout first");
  if (!existsSync(CHROME)) fail(`Chrome not found at ${CHROME}; set VERIFY_CHROME`);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const scratch = join(realpathSync(tmpdir()), `pi-verify-${id}`);
  const evidence = resolve(flag("evidence") ?? join(repo, "artifacts", "verify-pi-prjcts", id));
  const run = {
    id,
    scratch,
    evidence,
    repo,
    home: join(scratch, "home"),
    workspace: join(scratch, "workspace"),
    agentDir: join(scratch, "agent"),
    userHome: join(scratch, "userhome"),
    pids: {},
    revision: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
  run.socket = socketFor(run.home);
  run.hostLog = join(scratch, "host.log");
  run.providerLog = join(scratch, "fake-provider.log");
  run.requestLog = join(scratch, "model-requests.jsonl");
  for (const dir of [scratch, evidence, run.home, run.workspace, run.agentDir, run.userHome])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  saveRun(run);
  try {
    // Seed workspace: a one-commit git repo, with git's global/system config and HOME cut off from the owner's.
    const gitEnv = {
      ...process.env,
      HOME: run.userHome,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const git = (...args) =>
      execFileSync(
        "/usr/bin/git",
        ["-C", run.workspace, "-c", "commit.gpgsign=false", "-c", "user.email=verify@example.invalid", "-c", "user.name=Verify", ...args],
        { encoding: "utf8", env: gitEnv },
      );
    git("init", "-q", "-b", "main");
    writeFileSync(join(run.workspace, "README.md"), "verification workspace\n");
    // The project's own verification skill is part of the seed, so Settings can name an installed skill.
    cpSync(join(here, ".."), join(run.workspace, ".agents/skills/verify-pi-prjcts"), {
      recursive: true,
      filter: (source) => !source.includes("node_modules"),
    });
    git("add", ".");
    git("commit", "-qm", "seed");
    // Fake model provider (the only external-model seam): its own detached process group.
    const portFile = join(scratch, "fake-provider.port"),
      providerFd = openSync(run.providerLog, "a");
    await spawnTracked(run, "fakeProvider", process.execPath, [join(here, "fake-provider.mjs"), portFile, run.requestLog], {
      stdio: ["ignore", providerFd, providerFd],
    });
    run.fakePort = Number(await until(() => existsSync(portFile) && readFileSync(portFile, "utf8"), "fake provider port"));
    writeFileSync(
      join(run.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${run.fakePort}/v1`,
            apiKey: "fake",
            api: "openai-completions",
            models: ["fake-model", "fallback-model"].map((id) => ({
              id,
              name: id === "fake-model" ? "Fake" : "Fallback fake",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
            })),
          },
        },
      }),
    );
    // Host: private HOME, project home (hence a private socket), offline, inherited PI_PROJECTS_* stripped.
    const logFd = openSync(run.hostLog, "a");
    const { child: host, exited } = await spawnTracked(run, "host", process.execPath, [join(repo, "src/host.ts")], {
      cwd: repo,
      env: hostEnv(run),
      stdio: ["ignore", logFd, logFd],
    });
    let hostDied = false;
    exited.then(() => {
      hostDied = true;
    });
    await until(async () => {
      if (hostDied) throw Object.assign(Error("host exited during start"), { fatal: true });
      return (await rpc(run)).pid === host.pid;
    }, "host health answers with our pid");
    // Seed one project, pinned to the fake model, then wait until the browser URL is served.
    const project = await rpc(run, {
      action: "create",
      requestId: randomUUID(),
      name: PROJECT_NAME,
      cwd: run.workspace,
      objective: "Disposable verification project",
      model: "fake/fake-model",
    });
    const settings = await rpc(run, { action: "settings-snapshot", id: project.id });
    await rpc(run, {
      action: "settings-update",
      id: project.id,
      confirm: project.id,
      expectedRevision: settings.revision,
      changes: { models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" } },
    });
    run.projectId = project.id;
    run.webUrl = (await rpc(run, { action: "web" })).url;
    saveRun(run);
    await until(async () => (await fetch(new URL(run.webUrl).origin + "/")).ok, "web page served");
    await until(async () => (await rpc(run, { action: "list" })).some((p) => p.id === run.projectId), "seeded project listed");
    out({
      ready: true,
      scratch,
      evidence,
      projectId: run.projectId,
      origin: new URL(run.webUrl).origin,
      hostPid: host.pid,
      fakeProvider: `127.0.0.1:${run.fakePort}`,
    });
  } catch (error) {
    console.error(`launch failed: ${redact(error.message)}\nrunning cleanup on ${scratch}`);
    collectDiagnostics(run, { launchError: error.message });
    const left = await cleanup(run, { quiet: true });
    process.exit(left.length ? 2 : 1);
  }
}

async function doctor() {
  const run = loadRun(),
    checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), ...(ok ? {} : { detail }) });
  check("host process is ours and alive", ownership(run.pids.host ?? { pid: 0 }) === "ours", run.pids.host);
  check("fake provider process is ours and alive", ownership(run.pids.fakeProvider ?? { pid: 0 }) === "ours", run.pids.fakeProvider);
  const health = await rpc(run).catch((error) => ({ error: error.message }));
  check("private socket answers with the pid we started", health.pid === run.pids.host?.pid, health);
  check("host home is our scratch home", health.home === run.home, { reported: health.home, expected: run.home });
  check(
    "not the owner home",
    ![join(homedir(), ".pi/agent/projects"), join(homedir(), ".pi/agent/projects-mvp")].includes(run.home) &&
      run.home.startsWith(run.scratch),
    run.home,
  );
  check(
    "revision matches checkout HEAD",
    execFileSync("git", ["-C", run.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() === run.revision,
    run.revision,
  );
  const url = new URL(run.webUrl);
  check("web listener is loopback", url.hostname === "127.0.0.1", url.hostname);
  check(
    "web page serves",
    await fetch(url.origin + "/").then(
      (r) => r.ok,
      () => false,
    ),
    url.origin,
  );
  const hostWeb = await rpc(run, { action: "web" }).catch(() => ({}));
  check("web URL belongs to this host (same origin)", hostWeb.url && new URL(hostWeb.url).origin === url.origin, { expected: url.origin });
  check(
    "seeded project listed",
    (await rpc(run, { action: "list" }).catch(() => [])).some((p) => p.id === run.projectId),
    run.projectId,
  );
  const bad = checks.filter((item) => !item.ok);
  out({ ok: bad.length === 0, checks });
  process.exit(bad.length ? 1 : 0);
}

// Read-only second view of host state. `rpc --run <scratch> <action> ['{"path":"research/x.md"}']`; `id` defaults to the seeded project.
async function rpcCommand() {
  const run = loadRun(),
    [action, json] = positional;
  if (!RPC_ALLOWLIST.has(action))
    fail(`rpc action ${JSON.stringify(action)} is not allowed; read-only actions: ${[...RPC_ALLOWLIST].join(", ")}`);
  const fields = json ? JSON.parse(json) : {};
  out(await rpc(run, { action, ...(action === "list" ? {} : { id: run.projectId }), ...fields }));
}

// Raw CDP over a pipe, as scripts/lib/e2e-kit.mjs does. Chrome is tracked in run.json before any CDP call, so a crash anywhere still leaves it recorded for cleanup.
async function openBrowser(run, sinks) {
  const label = `chrome-${Date.now()}`;
  const { child: chrome, exited } = await spawnTracked(
    run,
    label,
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--use-mock-keychain",
      `--user-data-dir=${join(run.scratch, "chrome-profile")}`,
      "--remote-debugging-pipe",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  let id = 0,
    buffer = "";
  const pending = new Map();
  const page = {
    close: async () => {
      // Stop Chrome's whole process group and wait for the leader to exit; escalate to SIGKILL.
      const pgid = run.pids[label]?.pgid;
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        if (ownership(run.pids[label]) === "ours") {
          try {
            process.kill(-pgid, signal);
          } catch {}
        }
        await Promise.race([exited, delay(3000)]);
        if (ownership(run.pids[label]) !== "ours" && !groupAlive(pgid)) break;
      }
      if (ownership(run.pids[label]) !== "ours") {
        delete run.pids[label];
        saveRun(run);
      } else throw Error(`Chrome ${chrome.pid} would not exit`);
    },
  };
  try {
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
            msg.error ? p.bad(Error(JSON.stringify(msg.error))) : p.ok(msg.result);
          }
        } else if (msg.method === "Runtime.exceptionThrown")
          sinks.errors.push(redact(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
        else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
          sinks.errors.push(redact(msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ")));
        else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") sinks.errors.push(redact(msg.params.entry.text));
        else if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400)
          sinks.httpErrors.push({ url: redact(msg.params.response.url), status: msg.params.response.status });
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((ok, bad) => {
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          bad(Error(`CDP timeout: ${method}`));
        }, CDP_TIMEOUT);
        pending.set(key, {
          ok: (v) => {
            clearTimeout(timer);
            ok(v);
          },
          bad: (e) => {
            clearTimeout(timer);
            bad(e);
          },
        });
        chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    Object.assign(page, {
      evaluate: async (expression) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
        return r.result.value;
      },
      navigate: (url) => send("Page.navigate", { url }, sessionId),
      reload: () => send("Page.reload", {}, sessionId),
      cdp: (method, params) => send(method, params, sessionId),
      shot: async (dir, name) => {
        const image = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        writeFileSync(join(dir, `${name}.png`), Buffer.from(image.data, "base64"));
      },
      waitFor: (expression, what, ms = 30000) => until(() => page.evaluate(expression), what, ms),
      /** A real key press through the browser input pipeline; modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
      press: async (key, { code = key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode = 0, modifiers = 0 } = {}) => {
        const text = key.length === 1 && !(modifiers & 6) ? key : undefined;
        await send(
          "Input.dispatchKeyEvent",
          { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) },
          sessionId,
        );
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers }, sessionId);
      },
      /** A real pointer click at the centre of `selector`, after a hit test proving that point lands on that element. */
      click: async (selector) => {
        const point = await page.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, hit: !!hit && (hit === el || el.contains(hit)), top: hit?.tagName + '#' + (hit?.id ?? '') }; })()`,
        );
        if (!point) throw Error(`click target not found: ${selector}`);
        if (!point.hit) throw Error(`hit test failed for ${selector}: point is covered by ${point.top}`);
        for (const [type, extra] of [
          ["mouseMoved", {}],
          ["mousePressed", { button: "left", clickCount: 1 }],
          ["mouseReleased", { button: "left", clickCount: 1 }],
        ])
          await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra }, sessionId);
      },
    });
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
  return page;
}

const journeys = {
  // Feature: features/verification-settings.md
  async "verification-settings"(run, page, record, dir, sinks) {
    const origin = new URL(run.webUrl).origin,
      snap = async () => rpc(run, { action: "settings-snapshot", id: run.projectId });
    await page.navigate(run.webUrl);
    await page.waitFor(
      `document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)}) && !document.querySelector('#sign-in')?.open`,
      "seeded project shown",
    );
    const open = async () => {
      await page.click("button[data-tab=settings]");
      await page.waitFor(`!document.querySelector('#settings-button')?.hidden`, "settings tab with its edit button");
      await page.click("#settings-button");
      await page.waitFor(`!!document.querySelector('[data-settings-form]')`, "settings form");
    };
    const review = async () => {
      await page.click("[data-settings-form] [type=submit]");
      await page.waitFor(`!!document.querySelector('[data-settings-confirm]')`, "review dialog");
    };
    record("entry", `opened ${origin}; Project settings dialog`);
    await open();
    if ((await snap()).values.verification !== null) throw Error("verification must be off in a fresh project");
    const trust = await page.evaluate(`document.querySelector('[data-verify-trust]')?.innerText ?? ''`),
      emptyModel = await page.evaluate(`document.querySelector('.mp[data-role=verifier] .mp-current')?.innerText ?? ''`);
    if (!/trusted like the worker, not sandboxed/.test(trust) || !/not a security boundary/.test(trust))
      throw Error(`trusted execution disclosure is missing or misleading: ${trust}`);
    if (!/No verifier model/.test(emptyModel)) throw Error(`empty verifier model is not labelled clearly: ${emptyModel}`);
    record("visible", "verification discloses trusted shell execution and no security boundary; the empty verifier model is labelled");
    await page.shot(dir, "01-settings-off");
    // 1. Opting in without a verifier model is refused by the host; nothing is stored.
    await page.click("input[name=verifyEnabled]");
    await page.click("input[name=verifySkill]");
    await page.cdp("Input.insertText", { text: "verify-pi-prjcts" });
    await page.shot(dir, "02-enabled-no-model");
    await review();
    await page.shot(dir, "03-review-diff");
    const diff = await page.evaluate(`document.querySelector('.diff-list').innerText`);
    if (!/Verification/.test(diff) || !/verify-pi-prjcts/.test(diff))
      throw Error(`review dialog does not show the verification change: ${diff}`);
    await page.click("[data-settings-confirm] [type=submit]");
    await page.waitFor(`/own verifier model/.test(document.body.innerText)`, "host refusal visible");
    await page.shot(dir, "04-refused-without-model");
    record("action", "enabled verification with skill verify-pi-prjcts and no verifier model, reviewed and saved");
    record("visible", "the host refused: verification needs its own verifier model");
    // The refusal is an HTTP 400 by design: take exactly that one out of the error sinks, so any other error still fails the drive.
    const bad = sinks.httpErrors.findIndex((item) => item.status === 400);
    if (bad < 0) throw Error("expected the refusal to be an HTTP 400");
    sinks.httpErrors.splice(bad, 1);
    const log = sinks.errors.findIndex((item) => /status of 400/.test(item));
    if (log >= 0) sinks.errors.splice(log, 1);
    if ((await snap()).values.verification !== null) throw Error("refused update must not store anything");
    record("side-effect", "settings-snapshot still reports verification: null");
    // 2. Pick the verifier model, save again.
    await page.navigate(run.webUrl);
    await page.waitFor(`document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, "project shown again");
    await open();
    await page.click(".mp[data-role=verifier] .mp-current");
    await page.waitFor(`!!document.querySelector('.mp[data-role=verifier] .mp-row[data-ref="fake/fake-model"]')`, "verifier options");
    await page.click('.mp[data-role=verifier] .mp-row[data-ref="fake/fake-model"]');
    await page.click("input[name=verifyEnabled]");
    await page.click("input[name=verifySkill]");
    await page.cdp("Input.insertText", { text: "verify-pi-prjcts" });
    await page.shot(dir, "05-model-and-skill");
    await review();
    await page.click("[data-settings-confirm] [type=submit]");
    await page.waitFor(`!document.querySelector('dialog[open]')`, "saved");
    const saved = (await snap()).values;
    if (!saved.verification?.enabled || saved.verification.skill !== "verify-pi-prjcts" || saved.models.verifier !== "fake/fake-model")
      throw Error(`not stored: ${JSON.stringify(saved.verification)} ${saved.models.verifier}`);
    writeFileSync(
      join(dir, "host-settings-snapshot.json"),
      JSON.stringify({ verification: saved.verification, models: saved.models }, null, 2),
    );
    record("side-effect", `settings-snapshot: verification ${JSON.stringify(saved.verification)}, verifier model ${saved.models.verifier}`);
    // 3. Persistence: reopen after a reload, and turn it off again.
    await page.reload();
    await page.waitFor(`document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, "project after reload");
    await open();
    const shown = await page.evaluate(
      `({ on: document.querySelector('input[name=verifyEnabled]').checked, skill: document.querySelector('input[name=verifySkill]').value })`,
    );
    if (!shown.on || shown.skill !== "verify-pi-prjcts") throw Error(`settings dialog after reload: ${JSON.stringify(shown)}`);
    await page.shot(dir, "06-after-reload");
    record("persist", "after reload the dialog shows verification on with the skill");
    await page.click("input[name=verifyEnabled]");
    await review();
    await page.click("[data-settings-confirm] [type=submit]");
    await page.waitFor(`!document.querySelector('dialog[open]')`, "turned off");
    if ((await snap()).values.verification !== null) throw Error("verification did not turn off");
    await page.shot(dir, "07-turned-off");
    record("side-effect", "turning it off stores verification: null again; the verifier model choice stays");
  },
  // Feature: features/quota-settings.md
  async "quota-settings"(run, page, record, dir) {
    const url = new URL(run.webUrl);
    url.searchParams.set("tab", "settings");
    await page.navigate(url.toString());
    await page.waitFor(
      `document.querySelector('#settings-button')?.hidden === false && document.querySelector('#settings-button').getBoundingClientRect().width > 0`,
      "settings available",
    );
    await page.click("#settings-button");
    const picker = '.mp[data-role="worker-fallback"]';
    await page.waitFor(`!!document.querySelector('${picker}')`, "quota fallback picker");
    await page.evaluate(`document.querySelector('${picker}').scrollIntoView({ block: 'center' })`);
    await page.shot(dir, "01-before");
    await page.click(`${picker} .mp-current`);
    await page.click(`${picker} .mp-search`);
    await page.cdp("Input.insertText", { text: "Fallback fake" });
    await page.waitFor(`!!document.querySelector('${picker} .mp-row[data-ref="fake/fallback-model"]')`, "configured fallback result");
    await page.shot(dir, "02-typed");
    await page.click(`${picker} .mp-row[data-ref="fake/fallback-model"]`);
    await page.click("[data-settings-form] button[type=submit]");
    await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Save these changes?'`, "save review");
    const review = await page.evaluate(`document.querySelector('#dialog').innerText`);
    if (!review.includes("Worker quota fallback") || !review.includes("fake/fallback-model"))
      throw Error("review omitted fallback selection");
    await page.shot(dir, "03-review");
    await page.click("[data-settings-confirm] button[type=submit]");
    await page.waitFor(`!document.querySelector('#dialog').open`, "save completed");
    await page.reload();
    await page.waitFor(
      `document.querySelector('#settings-button')?.hidden === false && document.querySelector('#settings-button').getBoundingClientRect().width > 0`,
      "settings after reload",
    );
    await page.click("#settings-button");
    await page.waitFor(`!!document.querySelector('${picker}[data-value="fake/fallback-model"]')`, "persisted fallback");
    await page.evaluate(`document.querySelector('${picker}').scrollIntoView({ block: 'center' })`);
    await page.shot(dir, "04-saved");
    const view = await rpc(run, { action: "show", id: run.projectId });
    writeFileSync(join(dir, "host-show-proof.json"), JSON.stringify(view, null, 2));
    if (view.project.fallbackModels?.worker !== "fake/fallback-model" || view.project.models.worker !== "fake/fake-model")
      throw Error("host state differs from UI selection");
    writeFileSync(
      join(dir, "host-jobs-proof.json"),
      JSON.stringify(await rpc(run, { action: "jobs-snapshot", id: run.projectId }), null, 2),
    );
    record(
      "verified",
      "pointer clicks and browser text input saved the exact worker fallback; reload and read-only host show confirmed it without changing the primary model",
    );
  },
  // Feature: features/jobs.md
  async jobs(run, page, record, dir, sinks) {
    const prompt = "VERIFY-JOB please greet the world",
      composer = 'textarea[aria-label="Message coordinator"]',
      origin = new URL(run.webUrl).origin;
    await page.navigate(run.webUrl);
    await page.waitFor(
      `document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)}) && !!document.querySelector(${JSON.stringify(composer)}) && !document.querySelector('#sign-in')?.open`,
      "seeded project and composer",
    );
    await page.waitFor(`!document.querySelector('#job-tree').innerText.includes('Reading Jobs')`, "Jobs tree loaded");
    record("entry", `opened ${origin}; sidebar shows Chats, the right column the Workers card`);
    await page.shot(dir, "00-before-send");
    await page.click(composer);
    await page.cdp("Input.insertText", { text: prompt });
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ${JSON.stringify(prompt)}`, "typed text in composer");
    await page.click("#compose button[type=submit]");
    record("action", `pointer-clicked Send with ${JSON.stringify(prompt)}`);
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ''`, "composer cleared");
    await page.waitFor(`document.querySelector('#job-tree .job')?.innerText.includes('VERIFY-JOB')`, "Job in the Workers card", 60000);
    await page.shot(dir, "01-job-in-tree");
    await page.waitFor(`!!document.querySelector('#job-tree .job[data-status="ready"]')`, "Ready task", 90000);
    if (await page.evaluate(`!!document.querySelector('#messages .job-msg, #messages .event-card')`))
      throw Error("Internal report leaked into coordinator chat");
    await page.click('#job-tree [data-action="thread"]');
    await page.waitFor(
      `!document.querySelector('#inline-thread').hidden && !!document.querySelector('#worker-messages')`,
      "worker details",
    );
    await page.waitFor(`!!document.querySelector('#inline-thread [data-action="job-approve"]')`, "Approve in Ready task details");
    const ready = await page.evaluate(
      `({ tree: document.querySelector('#job-tree').innerText, details: document.querySelector('#inline-thread').innerText })`,
    );
    if (!/2\/2/.test(ready.tree) || !ready.details.includes("Proof")) throw Error(`Ready details or tree wrong: ${JSON.stringify(ready)}`);
    await page.shot(dir, "02-ready-with-approve");
    record("visible", "coordinator conversation contains no internal report; Ready task details retain proof and Approve");
    const jobs = await rpc(run, { action: "jobs-snapshot", id: run.projectId });
    writeFileSync(join(dir, "host-jobs-snapshot.json"), JSON.stringify(jobs, null, 2));
    if (jobs.jobs.length !== 1 || jobs.jobs[0].status !== "ready" || jobs.jobs[0].pr !== "12")
      throw Error(`host Job wrong: ${JSON.stringify(jobs.jobs.map((j) => [j.status, j.pr]))}`);
    record("side-effect", `jobs-snapshot lists one ${jobs.jobs[0].status} Job with PR ${jobs.jobs[0].pr}`);
    // Approve is a real host call; the private host has no GitHub, so the outcome line says why it did not merge.
    const seen = { errors: sinks.errors.length, http: sinks.httpErrors.length };
    await page.click('#inline-thread [data-action="job-approve"]');
    await page.waitFor(`!!document.querySelector('#inline-thread .job-outcome, #error:not([hidden])')`, "Approve outcome", 60000);
    const outcome = await page.evaluate(
      `document.querySelector('#inline-thread .job-outcome')?.innerText ?? document.querySelector('#error')?.innerText ?? ''`,
    );
    await page.shot(dir, "02b-approve-outcome");
    // The host answers the failed gh call with a 400; that is the expected result here, not a browser problem.
    sinks.errors.length = seen.errors;
    sinks.httpErrors.length = seen.http;
    writeFileSync(join(dir, "approve-outcome.txt"), outcome);
    record("visible", `after clicking Approve: ${JSON.stringify(outcome.slice(0, 160))}`);
    await page.click('[data-action="thread-close"]');
    await page.waitFor(`document.querySelector('#inline-thread').hidden`, "back to chat");
    // Expand the Job: its worker node shows status, plan progress and ETA.
    await page.click("#job-tree .job-toggle");
    await page.waitFor(`!!document.querySelector('#job-tree .job-children [data-action="thread"]')`, "expanded Job");
    await page.shot(dir, "03-job-tree-expanded");
    record("visible", `expanded Job: ${JSON.stringify(await page.evaluate(`document.querySelector('#job-tree').innerText`))}`);
    // Open the worker node: its transcript replaces the chat.
    await page.click('#job-tree [data-action="thread"]');
    await page.waitFor(
      `!document.querySelector('#inline-thread').hidden && !!document.querySelector('#worker-messages')`,
      "worker transcript",
    );
    await page.shot(dir, "04-worker-transcript");
    record("visible", "opening the worker node shows its transcript");
    await page.click('[data-action="thread-close"]');
    await page.waitFor(`document.querySelector('#inline-thread').hidden`, "back to the chat");
    await page.click(composer);
    await page.cdp("Input.insertText", { text: "VERIFY-CHECKPOINT stop at the decision boundary" });
    await page.click("#compose button[type=submit]");
    await page.waitFor(`!!document.querySelector('#job-tree .job[data-status="checkpoint"]')`, "independent checkpoint", 12000);
    await page.waitFor(
      `document.querySelector('#messages').innerText.includes('The intermediate result needs your decision.')`,
      "concise checkpoint reply",
    );
    if (
      await page.evaluate(
        `!!document.querySelector('#messages .job-msg, #messages .event-card') || document.querySelector('#messages').innerText.includes('VERIFY-FAKE-REPLY: [worker')`,
      )
    )
      throw Error("Checkpoint internals leaked into owner conversation");
    await page.shot(dir, "04e-clean-checkpoint-conversation");
    await page.click('#job-tree .job[data-status="checkpoint"] [data-action="thread"]');
    await page.waitFor(
      `document.querySelector('#inline-thread').innerText.includes('Intermediate checkpoint') && document.querySelector('#inline-thread').innerText.includes('checkpoint-evidence')`,
      "checkpoint evidence in details",
    );
    if (await page.evaluate(`!!document.querySelector('#inline-thread [data-action="job-approve"]')`))
      throw Error("Checkpoint offers approval");
    const held = await rpc(run, { action: "jobs-snapshot", id: run.projectId });
    writeFileSync(join(dir, "host-checkpoint-snapshot.json"), JSON.stringify(held, null, 2));
    const checkpoint = held.jobs.find((job) => job.status === "checkpoint");
    if (checkpoint?.ready || !checkpoint?.checkpoint?.proof.includes("checkpoint-evidence"))
      throw Error("Host checkpoint state differs from UI");
    await page.shot(dir, "04f-checkpoint-evidence-no-approve");
    record("verified", "real independent worker checkpoint retains evidence, has no Approve, and generates a concise coordinator reply");
    await page.click('[data-action="thread-close"]');
    await page.waitFor(`document.querySelector('#inline-thread').hidden`, "checkpoint details closed");
    // A second chat opens a second tab; its Workers card is empty while the first chat keeps the Job.
    await page.click('[data-action="chat-new"]');
    await page.waitFor(
      `document.querySelectorAll('#tab-strip .chat-tab').length === 2 && !document.querySelector('#tab-strip').hidden`,
      "two tabs",
    );
    await page.waitFor(`document.querySelector('#job-tree').innerText.includes('No workers in this chat')`, "empty card in the new chat");
    await page.shot(dir, "04b-tabs-new-chat");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.shot(dir, "04c-tabs-390");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.click('#tab-strip .chat-tab-open[data-index="0"]');
    await page.waitFor(`document.querySelector('#job-tree').innerText.includes('VERIFY-JOB')`, "Job card back on the first tab");
    await page.shot(dir, "04d-tabs-back");
    record("visible", "second chat opens a second tab with an empty Workers card; the first tab shows the Job again");
    // Host settings: the Deploy section.
    await page.click("button[data-tab=settings]");
    await page.waitFor(`!!document.querySelector('#deploy [data-action="deploy-start"]')`, "Deploy section", 30000);
    await page.evaluate(`document.querySelector('#set-deploy').scrollIntoView()`);
    await page.shot(dir, "05-deploy-settings");
    const deploy = await page.evaluate(`document.querySelector('#deploy').innerText`);
    writeFileSync(join(dir, "deploy-section.txt"), deploy);
    if (
      !/02:00 07:00/.test(
        await page.evaluate(`[...document.querySelectorAll('#deploy select')].map(n => n.selectedOptions[0]?.textContent).join(' ')`),
      )
    )
      throw Error(`deploy window default missing: ${deploy}`);
    record("visible", "Deploy section: Deploy button, deploy-when-idle switch and the 02:00-07:00 window");
  },
  // Feature: features/ui2.md
  async ui2(run, page, record, dir, sinks) {
    const origin = new URL(run.webUrl).origin,
      hash = new URL(run.webUrl).hash;
    // Serving: /ui2/ has the same security headers as /, /ui2 redirects, nothing outside web-ui2/ is reachable, and / is unchanged.
    const served = await fetch(`${origin}/ui2/`);
    if (!served.ok) throw Error(`/ui2/ not served: HTTP ${served.status}`);
    for (const header of ["content-security-policy", "x-content-type-options", "referrer-policy"])
      if (served.headers.get(header) !== (await fetch(`${origin}/`)).headers.get(header)) throw Error(`/ui2/ ${header} differs from /`);
    const bare = await fetch(`${origin}/ui2`, { redirect: "manual" });
    if (bare.status !== 308 || bare.headers.get("location") !== "/ui2/") throw Error(`/ui2 does not redirect: ${bare.status}`);
    // Dot segments normalize away before the request (then the token rule answers 401); everything else under /ui2/ is a 404.
    for (const probe of ["/ui2/%2e%2e/package.json", "/ui2/..%2fpackage.json", "/ui2/.env", "/ui2/missing.js", "/ui2/sub/app.js"]) {
      const status = (await fetch(origin + probe)).status;
      if (status !== 404 && status !== 401) throw Error(`${probe} answered ${status}`);
    }
    if ((await (await fetch(`${origin}/`)).text()) !== readFileSync(join(run.repo, "web/index.html"), "utf8")) throw Error("/ changed");
    record("verified", "/ui2/ served with the same CSP and headers as /, /ui2 redirects, traversal and unknown files 404, / unchanged");
    // Load with the launch link's token; it must leave the URL bar.
    await page.navigate(`${origin}/ui2/${hash}`);
    const name = JSON.stringify(PROJECT_NAME);
    await page.waitFor(
      `document.body.dataset.ready === "1" && [...document.querySelectorAll('#tree [data-project]')].some(n => n.innerText.includes(${name}))`,
      "tree lists the seeded project",
    );
    if (await page.evaluate(`location.hash.includes("token")`)) throw Error("token left in the URL");
    await page.waitFor(`!!document.querySelector('#tree [data-chat="main"]')`, "Main chat nested under the project");
    record("entry", `opened ${origin}/ui2/ with the launch token; tree shows ${PROJECT_NAME} with Main nested`);
    // An empty chat offers three starter prompts; one click puts the text in the focused composer without sending it.
    await page.waitFor(`document.querySelectorAll('#feed .starters [data-starter]').length === 3`, "three starter prompts");
    await page.click("#feed .starters [data-starter]");
    const starter = await page.evaluate(
      `({ value: document.querySelector('#composer textarea').value, focused: document.activeElement === document.querySelector('#composer textarea'), owners: document.querySelectorAll('#feed .msg.owner').length })`,
    );
    if (!starter.value || !starter.focused || starter.owners) throw Error(`starter prompt: ${JSON.stringify(starter)}`);
    await page.evaluate(
      `(() => { const t = document.querySelector('#composer textarea'); t.value = ''; t.dispatchEvent(new Event('input')); })()`,
    );
    record(
      "visible",
      `empty chat: three starter prompts; one fills the focused composer ("${starter.value.slice(0, 50)}") without sending`,
    );
    await delay(300);
    await page.shot(dir, "01-empty-claude");
    // Send through the composer: one owner bubble, the spawn as a tool row, the worker in the context panel, the reply.
    const prompt = "VERIFY-JOB please greet the world",
      composer = "#composer textarea";
    const bubbles = `[...document.querySelectorAll('#feed .msg.owner')].filter(n => n.innerText.includes(${JSON.stringify(prompt)})).length`;
    const before = await page.evaluate(bubbles);
    await page.click(composer);
    await page.cdp("Input.insertText", { text: prompt });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    record("action", `typed ${JSON.stringify(prompt)} and pressed Enter`);
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ''`, "composer cleared");
    await page.waitFor(`${bubbles} === ${before + 1}`, "exactly one new owner bubble");
    await page.waitFor(`!!document.querySelector('#feed .tool-row[data-tool="agents"]')`, "agents tool row", 60000);
    await page.waitFor(`!!document.querySelector('#workers .worker[data-status="ready"]')`, "Ready worker in the context panel", 90000);
    await page.waitFor(`document.querySelector('#feed').innerText.includes('The work is ready')`, "coordinator reply", 60000);
    if (await page.evaluate(`[...document.querySelectorAll('#feed .msg.owner')].some(n => n.innerText.includes('[worker '))`))
      throw Error("internal worker report rendered as an owner bubble");
    const row = await page.evaluate(
      `(() => { const r = document.querySelector('#feed .tool-row[data-tool="agents"]'); return { text: r.innerText, mono: getComputedStyle(r.querySelector('.tool-name')).fontFamily, height: r.getBoundingClientRect().height }; })()`,
    );
    if (!/spawn/.test(row.text) || !/mono|Menlo|Courier|SF Mono|ui-monospace/i.test(row.mono) || row.height > 44)
      throw Error(`tool row is not a compact mono row: ${JSON.stringify(row)}`);
    record("visible", `tool row: ${JSON.stringify(row.text.replace(/\s+/g, " ").slice(0, 120))}`);
    // The spawn links to the worker; the Ready worker card has one primary action (Approve) and plan progress.
    const card = await page.evaluate(`document.querySelector('#workers .worker[data-status="ready"]').innerText`);
    if (!/2\/2/.test(card) || !/Approve/.test(card)) throw Error(`worker card lacks plan progress or Approve: ${JSON.stringify(card)}`);
    await page.shot(dir, "02-chat-tool-rows-claude");
    // Expand the spawn row: parameters and a bounded result preview, escaped.
    await page.click('#feed .tool-row[data-tool="agents"] .tool-head');
    await page.waitFor(
      `/requestId/.test(document.querySelector('#feed .tool-row[data-tool="agents"] .tool-detail')?.innerText ?? '')`,
      "expanded params",
    );
    await delay(300); // let the open transition finish before the screenshot
    await page.shot(dir, "03-tool-expanded");
    // Worker opens in the center; Esc returns to the chat.
    await page.click('#feed .tool-row[data-tool="agents"] [data-open-worker]');
    await page.waitFor(
      `document.querySelector('#center').dataset.focus === 'worker' && !!document.querySelector('#worker-feed')`,
      "worker transcript in center",
    );
    await delay(300); // let the open transition finish before the screenshot
    await page.shot(dir, "04-worker-center");
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`document.querySelector('#center').dataset.focus === 'chat'`, "Esc returns to chat");
    record("visible", "spawn row opens the worker transcript in the center; Esc returns to the chat");
    // Memory: a knowledge read and write render as memory rows; the entry opens in the center; the tree node lists it by kind.
    await page.click(composer);
    await page.cdp("Input.insertText", { text: "VERIFY-MEMORY greet in one short line from now on" });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(`!!document.querySelector('#feed .memory-row[data-tool="projects_knowledge_write"]')`, "Remembered row", 60000);
    await page.waitFor(`document.querySelector('#feed').innerText.includes('Remembered the greeting style')`, "memory reply", 60000);
    const memoryRows = await page.evaluate(
      `[...document.querySelectorAll('#feed .memory-row')].map(n => n.innerText.replace(/\\s+/g, ' ').trim())`,
    );
    if (
      !memoryRows.some((text) => /Used memory: Preference · Preferences/.test(text)) ||
      !memoryRows.some((text) => /Remembered: Greeting style.*Undo.*Edit/.test(text))
    )
      throw Error(`memory rows: ${JSON.stringify(memoryRows)}`);
    record("visible", `memory rows: ${JSON.stringify(memoryRows)}`);
    await page.shot(dir, "04b-memory-rows");
    await page.click('#feed .memory-row[data-tool="projects_knowledge_write"] [data-memory]');
    await page.waitFor(
      `document.querySelector('#center').dataset.focus === 'memory' && /no emoji/.test(document.querySelector('#focus-view .doc')?.innerText ?? '')`,
      "memory entry in center",
    );
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`document.querySelector('#center').dataset.focus === 'chat'`, "Esc back from memory");
    await page.click("#tree [data-memory-node]");
    await page.waitFor(
      `[...document.querySelectorAll('#focus-view .mem-group')].some(g => /decisions/i.test(g.querySelector('h2').textContent) && /Greeting style/.test(g.innerText))`,
      "Memory view groups the decision",
    );
    await delay(300);
    await page.shot(dir, "04c-memory-view");
    await page.click("#memory-search");
    await page.cdp("Input.insertText", { text: "zzz-nothing" });
    await page.waitFor(`!/Greeting style/.test(document.querySelector('#focus-view').innerText)`, "search filters memory");
    await page.press("Escape", { keyCode: 27 });
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`document.querySelector('#center').dataset.focus === 'chat'`, "Esc back from the memory view");
    record("visible", "memory entry opens in the center; the Memory node groups it under Decisions; search filters");
    const projectId = (await rpc(run, { action: "list" })).find((item) => item.name === PROJECT_NAME).id;
    const indexed = (await rpc(run, { action: "memory-index", projectId })).entries.find(
      (entry) => entry.path === "decisions/greeting-style.md",
    );
    if (indexed?.kind !== "decision" || indexed.status !== "current" || indexed.title !== "Greeting style")
      throw Error(`memory-index entry: ${JSON.stringify(indexed)}`);
    // Undo on the Remembered row goes through memory-undo; the entry was new, so the host removes it.
    await page.click('#feed .memory-row[data-tool="projects_knowledge_write"] [data-memory-undo]');
    await page.waitFor(
      `/Undone/.test(document.querySelector('#feed .memory-row[data-tool="projects_knowledge_write"]')?.innerText ?? '')`,
      "Remembered row says Undone",
    );
    const undone = (await rpc(run, { action: "memory-index", projectId })).entries.some((entry) => entry.path === indexed.path);
    if (undone) throw Error("memory-undo left decisions/greeting-style.md in memory-index");
    record("side-effect", `memory-index listed ${indexed.path} as a current decision; Undo removed it through memory-undo`);
    // Settings by hotkey (⌘,), theme section by its letter, switch to Midnight.
    await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.waitFor(`document.querySelector('#settings')?.open === true`, "settings overlay open");
    await delay(300); // let the open transition finish before the screenshot
    await page.shot(dir, "05-settings-claude");
    const scopes = await page.evaluate(`[...document.querySelectorAll('#settings nav [data-section]')].map(n => n.dataset.scope)`);
    if (!scopes.length || scopes.some((scope) => scope !== "project" && scope !== "host"))
      throw Error(`nav items without scope: ${scopes}`);
    await page.press("h", { keyCode: 72 });
    await page.waitFor(`document.querySelector('#settings').dataset.section === 'theme'`, "theme section by letter H");
    await page.click('#settings [data-theme-option="midnight"]');
    await page.waitFor(`document.documentElement.dataset.theme === 'midnight'`, "midnight applied");
    await delay(300); // let the open transition finish before the screenshot
    await page.shot(dir, "06-settings-midnight");
    const ui = await rpc(run, { action: "ui-get" });
    writeFileSync(join(dir, "host-ui-get.json"), JSON.stringify(ui, null, 2));
    if (ui.ui?.theme !== "midnight") throw Error(`host ui document not updated: ${JSON.stringify(ui)}`);
    record("side-effect", `ui-set stored theme midnight on the host (ui revision ${String(ui.revision).slice(0, 8)})`);
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`!document.querySelector('#settings').open`, "settings closed");
    // Poison the browser's pre-paint cache: after reload the theme must come from the host's ui document, not localStorage.
    await page.evaluate(
      `localStorage.setItem('pi-ui2-ui', JSON.stringify({ ...JSON.parse(localStorage.getItem('pi-ui2-ui') || '{}'), theme: 'light' }))`,
    );
    await page.reload();
    await page.waitFor(
      `document.body.dataset.ready === "1" && document.documentElement.dataset.theme === 'midnight'`,
      "midnight from the host survives reload over a stale local cache",
    );
    record("verified", "after reload with a stale local cache (light), the page shows midnight from ui-get");
    await page.waitFor(`!!document.querySelector('#workers .worker[data-status="ready"]')`, "worker after reload", 30000);
    await page.shot(dir, "07-chat-midnight");
    // Host agent drawer from anywhere with \.
    await page.press("\\", { code: "Backslash", keyCode: 220 });
    await page.waitFor(`document.querySelector('#host-agent')?.dataset.open === '1'`, "host agent drawer open");
    await page.waitFor(`!!document.querySelector('#host-agent .ha-body')?.innerText.trim()`, "drawer content");
    await delay(300); // let the open transition finish before the screenshot
    await page.shot(dir, "08-host-agent-midnight");
    record(
      "visible",
      `host agent drawer: ${JSON.stringify((await page.evaluate(`document.querySelector('#host-agent .ha-body').innerText`)).slice(0, 160))}`,
    );
    const hostAgent = await rpc(run, { action: "host-agent-settings" });
    {
      // A real exchange: host_call rows in the drawer, a ui_focus that opens Memory, a gated archive shown as an approval card
      // and counted in the status pill, Deny, and the outcome posted back without archiving anything.
      record(
        "entry",
        `host agent model ${hostAgent.effectiveModel}, ${hostAgent.tools.length} tools, ${hostAgent.actions.length} host actions`,
      );
      await page.waitFor(`document.querySelector('#host-agent').dataset.available === '1'`, "drawer wired to the Host agent");
      await page.click("#ha-composer textarea");
      await page.cdp("Input.insertText", { text: "VERIFY-HOST tidy up the host" });
      await page.press("Enter", { code: "Enter", keyCode: 13 });
      await page.waitFor(`document.querySelector('#center').dataset.focus === 'memory'`, "ui_focus opened Memory in the center", 60000);
      record("visible", "ui_focus { view: memory } from the Host agent opened Memory in the center");
      await page.waitFor(`!!document.querySelector('#ha-approvals .approval[data-approval]')`, "pending approval card", 60000);
      await page.waitFor(
        `/Archiving Verify seed waits/.test(document.querySelector('#host-agent .ha-body').innerText)`,
        "host agent reply",
        60000,
      );
      const drawer = await page.evaluate(`({
        rows: [...document.querySelectorAll('#host-agent .ha-body .tool-row')].map(n => n.dataset.tool),
        owner: [...document.querySelectorAll('#host-agent .ha-body .msg.owner')].filter(n => n.innerText.includes('VERIFY-HOST')).length,
        card: document.querySelector('#ha-approvals .approval').innerText.replace(/\\s+/g, ' '),
        pill: document.querySelector('#status-pill').innerText,
      })`);
      if (drawer.owner !== 1) throw Error(`expected one owner bubble in the drawer, saw ${drawer.owner}`);
      if (!drawer.rows.includes("host_call") || !drawer.rows.includes("ui_focus")) throw Error(`drawer tool rows: ${drawer.rows}`);
      if (!/Archive the Verify seed project/.test(drawer.card) || !/archive/.test(drawer.card))
        throw Error(`approval card: ${drawer.card}`);
      if (!/needs you/.test(drawer.pill)) throw Error(`status pill does not count the approval: ${drawer.pill}`);
      record("visible", `drawer rows ${drawer.rows.join(", ")}; approval card "${drawer.card.slice(0, 120)}"; pill "${drawer.pill}"`);
      await page.shot(dir, "08b-host-agent-approval");
      await page.click('#ha-approvals [data-decide="deny"]');
      await page.waitFor(`!document.querySelector('#ha-approvals .approval[data-approval]')`, "card leaves after Deny");
      await page.waitFor(`/nothing was archived/.test(document.querySelector('#host-agent .ha-body').innerText)`, "outcome reply", 60000);
      const after = await page.evaluate(`({
        outcome: [...document.querySelectorAll('#host-agent .ha-body .approval-row')].map(n => n.innerText.replace(/\\s+/g, ' ')),
        owners: [...document.querySelectorAll('#host-agent .ha-body .msg.owner')].map(n => n.innerText).filter(t => t.includes('[approval')).length,
      })`);
      if (!after.outcome.some((text) => /denied/i.test(text)) || after.owners)
        throw Error(`approval outcome row: ${JSON.stringify(after)}`);
      const decided = (await rpc(run, { action: "approvals-list" })).approvals.find((item) => item.action === "archive");
      const seed = (await rpc(run, { action: "list" })).find((item) => item.name === PROJECT_NAME);
      if (decided?.state !== "denied" || seed?.archived) throw Error(`after Deny: approval ${decided?.state}, archived ${seed?.archived}`);
      record("side-effect", `approval ${decided.id} denied; ${PROJECT_NAME} not archived; outcome row "${after.outcome.at(-1)}"`);
      await page.shot(dir, "08c-host-agent-denied");
      // Host agent settings from the model chip: thinking goes through host-agent-settings with the current revision.
      await page.click("#ha-model");
      await page.waitFor(
        `!document.querySelector('#ha-settings').hidden && !!document.querySelector('#ha-settings [data-thinking="low"]')`,
        "drawer settings",
      );
      await page.click('#ha-settings [data-thinking="low"]');
      await page.waitFor(
        `document.querySelector('#ha-settings [data-thinking="low"]')?.getAttribute('aria-checked') === 'true'`,
        "thinking low checked",
      );
      const tuned = await rpc(run, { action: "host-agent-settings" });
      if (tuned.thinking !== "low" || tuned.revision !== hostAgent.revision + 1)
        throw Error(`host agent settings after change: ${JSON.stringify(tuned).slice(0, 200)}`);
      await delay(300);
      await page.shot(dir, "08d-host-agent-settings");
      await page.click('#ha-settings [data-thinking="medium"]');
      await page.waitFor(
        `document.querySelector('#ha-settings [data-thinking="medium"]')?.getAttribute('aria-checked') === 'true'`,
        "thinking back to medium",
      );
      record("side-effect", `host-agent-settings thinking low at revision ${tuned.revision}, then back to medium`);
      // Approve: a spare project, archived by the Host agent only after the owner presses Approve in the drawer.
      const spare = await rpc(run, {
        action: "create",
        requestId: randomUUID(),
        name: "Verify spare",
        cwd: run.workspace,
        objective: "Archived through an approval",
        model: "fake/fake-model",
      });
      await page.click("#ha-composer textarea");
      await page.cdp("Input.insertText", { text: `VERIFY-HOST-APPROVE ${spare.id}` });
      await page.press("Enter", { code: "Enter", keyCode: 13 });
      await page.waitFor(
        `[...document.querySelectorAll('#ha-approvals .approval[data-approval]')].some(n => /Archive the spare project/.test(n.innerText))`,
        "second approval card",
        60000,
      );
      await page.click('#ha-approvals .approval[data-approval] [data-decide="approve"]');
      await page.waitFor(
        `/Done as approved/.test(document.querySelector('#host-agent .ha-body').innerText)`,
        "approved outcome reply",
        60000,
      );
      const approvedRows = await page.evaluate(
        `[...document.querySelectorAll('#host-agent .ha-body .approval-row[data-status="done"]')].map(n => n.innerText.replace(/\\s+/g, ' '))`,
      );
      const approved = (await rpc(run, { action: "approvals-list" })).approvals.find(
        (item) => item.summary === "Archive the spare project",
      );
      const spareNow = (await rpc(run, { action: "list" })).find((item) => item.id === spare.id);
      if (approved?.state !== "done" || !spareNow?.archived || !approvedRows.length)
        throw Error(`after Approve: approval ${approved?.state}, archived ${spareNow?.archived}, rows ${JSON.stringify(approvedRows)}`);
      record("side-effect", `approval ${approved.id} approved and done; "Verify spare" archived; outcome row "${approvedRows.at(-1)}"`);
      await delay(300);
      await page.shot(dir, "08e-host-agent-approved");
    }
    await page.press("\\", { code: "Backslash", keyCode: 220 });
    await page.press("Escape", { keyCode: 27 });
    // Profile thinking: Model section, coordinator profile, high; profiles-set stores it and the status line follows.
    await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.waitFor(`document.querySelector('#settings')?.open === true`, "settings for the model");
    await page.click('#settings nav [data-section="model"]');
    await page.waitFor(`!!document.querySelector('#settings .settings-body [data-thinking="high"]')`, "model section");
    await page.click('#settings .profiles [data-profile="coordinator"]');
    await page.waitFor(`!!document.querySelector('#settings .settings-body [data-thinking="high"]')`, "coordinator model section");
    await page.click('#settings .settings-body [data-thinking="high"]');
    await page.waitFor(
      `document.querySelector('#settings .settings-body [data-thinking="high"]')?.getAttribute('aria-checked') === 'true'`,
      "thinking high checked",
    );
    const profiles = await rpc(run, { action: "profiles-get", projectId });
    if (profiles.profiles.coordinator.thinking !== "high")
      throw Error(`profiles-get coordinator: ${JSON.stringify(profiles.profiles.coordinator)}`);
    await page.waitFor(`/think high/.test(document.querySelector('#statusline').innerText)`, "status line shows think high");
    record("side-effect", "profiles-set coordinator thinking high; profiles-get agrees; status line shows think high");
    await delay(300);
    await page.shot(dir, "11-settings-model");
    // Tier reorder: add the fallback model to the tier, move it first, save; tiers-get keeps the new order.
    await page.click('#settings nav [data-section="tiers"]');
    await page.waitFor(`!!document.querySelector('#settings .tier-edit [data-add-search]')`, "tiers editor");
    const tierBefore = (await rpc(run, { action: "tiers-get" })).tiers[0];
    await page.click("#settings .tier-edit [data-add-search]");
    await page.cdp("Input.insertText", { text: "fallback-model" });
    await page.waitFor(`!!document.querySelector('#settings [data-add="fake/fallback-model"]')`, "model search result");
    await page.click('#settings [data-add="fake/fallback-model"]');
    await page.click('#settings .tier-edit li[data-m="1"] [data-move="-1"]');
    await page.waitFor(
      `/fallback-model/.test(document.querySelector('#settings .tier-edit li[data-m="0"]')?.innerText ?? '')`,
      "fallback model moved first",
    );
    await delay(300);
    await page.shot(dir, "12-settings-tiers-reordered");
    await page.click("#settings #tiers-save");
    await page.waitFor(`!document.querySelector('#settings #tiers-save')`, "tiers saved");
    const tierAfter = (await rpc(run, { action: "tiers-get" })).tiers.find((tier) => tier.id === tierBefore.id);
    if (JSON.stringify(tierAfter.models) !== JSON.stringify(["fake/fallback-model", ...tierBefore.models]))
      throw Error(`tiers-get after reorder: ${JSON.stringify(tierAfter.models)}`);
    record("side-effect", `tiers-set: tier ${tierBefore.id} is now ${tierAfter.models.join(" → ")}`);
    // Back to the seed order so the model the rest of the run uses is unchanged.
    await page.click('#settings .tier-edit li[data-m="0"] [data-remove]');
    await page.click("#settings #tiers-save");
    await page.waitFor(`!document.querySelector('#settings #tiers-save')`, "tiers restored");
    await page.click('#settings nav [data-section="model"]');
    await page.waitFor(`!!document.querySelector('#settings .settings-body [data-thinking="medium"]')`, "model section again");
    await page.click('#settings .settings-body [data-thinking="medium"]');
    await page.waitFor(
      `document.querySelector('#settings .settings-body [data-thinking="medium"]')?.getAttribute('aria-checked') === 'true'`,
      "thinking back to medium",
    );
    // Inline status: a change in Settings is confirmed next to it, not by a toast.
    const inline = await page.evaluate(
      `({ status: document.querySelector('#settings .settings-status')?.innerText ?? '', toasts: document.querySelectorAll('#toasts .toast').length })`,
    );
    if (!/thinking/i.test(inline.status)) throw Error(`no inline status after the thinking change: ${JSON.stringify(inline)}`);
    record("visible", `inline status "${inline.status}"; ${inline.toasts} toasts`);
    // Context: current use, a draggable auto-compaction mark (keyboard here), the derived force mark, the window, Compact now.
    await page.click('#settings nav [data-section="context"]');
    await page.waitFor(
      `!!document.querySelector('#settings .ctx-bar .mark.auto') && !!document.querySelector('#settings .ctx-bar .mark.force')`,
      "context bar",
    );
    const ctxBefore = (await rpc(run, { action: "settings-snapshot", id: projectId })).values.context?.thresholdPercent ?? 80;
    await page.evaluate(`document.querySelector('#settings .ctx-bar .mark.auto').focus()`);
    await page.press("ArrowRight", { code: "ArrowRight", keyCode: 39 });
    await page.waitFor(
      `/saved/i.test(document.querySelector('#settings .settings-status')?.innerText ?? '')`,
      "context saved inline",
      15000,
    );
    const ctxAfter = (await rpc(run, { action: "settings-snapshot", id: projectId })).values.context?.thresholdPercent;
    if (ctxAfter !== ctxBefore + 1) throw Error(`auto-compaction ${ctxBefore} -> ${ctxAfter}`);
    const ctxBar = await page.evaluate(
      `({ used: !!document.querySelector('#settings .ctx-bar .ctx-now'), window: document.querySelector('#settings .ctx-total')?.innerText ?? '', compact: !!document.querySelector('#settings #compact-now') })`,
    );
    if (!ctxBar.used || !/\//.test(ctxBar.window) || !ctxBar.compact) throw Error(`context bar parts: ${JSON.stringify(ctxBar)}`);
    record("side-effect", `context bar: auto-compaction ${ctxBefore}% -> ${ctxAfter}% by keyboard, saved; use "${ctxBar.window}"`);
    await delay(300);
    await page.shot(dir, "13-settings-context");
    // Prompt editor: Edit, change the project instructions, Save; prompt-render returns the new text.
    await page.click('#settings nav [data-section="prompt"]');
    await page.waitFor(`!!document.querySelector('#settings [data-mode="edit"]')`, "prompt section");
    await page.click('#settings [data-mode="edit"]');
    await page.waitFor(`!!document.querySelector('#settings [data-sec="project"] textarea')`, "prompt editor");
    await page.evaluate(
      `(() => { const t = document.querySelector('#settings [data-sec="project"] textarea'); t.focus(); t.select(); })()`,
    );
    await page.cdp("Input.insertText", { text: "VERIFY project instructions: greet briefly." });
    await page.click("#settings #prompt-save");
    await page.waitFor(
      `/saved/i.test(document.querySelector('#settings .settings-status')?.innerText ?? '')`,
      "prompt saved inline",
      15000,
    );
    const rendered = await rpc(run, { action: "prompt-render", projectId, profile: "coordinator" });
    if (!rendered.sections.find((item) => item.id === "project")?.text.includes("VERIFY project instructions"))
      throw Error("prompt-render project section does not hold the saved text");
    record("side-effect", "prompt editor saved the project instructions; prompt-render shows them");
    // Tools: switch one unlocked coordinator tool off; profile-tools reports it disabled; switch it back on.
    await page.click('#settings nav [data-section="tools"]');
    await page.waitFor(`!!document.querySelector('#settings [data-tool-name]:not([disabled])')`, "tools grid");
    const toolName = await page.evaluate(`document.querySelector('#settings [data-tool-name]:not([disabled])').dataset.toolName`);
    const toolBox = `#settings [data-tool-name="${toolName}"]`;
    await page.click(toolBox);
    const toolOff = async () =>
      (await rpc(run, { action: "profile-tools", projectId, profile: "coordinator" })).groups
        .flatMap((group) => group.tools)
        .find((tool) => tool.name === toolName)?.enabled === false;
    await until(toolOff, `profile-tools reports ${toolName} off`);
    await page.waitFor(`document.querySelector(${JSON.stringify(toolBox)})?.checked === false`, "tool box unchecked after reload");
    await page.shot(dir, "14-settings-tools-off");
    await page.click(toolBox);
    await until(async () => !(await toolOff()), `profile-tools reports ${toolName} on again`);
    record("side-effect", `Tools: ${toolName} off for the coordinator (profile-tools enabled false), then on again`);
    // Tier editor: rename the tier and add a tier with the fallback model; tiers-get keeps both.
    await page.click('#settings nav [data-section="tiers"]');
    await page.waitFor(`!!document.querySelector('#settings .tier-edit .tier-name-input')`, "tiers editor again");
    await page.evaluate(`(() => { const t = document.querySelector('#settings .tier-edit .tier-name-input'); t.focus(); t.select(); })()`);
    await page.cdp("Input.insertText", { text: "Verify tier" });
    await page.evaluate(
      `document.querySelector('#settings .tier-edit .tier-name-input').dispatchEvent(new Event('change', { bubbles: true }))`,
    );
    await page.click("#settings #tier-new");
    await page.waitFor(`document.querySelectorAll('#settings .tier-edit').length === 2`, "new tier row");
    await page.cdp("Input.insertText", { text: "fallback-model" });
    await page.waitFor(
      `!!document.querySelector('#settings .tier-edit[data-t="1"] [data-add="fake/fallback-model"]')`,
      "model search in the new tier",
    );
    await page.click('#settings .tier-edit[data-t="1"] [data-add="fake/fallback-model"]');
    await page.click("#settings #tiers-save");
    await page.waitFor(`!document.querySelector('#settings #tiers-save')`, "tiers saved again");
    const named = (await rpc(run, { action: "tiers-get" })).tiers;
    if (named.length !== 2 || named[0].name !== "Verify tier" || named[1].models.join() !== "fake/fallback-model")
      throw Error(`tiers-get after rename/add: ${JSON.stringify(named)}`);
    record("side-effect", `tiers-set: renamed to "Verify tier", added ${named[1].id} (${named[1].letter}) with fake/fallback-model`);
    // Model page: every tier as a row plus Project model; pick the new tier, then back to the project model.
    await page.click('#settings nav [data-section="model"]');
    await page.waitFor(`document.querySelectorAll('#settings .tier-row').length === 3`, "two tier rows and the project model row");
    await page.click(`#settings .tier-row[data-tier="${named[1].id}"]`);
    await page.waitFor(
      `document.querySelector('#settings .tier-row[data-tier="${named[1].id}"]')?.getAttribute('aria-checked') === 'true'`,
      "new tier selected",
    );
    const onTier = (await rpc(run, { action: "profiles-get", projectId })).profiles.coordinator;
    if (onTier.tier !== named[1].id || onTier.effectiveModel !== "fake/fallback-model")
      throw Error(`coordinator on tier: ${JSON.stringify(onTier)}`);
    await delay(300);
    await page.shot(dir, "15-settings-model-tiers");
    await page.click('#settings .tier-row[data-tier=""]');
    await page.waitFor(
      `document.querySelector('#settings .tier-row[data-tier=""]')?.getAttribute('aria-checked') === 'true'`,
      "project model selected",
    );
    const offTier = (await rpc(run, { action: "profiles-get", projectId })).profiles.coordinator;
    if (offTier.tier || offTier.effectiveModel !== "fake/fake-model")
      throw Error(`coordinator back on the project model: ${JSON.stringify(offTier)}`);
    record("side-effect", `Model rows: coordinator on ${named[1].id} (effective fake/fallback-model), then Project model (no tier)`);
    await page.press("Escape", { keyCode: 27 });
    // A coordinator files a dangerous request through owner_approval_request: the chat row links to the card, the pill counts it.
    const spare2 = await rpc(run, {
      action: "create",
      requestId: randomUUID(),
      name: "Verify spare two",
      cwd: run.workspace,
      objective: "Archive request from a coordinator",
      model: "fake/fake-model",
    });
    await page.click("#composer textarea");
    await page.cdp("Input.insertText", { text: `VERIFY-COORD-APPROVAL ${spare2.id}` });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(
      `!!document.querySelector('#feed .tool-row[data-tool="owner_approval_request"] [data-review-approval]')`,
      "approval row in the chat",
      60000,
    );
    await page.waitFor(`/needs you/.test(document.querySelector('#status-pill').innerText)`, "pill counts the coordinator approval");
    await page.shot(dir, "16-coordinator-approval-row");
    await page.click('#feed .tool-row[data-tool="owner_approval_request"] [data-review-approval]');
    await page.waitFor(
      `[...document.querySelectorAll('#ha-approvals .approval[data-approval]')].some(n => /Archive the second spare project/.test(n.innerText) && /Coordinator/.test(n.innerText))`,
      "coordinator approval card in the drawer",
    );
    await delay(300);
    await page.shot(dir, "16b-coordinator-approval-card");
    await page.click('#ha-approvals .approval[data-approval] [data-decide="deny"]');
    await page.waitFor(`!document.querySelector('#ha-approvals .approval[data-approval]')`, "coordinator card gone after Deny");
    await page.press("\\", { code: "Backslash", keyCode: 220 });
    await page.waitFor(
      `[...document.querySelectorAll('#feed .approval-row')].some(n => /Denied/i.test(n.innerText))`,
      "denied outcome row in the coordinator chat",
      60000,
    );
    const spare2Now = (await rpc(run, { action: "list" })).find((item) => item.id === spare2.id);
    if (spare2Now?.archived) throw Error("denied coordinator approval still archived the project");
    record(
      "side-effect",
      "coordinator owner_approval_request: chat row → drawer card (Coordinator) → Deny; outcome row in the chat; project kept",
    );
    // Light theme through the settings overlay, then the narrow layout.
    await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.waitFor(`document.querySelector('#settings')?.open === true`, "settings again");
    await page.press("h", { keyCode: 72 });
    await page.click('#settings [data-theme-option="light"]');
    await page.waitFor(`document.documentElement.dataset.theme === 'light'`, "light applied");
    await delay(300); // let the open transition finish before the screenshot
    await page.press("Escape", { keyCode: 27 });
    await page.shot(dir, "09-chat-light");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await delay(400);
    const overflow = await page.evaluate(`document.documentElement.scrollWidth - innerWidth`);
    await page.shot(dir, "10-narrow-390-light");
    if (overflow > 0) throw Error(`narrow layout overflows by ${overflow}px`);
    // Toasts: one identical message shows once, at most two show, and none covers the composer.
    for (let i = 0; i < 3; i++) await page.click("#status-pill");
    await page.waitFor(`document.querySelectorAll('#toasts .toast').length >= 1`, "pill toast");
    const toastBox = await page.evaluate(`(() => {
      const c = document.querySelector('#composer').getBoundingClientRect();
      const nodes = [...document.querySelectorAll('#toasts .toast:not(.leaving)')], t = nodes.map(n => n.getBoundingClientRect());
      const texts = nodes.map(n => n.dataset.text);
      return { count: t.length, unique: new Set(texts).size === texts.length, texts, covers: t.some(r => r.bottom > c.top && r.top < c.bottom && r.right > c.left && r.left < c.right) };
    })()`);
    if (toastBox.count > 2 || !toastBox.unique || toastBox.covers) throw Error(`toasts at 390 px: ${JSON.stringify(toastBox)}`);
    await delay(300);
    await page.shot(dir, "10a-narrow-toast");
    // The Host agent drawer at 390 px: full width, composer visible, closes by keyboard.
    await page.press("\\", { code: "Backslash", keyCode: 220 });
    await page.waitFor(`document.querySelector('#host-agent')?.dataset.open === '1'`, "drawer at 390 px");
    await delay(400);
    const drawerBox = await page.evaluate(`(() => {
      const d = document.querySelector('#host-agent').getBoundingClientRect(), c = document.querySelector('#ha-composer').getBoundingClientRect();
      return { left: d.left, right: d.right, width: innerWidth, composer: c.bottom <= innerHeight && c.top >= d.top && c.height > 0, overflow: document.documentElement.scrollWidth - innerWidth };
    })()`);
    if (drawerBox.left < 0 || drawerBox.right > drawerBox.width + 0.5 || !drawerBox.composer || drawerBox.overflow > 0)
      throw Error(`drawer at 390 px: ${JSON.stringify(drawerBox)}`);
    await page.shot(dir, "10b-narrow-390-drawer");
    // Focus is in the drawer's composer, where \\ is a character; Esc closes the drawer.
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`document.querySelector('#host-agent')?.dataset.open !== '1'`, "drawer closed at 390 px");
    record(
      "verified",
      `390 px: three identical events show once (${toastBox.count} toasts in all), clear of the composer; drawer ${Math.round(drawerBox.right - drawerBox.left)} px wide with its composer visible`,
    );
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // Back to the default theme so a rerun starts from Claude.
    await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.waitFor(`document.querySelector('#settings')?.open === true`, "settings for reset");
    await page.press("h", { keyCode: 72 });
    await page.click('#settings [data-theme-option="claude"]');
    await page.waitFor(`document.documentElement.dataset.theme === 'claude'`, "claude restored");
    record("verified", "no horizontal overflow at 390 px; themes claude, midnight and light applied through the settings overlay");
    writeFileSync(join(dir, "feed-dom.txt"), await page.evaluate(`document.querySelector('#feed').innerText`));
    if (sinks.errors.length) throw Error(`browser errors: ${sinks.errors.slice(0, 3).join(" | ")}`);
  },
  // Feature: features/message-coordinator.md
  async "message-coordinator"(run, page, record, dir) {
    const prompt = `VERIFY-PING ${run.id}`,
      composer = 'textarea[aria-label="Message coordinator"]';
    const origin = new URL(run.webUrl).origin;
    await page.navigate(run.webUrl);
    await page.waitFor(
      `document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`,
      "seeded project title shown",
    );
    await page.waitFor(
      `!!document.querySelector(${JSON.stringify(composer)}) && !document.querySelector('#sign-in')?.open`,
      "composer visible, sign-in closed",
    );
    record("entry", `opened ${origin} through the launch link; project "${PROJECT_NAME}" selected`);
    await page.shot(dir, "01-before-send");
    // Real user input: pointer-click the composer, insert text through the browser input pipeline, pointer-click Send.
    await page.click(composer);
    await page.cdp("Input.insertText", { text: prompt });
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ${JSON.stringify(prompt)}`, "typed text in composer");
    await page.shot(dir, "02-typed");
    const before = existsSync(run.requestLog) ? readFileSync(run.requestLog, "utf8").split("\n").filter(Boolean).length : 0;
    await page.click("#compose button[type=submit]");
    record("action", `pointer-clicked "Send ↵" with message ${JSON.stringify(prompt)}`);
    // The user's own bubble appears once, and the composer clears.
    const bubbles = (role) => `[...document.querySelectorAll('#messages article.msg.${role} .text')].map(n => n.innerText)`;
    await page.waitFor(`${bubbles("you")}.some(t => t.includes(${JSON.stringify(prompt)}))`, "user bubble rendered");
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ''`, "composer cleared");
    record("visible", "user bubble shows the message and the composer is empty");
    await page.waitFor(`${bubbles("them")}.some(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}'))`, "coordinator reply rendered", 60000);
    await page.shot(dir, "03-reply");
    const count = await page.evaluate(
      `({ you: ${bubbles("you")}.filter(t => t.includes(${JSON.stringify(prompt)})).length, them: ${bubbles("them")}.filter(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}')).length })`,
    );
    if (count.you !== 1 || count.them !== 1) throw Error(`expected exactly one user and one reply bubble, got ${JSON.stringify(count)}`);
    record("visible", "one user bubble and one coordinator bubble with the VERIFY-FAKE-REPLY echo");
    // Persistence: a reload (token kept in localStorage) re-renders both turns from the host.
    await page.reload();
    await page.waitFor(
      `${bubbles("you")}.some(t => t.includes(${JSON.stringify(prompt)})) && ${bubbles("them")}.some(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}'))`,
      "both bubbles after reload",
    );
    await page.shot(dir, "04-after-reload");
    writeFileSync(join(dir, "messages-dom.txt"), await page.evaluate(`document.querySelector('#messages').innerText`));
    record("persist", "after reload both bubbles are rendered again");
    // Side effects: the model seam received the prompt, and the host's stored transcript has both turns.
    const calls = readFileSync(run.requestLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (calls.length <= before || !calls.some((call) => call.user.includes(prompt))) throw Error("fake provider never received the prompt");
    const view = await rpc(run, { action: "show", id: run.projectId });
    const texts = (view.messages ?? []).map((m) => `${m.role ?? m.from ?? "?"}: ${m.text}`);
    writeFileSync(join(dir, "host-show-messages.json"), JSON.stringify(texts, null, 2));
    if (!texts.some((t) => t.includes(prompt)) || !texts.some((t) => t.includes(`VERIFY-FAKE-REPLY: ${prompt}`)))
      throw Error(`host transcript lacks both turns: ${JSON.stringify(texts).slice(0, 500)}`);
    writeFileSync(join(dir, "model-requests.jsonl"), calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
    record(
      "side-effect",
      `host \`show\` lists both turns; fake provider logged ${calls.length - before} new call(s) containing the prompt`,
    );
  },
};

async function drive() {
  const run = loadRun(),
    name = positional[0],
    journey = journeys[name];
  if (!journey) fail(`unknown feature ${JSON.stringify(name)}; known: ${Object.keys(journeys).join(", ")}`);
  // One fresh directory per drive, so a retry never overwrites an earlier attempt's proof.
  const dir = join(run.evidence, `drive-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  const sinks = { errors: [], httpErrors: [] },
    steps = [];
  const record = (kind, detail) => {
    steps.push({ kind, detail: redact(detail), at: new Date().toISOString() });
    console.log(redact(`${kind}: ${detail}`));
  };
  let page, failure;
  try {
    page = await openBrowser(run, sinks);
    await journey(run, page, record, dir, sinks);
  } catch (error) {
    failure = error;
    try {
      await page?.shot(dir, "99-failure");
    } catch {}
  } finally {
    try {
      await page?.close();
    } catch (error) {
      failure ??= error;
    }
    // Chrome may exist without a page when openBrowser threw: cleanup reaps anything still recorded.
    collectDiagnostics(run, { drive: name });
    const problems = failure
      ? [failure.message]
      : sinks.errors.length || sinks.httpErrors.length
        ? [`browser reported errors: ${JSON.stringify({ errors: sinks.errors, http: sinks.httpErrors })}`]
        : [];
    writeFileSync(
      join(dir, "report.json"),
      redact(
        JSON.stringify(
          {
            feature: name,
            entry: "browser launch link",
            ok: problems.length === 0,
            problems,
            steps,
            consoleErrors: sinks.errors,
            httpErrors: sinks.httpErrors,
            revision: run.revision,
          },
          null,
          2,
        ),
      ),
    );
    if (problems.length) fail(problems[0]);
  }
  out({ ok: true, feature: name, evidence: dir });
}

/** Stops every process recorded in run.json that still verifies as ours (graceful host shutdown first), then removes scratch. Returns the labels still alive; scratch and run.json stay in that case so a retry works. */
async function cleanup(run = loadRun(), { quiet = false } = {}) {
  collectDiagnostics(run, { phase: "cleanup" });
  const stillAlive = [],
    notOurs = [];
  if (ownership(run.pids.host ?? { pid: 0 }) === "ours") {
    await rpc(run, { action: "shutdown" }).catch(() => {});
    for (let i = 0; i < 150 && ownership(run.pids.host) === "ours"; i++) await delay(100);
  }
  for (const [label, who] of Object.entries(run.pids)) {
    const state = ownership(who);
    if (state === "foreign") {
      notOurs.push(label);
      continue;
    }
    // Leader is ours, or already gone with children possibly left in its group: signal the group, never a bare pid we cannot verify.
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (ownership(who) === "dead" && !groupAlive(who.pgid)) break;
      if (ownership(who) === "foreign") break;
      try {
        process.kill(-who.pgid, signal);
      } catch {}
      for (let i = 0; i < 30 && (ownership(who) === "ours" || groupAlive(who.pgid)); i++) await delay(100);
    }
    if (ownership(who) === "ours" || (ownership(who) === "dead" && groupAlive(who.pgid))) stillAlive.push(label);
  }
  if (stillAlive.length) {
    collectDiagnostics(run, { phase: "cleanup-incomplete", stillAlive });
    console.error(`FAIL: processes still alive: ${stillAlive}; scratch kept at ${run.scratch}, rerun cleanup`);
    return stillAlive;
  }
  // Scratch removal is limited to the directory this run created; evidence lives elsewhere and stays.
  collectDiagnostics(run, { phase: "cleanup-done", pidsNotOurs: notOurs });
  if (run.scratch.includes("/pi-verify-")) {
    try {
      if (existsSync(run.socket)) rmSync(run.socket);
    } catch {}
    rmSync(run.scratch, { recursive: true, force: true });
  }
  if (!quiet)
    out({
      cleaned: run.scratch,
      skippedReusedPids: notOurs,
      evidenceKept: run.evidence,
      evidenceFiles: existsSync(run.evidence) ? readdirSync(run.evidence) : [],
    });
  return [];
}

if (command === "launch") await launch();
else if (command === "doctor") await doctor();
else if (command === "rpc") await rpcCommand();
else if (command === "drive") await drive();
else if (command === "cleanup") process.exit((await cleanup()).length ? 1 : 0);
else
  fail(
    "usage: verify.mjs <launch [--evidence dir] | doctor --run dir | rpc --run dir <action> [json] | drive --run dir <feature> | cleanup --run dir>",
  );
