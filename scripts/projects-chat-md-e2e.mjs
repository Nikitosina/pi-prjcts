// Startup + browser render and sign-in check for the inbox at `/`. Fresh isolated home. No model submissions, grants or provider operations.
// The classic tabs (Knowledge, Observability, Settings panels) and Owner setup dialog were retired on 2026-11-04 (docs/classic-retirement.md).
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const stamp = new Date().toISOString().replaceAll(":", "-");
const artifacts = process.env.ARTIFACT_DIR || join(process.env.PI_ARTIFACTS_DIR || repo + "/artifacts", `projects-chat-md-${stamp}`),
  root = process.env.REVIEW_ROOT ? realpathSync(process.env.REVIEW_ROOT) : join(realpathSync(tmpdir()), `projects-chat-md-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace");
const result = {
  scope: "startup + browser render of project-home UI",
  root,
  home,
  checks: [],
  errors: [],
  httpErrors: [],
  modelSubmissions: 0,
  grantsIssued: 0,
  providerOperations: 0,
};
const save = () => writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Unsafe runtime override; refused without clearing");
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(home, { mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
const socket = join(
  tmpdir(),
  `pi-projects-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}.sock`,
);
result.socket = socket;
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: "1" };
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

try {
  result.pid = host.pid;
  result.node = process.version;
  save();
  let health;
  for (let i = 0; i < 150; i++) {
    if (hostEnded) throw new Error("Host exited before health readiness");
    try {
      health = await rpc();
      break;
    } catch {
      await delay(200);
    }
  }
  if (!health || health.pid !== host.pid || health.home !== home) throw new Error("Owned host health readiness failed");
  result.checks.push("owned host health ready");
  const project = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "UI Review Alpha",
    cwd: workspace,
    objective: "Disposable UI review. No execution grants.",
  });
  const second = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "UI Review Beta",
    cwd: workspace,
    objective: "Second disposable project for switching.",
  });
  result.projectId = project.id;
  result.secondProjectId = second.id;
  result.checks.push("two stable-ID projects created");
  save();
  await rpc({ action: "pause", id: project.id });
  await rpc({ action: "resume", id: project.id });
  const initialEvents = await rpc({ action: "event-log", id: project.id, offset: 0, limit: 20 });
  const initialHealth = await rpc({ action: "host-health", id: project.id });
  if (!initialEvents.events.some((event) => event.source === "host-observed" && /paused:|resumed:/.test(JSON.stringify(event))))
    throw new Error("Lifecycle events missing from event-log API");
  if (!(initialHealth.uptimeMs > 0)) throw new Error("host-health API did not report positive uptime");
  result.checks.push("event-log API includes pause/resume; host-health reports positive uptime");
  const web = await rpc({ action: "web" });
  const launch = new URL(web.url);
  launch.searchParams.set("project", project.id);
  result.browserOrigin = launch.origin;

  startChrome();
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  chromeSession = s;
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) await send(method, {}, s);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send("Page.navigate", { url: launch.toString() }, s);
  const ready = `document.body.dataset.ready === "1"`;
  const crumb = `(document.querySelector('#crumb, header .crumb, .crumbs')?.innerText ?? document.title)`;
  await waitFor(
    `${ready} && document.querySelector('#tree .tree-project.selected')?.innerText.includes('UI Review Alpha')`,
    s,
    "project render",
  );
  await waitFor(`location.hash === ''`, s, "token fragment removed");
  if (!(await evaluate(`location.pathname === '/'`, s))) throw new Error("The inbox is not at /");
  result.checks.push("project rendered at / in headless Chrome; token fragment stripped from address bar");
  // A browser that re-creates the tab (e.g. a browser moving a tab into a new window) loads the stripped URL in a fresh tab.
  const strippedUrl = await evaluate("location.href", s);
  const { targetId: tab2 } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s2 } = await send("Target.attachToTarget", { targetId: tab2, flatten: true });
  await send("Runtime.enable", {}, s2);
  await send("Page.navigate", { url: strippedUrl }, s2);
  await waitFor(
    `${ready} && !document.querySelector('#signin')?.open && !!document.querySelector('#tree .tree-project.selected')`,
    s2,
    "fresh tab without #token stays authenticated",
  );
  await send("Target.closeTarget", { targetId: tab2 });
  result.checks.push("fresh tab on the token-less URL stays authenticated (re-created tab case)");
  // A browser that never had the token (another profile) gets the sign-in dialog and no project data; a wrong token is refused.
  const { browserContextId } = await send("Target.createBrowserContext", {});
  const { targetId: tab3 } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId: s3 } = await send("Target.attachToTarget", { targetId: tab3, flatten: true });
  await send("Runtime.enable", {}, s3);
  await send("Page.navigate", { url: strippedUrl }, s3);
  await waitFor(`document.querySelector('#signin')?.open === true`, s3, "sign-in dialog without a token");
  const outsider = await evaluate(
    `({ tree: document.querySelector('#tree').innerText, feed: document.querySelector('#feed').innerText })`,
    s3,
  );
  if (/UI Review/.test(outsider.tree + outsider.feed)) throw new Error("Project data shown without a token: " + JSON.stringify(outsider));
  const wrong = new URL(strippedUrl);
  wrong.hash = "token=" + "0".repeat(64);
  await send("Page.navigate", { url: "about:blank" }, s3); // a hash-only change would not reload the page
  await waitFor(`location.href === 'about:blank'`, s3, "blank");
  await send("Page.navigate", { url: wrong.toString() }, s3);
  await waitFor(
    `document.querySelector('#signin')?.open === true && /no longer valid/.test(document.querySelector('#signin').innerText)`,
    s3,
    "wrong token refused",
  );
  if (!(await evaluate(`location.hash === ''`, s3))) throw new Error("A wrong token stayed in the address bar");
  await send("Target.closeTarget", { targetId: tab3 });
  await send("Target.disposeBrowserContext", { browserContextId });
  result.checks.push("a browser without the token gets the sign-in dialog and no project data; a wrong token is refused and stripped");
  const sidebar = await evaluate(`[...document.querySelectorAll('#tree .tree-head[data-project]')].map(n => n.textContent.trim())`, s);
  if (!sidebar.some((t) => t.includes("UI Review Alpha")) || !sidebar.some((t) => t.includes("UI Review Beta")))
    throw new Error("Tree projects missing: " + JSON.stringify(sidebar));
  result.checks.push("the tree lists both projects");
  await waitFor(
    `!!document.querySelector('#feed .empty-chat') && !document.querySelector('#composer-input').disabled`,
    s,
    "empty chat with an enabled composer",
  );
  result.checks.push("the Main chat opens by default with starters and an enabled composer");
  await shot("01-coordinator", s);

  await evaluate(`document.querySelector('#tree .tree-head[data-project="${second.id}"]').click()`, s);
  await waitFor(
    `new URL(location.href).searchParams.get('project') === '${second.id}' && document.querySelector('#tree .tree-project.selected')?.innerText.includes('UI Review Beta') && document.querySelector('#feed .empty-title')?.innerText === 'UI Review Beta'`,
    s,
    "project switch",
  );
  result.checks.push("the tree switches project; URL and the selected item follow");

  await evaluate(`document.activeElement?.blur()`, s);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "/", code: "Slash", text: "/", windowsVirtualKeyCode: 191 }, s);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "/", code: "Slash", windowsVirtualKeyCode: 191 }, s);
  await waitFor(`document.activeElement === document.querySelector('#composer-input')`, s, "/ shortcut");
  result.checks.push('"/" focuses the composer');
  await shot("07-second-project", s);

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(600);
  await shot("08-mobile", s);
  if (!(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s))) throw new Error("390 px overflows sideways");
  result.checks.push("390 px: nothing overflows sideways");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);

  const keyboard = await evaluate(
    `(() => { const area = document.querySelector('#composer-input'), form = document.querySelector('#composer'); let submits = 0; form.addEventListener('submit', e => { e.preventDefault(); e.stopImmediatePropagation(); submits++; }, { capture: true }); area.value = 'Enter test'; area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })); const shiftNotSubmitted = submits === 0; area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); const enterSubmitted = submits === 1; area.value = ''; return { enterSubmitted, shiftNotSubmitted }; })()`,
    s,
  );
  if (!keyboard.enterSubmitted || !keyboard.shiftNotSubmitted)
    throw new Error("Composer keyboard behavior failed: " + JSON.stringify(keyboard));
  result.checks.push("Enter submits; Shift+Enter remains a newline");
  const markdown = await evaluate(
    `import('/format.js').then(({ markdown }) => { const html = markdown('# Heading\\n\\n- one\\n- **two**\\n\\n1. ordered\\n2. item\\n\\n> quote\\n> continuation\\n\\n\x60*literal*\x60 [link](https://example.test/?a=1&b=2) <img src=x onerror=alert(1)> [bad](javascript:alert(1))'); const node = document.createElement('div'); node.innerHTML = html; return { html, headings: node.querySelectorAll('.md-h').length, lists: node.querySelectorAll('ul').length, ordered: node.querySelectorAll('ol').length, quotes: node.querySelectorAll('blockquote').length, literal: node.querySelector('code')?.textContent, img: !!node.querySelector('img'), javascript: [...node.querySelectorAll('a')].some(a => /^javascript:/i.test(a.getAttribute('href') ?? '')), href: node.querySelector('a')?.getAttribute('href') }; })`,
    s,
  );
  if (
    !markdown ||
    markdown.headings !== 1 ||
    markdown.lists !== 1 ||
    markdown.ordered !== 1 ||
    markdown.quotes !== 1 ||
    markdown.literal !== "*literal*" ||
    markdown.img ||
    markdown.javascript ||
    markdown.href !== "https://example.test/?a=1&b=2"
  )
    throw new Error("Markdown rendering or XSS check failed: " + JSON.stringify(markdown));
  result.checks.push("Markdown headings, lists, blockquotes, inline code, safe URL escaping and inert XSS payload");
  if (result.errors.length || result.httpErrors.length) throw new Error("Browser JS errors or HTTP failures captured");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
  try {
    result.diagnostic = await evaluate(
      `({ ready: document.body?.dataset.ready, signin: !!document.querySelector('#signin')?.open, composer: !!document.querySelector('#composer-input'), active: document.activeElement?.tagName, feed: document.querySelector('#feed')?.innerText.slice(0, 600) })`,
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
if (result.status === "passed" && process.env.KEEP_HOST === "1") {
  // Leave the isolated host running for owner review; open the authenticated URL in the default browser.
  const web = await rpc({ action: "web" });
  const url = new URL(web.url);
  url.searchParams.set("project", result.projectId);
  spawn("/usr/bin/open", [url.toString()], { stdio: "ignore" });
  result.leftRunningForReview = true;
  save();
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, artifact: artifacts }));
  await hostExit;
} else {
  if (!hostEnded) {
    try {
      await rpc({ action: "shutdown" });
    } catch (e) {
      result.shutdownError = String(e);
    }
    await Promise.race([hostExit, delay(10000)]);
  }
  if (!hostEnded) host.kill("SIGTERM");
  save();
  log.end();
  console.log(
    JSON.stringify({
      status: result.status,
      failure: result.failure,
      errors: result.errors,
      httpErrors: result.httpErrors,
      artifact: artifacts,
    }),
  );
  if (result.status !== "passed") process.exitCode = 1;
}
