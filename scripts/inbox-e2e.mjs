import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureHost, health, inboxUrl, request } from "../src/client.ts";
import { parse, Project, Snapshot, saveJson } from "../src/state.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "artifacts", `inbox-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.PI_PROJECTS_HOME = join(dir, "state");
const proof = randomUUID();
writeFileSync(join(workspace, "expected.txt"), proof);
writeFileSync(join(dir, "outside.txt"), "PRIVATE_FIXTURE");
symlinkSync(dir, join(workspace, "outside-link"));
writeFileSync(join(workspace, "verify.mjs"), "import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(fs.readFileSync('proof.txt','utf8').trim(),fs.readFileSync('expected.txt','utf8').trim()); fs.writeFileSync('verification.json',JSON.stringify({ok:true,proof:fs.readFileSync('proof.txt','utf8').trim()}));");
writeFileSync(join(workspace, "unsafe.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>globalThis.EVIDENCE_EXECUTED=true</script></svg>');
writeFileSync(join(workspace, "capture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mzcAAAAASUVORK5CYII=", "base64"));
const checks = [];
const errors = [];
let chrome;
let ws;
let projectId;
let url;
let n = 0;
const pending = new Map();

function check(name, value) {
  assert.ok(value, name);
  checks.push({ name, at: new Date().toISOString() });
  saveJson(join(dir, "assertions.json"), checks);
  process.stderr.write(`PASS ${name}\n`);
}
async function wait(name, fn, timeout = 360000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(500); }
  throw new Error(`Timed out: ${name}`);
}
async function snapshot() { return parse(Snapshot, await request({ action: "show", id: projectId })); }
async function connectChrome() {
  chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "chrome-profile")}`, "about:blank"], { stdio: "ignore" });
  chrome.on("error", error => errors.push(error.message));
  const port = await wait("Chrome startup", () => { try { return readFileSync(join(dir, "chrome-profile", "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, 20000);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.id) {
      const call = pending.get(message.id); pending.delete(message.id);
      if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
    }
  });
  await cdp("Page.enable"); await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
}
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function navigate(address) { await cdp("Page.navigate", { url: address }); await sleep(300); }
async function click(selector) {
  await wait(`element ${selector}`, () => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), 20000);
  const point = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
async function fill(selector, text) { await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(text)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function submit(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`); }
async function screenshot(name) { const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(join(dir, `${name}.png`), Buffer.from(image.data, "base64")); }
async function webApi(input, options = {}) {
  const address = new URL(url);
  const token = new URLSearchParams(address.hash.slice(1)).get("token");
  return fetch(`${address.origin}/api`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...options }, body: JSON.stringify(input) });
}
function forgedHost() {
  return new Promise((resolve, reject) => {
    const address = new URL(url);
    const token = new URLSearchParams(address.hash.slice(1)).get("token");
    const call = httpRequest(`${address.origin}/api`, { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${token}`, "content-type": "application/json" } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    call.on("error", reject); call.end(JSON.stringify({ action: "list" }));
  });
}
async function restart() {
  const old = await health();
  await request({ action: "shutdown" }, false);
  await wait("host stops", () => { try { process.kill(old.pid, 0); return false; } catch { return true; } }, 20000);
  await ensureHost(); url = await inboxUrl(projectId);
}

try {
  await ensureHost(); url = await inboxUrl();
  check("Missing auth is rejected", (await fetch(new URL(url).origin + "/api", { method: "POST", body: JSON.stringify({ action: "list" }) })).status === 401);
  check("Wrong auth is rejected", (await webApi({ action: "list" }, { authorization: "Bearer WRONG" })).status === 401);
  check("Cross-origin request is rejected", (await webApi({ action: "list" }, { origin: "https://evil.example" })).status === 403);
  check("Forged Host is rejected", await forgedHost() === 403);
  check("Oversized browser request is rejected", (await webApi({ action: "message", id: randomUUID(), text: "x".repeat(70000) })).status === 400);
  await connectChrome(); await navigate(url);
  await wait("empty inbox", () => evaluate('document.querySelector("#title").textContent.includes("Create your first")'), 20000);
  await click("#create"); await fill('[data-create] [name="name"]', "Live inbox E2E"); await fill('[data-create] [name="cwd"]', workspace); await fill('[data-create] [name="objective"]', "Prove durable decisions, worker review, and immutable evidence.");
  await evaluate('document.querySelector("[name=trusted]").checked=true'); await submit("[data-create]");
  const project = await wait("project created", async () => (await request({ action: "list" }))[0]);
  projectId = parse(Project, project).id;
  await wait("project connected", () => evaluate('document.querySelector("#connection").textContent.startsWith("Connected")'), 30000);
  check("Create project through the live browser", (await snapshot()).project.cwd === workspace);
  const task = `First call projects_question with question "Which verification scope should I use?" and choices ["Smoke", "Full"], then stop. Do not delegate yet. After the owner answers Smoke, delegate exactly one worker with this bounded task: read expected.txt and write proof.txt with its exact value; attempt projects_evidence on ../outside.txt and outside-link/outside.txt and observe the expected policy denials without bypassing them; execute bash sleep 75 to leave time for owner and coordinator steering; then execute node verify.mjs and capture verification.json, proof.txt, unsafe.svg and capture.png with projects_evidence. Report command exit status and captured artifacts. Do not create unit tests, commit, or publish. Return after delegation and inspect the result when completion wakes you. No further decision is needed.`;
  await cdp("Network.emulateNetworkConditions", { offline: false, latency: 500, downloadThroughput: -1, uploadThroughput: -1 });
  await fill("#compose textarea", task); await submit("#compose");
  await fill("#compose textarea", "Keep text typed while the first request is in flight.");
  await wait("message accepted by browser", () => evaluate("!busy"), 20000);
  check("An in-flight send does not erase newly typed text", await evaluate('document.querySelector("#compose textarea").value === "Keep text typed while the first request is in flight."'));
  await cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await fill("#compose textarea", "");
  const question = await wait("durable question", async () => (await snapshot()).inbox.find(item => item.kind === "question" && !item.result));
  await wait("question in browser", () => evaluate('document.querySelector("#letter").textContent.includes("Which verification scope")'));
  check("Real model question has actionable choices", question.choices.includes("Smoke"));
  await screenshot("question");
  await wait("question turn settles", async () => !(await snapshot()).busy);
  await restart(); await navigate(url);
  await wait("question restores", () => evaluate('document.querySelector("#letter").textContent.includes("Which verification scope")'));
  check("Question survives a host restart", (await snapshot()).inbox.some(item => item.id === question.id && !item.result));
  await click(`[data-action="answer"][data-choice="${question.choices.indexOf("Smoke")}"]`);
  await wait("answer stored", async () => (await snapshot()).inbox.find(item => item.id === question.id)?.result);
  let jobCount = (await snapshot()).jobs.length;
  await request({ action: "answer", id: projectId, entry: question.id, text: "Smoke" });
  check("Duplicate answer does not enqueue another job", (await snapshot()).jobs.length === jobCount);
  check("Conflicting answer is rejected", (await webApi({ action: "answer", id: projectId, entry: question.id, text: "Full" })).status === 400);
  const run = await wait("worker starts", async () => (await snapshot()).activeRuns[0]);
  await wait("worker visible", () => evaluate(`Boolean(document.querySelector('[data-action="worker"][data-run="${run.id}"]'))`));
  await fill("#compose textarea", "Keep this draft while the project refreshes."); await evaluate('document.querySelector("#compose textarea").focus()'); await sleep(2500);
  check("Polling preserves the focused draft", await evaluate('document.activeElement.matches("#compose textarea") && document.activeElement.value === "Keep this draft while the project refreshes."'));
  await fill("#compose textarea", "");
  await click(`[data-action="worker"][data-run="${run.id}"]`);
  await wait("worker report", () => evaluate('Boolean(document.querySelector("#dialog [data-action=steer]"))'));
  await click('#dialog [data-action="steer"]'); await fill('#dialog textarea', 'Also write steered.txt containing exactly STEER_OK before completion.'); await submit('[data-task-message]');
  await wait("steering modal closes", () => evaluate('!dialog.open'), 20000);
  check("Live browser can steer a real worker", true);
  await fill("#compose textarea", 'For the worker already doing this task, add one requirement: also write master-steered.txt containing exactly MASTER_STEER_OK before completion. Keep its existing run; do not spawn another worker, create a goal, or edit files yourself. Then reply MASTER_REQUEST_HANDLED.');
  await submit("#compose");
  await wait("master steers existing worker", async () => { const s = await snapshot(); return !s.busy && s.messages.some(message => message.role === "assistant" && message.text.includes("MASTER_REQUEST_HANDLED")); });
  check("Arbitrary request reaches the master without duplicating the worker", (await snapshot()).project.runs.length === 1);
  check("Conversation remains collapsed by default", await evaluate('!document.querySelector(".conversation").open'));
  await wait("master reply appears in the inbox", () => evaluate('document.querySelector("#reply-summary").textContent.includes("MASTER_REQUEST_HANDLED")'));
  await click('[data-action="conversation"]');
  check("Coordinator conversation opens on demand", await evaluate('document.querySelector(".conversation").open && document.querySelector("#messages").textContent.includes("MASTER_REQUEST_HANDLED")'));
  jobCount = (await snapshot()).jobs.length;
  await navigate("about:blank");
  check("Closing the browser view leaves worker active", (await snapshot()).activeRuns.length === 1);
  await wait("worker result and captured evidence", async () => { const s = await snapshot(); saveJson(join(dir, "latest.json"), s); return !s.busy && s.activeRuns.length === 0 && s.evidence.length >= 4 ? s : null; });
  check("Actual worker edits and verifies", JSON.parse(readFileSync(join(workspace, "verification.json"), "utf8")).proof === proof);
  check("Worker receives browser steering", readFileSync(join(workspace, "steered.txt"), "utf8").trim() === "STEER_OK");
  check("Worker receives master steering", readFileSync(join(workspace, "master-steered.txt"), "utf8").trim() === "MASTER_STEER_OK");
  const result = await snapshot();
  const coordinatorEntries = readFileSync(result.project.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const coordinatorCalls = coordinatorEntries.filter(entry => entry.type === "message" && entry.message.role === "assistant").flatMap(entry => entry.message.content.filter(block => block.type === "toolCall"));
  check("Master uses the real worker steering tool", coordinatorCalls.some(call => call.name === "projects_control" && call.arguments.run === run.id && call.arguments.operation === "steer"));
  check("Master never codes, runs shell, or starts goal mode", coordinatorCalls.every(call => !["write", "edit", "bash", "create_goal"].includes(call.name)));
  saveJson(join(dir, "coordinator-tools.json"), coordinatorCalls);
  const review = result.inbox.find(item => item.kind === "review" && item.run === run.id);
  check("Terminal worker has one durable review", review && result.inbox.filter(item => item.kind === "review" && item.run === run.id).length === 1);
  const status = result.runStates.find(item => item.id === run.id);
  check("Captured evidence belongs to the worker session", result.evidence.every(item => item.sessionFile === status.sessionFile));
  const calls = readFileSync(status.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const denials = calls.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "projects_evidence" && entry.message.isError);
  check("Evidence rejects actual outside-workspace and symlink calls", denials.length >= 2);
  saveJson(join(dir, "evidence-denials.json"), denials);
  await navigate(url);
  await wait("review visible", () => evaluate(`Boolean(document.querySelector('[data-action="accept"][data-entry="${review.id}"]'))`));
  await screenshot("review");
  const artifact = result.evidence.find(item => item.filename === "verification.json");
  writeFileSync(join(workspace, "verification.json"), "CHANGED_AFTER_CAPTURE");
  await click(`[data-action="artifact"][data-file="${artifact.id}"]`);
  await wait("evidence visible", () => evaluate(`document.querySelector('#dialog pre')?.textContent.includes(${JSON.stringify(proof)})`));
  check("Browser reads immutable verification evidence", await evaluate(`document.querySelector('#dialog pre').textContent.includes(${JSON.stringify(proof)})`));
  await screenshot("evidence"); await click('#dialog [data-action="close-dialog"]');
  const svg = result.evidence.find(item => item.filename === "unsafe.svg");
  await click(`[data-action="artifact"][data-file="${svg.id}"]`); await wait("SVG shown as text", () => evaluate('Boolean(document.querySelector("#dialog pre"))'));
  check("SVG evidence cannot execute", await evaluate('!globalThis.EVIDENCE_EXECUTED && !document.querySelector("#dialog img")'));
  await click('#dialog [data-action="close-dialog"]');
  const image = result.evidence.find(item => item.filename === "capture.png");
  await click(`[data-action="artifact"][data-file="${image.id}"]`); await wait("PNG decoded", () => evaluate('document.querySelector("#dialog img")?.naturalWidth > 0'));
  check("PNG evidence opens as an image", true); await click('#dialog [data-action="close-dialog"]');
  await click(`[data-action="accept"][data-entry="${review.id}"]`);
  await wait("review accepted", async () => (await snapshot()).inbox.find(item => item.id === review.id)?.result?.action === "accept");
  const accepted = await snapshot();
  check("Accepting does not delegate or publish", accepted.project.runs.length === 1 && accepted.jobs.length === jobCount);
  await restart(); await navigate(url); await wait("inbox reconnects", () => evaluate('document.querySelector("#connection").textContent.startsWith("Connected")'));
  check("Accepted review stays closed after restart", (await snapshot()).inbox.find(item => item.id === review.id).result?.action === "accept");
  check("Pending inbox is empty after accepted review", (await snapshot()).inbox.every(item => item.result));
  const other = parse(Project, await request({ action: "create", name: "Other owner", cwd: workspace }));
  check("Foreign worker control is rejected", (await webApi({ action: "control", id: other.id, run: run.id, operation: "stop" })).status === 400);
  const origin = new URL(url).origin; const auth = { authorization: `Bearer ${new URLSearchParams(new URL(url).hash.slice(1)).get("token")}` };
  check("Foreign evidence is not served", (await fetch(`${origin}/evidence/${other.id}/${artifact.id}`, { headers: auth })).status === 400);
  check("Evidence path traversal is rejected", (await fetch(`${origin}/evidence/${projectId}/%2e%2e%2fauth.json`, { headers: auth })).status === 400);
  const slow = await request({ action: "delegate", id: projectId, role: "worker", task: "Do not edit anything or create tests. Execute bash sleep 120 so the human can exercise stop. Then report SLEEP_DONE. Do not delegate or publish." });
  await wait("stop worker visible", () => evaluate(`Boolean(document.querySelector('[data-action="worker"][data-run="${slow.runId}"]'))`));
  await click(`[data-action="worker"][data-run="${slow.runId}"]`); await wait("stop control", () => evaluate('Boolean(document.querySelector("#dialog [data-action=stop]"))'));
  await click('#dialog [data-action="stop"]'); await click('#dialog [data-action="confirm-stop"]');
  const stopped = await wait("worker stopped", async () => (await snapshot()).inbox.find(item => item.kind === "review" && item.run === slow.runId));
  check("Stopped worker is never labeled verified", stopped.outcome === "stopped" || stopped.outcome === "failed");
  await wait("stopped review visible", () => evaluate(`Boolean(document.querySelector('[data-action="revise"][data-entry="${stopped.id}"]'))`));
  await click(`[data-action="revise"][data-entry="${stopped.id}"]`); await fill('#dialog textarea', 'Do not edit or delegate. Only reply REQUEST_SEEN. This is an E2E control check.'); await submit('[data-task-message]');
  await wait("change request stored", async () => (await snapshot()).inbox.find(item => item.id === stopped.id)?.result?.action === "revise");
  await wait("coordinator acknowledges changes", async () => { const s = await snapshot(); return !s.busy && s.messages.some(message => message.text.includes("REQUEST_SEEN")); });
  check("Request changes reaches the live coordinator once", (await snapshot()).project.runs.length === 2);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await screenshot("mobile");
  check("Live inbox fits a narrow screen", await evaluate('document.documentElement.scrollWidth<=390'));
  check("No browser runtime errors", errors.length === 0);
  saveJson(join(dir, "report.json"), { ok: true, proof, checks, projectId, errors, repeat: "npm run e2e:inbox", screenshots: ["question.png", "review.png", "evidence.png", "mobile.png"], evidence: result.evidence.map(item => ({ id: item.id, sha256: item.sha256, filename: item.filename })) });
  process.stdout.write(`E2E evidence: ${dir}\n`);
} catch (error) {
  saveJson(join(dir, "report.json"), { ok: false, error: error.stack ?? String(error), checks, errors });
  process.stderr.write(`FAILED ${error.stack}\nEvidence: ${dir}\n`);
  process.exitCode = 1;
} finally {
  if (ws?.readyState === WebSocket.OPEN) { try { await cdp("Browser.close"); } catch {} ws.close(); }
  chrome?.kill("SIGTERM");
  if (projectId) {
    try { for (const run of (await snapshot()).activeRuns) await request({ action: "control", id: projectId, run: run.id, operation: "stop" }); } catch {}
  }
  try { await request({ action: "shutdown" }, false); } catch {}
}
