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
import { deflateSync } from "node:zlib";
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
    writeFileSync(join(run.workspace, "screen.png"), fakeScreenshot());
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
      select: async (selector, value) => {
        const changed = await page.evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value === ${JSON.stringify(value)}; })()`,
        );
        if (!changed) throw Error(`select target or option not found: ${selector} = ${value}`);
      },
      cdp: (method, params) => send(method, params, sessionId),
      shot: async (dir, name) => {
        const image = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        writeFileSync(join(dir, `${name}.png`), Buffer.from(image.data, "base64"));
      },
      waitFor: (expression, what, ms = 30000) => until(() => page.evaluate(expression), what, ms),
      /** A real key press through the browser input pipeline; modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. `text: "\r"` makes Enter
       * activate a focused button. */
      press: async (key, { code = key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode = 0, modifiers = 0, text: typed } = {}) => {
        const text = typed ?? (key.length === 1 && !(modifiers & 6) ? key : undefined);
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

const ITEM_ORDER = ["activity", "model", "thinking", "context", "cost", "limits", "spacer", "machine", "connection", "hints"];

/** A 1000×640 PNG (a realistic screenshot size) with a solid accent bar: what a VERIFY-IMAGE read returns. */
function fakeScreenshot(width = 1000, height = 640) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]),
      out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rows.set(y < 80 ? [217, 119, 87] : [(x * 200) / width + 40, 60, (y * 160) / height + 90], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Page expression: the newest `.prose` under `selector` holds the VERIFY-TABLE reply rendered safely. Returns { problems, summary }. */
function proseCheck(selector) {
  return `(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(n => n.querySelector('table'));
    const p = all.at(-1), problems = [];
    if (!p) return { problems: ['no prose with a table'], summary: '' };
    const th = [...p.querySelectorAll('table thead th')], rows = p.querySelectorAll('table tbody tr');
    if (th.map(n => n.textContent.trim()).join('|') !== 'Role|Model|Cost') problems.push('header ' + th.map(n => n.textContent).join('|'));
    if (rows.length !== 2) problems.push(rows.length + ' body rows');
    if (!th[1]?.classList.contains('align-center') || !th[2]?.classList.contains('align-right')) problems.push('column alignment lost');
    const wrap = p.querySelector('table')?.parentElement;
    if (!wrap?.classList.contains('table-wrap') || !/auto|scroll/.test(getComputedStyle(wrap).overflowX)) problems.push('table does not scroll in its own box');
    if (p.querySelector('img, script, [onerror]') || window.__xss) problems.push('hostile HTML became live');
    if ([...p.querySelectorAll('a')].some(a => !/^https?:/.test(a.getAttribute('href') ?? ''))) problems.push('non-web link is clickable');
    if (p.querySelector('code')?.textContent !== '**sol**') problems.push('code span formatted: ' + p.querySelector('code')?.innerHTML);
    if (p.querySelector('del')?.textContent !== 'old') problems.push('no strikethrough');
    if (p.querySelector('ul > li > ul > li')?.textContent !== 'nested') problems.push('nested list flattened');
    if (p.querySelector('ol')?.getAttribute('start') !== '3' || p.querySelectorAll('ol > li').length !== 2) problems.push('numbered list start lost');
    if (!p.querySelector('blockquote strong')) problems.push('no quote');
    const docs = [...p.querySelectorAll('a')].find(a => a.getAttribute('href') === 'https://example.com/docs');
    if (!docs || docs.textContent !== 'https://example.com/docs') problems.push('autolink swallowed punctuation');
    if (![...p.querySelectorAll('a')].some(a => a.getAttribute('href') === 'https://example.com/p.png' && a.rel.includes('noopener'))) problems.push('image is not a plain link');
    if (!/<img src=x onerror/.test(p.textContent)) problems.push('escaped HTML text missing');
    return { problems, summary: th.length + ' columns, ' + rows.length + ' rows, nested list, ol start 3, quote, inert HTML and links' };
  })()`;
}

/** UI 2.0 composer "/" completion: commands at the start, skills anywhere, keyboard and pointer picking, Esc, a command that runs. */
async function ui2SlashMenu(run, page, record, dir) {
  const composer = "#composer textarea";
  const menu = `(() => { const m = document.querySelector('#slash-menu'), t = document.querySelector('#composer textarea');
    const opts = [...(m?.querySelectorAll('[role=option]') ?? [])];
    return { open: !!m && !m.hidden, role: m?.getAttribute('role'), expanded: t.getAttribute('aria-expanded'), controls: t.getAttribute('aria-controls'),
      active: t.getAttribute('aria-activedescendant'), selected: opts.findIndex(o => o.getAttribute('aria-selected') === 'true'),
      ids: opts.map(o => o.id), items: opts.map(o => o.dataset.source + ':' + o.dataset.name), value: t.value, focused: document.activeElement === t }; })()`;
  const owners = `document.querySelectorAll('#feed .msg.owner').length`,
    ownersBefore = await page.evaluate(owners);
  const clear = `(() => { const t = document.querySelector('#composer textarea'); t.value = ''; t.dispatchEvent(new Event('input')); })()`;
  const skills = (await rpc(run, { action: "coordinator-skills", id: run.projectId })).skills.map((skill) => skill.name);
  if (!skills.includes("verify-pi-prjcts")) throw Error(`seed skill missing from coordinator-skills: ${skills}`);
  await page.click(composer);
  await page.cdp("Input.insertText", { text: "/" });
  await page.waitFor(`${menu}.open`, "slash menu opens on /");
  let state = await page.evaluate(menu);
  if (state.role !== "listbox" || state.expanded !== "true" || state.controls !== "slash-menu" || state.active !== state.ids[0])
    throw Error(`slash menu a11y: ${JSON.stringify(state)}`);
  if (!state.items.includes("command:reload") || !state.items.includes("skill:verify-pi-prjcts"))
    throw Error(`slash menu items at the start: ${state.items}`);
  await page.press("ArrowDown", { keyCode: 40 });
  state = await page.evaluate(menu);
  if (state.selected !== 1 || state.active !== state.ids[1]) throw Error(`ArrowDown: ${JSON.stringify(state)}`);
  await delay(200);
  await page.shot(dir, "01b-slash-menu");
  await page.cdp("Input.insertText", { text: "verif" });
  await page.waitFor(`${menu}.items.join() === 'skill:verify-pi-prjcts'`, "filtered to the matching skill");
  await page.press("Tab", { keyCode: 9 });
  state = await page.evaluate(menu);
  if (state.value !== "/skill:verify-pi-prjcts " || state.open || state.expanded !== "false" || !state.focused)
    throw Error(`Tab pick: ${JSON.stringify(state)}`);
  record(
    "visible",
    `"/" lists ${state.items.length || "commands and"} skills from coordinator-skills; ArrowDown moves; Tab inserts /skill:verify-pi-prjcts`,
  );
  // Mid-message: skills only; Esc closes just the menu; a non-matching slash stays text; a click picks and keeps focus.
  await page.cdp("Input.insertText", { text: "and /" });
  await page.waitFor(`${menu}.open`, "mid-message slash menu");
  state = await page.evaluate(menu);
  if (state.items.some((item) => item.startsWith("command:"))) throw Error(`commands offered mid-message: ${state.items}`);
  await page.press("Escape", { keyCode: 27 });
  state = await page.evaluate(menu);
  if (state.open || !state.focused || state.value !== "/skill:verify-pi-prjcts and /") throw Error(`Esc: ${JSON.stringify(state)}`);
  await page.cdp("Input.insertText", { text: "zzzq" });
  await delay(300);
  if ((await page.evaluate(menu)).open) throw Error("a mid-message slash with no match opened the menu");
  await page.cdp("Input.insertText", { text: " /verif" });
  await page.waitFor(`${menu}.items.join() === 'skill:verify-pi-prjcts'`, "mid-message skill match");
  await page.click('#slash-menu [data-name="verify-pi-prjcts"]');
  state = await page.evaluate(menu);
  if (!state.value.endsWith(" /skill:verify-pi-prjcts ") || state.open || !state.focused)
    throw Error(`click pick: ${JSON.stringify(state)}`);
  record("visible", "mid-message: skills only, Esc closes only the menu, no menu for an unmatched slash, a click inserts and keeps focus");
  // A command that takes an argument fills the composer; one without runs on Enter instead of being sent.
  await page.evaluate(clear);
  await page.cdp("Input.insertText", { text: "/na" });
  await page.waitFor(`${menu}.items[0] === 'command:name'`, "name command first");
  await page.press("Enter", { code: "Enter", keyCode: 13 });
  state = await page.evaluate(menu);
  if (state.value !== "/name " || state.open) throw Error(`argument command: ${JSON.stringify(state)}`);
  await page.evaluate(clear);
  await page.cdp("Input.insertText", { text: "/rel" });
  await page.waitFor(`${menu}.items[0] === 'command:reload'`, "reload command first");
  await page.press("Enter", { code: "Enter", keyCode: 13 });
  await page.waitFor(`/Reloaded|Already up to date/.test(document.querySelector('#toasts')?.innerText ?? '')`, "/reload ran", 30000);
  state = await page.evaluate(menu);
  const sent = (await rpc(run, { action: "show", id: run.projectId })).messages.filter((item) => item.text?.includes("/reload"));
  if (state.value || sent.length || (await page.evaluate(owners)) !== ownersBefore)
    throw Error(`/reload was sent as a message: ${JSON.stringify({ state, sent: sent.length })}`);
  record("side-effect", "/name fills the composer for its argument; /reload ran chat-reload (toast) and nothing reached the coordinator");
}

/** Page expression: the image under `selector` is the full 1000 px screenshot, loaded from a blob: URL. */
const screenshotLoaded = (selector) =>
  `(() => { const img = document.querySelector(${JSON.stringify(selector)}); return !!img && img.complete && img.naturalWidth === 1000 && img.src.startsWith('blob:'); })()`;
/** Page expression: every loaded image under `root` shows bounded (≤ 520×360) yet readable (≥ 120 px wide), inside its column. */
const screenshotsBounded = (root) => `(() => {
  const column = document.querySelector(${JSON.stringify(root)}).getBoundingClientRect();
  return [...document.querySelectorAll(${JSON.stringify(`${root} img.media-img`)})].map(img => img.getBoundingClientRect())
    .map(r => ({ w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= column.left - 1 && r.right <= column.right + 1 }));
})()`;
const badBox = (boxes) => !boxes.length || boxes.some((box) => box.w > 520 || box.h > 360 || box.w < 120 || !box.inside);

/** Transcript images: a tool-result screenshot and a cited artifact load lazily as blob: images; a missing one degrades to text. */
async function ui2Images(run, page, record, dir, sinks) {
  await page.click("#composer textarea");
  await page.cdp("Input.insertText", { text: "VERIFY-IMAGE look at the screen" });
  await page.press("Enter", { code: "Enter", keyCode: 13 });
  await page.waitFor(`document.querySelector('#feed').innerText.includes('Screenshot:')`, "image reply", 60000);
  const view = await rpc(run, { action: "show", id: run.projectId });
  const result = view.messages.findLast((item) => item.kind === "tool-result" && item.name === "read");
  if (!result?.images?.length) throw Error(`the read result carries no image reference: ${JSON.stringify(result).slice(0, 300)}`);
  await page.waitFor(
    screenshotLoaded('#feed .tool-row[data-tool="read"] img.media-img'),
    "tool-result screenshot shown under the collapsed row",
  );
  await page.waitFor(screenshotLoaded("#feed .msg.agent .prose img.media-img"), "cited artifact image inline in the reply");
  const boxes = await page.evaluate(screenshotsBounded("#feed"));
  if (badBox(boxes)) throw Error(`1000 px screenshots are not shown bounded in the chat column: ${JSON.stringify(boxes)}`);
  await page.waitFor(
    `/gone/.test(document.querySelector('#feed .msg.agent .prose [data-media][data-state="missing"]')?.innerText ?? '')`,
    "missing artifact degrades to a labelled note",
  );
  const facts = await page.evaluate(`(async () => {
    const { transcriptHtml } = await import('/chat.js');
    const only = transcriptHtml([{ kind: 'message', role: 'assistant', entryId: 9e9, at: 0, text: '', ref: '1.0', truncated: false, images: [{ ref: '1.0.0', mime: 'image/png', bytes: 2048 }] },
      { kind: 'message', role: 'user', origin: 'owner', entryId: 9e9 + 1, at: 0, text: '', ref: '2.0', truncated: false, images: [{ ref: '2.0.1', mime: 'image/"png', bytes: 10 }] }], false);
    const box = document.createElement('div');
    box.innerHTML = only;
    const shown = document.querySelector('#feed .msg.agent .prose img.media-img');
    return { slots: box.querySelectorAll('[data-media][data-image-ref]').length, raw: box.querySelectorAll('img:not([src])').length, alt: shown.alt, external: performance.getEntriesByType('resource').filter(e => !e.name.startsWith(location.origin) && !e.name.startsWith('blob:')).map(e => e.name) };
  })()`);
  if (facts.slots !== 2) throw Error(`image-only messages render no image slot: ${JSON.stringify(facts)}`);
  if (facts.raw) throw Error("an image slot is a broken <img> without src");
  if (facts.alt !== "screen") throw Error(`artifact alt text: ${facts.alt}`);
  if (facts.external.length) throw Error(`the page fetched outside the host: ${facts.external}`);
  record(
    "visible",
    `read result screenshot (${result.images[0].mime}) and cited artifact load as blob: images; missing artifact shows a note; image-only messages render slots; nothing fetched off-host`,
  );
  await delay(300);
  await page.shot(dir, "01d-images");
  // The missing artifact is the one expected 404: requested once per page load, not again per re-render.
  const missing = sinks.httpErrors.filter((item) => item.status === 404 && item.url.endsWith("/binary/missing.png"));
  if (missing.length !== 1) throw Error(`missing artifact requested ${missing.length} times`);
}
/** A worker transcript in the center loads its own images through its thread: tool result and cited artifact. */
async function ui2WorkerImages(run, page, record, dir) {
  await page.click("#composer textarea");
  await page.cdp("Input.insertText", { text: "VERIFY-WORKER-IMAGE ask a worker" });
  await page.press("Enter", { code: "Enter", keyCode: 13 });
  await page.waitFor(
    `[...document.querySelectorAll('#feed .tool-row[data-tool="agents"]')].some(n => /Look at the screen/.test(n.innerText) && n.querySelector('[data-open-worker]'))`,
    "worker spawn row",
    60000,
  );
  const worker = await page.evaluate(
    `[...document.querySelectorAll('#feed .tool-row[data-tool="agents"]')].findLast(n => /Look at the screen/.test(n.innerText)).querySelector('[data-open-worker]').dataset.openWorker`,
  );
  await until(
    async () => {
      const history = await rpc(run, { action: "thread-history", id: run.projectId, threadId: worker, limit: 50 });
      return history.items.some((item) => item.kind === "message" && item.role === "assistant" && /Screenshot:/.test(item.text));
    },
    "worker reply with its screenshot",
    90000,
  );
  // Click only once the coordinator's turn about this worker has painted; a repaint under the click would swallow it.
  await page.waitFor(
    `document.querySelectorAll('#feed [data-open-worker="${worker}"]').length >= 2 && [...document.querySelectorAll('#feed .msg.agent')].at(-1)?.innerText.includes('Proof is available')`,
    "coordinator turn about the worker settled",
    60000,
  );
  await delay(500);
  await page.click(`#feed [data-open-worker="${worker}"]`);
  await page.waitFor(`document.querySelector('#center').dataset.focus === 'worker'`, "worker transcript in the center");
  // Lazy: the view opens at the bottom, where the reply's images are; the read row's image loads once it is scrolled near.
  const missingNote = `#worker-feed .prose [data-media][data-state="missing"]`;
  await page.waitFor(`!!document.querySelector('${missingNote}')`, "worker missing artifact note");
  await page.evaluate(`document.querySelector('${missingNote}').scrollIntoView({ block: 'end' })`);
  await page.waitFor(screenshotLoaded("#worker-feed .msg.agent .prose img.media-img"), "worker cited artifact image");
  await page.waitFor(`!!document.querySelector('#worker-feed .tool-row[data-tool="read"] [data-media]')`, "worker read row image slot");
  await page.evaluate(`document.querySelector('#worker-feed .tool-row[data-tool="read"]').scrollIntoView({ block: 'center' })`);
  await page.waitFor(screenshotLoaded('#worker-feed .tool-row[data-tool="read"] img.media-img'), "worker tool-result screenshot");
  // The earlier worker view (VERIFY-JOB) is gone: a jobs change re-reads only the open worker's thread.
  const reread = await page.evaluate(`(async () => {
    const seen = [], real = window.fetch;
    window.fetch = (url, init) => {
      try { const body = JSON.parse(init?.body ?? 'null'); if (body?.action === 'thread-history') seen.push(body.threadId); } catch {}
      return real(url, init);
    };
    (await import('/state.js')).emit('jobs');
    await new Promise(done => setTimeout(done, 1500));
    window.fetch = real;
    return { seen, head: document.querySelector('#focus-view .focus-head h1')?.textContent };
  })()`);
  if (reread.head !== "Look at the screen" || reread.seen.some((thread) => thread !== worker))
    throw Error(`a closed worker view still reloads: ${JSON.stringify(reread)}`);
  const boxes = await page.evaluate(screenshotsBounded("#worker-feed"));
  if (badBox(boxes)) throw Error(`worker screenshots are not shown bounded: ${JSON.stringify(boxes)}`);
  record(
    "visible",
    `worker ${worker} transcript in the center: tool-result and cited 1000 px screenshots load through its thread; missing one is a note`,
  );
  await delay(300);
  await page.shot(dir, "04d-worker-images");
  await page.press("Escape", { keyCode: 27 });
  await page.waitFor(`document.querySelector('#center').dataset.focus === 'chat'`, "Esc returns to chat after the worker");
}
/** Drops the expected missing-artifact 404s and their console lines: the coordinator's once per page load of the ui2 journey (the
 *  first and two reloads) plus the worker's once. */
function dropMissingArtifact(sinks, loads) {
  const missing = sinks.httpErrors.filter((item) => item.status === 404 && item.url.endsWith("/binary/missing.png"));
  if (missing.length > loads) throw Error(`missing artifact requested ${missing.length} times in ${loads} page loads`);
  for (const item of missing) {
    sinks.httpErrors.splice(sinks.httpErrors.indexOf(item), 1);
    const log = sinks.errors.findIndex((text) => /status of 404/.test(text));
    if (log >= 0) sinks.errors.splice(log, 1);
  }
}

/** Settings → Prompt: blocks per target, one selected editor, preview, drafts and conflicts (features/ui2-prompts.md). Check ids are
 * the failure list in scripts/ui2-prompt-editor-failures.md. */
async function ui2Prompts(run, page, record, dir, sinks) {
  const origin = new URL(run.webUrl).origin,
    hash = new URL(run.webUrl).hash,
    projectId = run.projectId;
  // Host second view: the stored blocks of a target (docs/ui2-contract.md, prompt blocks). The Host agent target has no project.
  const where = (target) => (target === "host" ? {} : { projectId });
  const blocks = (target) => rpc(run, { action: "prompt-blocks-get", ...where(target), target });
  /** Another writer (a second tab, the Host agent) changes blocks with the revision it just read; `patch` is per block id. */
  const otherWriter = async (target, patch) => {
    const now = await blocks(target);
    await rpc(run, {
      action: "prompt-blocks-set",
      ...where(target),
      target,
      revision: now.revision,
      blocks: now.blocks.map((b) => {
        const next = { ...b, ...patch[b.id] };
        const edited = next.text !== b.text || b.edited;
        return b.kind === "custom"
          ? { id: b.id, name: b.name, text: next.text, enabled: next.enabled }
          : { id: b.id, enabled: next.enabled, ...(edited ? { text: next.text } : {}) };
      }),
    });
  };
  const q = (selector) => JSON.stringify(selector);
  const text = (selector) => page.evaluate(`document.querySelector(${q(selector)})?.innerText ?? ''`);
  const status = () => text("#settings .settings-status");
  const row = (id) => `#settings .pb-row[data-block="${id}"]`;
  const open = async (target = "coordinator") => {
    if (!(await page.evaluate(`document.querySelector('#settings')?.open === true`)))
      await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.waitFor(`document.querySelector('#settings')?.open === true`, "settings open");
    if ((await page.evaluate(`document.querySelector('#settings').dataset.section`)) !== "prompt")
      await page.click('#settings nav [data-section="prompt"]');
    await page.click(`#settings .profiles [data-profile="${target === "taskHelper" ? "worker" : target}"]`);
    if (target === "taskHelper" || target === "worker") {
      await page.waitFor(`!!document.querySelector('#settings .pb-bar [data-kind]')`, "worker kind switch");
      await page.click(`#settings .pb-bar [data-kind="${target === "worker" ? "job" : "task"}"]`);
    }
    await page.waitFor(
      `document.querySelector('#settings .pb')?.dataset.target === ${q(target)} && document.querySelectorAll('#settings .pb-row').length > 0`,
      `prompt blocks of ${target}`,
    );
  };
  const select = async (id) => {
    await page.click(`${row(id)} .pb-name`);
    await page.waitFor(`document.querySelector('#settings .pb-editor')?.dataset.block === ${q(id)}`, `editor shows ${id}`);
  };
  /** Replaces the editor text through the browser input pipeline. */
  const type = async (value, selector = "#settings .pb-editor textarea") => {
    await page.evaluate(`(() => { const t = document.querySelector(${q(selector)}); t.focus(); t.select(); })()`);
    await page.cdp("Input.insertText", { text: value });
  };
  /** The header status says `expect` (each step's own words, so an earlier "saved" never passes for a later one). */
  const saved = async (what, expect) => {
    await page.waitFor(
      `(document.querySelector('#settings .settings-status')?.innerText ?? '').includes(${q(expect)})`,
      `${what}: "${expect}" inline`,
      15000,
    );
    record("visible", `${what}: "${await status()}"`);
  };
  const noOverflow = () =>
    page.evaluate(
      `document.documentElement.scrollWidth <= innerWidth && document.querySelector('#settings').scrollWidth <= document.querySelector('#settings').clientWidth`,
    );

  await page.navigate(`${origin}/${hash}`);
  await page.waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#tree [data-chat="main"]')`, "ui2 ready");
  record("entry", `opened ${origin}/; ⌘, → Prompt`);
  await open("coordinator");

  // E2/E3: compact rows; generated sections are read-only rows in their own folded group.
  const shape = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#settings .pb-row')];
    const own = rows.filter(r => !r.matches('[data-generated]')), gen = rows.filter(r => r.matches('[data-generated]'));
    return {
      own: own.map(r => ({ id: r.dataset.block, project: r.dataset.block === 'objective', toggle: !!r.querySelector('input.pb-toggle[type=checkbox]'), name: r.querySelector('.pb-name')?.innerText.trim(),
        src: r.querySelector('.pb-src')?.innerText.trim(), tok: r.querySelector('.pb-tok')?.innerText.trim(), h: r.getBoundingClientRect().height })),
      gen: gen.map(r => ({ id: r.dataset.block, toggle: !!r.querySelector('input'), name: r.querySelector('.pb-name')?.innerText.trim() })),
      textareas: document.querySelectorAll('#settings textarea').length,
      editor: !!document.querySelector('#settings .pb-editor'),
    };
  })()`);
  if (
    !shape.own.length ||
    shape.own.some(
      (r) => (!r.toggle && !r.project) || !r.name || !/^(Built-in|Edited|Custom|Project)$/.test(r.src) || !/\d/.test(r.tok) || r.h > 48,
    )
  )
    throw Error(`E2 block rows: ${JSON.stringify(shape.own)}`);
  if (!shape.gen.length || shape.gen.some((r) => r.toggle) || shape.textareas > 1 || !shape.editor)
    throw Error(`E3 generated rows or stacked forms: ${JSON.stringify(shape)}`);
  record(
    "visible",
    `E2/E3 ${shape.own.length} block rows (switch, name, badge, tokens); ${shape.gen.length} generated read-only rows; one editor`,
  );
  await page.shot(dir, "01-blocks");
  if (shape.own[0]?.id !== "objective" || shape.own[0].toggle || shape.own[0].src !== "Project")
    throw Error(`E19 Project instructions row: ${JSON.stringify(shape.own[0])}`);
  const first = shape.own.find((r) => r.src === "Built-in").id;

  // E5: Space on a focused row switches the block off; the host stores it and the preview leaves it out.
  await page.evaluate(`document.querySelector(${q(row(first))}).focus()`);
  await page.press(" ", { code: "Space", keyCode: 32 });
  await until(async () => (await blocks("coordinator")).blocks.find((b) => b.id === first)?.enabled === false, `E5 ${first} stored off`);
  const firstName = shape.own.find((r) => r.id === first).name;
  await saved("E5 switch", `${firstName} off · saved`);
  if (
    !(await page.evaluate(
      `document.querySelector(${q(row(first))}).matches('[data-enabled="false"]') && /off/i.test(document.querySelector(${q(row(first))}).innerText)`,
    ))
  )
    throw Error("E5/E17 an off block is not marked in text");
  record("side-effect", `E5 ${first} off by Space; host config enabled:false`);
  await page.shot(dir, "02-block-off");
  await page.evaluate(`document.querySelector(${q(row(first))}).focus()`);
  await page.press(" ", { code: "Space", keyCode: 32 });
  await until(async () => (await blocks("coordinator")).blocks.find((b) => b.id === first)?.enabled === true, `E5 ${first} stored on`);

  // E6: editing a built-in stores an override on that block (badge Edited); Restore default removes it (badge Built-in).
  await select(first);
  const original = await page.evaluate(`document.querySelector('#settings .pb-editor textarea').value`);
  await type("VERIFY edited built-in: answer in one line.");
  await page.press("Enter", { keyCode: 13, modifiers: 4 }); // ⌘↵ saves
  await saved("E6 override", `${firstName} saved`);
  const edited = (await blocks("coordinator")).blocks.find((b) => b.id === first);
  if (edited?.kind !== "builtin" || !JSON.stringify(edited).includes("VERIFY edited built-in"))
    throw Error(`E6 override: ${JSON.stringify(edited)}`);
  await page.waitFor(`document.querySelector(${q(row(first) + " .pb-src")})?.innerText.trim() === 'Edited'`, "E6 Edited badge");
  await page.shot(dir, "03-edited");
  await page.click("#settings #pb-restore");
  await saved("E6 restore default", `${firstName} restored to default`);
  const restored = (await blocks("coordinator")).blocks.find((b) => b.id === first);
  if (JSON.stringify(restored).includes("VERIFY edited built-in")) throw Error(`E6 override survived restore: ${JSON.stringify(restored)}`);
  await page.waitFor(
    `document.querySelector(${q(row(first) + " .pb-src")})?.innerText.trim() === 'Built-in' && document.querySelector('#settings .pb-editor textarea').value === ${q(original)}`,
    "E6 Built-in badge and default text back",
  );
  record("side-effect", `E6 ${first} edited (override stored, badge Edited), then restored (override removed, default text back)`);

  // E7/E16: a new custom block for the coordinator; text with markup stays text.
  const marked = 'VERIFY custom: <b>bold?</b><img src=x onerror="window.__pwned=1">';
  await page.click("#settings #pb-new");
  await page.waitFor(`!!document.querySelector('#settings .pb-editor input.pb-title')`, "E7 new block editor");
  await type("Verify aliases", "#settings .pb-editor input.pb-title");
  await type(marked);
  await page.click("#settings #pb-save");
  await saved("E7 custom block", "Verify aliases added · saved");
  const custom = (await blocks("coordinator")).blocks.find((b) => b.kind === "custom" && b.name === "Verify aliases");
  if (!custom || custom.id !== "custom:verify-aliases" || custom.text !== marked || !custom.enabled)
    throw Error(`E7 custom block: ${JSON.stringify(custom)}`);
  const customRow = row(custom.id);
  await page.waitFor(`document.querySelector(${q(customRow + " .pb-src")})?.innerText.trim() === 'Custom'`, "E7 Custom badge");
  if (await page.evaluate(`!!window.__pwned || !!document.querySelector('#settings .pb b, #settings .pb img')`))
    throw Error("E16 block text rendered as HTML");
  await page.shot(dir, "04-custom");
  await open("worker");
  if (await page.evaluate(`!!document.querySelector(${q(customRow)})`)) throw Error("E7 a coordinator block shows for the worker");
  if ((await blocks("worker")).blocks.some((b) => b.id === custom.id)) throw Error("E7 a coordinator block was stored for the worker");
  record("side-effect", `E7 custom block ${custom.id} stored for the coordinator only, with its name and text; markup inert`);

  // E8: Alt+↑ moves the focused row up; the saved order follows and focus stays on the moved row.
  await open("coordinator");
  const before = (await blocks("coordinator")).blocks.map((b) => b.id);
  await page.evaluate(`document.querySelector(${q(customRow)}).focus()`);
  await page.press("ArrowUp", { keyCode: 38, modifiers: 1 });
  await until(async () => {
    const after = (await blocks("coordinator")).blocks.map((b) => b.id);
    return after.indexOf(custom.id) === before.indexOf(custom.id) - 1;
  }, "E8 stored order moved up");
  await page.waitFor(`document.activeElement?.closest('.pb-row')?.dataset.block === ${q(custom.id)}`, "E8 focus stays on the moved row");
  record("side-effect", `E8 Alt+↑ moved ${custom.id} up one place in the stored order; focus kept`);
  await page.shot(dir, "05-reordered");

  // E10: an unsaved draft survives a reload; saving clears it.
  await select(first);
  await type("VERIFY draft kept across reload");
  await page.waitFor(`/draft/i.test(document.querySelector(${q(row(first))})?.innerText ?? '')`, "E10 row marked draft");
  await page.reload();
  await page.waitFor(`document.body.dataset.ready === "1"`, "ui2 ready after reload");
  await open("coordinator");
  await select(first);
  if ((await page.evaluate(`document.querySelector('#settings .pb-editor textarea').value`)) !== "VERIFY draft kept across reload")
    throw Error("E10 draft lost on reload");
  record("visible", "E10 unsaved draft restored after a reload, row marked draft");
  await page.shot(dir, "06-draft-restored");

  // E11: another writer edits the same block and switches the custom block off. Whether the change feed or the refused stale
  // write notices it first, the draft is kept and Load latest offers to save it over the newer text; the other change survives.
  await otherWriter("coordinator", { [first]: { text: "VERIFY other tab text" }, [custom.id]: { enabled: false } });
  await page.click("#settings #pb-save");
  await page.waitFor(`!!document.querySelector('#settings .pb-conflict')`, "E11 conflict banner");
  if ((await page.evaluate(`document.querySelector('#settings .pb-editor textarea').value`)) !== "VERIFY draft kept across reload")
    throw Error("E11 draft discarded on conflict");
  if (!JSON.stringify((await blocks("coordinator")).blocks.find((b) => b.id === first)).includes("VERIFY other tab text"))
    throw Error("E11 the draft overwrote the other write without asking");
  await page.shot(dir, "07-conflict");
  await page.click("#settings .pb-conflict [data-conflict='reload']");
  await page.waitFor(`!document.querySelector('#settings .pb-conflict')`, "E11 conflict resolved");
  await page.click("#settings #pb-save");
  await saved("E11 save after Load latest", `${firstName} saved`);
  const merged = await blocks("coordinator");
  if (
    merged.blocks.find((b) => b.id === first)?.text !== "VERIFY draft kept across reload" ||
    merged.blocks.find((b) => b.id === custom.id)?.enabled !== false
  )
    throw Error(`E11 draft stored and other change kept: ${JSON.stringify(merged.blocks)}`);
  record(
    "side-effect",
    "E11 conflicting edit: draft kept, banner shown; after Load latest the draft is stored and the other tab's switch kept",
  );
  await page.reload();
  await page.waitFor(`document.body.dataset.ready === "1"`, "ui2 ready after reload");
  await open("coordinator");
  if (/draft/i.test(await text(row(first)))) throw Error("E10 a saved draft came back after reload");

  // E12: a change from elsewhere shows up without a reload, and a closed Settings stays closed.
  await otherWriter("coordinator", { [custom.id]: { enabled: true } });
  await page.waitFor(`document.querySelector(${q(customRow)})?.dataset.enabled === 'true'`, "E12 open editor follows a host write");
  await page.press("Escape", { keyCode: 27 });
  await page.press("Escape", { keyCode: 27 });
  await page.waitFor(`document.querySelector('#settings')?.open === false`, "settings closed");
  await otherWriter("coordinator", { [custom.id]: { enabled: false } });
  await delay(800);
  if (await page.evaluate(`[...document.querySelectorAll('dialog')].some(d => d.open)`)) throw Error("E12 a host write opened a dialog");
  record("verified", "E12 host writes update the open editor and never open Settings or a dialog");

  // E13/E14/E15: preview in order, generated sections folded, Job worker vs task helper, configured-for-next-use label.
  await open("worker");
  await page.click('#settings [data-pane="preview"]');
  await page.waitFor(`document.querySelectorAll('#settings .pv-sec').length > 0`, "E13 preview sections");
  const pv = await page.evaluate(`(() => ({
    secs: [...document.querySelectorAll('#settings .pv-sec')].map(s => ({ gen: s.matches('[data-generated]'), open: s.matches('details') ? s.open : true,
      src: s.querySelector('.pv-src')?.innerText.trim(), tok: s.querySelector('.pv-tok')?.innerText.trim(), name: s.querySelector('.pv-name')?.innerText.trim() })),
    state: document.querySelector('#settings .pv-state')?.innerText ?? '',
    text: document.querySelector('#settings .pv-body')?.innerText ?? '',
  }))()`);
  if (
    pv.secs.some((s) => !s.name || !/\d/.test(s.tok ?? "")) ||
    pv.secs.filter((s) => s.gen).some((s) => s.open) ||
    !pv.secs.some((s) => !s.gen && s.open)
  )
    throw Error(`E13 preview sections: ${JSON.stringify(pv.secs)}`);
  if (!/next use/i.test(pv.state)) throw Error(`E15 preview state label: ${pv.state}`);
  await page.shot(dir, "08-preview-job");
  await page.click('#settings .pb-bar [data-kind="task"]');
  await page.waitFor(
    `/next use/i.test(document.querySelector('#settings .pv-state')?.innerText ?? '') && (document.querySelector('#settings .pv-body')?.innerText ?? '') !== ${q(pv.text)}`,
    "E14 task helper preview differs",
  );
  await page.shot(dir, "09-preview-helper");
  record(
    "visible",
    `E13-E15 preview: ${pv.secs.length} sections, generated folded, "${pv.state.trim()}"; task helper preview differs from the Job worker`,
  );

  // E1: the Host agent is a target with its own blocks.
  await page.click('#settings [data-pane="blocks"]');
  await open("host");
  const hostRows = await page.evaluate(
    `[...document.querySelectorAll('#settings .pb-row:not([data-generated])')].map(r => r.dataset.block)`,
  );
  if (!hostRows.length || hostRows.includes(custom.id) || hostRows.includes("objective"))
    throw Error(`E1 Host agent blocks: ${JSON.stringify(hostRows)}`);
  const hostFirst = hostRows[0];
  await page.evaluate(`document.querySelector(${q(row(hostFirst))}).focus()`);
  await page.press(" ", { code: "Space", keyCode: 32 });
  await until(async () => (await blocks("host")).blocks.find((b) => b.id === hostFirst)?.enabled === false, "E1 host block stored off");
  await page.evaluate(`document.querySelector(${q(row(hostFirst))}).focus()`);
  await page.press(" ", { code: "Space", keyCode: 32 });
  await until(async () => (await blocks("host")).blocks.find((b) => b.id === hostFirst)?.enabled === true, "E1 host block stored on");
  record("side-effect", `E1 Host agent target lists its own blocks; ${hostFirst} switched off and on through the host config`);
  await page.shot(dir, "10-host-agent");
  for (const theme of ["light", "midnight"]) {
    await page.evaluate(`document.documentElement.dataset.theme = ${q(theme)}`);
    await delay(150);
    await page.shot(dir, `11-${theme}`);
  }
  await page.evaluate(`document.documentElement.dataset.theme = 'claude'`);

  // E4: at 390 px the list and the editor are separate views with a way back.
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await open("coordinator");
  const narrowList = await page.evaluate(
    `({ list: !!document.querySelector('#settings .pb-list')?.offsetParent, editor: !!document.querySelector('#settings .pb-editor')?.offsetParent })`,
  );
  if (!narrowList.list || narrowList.editor || !(await noOverflow())) throw Error(`E4 narrow list view: ${JSON.stringify(narrowList)}`);
  await page.shot(dir, "12-narrow-list");
  await page.click(`${row(first)} .pb-name`);
  await page.waitFor(
    `!!document.querySelector('#settings .pb-editor')?.offsetParent && !document.querySelector('#settings .pb-list')?.offsetParent`,
    "E4 narrow editor view",
  );
  if (!(await noOverflow())) throw Error("E4 narrow editor overflows");
  await page.shot(dir, "13-narrow-editor");
  await page.click("#settings .pb-back");
  await page.waitFor(`!!document.querySelector('#settings .pb-list')?.offsetParent`, "E4 back to the list");
  record("visible", "E4 at 390 px: list, then the editor alone with Back, no sideways overflow");
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // E11: which side noticed the conflict first is a race by nature. A refused stale write is the one HTTP 400 this journey expects
  // (its console line too); any other error still fails the drive.
  const refused = sinks.httpErrors.findIndex((item) => item.status === 400);
  if (refused >= 0) {
    sinks.httpErrors.splice(refused, 1);
    const line = sinks.errors.findIndex((item) => /status of 400/.test(item));
    if (line >= 0) sinks.errors.splice(line, 1);
  }
  record("verified", `E11 the conflict was noticed by ${refused >= 0 ? "the refused stale write" : "the change feed"}`);

  // E23: in a chat other than Main, every tab renders its blocks and preview; only the coordinator preview is chat-specific.
  const side = await rpc(run, { action: "chat-create", id: projectId, title: "Verify side chat" });
  await page.navigate(`${origin}/?project=${projectId}&chat=${side.id}${hash}`);
  await page.waitFor(
    `document.body.dataset.ready === "1" && new URL(location.href).searchParams.get("chat") === ${q(side.id)}`,
    "side chat open",
  );
  for (const target of ["coordinator", "worker", "taskHelper", "scout", "reviewer", "host"]) {
    await open(target);
    await page.click('#settings .pb-bar [data-pane="preview"]');
    await page.waitFor(`document.querySelectorAll('#settings .pv-sec').length > 0`, `preview of ${target} in a side chat`);
    const said = await status();
    if (/applies to the coordinator|error|✕|⚠/i.test(said)) throw Error(`E23 ${target} in a side chat: ${said}`);
    await page.click('#settings .pb-bar [data-pane="blocks"]');
  }
  record(
    "visible",
    "E23 in a side chat, all six Prompt tabs (coordinator, Job worker, task helper, scout, reviewer, Host agent) show blocks and a preview, no error",
  );
}

const journeys = {
  // Feature: features/ui2-prompts.md; failure list: scripts/ui2-prompt-editor-failures.md (E1-E23).
  async "ui2-prompts"(run, page, record, dir, sinks) {
    await ui2Prompts(run, page, record, dir, sinks);
  },
  // Feature: features/jobs.md
  async jobs(run, page, record, dir, sinks) {
    const prompt = "VERIFY-JOB please greet the world",
      composer = "#composer textarea",
      origin = new URL(run.webUrl).origin;
    const worker = (status) => `#workers .worker[data-status="${status}"]`;
    await page.navigate(run.webUrl);
    await page.waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#tree [data-chat="main"]')`, "UI ready on Main");
    await page.waitFor(`/No workers in this chat/.test(document.querySelector('#workers').innerText)`, "empty Workers panel");
    record("entry", `opened ${origin}/; Main is selected and the context panel lists no workers`);
    await page.shot(dir, "00-before-send");
    await page.click(composer);
    await page.cdp("Input.insertText", { text: prompt });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    record("action", `typed ${JSON.stringify(prompt)} and pressed Enter`);
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ''`, "composer cleared");
    await page.waitFor(`document.querySelector('#workers .worker')?.innerText.includes('VERIFY-JOB')`, "Job in the Workers panel", 60000);
    await page.shot(dir, "01-job-in-panel");
    await page.waitFor(`!!document.querySelector('${worker("ready")}')`, "Ready worker", 90000);
    if (await page.evaluate(`[...document.querySelectorAll('#feed .msg.owner')].some(n => n.innerText.includes('[worker '))`))
      throw Error("Internal report leaked into coordinator chat");
    const card = await page.evaluate(`document.querySelector('${worker("ready")}').innerText`);
    if (!/2\/2/.test(card) || !/Approve/.test(card) || !/PR #12/.test(card)) throw Error(`Ready card wrong: ${JSON.stringify(card)}`);
    await page.shot(dir, "02-ready-with-approve");
    record("visible", "coordinator chat has no internal report; the Ready card shows 2/2, PR #12 and Approve");
    const jobs = await rpc(run, { action: "jobs-snapshot", id: run.projectId });
    writeFileSync(join(dir, "host-jobs-snapshot.json"), JSON.stringify(jobs, null, 2));
    if (jobs.jobs.length !== 1 || jobs.jobs[0].status !== "ready" || jobs.jobs[0].pr !== "12")
      throw Error(`host Job wrong: ${JSON.stringify(jobs.jobs.map((j) => [j.status, j.pr]))}`);
    record("side-effect", `jobs-snapshot lists one ${jobs.jobs[0].status} Job with PR ${jobs.jobs[0].pr}`);
    // Approve takes two presses; it is a real host call, and the private host has no GitHub, so the toast says why it did not merge.
    const seen = { errors: sinks.errors.length, http: sinks.httpErrors.length };
    const toasts = await page.evaluate(`document.querySelector('#toasts').innerText`);
    await page.click(`${worker("ready")} [data-approve]`);
    await page.waitFor(
      `/Confirm approve #12/.test(document.querySelector('${worker("ready")} [data-approve]')?.innerText ?? '')`,
      "armed Approve",
    );
    await page.shot(dir, "02a-confirm-approve");
    await page.click(`${worker("ready")} [data-approve]`);
    await page.waitFor(`document.querySelector('#toasts').innerText !== ${JSON.stringify(toasts)}`, "Approve outcome", 60000);
    const outcome = await page.evaluate(`document.querySelector('#toasts').innerText`);
    await page.shot(dir, "02b-approve-outcome");
    // The host answers the failed gh call with an error; that is the expected result here, not a browser problem.
    sinks.errors.length = seen.errors;
    sinks.httpErrors.length = seen.http;
    writeFileSync(join(dir, "approve-outcome.txt"), outcome);
    record("visible", `after confirming Approve: ${JSON.stringify(outcome.slice(0, 160))}`);
    // The worker opens in the center with its transcript; Esc returns to the chat.
    await page.click(`#workers .worker .w-title`);
    await page.waitFor(
      `document.querySelector('#center').dataset.focus === 'worker' && !!document.querySelector('#worker-feed')`,
      "worker transcript",
    );
    await page.shot(dir, "04-worker-transcript");
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`document.querySelector('#center').dataset.focus === 'chat'`, "Esc returns to chat");
    record("visible", "the worker title opens its transcript in the center; Esc returns to the chat");
    // An independent checkpoint: a concise reply, evidence held on the host, Open instead of Approve.
    await page.click(composer);
    await page.cdp("Input.insertText", { text: "VERIFY-CHECKPOINT stop at the decision boundary" });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(`!!document.querySelector('${worker("checkpoint")}')`, "independent checkpoint", 60000);
    await page.waitFor(
      `document.querySelector('#feed').innerText.includes('The intermediate result needs your decision.')`,
      "concise checkpoint reply",
      60000,
    );
    if (await page.evaluate(`document.querySelector('#feed').innerText.includes('VERIFY-FAKE-REPLY: [worker')`))
      throw Error("Checkpoint internals leaked into owner conversation");
    if (await page.evaluate(`!!document.querySelector('${worker("checkpoint")} [data-approve]')`))
      throw Error("Checkpoint offers approval");
    await page.shot(dir, "04e-clean-checkpoint-conversation");
    const held = await rpc(run, { action: "jobs-snapshot", id: run.projectId });
    writeFileSync(join(dir, "host-checkpoint-snapshot.json"), JSON.stringify(held, null, 2));
    const checkpoint = held.jobs.find((job) => job.status === "checkpoint");
    if (checkpoint?.ready || !checkpoint?.checkpoint?.proof.includes("checkpoint-evidence"))
      throw Error("Host checkpoint state differs from UI");
    await page.click(`${worker("checkpoint")} [data-open-worker]`);
    await page.waitFor(`document.querySelector('#center').dataset.focus === 'worker'`, "checkpoint worker opened");
    await page.shot(dir, "04f-checkpoint-no-approve");
    await page.press("Escape", { keyCode: 27 });
    record(
      "verified",
      "a real independent checkpoint keeps its evidence on the host, offers Open but no Approve, and gets a concise coordinator reply",
    );
    // A new chat has its own, empty Workers panel; Main keeps the Jobs.
    await page.click(`#tree [data-new-chat]`);
    await page.waitFor(
      `document.querySelectorAll('#tree [data-chat]').length >= 2 && /No workers in this chat/.test(document.querySelector('#workers').innerText)`,
      "empty panel in the new chat",
    );
    await page.shot(dir, "04b-new-chat");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.shot(dir, "04c-new-chat-390");
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.click(`#tree [data-chat="main"]`);
    await page.waitFor(`document.querySelector('#workers').innerText.includes('VERIFY-JOB')`, "Jobs back on Main");
    await page.shot(dir, "04d-back-on-main");
    record("visible", "a new chat shows an empty Workers panel; Main shows its Jobs again");
    // Host settings: the Deploy section reports the default window (read only in this client; the CLI deploys).
    await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
    await page.waitFor(`!!document.querySelector('dialog[open] [data-section="deploy"]')`, "settings open");
    await page.click(`dialog[open] [data-section="deploy"]`);
    await page.waitFor(`/2:00–7:00/.test(document.querySelector('dialog[open]').innerText)`, "Deploy window", 30000);
    await page.shot(dir, "05-deploy-settings");
    writeFileSync(join(dir, "deploy-section.txt"), await page.evaluate(`document.querySelector('dialog[open]').innerText`));
    record("visible", "Settings → Deploy shows the 2:00–7:00 window and the idle state");
  },
  // Feature: features/ui2.md
  async ui2(run, page, record, dir, sinks) {
    const origin = new URL(run.webUrl).origin,
      hash = new URL(run.webUrl).hash;
    // Serving (scripts/ui2-web-failures.md S1-S6): / is this client with the CSP, the classic files are gone, old /ui2 links redirect.
    const served = await fetch(`${origin}/`);
    if (!served.ok || !/script-src 'self'/.test(served.headers.get("content-security-policy") ?? ""))
      throw Error(`/ not served: ${served.status}`);
    if ((await served.text()) !== readFileSync(join(run.repo, "web/index.html"), "utf8")) throw Error("/ is not web/index.html");
    for (const probe of ["/app/chat.js", "/vendor/mermaid.min.js", "/%2e%2e/package.json", "/..%2fpackage.json", "/.env", "/sub/app.js"]) {
      const status = (await fetch(origin + probe)).status;
      if (status !== 404 && status !== 401) throw Error(`${probe} answered ${status}`);
    }
    const bare = await fetch(`${origin}/ui2`, { redirect: "manual" });
    if (bare.status !== 308 || bare.headers.get("location") !== "/") throw Error(`/ui2 does not redirect to /: ${bare.status}`);
    record("verified", "/ serves web/index.html with the CSP; classic files, traversal and unknown paths refused; /ui2 redirects to /");
    // An old launch link (`/ui2/#token=…`) still signs in: the 308 keeps the fragment, the page stores the token and drops it from the URL.
    await page.navigate(`${origin}/ui2/${hash}`);
    const name = JSON.stringify(PROJECT_NAME);
    await page.waitFor(
      `document.body.dataset.ready === "1" && [...document.querySelectorAll('#tree [data-project]')].some(n => n.innerText.includes(${name}))`,
      "tree lists the seeded project",
    );
    if (await page.evaluate(`location.hash.includes("token")`)) throw Error("token left in the URL");
    await page.waitFor(`!!document.querySelector('#tree [data-chat="main"]')`, "Main chat nested under the project");
    if ((await page.evaluate(`location.pathname`)) !== "/") throw Error("the old /ui2/ link did not land on /");
    record("entry", `opened the old ${origin}/ui2/ launch link; landed on / signed in; tree shows ${PROJECT_NAME} with Main nested`);
    // The default face is a real locally served font, not merely a family name that can silently fall back.
    const defaultFont = await page.evaluate(`(async () => {
      await document.fonts.ready;
      return { pref: document.documentElement.dataset.font, body: getComputedStyle(document.body).fontFamily,
        faces: [...document.fonts].filter(f => f.family.replace(/["']/g, '') === 'JetBrains Mono').map(f => f.status) };
    })()`);
    const fontAsset = await fetch(`${origin}/jetbrains-mono-latin-wght-normal.woff2`);
    if (
      defaultFont.pref !== "jetbrains-mono" ||
      !/JetBrains Mono/.test(defaultFont.body) ||
      !defaultFont.faces.includes("loaded") ||
      !fontAsset.ok ||
      fontAsset.headers.get("content-type") !== "font/woff2"
    )
      throw Error(
        `default local JetBrains Mono: ${JSON.stringify({ defaultFont, status: fontAsset.status, mime: fontAsset.headers.get("content-type") })}`,
      );
    record("verified", "JetBrains Mono is the default app font; the bundled woff2 loads locally with font/woff2");
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
    await ui2Images(run, page, record, dir, sinks);
    await ui2SlashMenu(run, page, record, dir);
    // Markdown: a table reply renders as a table with alignment, lists nest, and hostile HTML or links stay inert.
    await page.click("#composer textarea");
    await page.cdp("Input.insertText", { text: "VERIFY-TABLE show the roles" });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(`!!document.querySelector('#feed .msg.agent .prose table')`, "table in the coordinator reply", 60000);
    const feedMd = await page.evaluate(proseCheck("#feed .msg.agent .prose"));
    if (feedMd.problems.length) throw Error(`coordinator Markdown: ${feedMd.problems.join("; ")}`);
    record("visible", `coordinator reply Markdown: ${feedMd.summary}`);
    await delay(300);
    await page.shot(dir, "01c-markdown-table");
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
    // The model chip names the model the worker runs on, as the host's Jobs snapshot reports it.
    const chipModel = await page.evaluate(`document.querySelector('#workers .worker[data-status="ready"] .chip')?.dataset.model ?? null`);
    const readyJob = (await rpc(run, { action: "jobs-snapshot", id: run.projectId })).jobs.find((job) => job.status === "ready");
    if (!readyJob?.model || chipModel !== readyJob.model)
      throw Error(`worker chip model ${chipModel} is not the snapshot model ${readyJob?.model}`);
    record("side-effect", `worker chip shows ${chipModel}, the model jobs-snapshot reports for the Ready Job`);
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
    await ui2WorkerImages(run, page, record, dir);
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
    const recent = (await rpc(run, { action: "memory-recent", projectId })).writes.find(
      (write) => write.path === indexed.path && write.revision === indexed.revision,
    );
    if (!recent?.undone) throw Error(`memory-recent does not report the undone write: ${JSON.stringify(recent)}`);
    await page.reload();
    await page.waitFor(
      `document.body.dataset.ready === '1' && /Undone/.test(document.querySelector('#feed .memory-row[data-tool="projects_knowledge_write"]')?.innerText ?? '') && !document.querySelector('#feed [data-memory-undo]')`,
      "Remembered row stays Undone after reload",
    );
    record(
      "side-effect",
      `memory-index and memory-recent record Undo; the reloaded Remembered row stays Undone without another Undo action`,
    );
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
    // Appearance also selects the app font through the same host document.
    await page.click('#settings [data-font-option="system-sans"]');
    await page.waitFor(`document.documentElement.dataset.font === 'system-sans'`, "system sans applied");
    const sans = await page.evaluate(`getComputedStyle(document.body).fontFamily`);
    const uiSans = await rpc(run, { action: "ui-get" });
    if (/JetBrains Mono/.test(sans) || uiSans.ui?.font !== "system-sans")
      throw Error(`font selection: ${JSON.stringify({ sans, ui: uiSans.ui })}`);
    record("side-effect", "Theme → Font selects System sans and ui-set stores font system-sans");
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`!document.querySelector('#settings').open`, "settings closed");
    // Poison the browser's pre-paint cache: after reload the theme must come from the host's ui document, not localStorage.
    await page.evaluate(
      `localStorage.setItem('pi-ui2-ui', JSON.stringify({ ...JSON.parse(localStorage.getItem('pi-ui2-ui') || '{}'), theme: 'light', font: 'system-mono' }))`,
    );
    await page.reload();
    await page.waitFor(
      `document.body.dataset.ready === "1" && document.documentElement.dataset.theme === 'midnight' && document.documentElement.dataset.font === 'system-sans'`,
      "midnight and system sans from the host survive reload over a stale local cache",
    );
    record("verified", "after reload with a stale local cache (light/system mono), ui-get restores midnight and system sans");
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
      // A pin can be cleared, and choosing a tier clears the pin so the tier's effective model actually applies.
      await page.select("#ha-model-select", "fake/fake-model");
      await page.waitFor(`document.querySelector('#ha-model-select').value === 'fake/fake-model'`, "host model pinned");
      await until(async () => (await rpc(run, { action: "host-agent-settings" })).model === "fake/fake-model", "host model pin saved");
      const hostTiers = (await rpc(run, { action: "tiers-get" })).tiers;
      await page.select("#ha-tier-select", hostTiers[0].id);
      await until(async () => {
        const current = await rpc(run, { action: "host-agent-settings" });
        return current.tier === hostTiers[0].id && current.model === null;
      }, "tier selection clears the model pin");
      await page.select("#ha-model-select", "fake/fallback-model");
      await until(
        async () => (await rpc(run, { action: "host-agent-settings" })).model === "fake/fallback-model",
        "second model pin saved",
      );
      await page.select("#ha-model-select", "");
      await until(async () => (await rpc(run, { action: "host-agent-settings" })).model === null, "model pin cleared by the owner");
      await page.waitFor(`document.querySelector('#ha-model-select').value === ''`, "From tier selected after clearing the pin");
      record("side-effect", "host-agent-settings: pin a model, select a tier (pin cleared), pin again, then From tier sends model null");
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
      // Status line from the Host agent: ui_set reorders and hides items without a reload; its ui_focus at Settings only offers them.
      await page.click("#ha-composer textarea");
      await page.cdp("Input.insertText", { text: "VERIFY-HOST-STATUS" });
      await page.press("Enter", { code: "Enter", keyCode: 13 });
      await page.waitFor(
        `/Status line updated/.test(document.querySelector('#host-agent .ha-body').innerText)`,
        "status line reply",
        60000,
      );
      await page.waitFor(
        `document.querySelector('#statusline [data-item]')?.dataset.item === 'connection' && !document.querySelector('#statusline [data-item="cost"]')`,
        "the Host agent's status line order shows without a reload",
      );
      await page.waitFor(
        `[...document.querySelectorAll('#toasts .toast')].some(n => /changed your settings/.test(n.innerText) && /Open settings/.test(n.innerText))`,
        "a toast offers Open settings",
      );
      if (await page.evaluate(`document.querySelector('#settings').open`))
        throw Error("the Host agent's ui_focus opened Settings by itself");
      const barOrder = await page.evaluate(`[...document.querySelectorAll('#statusline [data-item]')].map(n => n.dataset.item).join(' ')`);
      record(
        "visible",
        `Host agent ui_set: status line now "${barOrder}", no chat cost; Settings stayed closed and a toast offers Open settings`,
      );
      await page.shot(dir, "08f-host-agent-status-line");
      await page.evaluate(
        `[...document.querySelectorAll('#toasts .toast')].find(n => /Open settings/.test(n.innerText)).querySelector('button').dataset.verify = 'open-settings'`,
      );
      await page.click('[data-verify="open-settings"]');
      await page.waitFor(
        `document.querySelector('#settings')?.open === true && document.querySelector('#settings').dataset.section === 'statusline' && !!document.querySelector('#settings .sl-order')`,
        "the owner's click opens Settings at Status line",
      );
      record("visible", "the toast's Open settings opened Settings → Status line");
      // Keyboard: move Connection down with Enter on its ↓ button; focus stays on that button.
      await page.evaluate(`document.querySelector('#settings [data-sl-item="connection"] [data-sl-move="down"]').focus()`);
      await page.press("Enter", { code: "Enter", keyCode: 13, text: "\r" });
      await until(
        async () => (await rpc(run, { action: "ui-get" })).ui.statusItems[1]?.id === "connection",
        "Connection moved to 2 in ui-get",
      );
      await page.waitFor(
        `document.activeElement?.matches('[data-sl-item="connection"] [data-sl-move="down"]') && document.querySelector('#statusline [data-item]').dataset.item === 'activity'`,
        "focus stays on the moved item and the bar follows",
      );
      // Space on Chat cost's checkbox shows it again.
      await page.evaluate(`document.querySelector('#settings [data-sl-toggle="cost"]').focus()`);
      await page.press(" ", { code: "Space", keyCode: 32 });
      await page.waitFor(`!!document.querySelector('#statusline [data-item="cost"]')`, "chat cost shown again in the bar");
      await until(
        async () => (await rpc(run, { action: "ui-get" })).ui.statusItems.find((item) => item.id === "cost")?.enabled === true,
        "cost enabled in ui-get",
      );
      const hiddenLabel = await page.evaluate(
        `(() => { const box = document.querySelector('#settings [data-sl-toggle="model"]'); box.click(); return document.querySelector('#settings [data-sl-item="model"] .sl-state').textContent; })()`,
      );
      if (hiddenLabel !== "hidden") throw Error(`a hidden item is not labelled hidden: ${JSON.stringify(hiddenLabel)}`);
      await page.waitFor(`!document.querySelector('#statusline [data-item="model"]')`, "model hidden in the bar");
      await page.shot(dir, "08g-settings-status-line");
      // The whole bar off and on again.
      await page.click("#statusline-toggle");
      await page.waitFor(`document.querySelector('#app').dataset.statusline === '0'`, "status line hidden");
      await until(async () => (await rpc(run, { action: "ui-get" })).ui.statusLine === false, "statusLine false in ui-get");
      await page.click("#statusline-toggle");
      await page.waitFor(`document.querySelector('#app').dataset.statusline === '1'`, "status line shown again");
      await page.click('#settings [data-sl-toggle="model"]');
      await page.click("#settings [data-sl-reset]");
      const restored = await until(async () => {
        const { ui } = await rpc(run, { action: "ui-get" });
        return ui.statusLine && ui.statusItems.every((item, index) => item.enabled && item.id === ITEM_ORDER[index]) ? ui : null;
      }, "default order with every item shown");
      record(
        "side-effect",
        `ui-get after keyboard move, show, hide, bar off/on and Restore: ${restored.statusItems.map((item) => item.id).join(" ")}`,
      );
      // Two quick changes: the host's answer to the first must not undo the second while it is still being written.
      const race = await page.evaluate(`(async () => {
        const { setUi } = await import('/ui.js'), { state } = await import('/state.js');
        const first = setUi({ statusLine: true });
        const second = setUi({ statusItems: state.ui.statusItems.map(item => item.id === 'model' ? { ...item, enabled: false } : item) });
        await first;
        const between = state.ui.statusItems.find(item => item.id === 'model').enabled;
        await second;
        const after = state.ui.statusItems.find(item => item.id === 'model').enabled;
        await setUi({ statusItems: state.ui.statusItems.map(item => ({ ...item, enabled: true })) });
        return { between, after };
      })()`);
      if (race.between !== false || race.after !== false)
        throw Error(`an earlier ui-set answer undid a queued change: ${JSON.stringify(race)}`);
      record("verified", "a ui-set answer keeps a later queued change (Model stayed hidden between the two writes)");
      await page.press("Escape", { keyCode: 27 });
      await page.waitFor(`document.querySelector('#settings')?.open === false`, "settings closed after status line");
      // The drawer renders replies through the same Markdown as the chat.
      await page.click("#ha-composer textarea");
      await page.cdp("Input.insertText", { text: "VERIFY-TABLE show the roles" });
      await page.press("Enter", { code: "Enter", keyCode: 13 });
      await page.waitFor(`!!document.querySelector('#host-agent .ha-body .prose table')`, "table in the Host agent reply", 60000);
      const drawerMd = await page.evaluate(proseCheck("#host-agent .ha-body .msg.agent .prose"));
      if (drawerMd.problems.length) throw Error(`Host agent Markdown: ${drawerMd.problems.join("; ")}`);
      const hostImage = await page.evaluate(
        `[...document.querySelectorAll('#host-agent .ha-body .prose [data-media]')].map(n => n.dataset.state + ':' + n.innerText).at(-1) ?? ''`,
      );
      if (!/^failed:[\s\S]*chart[\s\S]*not viewable here/.test(hostImage))
        throw Error(`Host agent artifact image: ${JSON.stringify(hostImage)}`);
      record(
        "visible",
        `Host agent reply Markdown: ${drawerMd.summary}; its artifact image says "${hostImage.replace(/^\w+:/, "").replace(/\s+/g, " ")}"`,
      );
      await delay(300);
      await page.shot(dir, "08h-host-agent-table");
      await page.evaluate(`document.activeElement.blur()`); // the drawer's own keys below run outside the text field
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
    // Prompt editor: the Project instructions row saves the objective (prompt-render's project section follows); then the first
    // coordinator block saves with ⌘↵ (role section follows) and Restore default undoes it.
    await page.click('#settings nav [data-section="prompt"]');
    await page.waitFor(`!!document.querySelector('#settings .pb-row[data-block="objective"]')`, "prompt blocks");
    await page.click('#settings .pb-row[data-block="objective"] .pb-name');
    await page.waitFor(`document.querySelector('#settings .pb-editor')?.dataset.block === 'objective'`, "project instructions editor");
    await page.evaluate(`(() => { const t = document.querySelector('#settings .pb-text'); t.focus(); t.select(); })()`);
    await page.cdp("Input.insertText", { text: "VERIFY project instructions: greet briefly." });
    await page.click("#settings #pb-save");
    // Each wait names its own status words, so an earlier "saved" never passes for a later step.
    const status = (words, what) =>
      page.waitFor(
        `(document.querySelector('#settings .settings-status')?.innerText ?? '').includes(${JSON.stringify(words)})`,
        what,
        15000,
      );
    await status("Project instructions saved", "project instructions saved inline");
    const objective = (await rpc(run, { action: "prompt-render", projectId, profile: "coordinator" })).sections.find(
      (item) => item.id === "project",
    );
    if (objective?.text !== "Project instructions: VERIFY project instructions: greet briefly.")
      throw Error(`prompt-render project section: ${JSON.stringify(objective?.text)}`);
    record("side-effect", "prompt editor saved the project instructions; prompt-render shows them once, without a doubled prefix");
    const [blockId, blockName] = await page.evaluate(
      `(() => { const r = document.querySelector('#settings .pb-row:not([data-generated]):not([data-block="objective"])'); return [r.dataset.block, r.querySelector('.pb-name').innerText.trim()]; })()`,
    );
    await page.click(`#settings .pb-row[data-block="${blockId}"] .pb-name`);
    await page.waitFor(`document.querySelector('#settings .pb-editor')?.dataset.block === ${JSON.stringify(blockId)}`, "prompt editor");
    await page.evaluate(`(() => { const t = document.querySelector('#settings .pb-text'); t.focus(); t.select(); })()`);
    await page.cdp("Input.insertText", { text: "VERIFY coordinator block: greet briefly." });
    await page.press("Enter", { keyCode: 13, modifiers: 4 });
    await status(`${blockName} saved`, "prompt saved inline");
    const rendered = await rpc(run, { action: "prompt-render", projectId, profile: "coordinator" });
    if (!rendered.sections.find((item) => item.id === "role")?.text.includes("VERIFY coordinator block"))
      throw Error("prompt-render role section does not hold the saved block text");
    await page.click("#settings #pb-restore");
    await until(
      async () =>
        !(await rpc(run, { action: "prompt-blocks-get", projectId, target: "coordinator" })).blocks.find((b) => b.id === blockId)?.edited,
      "block restored to default",
    );
    record("side-effect", `prompt editor saved coordinator block ${blockId}; prompt-render shows it; Restore default removed the override`);
    // Tools: switch one unlocked coordinator tool off; profile-tools reports it disabled; switch it back on.
    await page.click('#settings nav [data-section="tools"]');
    await page.waitFor(`!!document.querySelector('#settings [data-tool-name]:not([disabled])')`, "tools grid");
    const toolName = await page.evaluate(
      `[...document.querySelectorAll('#settings [data-tool-name]:not([disabled])')].at(-1).dataset.toolName`,
    );
    const toolBox = `#settings [data-tool-name="${toolName}"]`;
    await page.evaluate(`(() => { const b = document.querySelector('#settings .settings-body'); b.scrollTop = b.scrollHeight; })()`);
    const toolScroll = await page.evaluate(`document.querySelector('#settings .settings-body').scrollTop`);
    if (toolScroll <= 0) throw Error("Tools journey needs a scrollable settings body");
    await page.click(toolBox);
    const toolOff = async () =>
      (await rpc(run, { action: "profile-tools", projectId, profile: "coordinator" })).groups
        .flatMap((group) => group.tools)
        .find((tool) => tool.name === toolName)?.enabled === false;
    await until(toolOff, `profile-tools reports ${toolName} off`);
    await page.waitFor(`document.querySelector(${JSON.stringify(toolBox)})?.checked === false`, "tool box unchecked after reload");
    await page.waitFor(`document.querySelector('#settings .settings-body')?.scrollTop >= ${toolScroll - 1}`, "tool save preserves scroll");
    await page.shot(dir, "14-settings-tools-off");
    await page.click(toolBox);
    await until(async () => !(await toolOff()), `profile-tools reports ${toolName} on again`);
    await page.waitFor(`document.querySelector('#settings .settings-body')?.scrollTop > 0`, "second tool save preserves scroll");
    record("side-effect", `Tools: ${toolName} off for the coordinator, then on again; both saves preserved scroll`);
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
    // Automations: run for real, edit with the record revision, then confirm Delete and restore through the Undo tombstone.
    const scheduled = await rpc(run, {
      action: "schedule-create",
      id: projectId,
      atMs: Date.now() + 3600000,
      everyMs: 3600000,
      name: "UI2 hourly check",
      text: "Verify automation run",
    });
    const script = await rpc(run, {
      action: "routine-script-create",
      id: projectId,
      atMs: Date.now() + 3600000,
      everyMs: 3600000,
      name: "UI2 nightly script",
      command: "make verify-nightly",
    });
    const autoCard = `#settings .auto-card[data-kind="schedule"][data-id="${scheduled.id}"]`;
    await page.click('#settings nav [data-section="automations"]');
    await page.waitFor(`!!document.querySelector(${JSON.stringify(autoCard)})`, "schedule automation card");
    await page.click(`${autoCard} [data-auto-run]`);
    await until(async () => {
      const history = await rpc(run, { action: "schedule-history", id: projectId, kind: "intents" });
      return history.routines.some((routine) => routine.routineId === scheduled.id && routine.recentRuns.length === 1);
    }, "Run now records a real schedule run");
    await page.click(`${autoCard} [data-auto-edit]`);
    await page.waitFor(`!!document.querySelector('${autoCard} [data-edit-name]')`, "schedule edit form");
    await page.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(autoCard)});
      const set = (selector, value) => { const field = card.querySelector(selector); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
      set('[data-edit-name]', 'UI2 edited check'); set('[data-edit-text]', 'Edited automation prompt'); set('[data-edit-minutes]', '120');
    })()`);
    await page.click(`${autoCard} [data-auto-save]`);
    await until(async () => {
      const item = (await rpc(run, { action: "schedule-snapshot", id: projectId })).schedules.find((entry) => entry.id === scheduled.id);
      return item?.name === "UI2 edited check" && item.text === "Edited automation prompt" && item.everyMs === 7200000;
    }, "edited schedule saved");
    await page.waitFor(`!!document.querySelector(${JSON.stringify(`${autoCard} [data-auto-delete]`)})`, "saved schedule controls");
    await page.click(`${autoCard} [data-auto-delete]`);
    await page.waitFor(
      `/Confirm delete/.test(document.querySelector('${autoCard} [data-auto-delete]')?.innerText ?? '')`,
      "delete confirmation",
    );
    await page.click(`${autoCard} [data-auto-delete]`);
    await page.waitFor(`!document.querySelector(${JSON.stringify(autoCard)})`, "deleted schedule leaves the cards");
    await page.waitFor(`[...document.querySelectorAll('#toasts .toast button')].some(n => n.textContent === 'Undo')`, "delete Undo toast");
    await page.evaluate(`[...document.querySelectorAll('#toasts .toast button')].find(n => n.textContent === 'Undo').click()`);
    await until(async () => {
      const item = (await rpc(run, { action: "schedule-snapshot", id: projectId })).schedules.find((entry) => entry.id === scheduled.id);
      return item?.name === "UI2 edited check" && item.revision === scheduled.revision + 1 && item.enabled === scheduled.enabled;
    }, "Undo restores the exact schedule tombstone");
    await page.waitFor(`!!document.querySelector(${JSON.stringify(autoCard)})`, "restored schedule card");
    // A script routine shows its command and can be deleted, not edited as a prompt.
    const scriptSelector = `#settings .auto-card[data-kind="schedule"][data-id="${script.id}"]`;
    await page.waitFor(`!!document.querySelector(${JSON.stringify(scriptSelector)})`, "script routine card");
    const scriptCard = await page.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(scriptSelector)});
      return { text: card.innerText, edit: !!card.querySelector('[data-auto-edit]'), remove: !!card.querySelector('[data-auto-delete]') };
    })()`);
    if (!/\$ make verify-nightly/.test(scriptCard.text) || scriptCard.edit || !scriptCard.remove)
      throw Error(`script routine card: ${JSON.stringify(scriptCard)}`);
    // The built-in cleanup routine describes its settings and can only be run or turned off.
    const cleanupCard = await page.evaluate(`(() => {
      const card = document.querySelector('#settings .auto-card[data-kind="schedule"][data-id="workspace-cleanup"]');
      return card && { text: card.innerText, run: !!card.querySelector('[data-auto-run]'), toggle: !!card.querySelector('[data-auto-toggle]'), edit: !!card.querySelector('[data-auto-edit]'), remove: !!card.querySelector('[data-auto-delete]') };
    })()`);
    if (
      !cleanupCard ||
      !/Workspace cleanup/.test(cleanupCard.text) ||
      !/over 20 GB or unused for 7 days/.test(cleanupCard.text) ||
      !cleanupCard.run ||
      !cleanupCard.toggle ||
      cleanupCard.edit ||
      cleanupCard.remove
    )
      throw Error(`cleanup routine card: ${JSON.stringify(cleanupCard)}`);
    await delay(300);
    await page.shot(dir, "15b-settings-automations");
    record(
      "side-effect",
      "Automations: Run now recorded history; Edit saved name/prompt/two-hour cadence; confirmed Delete then Undo restored the exact schedule; the cleanup routine card shows its settings with Run now and the switch only; a script card shows its command with Delete and no prompt Edit",
    );
    // Storage: one row per kind with sizes; Clean up runs the cleanup routine and shows its outcome, then measures again.
    await page.click('#settings nav [data-section="storage"]');
    await page.waitFor(`!!document.querySelector('#settings table.storage tfoot')`, "storage table", 60000);
    const storageRows = await page.evaluate(
      `[...document.querySelectorAll('#settings table.storage tbody tr')].map((row) => ({ id: row.dataset.row, text: row.innerText }))`,
    );
    if (
      !["worktrees", "caches", "disposable", "videos"].every((key) => storageRows.some((row) => row.id === key)) ||
      !storageRows.every((row) => /\d+(\.\d)? (B|KB|MB|GB)|unknown/.test(row.text))
    )
      throw Error(`storage rows: ${JSON.stringify(storageRows)}`);
    const cleanupRunsBefore = (await rpc(run, { action: "schedule-history", id: projectId, kind: "intents" })).items.filter(
      (item) => item.stableId === "workspace-cleanup",
    ).length;
    await page.click("#settings [data-storage-clean]");
    await page.waitFor(
      `!!document.querySelector('#settings .storage-outcome') && !!document.querySelector('#settings table.storage tfoot')`,
      "cleanup outcome",
      120000,
    );
    const storageOutcome = await page.evaluate(`document.querySelector('#settings .storage-outcome').innerText`);
    const cleanupRuns = (await rpc(run, { action: "schedule-history", id: projectId, kind: "intents" })).items.filter(
      (item) => item.stableId === "workspace-cleanup",
    );
    if (cleanupRuns.length !== cleanupRunsBefore + 1 || !/Removed \d+ worktree/.test(storageOutcome))
      throw Error(`storage clean up: ${storageOutcome} runs ${cleanupRunsBefore} -> ${cleanupRuns.length}`);
    await delay(300);
    await page.shot(dir, "15c-settings-storage");
    record(
      "side-effect",
      "Storage: rows for worktrees, caches, disposable paths and Job videos with sizes; Clean up ran the Workspace cleanup routine once (its history grew by one) and showed its summary, then measured again",
    );
    await page.press("Escape", { keyCode: 27 });
    // The free-disk readout opens disk use by project; a project row opens its Settings → Storage.
    await page.waitFor(`!!document.querySelector('#statusline [data-disk-detail]')`, "disk readout button", 30000);
    await page.click("#statusline [data-disk-detail]");
    await page.waitFor(
      `!!document.querySelector('#disk-detail:not([hidden]) [data-storage-project="${projectId}"]') && !!document.querySelector('#disk-detail [data-disk-measure]:not([disabled])')`,
      "disk use by project",
      120000,
    );
    const diskText = await page.evaluate(`document.querySelector('#disk-detail').innerText`);
    if (!/GB free/.test(diskText) || !/\d+(\.\d)? (B|KB|MB|GB)/.test(diskText) || !/measured/.test(diskText))
      throw Error(`disk detail: ${diskText}`);
    await delay(300);
    await page.shot(dir, "15d-disk-by-project");
    await page.click(`#disk-detail [data-storage-project="${projectId}"]`);
    await page.waitFor(
      `document.querySelector('#settings')?.open && document.querySelector('#settings')?.dataset.section === 'storage' && document.querySelector('#disk-detail').hidden`,
      "storage from disk detail",
      30000,
    );
    record(
      "side-effect",
      "Disk readout: pressing it listed disk use per project with sizes and when measured; a project row opened its Settings → Storage",
    );
    await page.press("Escape", { keyCode: 27 });
    // Stop is a real coordinator abort, not a contract placeholder; history stays and a follow-up can run.
    await page.click("#composer textarea");
    await page.cdp("Input.insertText", { text: "VERIFY-STOP hold this turn" });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(`document.querySelector('#stop-btn')?.hidden === false`, "running Stop button", 30000);
    await page.click("#stop-btn");
    await until(
      async () => !(await rpc(run, { action: "show", id: projectId })).chats.find((chat) => chat.id === "main")?.busy,
      "chat idle after Stop",
    );
    await page.waitFor(`document.querySelector('#stop-btn')?.hidden === true`, "Stop leaves after the abort");
    const stoppedView = await rpc(run, { action: "show", id: projectId });
    if (!stoppedView.messages.some((item) => item.text?.includes("VERIFY-STOP hold this turn")))
      throw Error("Stop dropped the owner message");
    record("side-effect", "Stop calls chat-stop with projectId; the running chat becomes idle and its history stays");
    // PR36: a codemode row keeps nested calls inspectable in one compact live status and in its bounded detail.
    await page.click("#composer textarea");
    await page.cdp("Input.insertText", { text: "VERIFY-CODEMODE nested diagnostics" });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(
      `/now bash/.test(document.querySelector('#feed [data-tool="codemode"] [data-nested]')?.innerText ?? '') && /1 call done, 1 failed/.test(document.querySelector('#feed [data-tool="codemode"] [data-nested]')?.innerText ?? '')`,
      "nested codemode running/done/failed summary",
      60000,
    );
    await page.waitFor(`/Nested codemode finished/.test(document.querySelector('#feed').innerText)`, "nested codemode reply", 60000);
    await page.click('#feed [data-tool="codemode"] .tool-head');
    const nestedDetail = await page.evaluate(`document.querySelector('#feed [data-tool="codemode"] .tool-detail')?.innerText ?? ''`);
    if (!/nested-ok/.test(nestedDetail) || nestedDetail.length > 12000)
      throw Error(`codemode detail is missing or unbounded: ${nestedDetail.length}`);
    record("visible", "PR36 codemode row shows nested bash now, one done and one failed; expanding it keeps a bounded result preview");
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
    // PR36 compaction failures stay visible but quiet: a status-line warning and an expandable, bounded error in Context.
    // Build enough new history to require a summary; the fake provider then refuses every summary attempt until re-enabled.
    const compactionRevision = (await rpc(run, { action: "settings-snapshot", id: projectId })).revision;
    await rpc(run, {
      action: "settings-update",
      id: projectId,
      confirm: projectId,
      expectedRevision: compactionRevision,
      changes: { context: { autoCompact: false, keepRecentTokens: 1000 } },
    });
    await page.click("#composer textarea");
    await page.cdp("Input.insertText", { text: `VERIFY-COMPACTION-FAIL retain this diagnostic marker ${"context ".repeat(2000)}` });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(
      `/VERIFY-FAKE-REPLY: VERIFY-COMPACTION-FAIL/.test(document.querySelector('#feed').innerText)`,
      "compaction fixture reply",
      60000,
    );
    await page.click("#composer textarea");
    await page.cdp("Input.insertText", { text: "Ordinary follow-up after the compaction marker" });
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    await page.waitFor(
      `/VERIFY-FAKE-REPLY: Ordinary follow-up/.test(document.querySelector('#feed').innerText)`,
      "post-marker reply",
      60000,
    );
    const failSummary = await fetch(`http://127.0.0.1:${run.fakePort}/fail-next-summary`, { method: "POST" });
    if (!failSummary.ok) throw Error(`failed to arm the fake summary failure: ${failSummary.status}`);
    await rpc(run, { action: "compact", id: projectId });
    await until(
      async () => /UI2-SUMMARY-FAIL/.test((await rpc(run, { action: "show", id: projectId })).context.compactionFailure?.error ?? ""),
      "compaction failure stored",
    );
    await fetch(`http://127.0.0.1:${run.fakePort}/allow-summary`, { method: "POST" });
    await page.waitFor(
      `/compaction failed/i.test(document.querySelector('#statusline').innerText)`,
      "status line names the failed compaction",
    );
    if (await page.evaluate(`document.querySelector('#feed').innerText.includes('UI2-SUMMARY-FAIL')`))
      throw Error("compaction failure became chat noise");
    await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.click('#settings nav [data-section="context"]');
    await page.waitFor(`!!document.querySelector('#settings [data-compaction-failure]')`, "Context compaction failure details");
    await page.click("#settings [data-compaction-failure] summary");
    const failureText = await page.evaluate(`document.querySelector('#settings [data-compaction-failure]').innerText`);
    if (!/UI2-SUMMARY-FAIL/.test(failureText) || failureText.length > 5000) throw Error(`compaction detail: ${failureText.slice(0, 500)}`);
    await page.shot(dir, "16c-context-compaction-failed");
    await page.press("Escape", { keyCode: 27 });
    record("visible", "PR36 failed compaction: status warning, no chat noise, expandable bounded UI2-SUMMARY-FAIL detail in Context");
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
    // The "/" menu at 390 px: inside the viewport, above the composer, its active option fully visible; screenshots fit the column.
    await page.click("#composer textarea");
    await page.cdp("Input.insertText", { text: "/" });
    await page.waitFor(`!document.querySelector('#slash-menu').hidden`, "slash menu at 390 px");
    await page.press("ArrowDown", { keyCode: 40 });
    const slashBox = await page.evaluate(`(() => {
      const m = document.querySelector('#slash-menu').getBoundingClientRect(), c = document.querySelector('#composer').getBoundingClientRect();
      const a = document.querySelector('#slash-menu [aria-selected="true"]').getBoundingClientRect();
      const name = document.querySelector('#slash-menu [aria-selected="true"] .slash-name').getBoundingClientRect();
      return { left: m.left, right: m.right, top: m.top, bottom: m.bottom, composerTop: c.top, width: innerWidth,
        activeInside: a.top >= m.top && a.bottom <= m.bottom + 1, nameInside: name.left >= m.left && name.right <= m.right,
        overflow: document.documentElement.scrollWidth - innerWidth };
    })()`);
    if (
      slashBox.left < 0 ||
      slashBox.right > slashBox.width ||
      slashBox.top < 0 ||
      slashBox.bottom > slashBox.composerTop + 8 ||
      !slashBox.activeInside ||
      !slashBox.nameInside ||
      slashBox.overflow > 0
    )
      throw Error(`slash menu at 390 px: ${JSON.stringify(slashBox)}`);
    await delay(200);
    await page.shot(dir, "10-narrow-390-slash");
    await page.press("Escape", { keyCode: 27 });
    await page.evaluate(
      `(() => { const t = document.querySelector('#composer textarea'); t.value = ''; t.dispatchEvent(new Event('input')); t.blur(); })()`,
    );
    // The first screenshot sits far up the chat, possibly on an older page: load earlier pages, then scroll it near so it loads.
    const readRow = `!!document.querySelector('#feed .tool-row[data-tool="read"] [data-media]')`;
    for (
      let n = 0;
      n < 6 && !(await page.evaluate(readRow)) && (await page.evaluate(`!!document.querySelector('#feed [data-earlier]')`));
      n++
    ) {
      await page.click("#feed [data-earlier]");
      await delay(500);
    }
    await page.waitFor(readRow, "the read screenshot is in the chat");
    await page.evaluate(`document.querySelector('#feed .tool-row[data-tool="read"]').scrollIntoView({ block: 'center' })`);
    await page.waitFor(screenshotLoaded('#feed .tool-row[data-tool="read"] img.media-img'), "screenshot loaded at 390 px");
    await delay(200);
    await page.shot(dir, "10-narrow-390-screenshot");
    const narrowShots = await page.evaluate(screenshotsBounded("#feed"));
    if (badBox(narrowShots)) throw Error(`screenshots at 390 px: ${JSON.stringify(narrowShots)}`);
    record(
      "verified",
      `390 px: "/" menu inside the viewport above the composer with the active option visible; ${narrowShots.length} screenshots fit the column`,
    );
    // Toasts: one identical message shows once, at most two show, and none covers the composer.
    await page.click("#status-pill");
    await page.waitFor(`document.querySelectorAll('#toasts .toast').length >= 1`, "pill toast");
    for (let i = 0; i < 2; i++) await page.click("#status-pill");
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
    // Settings → Status line at 390 px: every row's controls fit, pointer reorder and toggle save, and every enabled item
    // stays in the bar, reachable by scrolling it sideways (an enabled item must not vanish because the screen is narrow).
    await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.waitFor(`document.querySelector('#settings')?.open === true`, "settings at 390 px");
    await page.press("s", { keyCode: 83 });
    await page.waitFor(`!!document.querySelector('#settings .sl-order')`, "status line section at 390 px");
    await delay(300);
    const rows = await page.evaluate(`(() => {
      const bad = [...document.querySelectorAll('#settings .sl-order li')].flatMap(li => [...li.querySelectorAll('input, button')].filter(n => {
        const r = n.getBoundingClientRect(); return r.width < 10 || r.left < 0 || r.right > innerWidth;
      }).map(n => li.dataset.slItem + ':' + (n.dataset.slMove ?? 'toggle')));
      return { bad, overflow: document.documentElement.scrollWidth - innerWidth, rows: document.querySelectorAll('#settings .sl-order li').length };
    })()`);
    if (rows.bad.length || rows.overflow > 0 || rows.rows !== ITEM_ORDER.length)
      throw Error(`status line settings at 390 px: ${JSON.stringify(rows)}`);
    await page.shot(dir, "10c-narrow-390-status-line-settings");
    // The move's confirmation lands in the header after the host saved it. Hold that answer, measure the Thinking checkbox,
    // release it: the confirmation must not shift the rows, so a pointer aimed before it arrived still toggles Thinking.
    await page.evaluate(`(() => {
      const real = window.fetch;
      let release;
      const hold = new Promise((done) => (release = done));
      window.__releaseUiSet = () => { window.fetch = real; release(); };
      window.fetch = async (url, init) => {
        let action = null;
        try { action = JSON.parse(init?.body ?? 'null')?.action; } catch {}
        const held = action === 'ui-set' && !window.__heldUiSet;
        if (held) window.__heldUiSet = true;
        const response = await real(url, init);
        if (held) await hold;
        return response;
      };
    })()`);
    await page.click('#settings [data-sl-item="connection"] [data-sl-move="up"]');
    await until(
      async () => (await rpc(run, { action: "ui-get" })).ui.statusItems[ITEM_ORDER.indexOf("connection") - 1]?.id === "connection",
      "Connection moved up at 390 px",
    );
    const thinkingAt = `(() => { const r = document.querySelector('#settings [data-sl-toggle="thinking"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
    if (!(await page.evaluate(`window.__heldUiSet === true`))) throw Error("the move's ui-set answer was not held");
    const aimed = await page.evaluate(thinkingAt);
    await page.evaluate(`window.__releaseUiSet()`);
    await page.waitFor(
      `document.querySelector('#settings .settings-status')?.textContent.includes('Connection moved up')`,
      "move confirmed in the header",
    );
    await page.waitFor(`document.activeElement?.matches('[data-sl-item="connection"] [data-sl-move="up"]')`, "focus kept on ↑ at 390 px");
    const landed = await page.evaluate(thinkingAt);
    if (Math.abs(landed.x - aimed.x) > 0.5 || Math.abs(landed.y - aimed.y) > 0.5)
      throw Error(`the move's confirmation shifted the Thinking checkbox: ${JSON.stringify({ aimed, landed })}`);
    const head = await page.evaluate(`(() => {
      const h = document.querySelector('#settings .settings-head'), title = h.querySelector('h1'), status = h.querySelector('.settings-status');
      const fits = () => ({ overflow: h.scrollWidth - h.clientWidth, right: h.getBoundingClientRect().right, height: h.getBoundingClientRect().height });
      const real = fits(), saved = [title.textContent, status.textContent];
      // The longest section title with a long confirmation still fits on one line.
      title.textContent = [...document.querySelectorAll('#settings nav button')].map(b => b.childNodes[0]?.textContent?.trim() ?? '').sort((a, b) => b.length - a.length)[0];
      status.textContent = 'Subscription limits moved down to 9 and the bar scrolls sideways';
      const long = fits();
      [title.textContent, status.textContent] = saved;
      return { real, long, width: innerWidth };
    })()`);
    if ([head.real, head.long].some((box) => box.overflow > 0 || box.right > head.width) || head.long.height > head.real.height + 0.5)
      throw Error(`settings header at 390 px overflows or wraps: ${JSON.stringify(head)}`);
    for (const [type, extra] of [
      ["mouseMoved", {}],
      ["mousePressed", { button: "left", clickCount: 1 }],
      ["mouseReleased", { button: "left", clickCount: 1 }],
    ])
      await page.cdp("Input.dispatchMouseEvent", { type, x: aimed.x, y: aimed.y, ...extra });
    await until(
      async () => (await rpc(run, { action: "ui-get" })).ui.statusItems.find((item) => item.id === "thinking")?.enabled === false,
      "thinking hidden at 390 px",
    );
    await page.waitFor(
      `document.querySelector('#settings [data-sl-item="thinking"] .sl-state').textContent === 'hidden'`,
      "row says hidden",
    );
    // An unchanged settings event (the host's echo of this page's own write) leaves the rows in place, so a click is not lost.
    const kept = await page.evaluate(`(async () => {
      const { emit, state } = await import('/state.js'), row = document.querySelector('#settings [data-sl-item="thinking"]');
      emit('ui', state.ui);
      return row.isConnected;
    })()`);
    if (!kept) throw Error("an unchanged settings event redrew the status line rows");
    await page.click('#settings [data-sl-toggle="thinking"]');
    await until(
      async () => (await rpc(run, { action: "ui-get" })).ui.statusItems.find((item) => item.id === "thinking")?.enabled === true,
      "thinking shown again at 390 px",
    );
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`document.querySelector('#settings')?.open === false`, "settings closed at 390 px");
    const reach = await page.evaluate(`(() => {
      const bar = document.querySelector('#statusline'), b = bar.getBoundingClientRect();
      const enabled = JSON.parse(localStorage.getItem('pi-ui2-ui') ?? 'null')?.statusItems?.filter(i => i.enabled && i.id !== 'spacer').map(i => i.id) ?? [];
      const missing = [];
      for (const id of enabled) {
        const node = [...bar.querySelectorAll('[data-item="' + id + '"]')].find(n => n.getClientRects().length);
        if (!node && id === 'limits') continue; // no provider reports usage in this run
        if (!node) { missing.push(id + ':not drawn'); continue; }
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = node.getBoundingClientRect();
        if (r.width < 1 || r.left < b.left - 0.5 || r.right > Math.min(b.right, innerWidth) + 0.5) missing.push(id + ':out of view');
      }
      const order = [...bar.querySelectorAll('[data-item]')].filter(n => n.getClientRects().length || n.dataset.item === 'spacer').map(n => n.dataset.item);
      bar.scrollLeft = bar.scrollWidth;
      return { enabled, missing, order, scrollable: bar.scrollWidth > bar.clientWidth, overflowX: getComputedStyle(bar).overflowX, overflow: document.documentElement.scrollWidth - innerWidth };
    })()`);
    if (!reach.enabled.length || reach.missing.length || reach.overflow > 0) throw Error(`status line at 390 px: ${JSON.stringify(reach)}`);
    await page.shot(dir, "10d-narrow-390-status-line-scrolled");
    record(
      "verified",
      `390 px Settings → Status line: ${rows.rows} rows with controls in view; pointer ↑ moved Connection (focus kept), Thinking hidden ("hidden") and shown; bar "${[...new Set(reach.order)].join(" ")}", every enabled item reachable${reach.scrollable ? " by scrolling the bar sideways" : ""}`,
    );
    await page.evaluate(`document.querySelector('#statusline').scrollLeft = 0`);
    await page.press(",", { code: "Comma", keyCode: 188, modifiers: 4 });
    await page.waitFor(`document.querySelector('#settings')?.open === true`, "settings to restore the status line");
    await page.press("s", { keyCode: 83 });
    await page.waitFor(`!!document.querySelector('#settings [data-sl-reset]')`, "status line section to restore");
    await page.click("#settings [data-sl-reset]");
    await until(
      async () => (await rpc(run, { action: "ui-get" })).ui.statusItems.every((item, index) => item.id === ITEM_ORDER[index]),
      "default status line order restored at 390 px",
    );
    await page.press("Escape", { keyCode: 27 });
    await page.waitFor(`document.querySelector('#settings')?.open === false`, "settings closed after the restore");
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
    await page.click('#settings [data-font-option="jetbrains-mono"]');
    await page.waitFor(`document.documentElement.dataset.font === 'jetbrains-mono'`, "JetBrains Mono restored");
    record("verified", "no horizontal overflow at 390 px; themes and host-persisted fonts applied through the settings overlay");
    writeFileSync(join(dir, "feed-dom.txt"), await page.evaluate(`document.querySelector('#feed').innerText`));
    dropMissingArtifact(sinks, 4);
    if (sinks.errors.length) throw Error(`browser errors: ${sinks.errors.slice(0, 3).join(" | ")}`);
  },
  // Feature: features/message-coordinator.md
  async "message-coordinator"(run, page, record, dir) {
    const prompt = `VERIFY-PING ${run.id}`,
      composer = "#composer textarea";
    const origin = new URL(run.webUrl).origin;
    await page.navigate(run.webUrl);
    await page.waitFor(
      `document.body.dataset.ready === "1" && [...document.querySelectorAll('#tree [data-project]')].some(n => n.innerText.includes(${JSON.stringify(PROJECT_NAME)})) && !!document.querySelector('#tree [data-chat="main"]')`,
      "seeded project and Main chat shown",
    );
    await page.waitFor(`!!document.querySelector(${JSON.stringify(composer)})`, "composer visible");
    record("entry", `opened ${origin} through the launch link; project "${PROJECT_NAME}" selected`);
    await page.shot(dir, "01-before-send");
    // Real user input: pointer-click the composer, insert text through the browser input pipeline, pointer-click Send.
    await page.click(composer);
    await page.cdp("Input.insertText", { text: prompt });
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ${JSON.stringify(prompt)}`, "typed text in composer");
    await page.shot(dir, "02-typed");
    const before = existsSync(run.requestLog) ? readFileSync(run.requestLog, "utf8").split("\n").filter(Boolean).length : 0;
    await page.press("Enter", { code: "Enter", keyCode: 13 });
    record("action", `pressed Enter to send ${JSON.stringify(prompt)}`);
    // The user's own bubble appears once, and the composer clears.
    const bubbles = (role) => `[...document.querySelectorAll('#feed .msg.${role}')].map(n => n.innerText)`;
    await page.waitFor(`${bubbles("owner")}.some(t => t.includes(${JSON.stringify(prompt)}))`, "user bubble rendered");
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ''`, "composer cleared");
    record("visible", "user bubble shows the message and the composer is empty");
    await page.waitFor(`${bubbles("agent")}.some(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}'))`, "coordinator reply rendered", 60000);
    await page.shot(dir, "03-reply");
    const count = await page.evaluate(
      `({ you: ${bubbles("owner")}.filter(t => t.includes(${JSON.stringify(prompt)})).length, them: ${bubbles("agent")}.filter(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}')).length })`,
    );
    if (count.you !== 1 || count.them !== 1) throw Error(`expected exactly one user and one reply bubble, got ${JSON.stringify(count)}`);
    record("visible", "one user bubble and one coordinator bubble with the VERIFY-FAKE-REPLY echo");
    // Persistence: a reload (token kept in localStorage) re-renders both turns from the host.
    await page.reload();
    await page.waitFor(
      `${bubbles("owner")}.some(t => t.includes(${JSON.stringify(prompt)})) && ${bubbles("agent")}.some(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}'))`,
      "both bubbles after reload",
    );
    await page.shot(dir, "04-after-reload");
    writeFileSync(join(dir, "messages-dom.txt"), await page.evaluate(`document.querySelector('#feed').innerText`));
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
