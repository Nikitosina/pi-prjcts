import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { request, health } from "../src/client.ts";
import { addNote, projectDir } from "../src/state.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "artifacts", `knowledge-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.PI_PROJECTS_HOME = join(dir, "state");
const checks = [];
const marker = randomUUID();
const topicSecret = `TOPIC_ONLY_${randomUUID()}`;
const legacySecret = `LEGACY_ONLY_${randomUUID()}`;
const preferenceSecret = `PREFERENCE_ONLY_${randomUUID()}`;
let id;
function save(name, data) { writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + "\n"); }
function check(name, value) { assert.ok(value, name); checks.push(name); save("assertions.json", checks); process.stderr.write(`PASS ${name}\n`); }
async function wait(name, read, timeout = 240000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(300); }
  throw new Error(`Timed out: ${name}`);
}
async function state() { const s = await request({ action: "show", id }); save("latest.json", s); return s; }
async function idle() { return wait("coordinator idle", async () => { const s = await state(); return !s.busy && !s.jobs.some(j => ["queued", "running"].includes(j.state)) ? s : null; }); }
async function read(path) { return request({ action: "knowledge-read", id, path }); }
async function write(path, text, revision) { return request({ action: "knowledge-write", id, path, text, expectedRevision: revision }); }
function fixtureProcess(code, input, readyMarker) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(input)], { env: process.env });
  let stdout = "", stderr = "", finished = false;
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes(readyMarker)) markReady(); });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => { finished = true; markReady(); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, ready, done, finished: () => finished };
}
async function rejected(name, action) {
  let error;
  try { await action(); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  check(name, !!error); save(`denial-${checks.length}.json`, { name, error });
}

try {
  mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
  const promptDir = join(dir, "prompts"); mkdirSync(promptDir);
  writeFileSync(join(workspace, ".pi", "extensions", "prompt-proof.ts"), `import fs from 'node:fs';\nexport default function(pi) { pi.on('agent_start', (_event,ctx) => fs.writeFileSync(${JSON.stringify(promptDir)} + '/' + ctx.sessionManager.getSessionId() + '.json', JSON.stringify({sessionFile:ctx.sessionManager.getSessionFile(),prompt:ctx.getSystemPrompt()}))); }\n`);
  const project = await request({ action: "create", name: "Knowledge E2E", cwd: workspace, objective: "Only bounded knowledge verification in this disposable workspace. Do not publish or create unit tests." });
  id = project.id;
  const legacy = addNote(projectDir(id), "fixture", legacySecret);
  const originalFiles = readdirSync(join(projectDir(id), "notes"));
  const originals = new Map(originalFiles.map(name => [name, readFileSync(join(projectDir(id), "notes", name), "utf8")]));
  const files = await request({ action: "knowledge-list", id });
  check("Knowledge API initializes structured files", files.some(file => file.path === "MEMORY.md") && files.some(file => file.path === "preferences.md"));
  let memory = await read("MEMORY.md");
  check("Initial memory index is within the character limit", [...memory.text].length <= 3000);
  memory = await write("MEMORY.md", memory.text + `\nIndex fixture: ${marker}\n`, memory.revision);
  check("Managed writes save a new revision", memory.revision && memory.text.includes(marker));
  const preferences = await read("preferences.md");
  await write("preferences.md", `# Preferences\n${preferenceSecret}\n`, preferences.revision);
  const topic = await write("runbooks/verification.md", `# Verification\n${topicSecret}\n`, null);
  await rejected("Oversized ASCII memory is rejected", () => write("MEMORY.md", "x".repeat(3001), memory.revision));
  await rejected("Oversized Unicode memory is rejected", () => write("MEMORY.md", "界".repeat(3001), memory.revision));
  const astral = "😀".repeat(1501);
  let emoji = await write("MEMORY.md", astral, memory.revision);
  check("Memory counts Unicode characters rather than UTF-16 units", [...emoji.text].length === 1501);
  memory = await write("MEMORY.md", memory.text, emoji.revision);
  await rejected("Traversal cannot edit unrelated files", () => write("../escape.md", "bad", null));
  await rejected("Absolute paths cannot edit unrelated files", () => write(join(dir, "escape.md"), "bad", null));
  mkdirSync(join(dir, "outside"));
  symlinkSync(join(dir, "outside"), join(projectDir(id), "knowledge", "research", "outside"));
  await rejected("Symlink escape is rejected", () => write("research/outside/escape.md", "bad", null));
  const escape = join(dir, "outside", "escape.md"); writeFileSync(escape, "PRESERVE_OUTSIDE");
  symlinkSync(escape, join(projectDir(id), "knowledge", "research", "escape.md"));
  await rejected("Valid topic path cannot read a symlink target", () => read("research/escape.md"));
  await rejected("Valid topic path cannot overwrite a symlink target", () => write("research/escape.md", "bad", null));
  const knowledgeRoot = join(projectDir(id), "knowledge");
  renameSync(knowledgeRoot, knowledgeRoot + "-backup"); symlinkSync(join(dir, "outside"), knowledgeRoot);
  await rejected("Knowledge root itself cannot be a symlink", () => read("MEMORY.md"));
  unlinkSync(knowledgeRoot); renameSync(knowledgeRoot + "-backup", knowledgeRoot);
  const control = join(knowledgeRoot, ".knowledge");
  renameSync(control, control + "-backup"); symlinkSync(join(dir, "outside"), control);
  await rejected("Knowledge control directory cannot be a symlink", () => read("MEMORY.md"));
  unlinkSync(control); renameSync(control + "-backup", control);
  const lockDatabase = join(control, "writer.sqlite");
  renameSync(lockDatabase, lockDatabase + "-backup"); symlinkSync(escape, lockDatabase);
  await rejected("Native lock database cannot be a symlink", () => read("MEMORY.md"));
  unlinkSync(lockDatabase); renameSync(lockDatabase + "-backup", lockDatabase);
  const lockJournal = lockDatabase + "-journal";
  symlinkSync(escape, lockJournal);
  await rejected("Native lock journal cannot be a symlink", () => read("MEMORY.md"));
  unlinkSync(lockJournal);
  check("Symlink denials preserve external bytes and directories", readFileSync(escape, "utf8") === "PRESERVE_OUTSIDE" && !existsSync(join(dir, "outside", ".knowledge")));
  const racing = await Promise.allSettled([
    write(topic.path, `# Candidate A\n${topicSecret}\n`, topic.revision),
    write(topic.path, `# Candidate B\n${topicSecret}\n`, topic.revision),
  ]);
  check("Concurrent writes do not silently overwrite each other", racing.filter(x => x.status === "fulfilled").length === 1 && racing.filter(x => x.status === "rejected").length === 1);
  await rejected("Stale human revision is rejected", () => write(topic.path, "stale", topic.revision));
  const history = await request({ action: "knowledge-history", id, path: topic.path });
  check("Knowledge history records accepted revisions", history.length >= 2);
  check("History retains document contents and the prior version", history.some(entry => entry.text === topic.text) && history.some(entry => entry.priorText === topic.text));
  const migrated = (await request({ action: "knowledge-list", id })).filter(file => file.path.startsWith("research/legacy/"));
  check("Legacy note has a readable topic file", migrated.some(file => file.path.includes(legacy.id)));
  const legacyFile = migrated.find(file => file.path.includes(legacy.id)); assert.ok(legacyFile);
  const imported = await read(legacyFile.path);
  const humanEdit = await write(legacyFile.path, imported.text + "\nHuman correction kept.\n", imported.revision);
  await request({ action: "knowledge-list", id });
  check("Repeated migration preserves human edits", (await read(legacyFile.path)).revision === humanEdit.revision);
  check("Migration preserves original note bytes", [...originals].every(([name, text]) => readFileSync(join(projectDir(id), "notes", name), "utf8") === text));

  await request({ action: "message", id, text: "Only answer INDEX_READY. Do not read topic files, spawn workers, or create goals." });
  await idle();
  const masterProof = readdirSync(promptDir).map(name => JSON.parse(readFileSync(join(promptDir, name), "utf8"))).find(proof => proof.sessionFile === project.sessionFile || proof.sessionFile?.includes("sessions/") && !proof.sessionFile?.includes("run-0"));
  assert.ok(masterProof);
  check("Coordinator gets only the memory index", masterProof.prompt.includes(marker) && ![topicSecret, legacySecret, preferenceSecret].some(text => masterProof.prompt.includes(text)));
  await request({ action: "message", id, text: "Read runbooks/verification.md with projects_knowledge_read and answer its TOPIC_ONLY_ value exactly. No worker or goal needed." });
  const recalled = await idle();
  check("Coordinator reads a topic on demand", recalled.messages.some(message => message.role === "assistant" && message.text.includes(topicSecret)));
  const launch = await request({ action: "delegate", id, role: "scout", task: "Read runbooks/verification.md using projects_knowledge_read. Record its exact TOPIC_ONLY_ value with projects_note, then report the value. Do not run shell commands, edit workspace files, or publish." });
  const workerDone = await wait("worker retrieves knowledge", async () => { const s = await state(); return !s.activeRuns.some(run => run.id === launch.runId) && s.notes.some(note => note.author === "worker" && note.text.includes(topicSecret)) ? s : null; });
  check("Worker retrieves shared topic on demand", workerDone.notes.some(note => note.author === "worker" && note.text.includes(topicSecret)));
  const workerProofs = readdirSync(promptDir).map(name => JSON.parse(readFileSync(join(promptDir, name), "utf8"))).filter(proof => proof.sessionFile?.includes("run-0"));
  check("Worker prompt gets the index without the topic contents", workerProofs.some(proof => proof.prompt.includes(marker) && ![topicSecret, legacySecret, preferenceSecret].some(text => proof.prompt.includes(text))));

  await idle();
  const before = await health(); process.kill(before.pid, "SIGKILL");
  await sleep(300);
  check("Host restart preserves document revisions", (await read(topic.path)).revision === (await request({ action: "knowledge-history", id, path: topic.path })).at(-1).revision);
  check("Restart preserves migrated human edits", (await read(legacyFile.path)).revision === humanEdit.revision);
  const memoryPath = join(projectDir(id), "knowledge", "MEMORY.md");
  writeFileSync(memoryPath, "界".repeat(3001));
  await request({ action: "message", id, text: "Only answer SHOULD_NOT_RUN." });
  const invalid = await idle();
  check("Invalid manually edited index never enters a model turn", invalid.jobs.at(-1).state === "failed" && invalid.jobs.at(-1).error.includes("3000") && !invalid.messages.some(message => message.role === "assistant" && message.text.includes("SHOULD_NOT_RUN")));
  const current = await read("MEMORY.md");
  await write("MEMORY.md", memory.text, current.revision);
  check("Human can repair an invalid index through the API", (await read("MEMORY.md")).text === memory.text);
  await rejected("Invalid index prevents launching a worker", async () => {
    writeFileSync(memoryPath, "x".repeat(3001));
    try { await request({ action: "delegate", id, role: "scout", task: "Only answer SHOULD_NOT_RUN." }); }
    finally { writeFileSync(memoryPath, memory.text); }
  });

  // Disk fixtures use an actual accepted transaction to reproduce both crash
  // boundaries. Assertions exercise the real host recovery, not a mock store.
  await idle();
  const transaction = history.at(-1); assert.ok(transaction.priorText !== null);
  const journalPath = join(projectDir(id), "knowledge", ".knowledge", "journal.json");
  const topicPath = join(projectDir(id), "knowledge", topic.path);
  process.kill((await health()).pid, "SIGKILL"); await sleep(300);
  writeFileSync(topicPath, transaction.priorText); writeFileSync(journalPath, JSON.stringify(transaction));
  const recovered = await read(topic.path);
  check("Restart completes a prepared journal and preserves history", recovered.revision === transaction.revision && !existsSync(journalPath) && (await request({ action: "knowledge-history", id, path: topic.path })).some(entry => entry.id === transaction.id && entry.priorText === transaction.priorText));
  process.kill((await health()).pid, "SIGKILL"); await sleep(300);
  const interrupted = { ...transaction, id: randomUUID() };
  writeFileSync(topicPath, "HUMAN_CONFLICT_WINS"); writeFileSync(journalPath, JSON.stringify(interrupted));
  const preserved = await read(topic.path);
  check("Recovery never overwrites a conflicting human edit", preserved.text === "HUMAN_CONFLICT_WINS");
  const conflictPath = join(projectDir(id), "knowledge", ".knowledge", "conflicts", interrupted.id + ".json");
  check("Conflicting interrupted write remains recoverable", existsSync(conflictPath) && JSON.parse(readFileSync(conflictPath, "utf8")).text === transaction.text && !existsSync(journalPath));
  const lockCode = `import {DatabaseSync} from 'node:sqlite'; const input=JSON.parse(process.argv[1]); const db=new DatabaseSync(input.path); db.exec('BEGIN IMMEDIATE'); console.log('LOCK_READY'); setInterval(()=>{},1000);`;
  const writerCode = `const input=JSON.parse(process.argv[1]); const {writeKnowledge}=await import(input.module); console.log('WRITE_READY'); try { const value=await writeKnowledge(input.write); console.log(JSON.stringify({ok:true,value})); } catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }`;
  const holder = fixtureProcess(lockCode, { path: join(projectDir(id), "knowledge", ".knowledge", "writer.sqlite") }, "LOCK_READY");
  await holder.ready;
  const pendingText = "PREPARED_NATIVE_LOCK_RECOVERY";
  const pendingRevision = createHash("sha256").update(pendingText).digest("hex");
  const pending = { ...transaction, id: randomUUID(), text: pendingText, revision: pendingRevision, priorText: preserved.text, priorRevision: preserved.revision, size: Buffer.byteLength(pendingText), updatedAt: new Date().toISOString() };
  writeFileSync(journalPath, JSON.stringify(pending));
  const contenders = ["A", "B"].map(actor => fixtureProcess(writerCode, {
    module: new URL("../src/knowledge.ts", import.meta.url).href,
    write: { dir: projectDir(id), path: topic.path, text: `Process ${actor}`, expectedRevision: pendingRevision, author: `fixture-${actor}` },
  }, "WRITE_READY"));
  try {
    await Promise.all(contenders.map(process => process.ready)); await sleep(50);
    check("Separate-process writers wait for the live native lock", !holder.finished() && contenders.every(process => !process.finished()));
  } finally { holder.child.kill("SIGKILL"); await holder.done; }
  const processReceipts = await Promise.all(contenders.map(process => process.done));
  save("process-lock-receipts.json", processReceipts);
  const outcomes = processReceipts.map(receipt => {
    assert.equal(receipt.code, 0, receipt.stderr);
    return JSON.parse(receipt.stdout.trim().split("\n").at(-1));
  });
  check("SIGKILL releases the lock without stale-owner deletion", outcomes.some(outcome => outcome.ok));
  check("Separate-process writes accept exactly one matching revision", outcomes.filter(outcome => outcome.ok).length === 1 && outcomes.some(outcome => !outcome.ok && /revision conflict/i.test(outcome.error)));
  check("Native lock recovery restores the prepared journal", !existsSync(journalPath) && (await request({ action: "knowledge-history", id, path: topic.path })).some(entry => entry.id === pending.id && entry.priorText === preserved.text));
  check("Final document matches the sole process winner", (await read(topic.path)).revision === outcomes.find(outcome => outcome.ok).value.revision);
  save("report.json", { ok: true, checks, projectId: id, marker, topicSecret, promptEvidence: "prompts/", repeat: "cd /Users/nikitarat/.pi/agent/projects-mvp && npm run e2e:knowledge" });
  process.stdout.write(`${dir}/report.json\n`);
} catch (error) {
  save("failure.json", { error: error instanceof Error ? error.stack : String(error), checks }); throw error;
} finally {
  try {
    if (id) for (const run of (await state()).activeRuns) await request({ action: "control", id, run: run.id, operation: "stop" }, false);
    await request({ action: "shutdown" }, false);
  } catch { /* The isolated host may already be stopped. */ }
}
