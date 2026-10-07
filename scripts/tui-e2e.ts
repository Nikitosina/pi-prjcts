import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { request, health } from "../src/client.ts";
import { addQuestion } from "../src/inbox.ts";
import { captureEvidence } from "../src/evidence.ts";
import { Project, Snapshot, addNote, parse, projectDir, saveJson, type Snapshot as SnapshotData } from "../src/state.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "artifacts", `tui-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.PI_PROJECTS_HOME = join(dir, "state");
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const proof = randomUUID();
const tuiMode = process.env.PI_PROJECTS_E2E_TUI_MODE ?? "fullscreen";
assert.ok(tuiMode === "fullscreen" || tuiMode === "regular", "Supported Pi terminal mode");
writeFileSync(join(workspace, "expected.txt"), proof);
writeFileSync(join(workspace, "verify.mjs"), "import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(fs.readFileSync('proof.txt','utf8').trim(),fs.readFileSync('expected.txt','utf8').trim()); fs.writeFileSync('verification.json',JSON.stringify({ok:true,proof:fs.readFileSync('proof.txt','utf8').trim()}));");
writeFileSync(join(workspace, "capture.json"), JSON.stringify({ captureProof: proof, fixture: "real captured file" }));
const checks: string[] = [];
let terminal: ChildProcessWithoutNullStreams | undefined;
let id = "";
let sequence = 0;
const replies = new Map<number, (lines: string[]) => void>();
const Runner = Type.Union([
  Type.Object({ kind: Type.Literal("output"), data: Type.String() }),
  Type.Object({ kind: Type.Literal("ack"), id: Type.Number() }),
  Type.Object({ kind: Type.Literal("screen"), id: Type.Number(), lines: Type.Array(Type.String()) }),
  Type.Object({ kind: Type.Literal("exit"), code: Type.Union([Type.Number(), Type.Null()]) }),
]);
const escape = "\u001b";

function check(name: string, value: boolean): void { assert.ok(value, name); checks.push(name); saveJson(join(dir, "assertions.json"), checks); process.stderr.write(`PASS ${name}\n`); }
async function wait<T>(name: string, read: () => Promise<T | null | false>, timeout = 300000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(300); }
  throw new Error(`Timed out: ${name}`);
}
async function snapshot(): Promise<SnapshotData> { const state = parse(Snapshot, await request({ action: "show", id })); saveJson(join(dir, "latest.json"), state); return state; }
function command(value: { kind: "screen" } | { kind: "write"; data: string } | { kind: "resize"; rows: number; columns: number }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (!terminal) { reject(new Error("PTY not started")); return; }
    const n = ++sequence;
    const timer = setTimeout(() => { replies.delete(n); reject(new Error(`PTY command timed out: ${value.kind}`)); }, 15000);
    replies.set(n, lines => { clearTimeout(timer); resolve(lines); });
    terminal.stdin.write(JSON.stringify({ ...value, id: n }) + "\n");
  });
}
async function input(text: string): Promise<void> { await command({ kind: "write", data: text }); await sleep(180); }
async function screenContains(text: string): Promise<string[]> { return wait(`terminal shows ${text}`, async () => { const lines = await command({ kind: "screen" }); return lines.join("\n").includes(text) ? lines : null; }, 30000); }
async function selectWorker(run: string): Promise<void> {
  await wait("worker is visible and selected in Pi", async () => {
    await input("w");
    return (await command({ kind: "screen" })).join("\n").includes(run);
  }, 20000);
}
async function capture(name: string): Promise<void> { writeFileSync(join(dir, `${name}.txt`), (await command({ kind: "screen" })).join("\n") + "\n"); }
async function idle(): Promise<SnapshotData> { return wait("coordinator idle", async () => { const s = await snapshot(); return !s.busy && !s.jobs.some(job => job.state === "queued" || job.state === "running") ? s : null; }); }

try {
  execFileSync("python3", ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--target", join(dir, "python-packages"), "pyte==0.8.2", "wcwidth==0.2.13"], { stdio: "ignore" });
  const project = parse(Project, await request({ action: "create", name: "Native UI proof 界", cwd: workspace, objective: "Implement only the explicitly requested bounded verification. Never publish or modify files outside this disposable workspace." }));
  id = project.id;
  const question = addQuestion(projectDir(id), "Choose a scope for terminal verification. After my answer, only reply UI_ACK. Do not delegate or use tools.", ["Short", "Full"]);
  addNote(projectDir(id), "e2e", "Unicode: 界 привет.\n" + Array.from({ length: 70 }, (_, i) => `Note line ${i + 1}: the inspector must scroll without losing its footer.`).join("\n") + "\n\u001b]0;UNSAFE_TITLE\u0007\u001b[2J");
  await captureEvidence({ root: workspace, dir: projectDir(id), path: "capture.json", title: "Captured verification fixture", sessionFile: null });
  const args = [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--no-approve", "--no-context-files", "--offline", "--provider", "openai-codex", "--model", "gpt-5.6-sol", "--tui-mode", tuiMode, "--extension", join(root, "src", "extension.ts")];
  terminal = spawn("python3", [join(root, "scripts", "tui-pty.py"), workspace, process.execPath, ...args], { env: { ...process.env, PYTHONPATH: join(dir, "python-packages"), TERM: "xterm-256color", TERM_PROGRAM: "PiE2E" }, stdio: "pipe" });
  terminal.stderr.on("data", data => appendFileSync(join(dir, "pty-errors.log"), data));
  const lines = createInterface({ input: terminal.stdout });
  lines.on("line", line => {
    const message = parse(Runner, JSON.parse(line));
    if (message.kind === "output") appendFileSync(join(dir, "terminal.ansi"), Buffer.from(message.data, "base64"));
    else if (message.kind === "ack" || message.kind === "screen") { const reply = replies.get(message.id); replies.delete(message.id); reply?.(message.kind === "screen" ? message.lines : []); }
  });
  await sleep(2500);
  await input(`/project-open ${id}\r`); await screenContains("Project Native UI proof");
  await input("/projects-view\r"); await screenContains("Decision inbox"); await capture("default-inbox"); check("Decision inbox is the fresh-session default", true);
  await input("1"); await screenContains("Command desk"); await capture("desk"); check("Command desk renders in a real Pi terminal", true);
  await input("2"); await screenContains("Work board"); await capture("board"); check("Board renders real host lanes", true);
  await input("3"); await screenContains("Decision inbox"); await capture("inbox"); check("Inbox renders a persistent question", true);
  await input("/界 привет draft"); await screenContains("界 привет draft");
  await input(escape); await input("1"); await input("/"); await screenContains("界 привет draft"); check("Unicode coordinator draft survives layout switch", true);
  await input("\u0015"); await input(escape); await input("3");
  await input("a"); await screenContains("Answer the coordinator"); await input("\r");
  const answered = await wait("durable question answer", async () => { const s = await snapshot(); const e = s.inbox.find(entry => entry.id === question.id); return e?.result ? e : null; });
  check("Question answer reaches the real host", answered.result?.text === "Short");
  await wait("coordinator answers in its own conversation", async () => { const s = await snapshot(); return !s.busy && s.messages.some(message => message.role === "assistant" && message.text.trim() === "UI_ACK") ? s : null; });
  await input("m"); await screenContains("Coordinator conversation"); await screenContains("UI_ACK"); await capture("conversation"); check("Coordinator replies are available on demand inside Pi", true);
  await input("e"); await input("\r"); await screenContains(proof); await capture("evidence"); check("Captured evidence is read from hash-checked storage", true);
  await input(escape); await input("n"); await input(`${escape}[B`); await input("\t"); await input(`${escape}[6~`); await capture("notes-scrolled");
  const noteScreen = (await command({ kind: "screen" })).join("\n"); check("Long notes scroll inside the inspector", noteScreen.includes("Note line 20") || noteScreen.includes("Note line 25") || noteScreen.includes("Note line 30"));
  check("External terminal control sequences never reach the terminal", !readFileSync(join(dir, "terminal.ansi"), "utf8").includes("UNSAFE_TITLE"));
  await command({ kind: "resize", rows: 22, columns: 55 }); await sleep(300); await capture("narrow");
  check("Narrow terminal preserves back/close controls", (await command({ kind: "screen" })).join("\n").includes("Esc close"));
  await command({ kind: "resize", rows: 42, columns: 140 }); await sleep(300);
  await input(escape); await input("1"); await input("w"); await input("/");
  const task = `Implement a proof artifact: read expected.txt and write proof.txt with its exact value. In the worker process, execute bash sleep 35 to leave a steering window, then run node verify.mjs, capture verification.json with projects_evidence, add shared note TUI_WORKER_DONE, and report the exit status. Do not create unit tests or publish. When the result is ready, inspect it and reply TUI_PROVED. No clarification needed.`;
  await input(task + "\r");
  const working = await wait("live worker", async () => { const s = await snapshot(); return s.activeRuns[0] ? s : null; });
  const run = working.activeRuns[0]; assert.ok(run);
  await input(escape); await input("1"); await selectWorker(run.id); await input("s"); await screenContains("Steer worker");
  await input("Keep the verification evidence repeatable. Add a note TUI_STEER_RECEIVED if this instruction arrives before completion.\r"); await screenContains("Instruction recorded by the host"); check("Steering is sent through the real worker control path", true);
  await input("t"); await screenContains("Worker transcript"); await capture("transcript"); check("Transcript is human-readable, not raw worker JSON", true); await input(escape);
  await input("x"); await screenContains("Stop this worker?"); await input("\r");
  check("Default stop confirmation leaves the worker running", (await snapshot()).activeRuns.some(active => active.id === run.id));
  const completed = await wait("worker proof and review", async () => { const s = await snapshot(); return !s.busy && s.activeRuns.length === 0 && s.evidence.length >= 2 && s.inbox.some(entry => entry.kind === "review" && !entry.result) ? s : null; });
  check("Coordinator and worker produce real verification evidence", readFileSync(join(workspace, "proof.txt"), "utf8").trim() === proof && completed.notes.some(note => note.text.includes("TUI_WORKER_DONE")));
  const review = completed.inbox.find(entry => entry.kind === "review" && !entry.result); assert.ok(review);
  await input("3"); await input("i"); await screenContains("review · complete"); await input("v"); await screenContains("Accept this result?"); await input("\r");
  check("Default review confirmation does not accept the result", !(await snapshot()).inbox.find(entry => entry.id === review.id)?.result);
  await input("v"); await input(`${escape}[B`); await input("\r");
  await wait("accepted review", async () => (await snapshot()).inbox.find(entry => entry.id === review.id)?.result ?? null);
  check("Confirmed review acceptance is durable", true);
  await request({ action: "delegate", id, role: "worker", task: "Execute bash sleep 90, then report STOP_FIXTURE_DONE. Do not edit files, create tests, or publish." });
  const stopping = await wait("second worker active", async () => (await snapshot()).activeRuns[0] ?? null);
  await input("1"); await selectWorker(stopping.id); await input("x"); await screenContains("Stop this worker?"); await input(`${escape}[B`); await input("\r");
  await wait("worker stopped", async () => (await snapshot()).activeRuns.length === 0);
  check("Confirmed stop ends a real native worker", true);
  await input("/Retain this unsent draft"); await input(escape);
  const before = parse(Type.Object({ pid: Type.Number() }), await health()); process.kill(before.pid, "SIGKILL");
  await screenContains("Disconnected:"); await capture("disconnected");
  await input("r"); await wait("host restarted", async () => { try { const h = parse(Type.Object({ pid: Type.Number() }), await health()); return h.pid !== before.pid; } catch { return false; } }, 30000);
  await input("/"); await screenContains("Retain this unsent draft"); check("Host reconnect retains unsent text without replay", !(await snapshot()).jobs.some(job => job.text === "Retain this unsent draft"));
  await input(escape); await input(escape); await sleep(300);
  check("Closing the overlay leaves the host running", !!(await health()));
  await input("/projects-inbox\r"); await screenContains("Decision inbox"); check("A closed native screen can reopen", true); await capture("reopened");
  await input(escape);
  await wait("coordinator idle before teardown", async () => { const s = await snapshot(); return !s.busy ? s : null; });
  const final = await snapshot();
  saveJson(join(dir, "report.json"), { ok: true, checks, proof, projectId: id, tuiMode, terminal: "terminal.ansi", captures: ["default-inbox", "desk", "board", "inbox", "conversation", "evidence", "notes-scrolled", "narrow", "transcript", "disconnected", "reopened"].map(name => `${name}.txt`), repeat: `cd /Users/nikitarat/.pi/agent/projects-mvp && PI_PROJECTS_E2E_TUI_MODE=${tuiMode} npm run e2e:tui`, snapshot: final });
  process.stdout.write(`${dir}/report.json\n`);
} catch (error) { saveJson(join(dir, "failure.json"), { error: error instanceof Error ? error.stack : String(error), checks }); throw error; }
finally {
  terminal?.stdin.end(JSON.stringify({ kind: "close" }) + "\n");
  if (terminal) await Promise.race([new Promise(resolve => terminal?.once("exit", resolve)), sleep(15000)]);
  try {
    if (id) for (const run of (await snapshot()).activeRuns) await request({ action: "control", id, run: run.id, operation: "stop" }, false);
    await request({ action: "shutdown" }, false);
  } catch { /* The isolated host may already be stopped. */ }
}
