import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// Failure cases recorded before execution: Unicode index admission; prompt leakage;
// unsafe path/symlink traversal; read-only coordinator write; stale/concurrent CAS; history
// byte loss; migration overwrite; restart loss; and SQLite contention/SIGKILL release.
const root = resolve("artifacts", `durable-knowledge-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const sourceRoot = resolve(process.env.PI_DURABLE_E2E_SOURCE_ROOT ?? new URL("..", import.meta.url).pathname);
const source = name => pathToFileURL(join(sourceRoot, "src", name)).href;
const fixture = join(root, "fixture-source"), state = join(root, "state"), workspace = join(root, "workspace");
process.env.PI_PROJECTS_HOME = state;
mkdirSync(fixture, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const checks = [], requests = [], reports = [], ownedChildren = new Set();
const topic = `TOPIC_${randomUUID()}`, preference = `PREFERENCE_${randomUUID()}`, legacyText = `LEGACY_${randomUUID()}`, marker = `INDEX_${randomUUID()}`;
const credentialPattern = /(authorization|api[-_ ]?key|bearer|token|secret|password)/i;
function save(name, value) { writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
function pass(name, condition = true) { assert.ok(condition, name); checks.push(name); save("assertions.json", checks); process.stderr.write(`PASS ${name}\n`); }
async function rejects(name, action) { await assert.rejects(action); pass(name); }
function rendered(value) { return typeof value === "string" ? value : JSON.stringify(value); }
function has(messages, value) { return rendered(messages).includes(value); }
function redactMessages(messages) {
  return messages.map(message => {
    const copy = JSON.parse(JSON.stringify(message));
    const redact = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) credentialPattern.test(key) ? value[key] = "[REDACTED]" : redact(child);
    };
    redact(copy);
    return copy;
  });
}
function requestEvents(conversationId) { return requests.filter(request => request.conversationId === conversationId); }
async function waitFor(read, name, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(250); }
  throw new Error(`Timed out waiting for ${name}`);
}
function child(code, input, readyMarker) {
  const childProcess = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(input)], { env: process.env });
  ownedChildren.add(childProcess);
  let stdout = "", stderr = "", exited = false, signalReady;
  const ready = new Promise(resolveReady => { signalReady = resolveReady; });
  childProcess.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes(readyMarker)) signalReady(); });
  childProcess.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise(resolveDone => childProcess.on("exit", (code, signal) => { exited = true; ownedChildren.delete(childProcess); signalReady(); resolveDone({ code, signal, stdout, stderr }); }));
  return { childProcess, ready, done, exited: () => exited };
}
async function boundedClose(value) { if (value) await Promise.race([value.close(), sleep(5000)]); }

let runtime;
try {
  const { openDurableProject } = await import(source("durable-runtime.ts"));
  const { addNote, notes, projectDir, saveProject } = await import(source("state.ts"));
  const { ensureKnowledge, historyKnowledge, readKnowledge, writeKnowledge } = await import(source("knowledge.ts"));
  const model = process.env.PI_DURABLE_E2E_MODEL ?? "openai-codex/gpt-5.6-terra";
  const makeProject = name => {
    const id = randomUUID(), dir = projectDir(id);
    const project = { version: 1, id, name, cwd: workspace, objective: "Disposable knowledge verification only; do not publish or execute workspace files.", createdAt: new Date().toISOString(), model, models: { worker: model, scout: model, reviewer: model }, sessionFile: null, phase: "ready", problem: null, runs: [] };
    saveProject(project);
    return { project, dir };
  };
  const observe = event => {
    assert.equal(typeof event.conversationId, "number", "observer has numeric conversationId");
    assert.ok(Array.isArray(event.messages), "observer has prepared request messages");
    const messages = redactMessages(event.messages);
    assert.ok(!/(sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9])/.test(JSON.stringify(messages)), "request artifact has no credential value");
    requests.push({ conversationId: event.conversationId, messages }); save("model-requests.json", requests);
  };
  const options = access => ({ knowledgeAccess: access, onModelRequest: observe, onReport: report => { reports.push(report); save("reports.json", reports); } });

  // This read-only project owns the index/prompt/worker and denial assertions.
  const primary = makeProject("Durable knowledge read-only E2E");
  addNote(primary.dir, "fixture", legacyText);
  const originalNoteBytes = new Map(readdirSync(join(primary.dir, "notes")).map(name => [name, readFileSync(join(primary.dir, "notes", name))]));
  await ensureKnowledge(primary.dir);
  const seed = await readKnowledge(primary.dir, "MEMORY.md");
  copyFileSync(join(primary.dir, "knowledge", "MEMORY.md"), join(fixture, "MEMORY.original.md"));
  let memory = await writeKnowledge({ dir: primary.dir, path: "MEMORY.md", text: `${seed.text}\n- ${marker}\n`, expectedRevision: seed.revision, author: "fixture" });
  await writeKnowledge({ dir: primary.dir, path: "preferences.md", text: `# Preferences\n${preference}\n`, expectedRevision: (await readKnowledge(primary.dir, "preferences.md")).revision, author: "fixture" });
  let document = await writeKnowledge({ dir: primary.dir, path: "research/topic.md", text: topic, expectedRevision: null, author: "fixture" });
  const note = notes(primary.dir).find(value => value.text === legacyText); assert.ok(note, "legacy fixture note exists");
  const legacy = await readKnowledge(primary.dir, `research/legacy/${note.id}.md`), legacyOriginal = legacy.text;
  copyFileSync(join(primary.dir, "knowledge", "research", "topic.md"), join(fixture, "topic.original.md"));
  const fullUnicodeIndex = await writeKnowledge({ dir: primary.dir, path: "MEMORY.md", text: "😀".repeat(3000), expectedRevision: memory.revision, author: "fixture" });
  pass("exactly 3000 astral code points are accepted", [...fullUnicodeIndex.text].length === 3000);
  memory = await writeKnowledge({ dir: primary.dir, path: "MEMORY.md", text: memory.text, expectedRevision: fullUnicodeIndex.revision, author: "fixture" });
  await rejects("Unicode MEMORY.md writes over 3000 code points fail", () => writeKnowledge({ dir: primary.dir, path: "MEMORY.md", text: "😀".repeat(3001), expectedRevision: memory.revision, author: "fixture" }));
  await rejects("knowledge traversal is rejected", () => writeKnowledge({ dir: primary.dir, path: "../outside.md", text: "no", expectedRevision: null, author: "fixture" }));
  const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(primary.dir, "knowledge", "research", "escape"));
  await rejects("knowledge symlink escape is rejected", () => writeKnowledge({ dir: primary.dir, path: "research/escape/x.md", text: "no", expectedRevision: null, author: "fixture" }));
  unlinkSync(join(primary.dir, "knowledge", "research", "escape"));

  runtime = await openDurableProject({ project: primary.project, dir: primary.dir, ...options("read-only") });
  await rejects("one durable owner per project is enforced", () => openDurableProject({ project: primary.project, dir: primary.dir, ...options("read-only") }));
  // beforeRequest observation is not provider-dispatch proof: guard evidence is the
  // unanswered result/report and absence of the prohibited completed assistant reply.
  writeFileSync(join(primary.dir, "knowledge", "MEMORY.md"), "😀".repeat(3001));
  let invalid;
  try { invalid = await runtime.say("Reply INVALID_SHOULD_NOT_RUN.", { requestId: "invalid-index" }); }
  catch (error) { invalid = { status: "unanswered", reason: error instanceof Error ? error.message : String(error) }; }
  const invalidView = await runtime.snapshot();
  const guardEvidence = [invalid.reason, invalid.text, ...reports.map(report => report.message)].filter(Boolean).join("\n");
  pass("oversized Unicode MEMORY.md records memory guard failure before unsafe reply", invalid.status === "unanswered" && /3000|MEMORY\.md/i.test(guardEvidence) && !invalidView.coordinator.messages.some(message => message.role === "assistant" && message.text.includes("INVALID_SHOULD_NOT_RUN")));
  const damaged = await readKnowledge(primary.dir, "MEMORY.md");
  memory = await writeKnowledge({ dir: primary.dir, path: "MEMORY.md", text: memory.text, expectedRevision: damaged.revision, author: "human-repair" });
  const initialRequestOffset = requests.length;
  const initial = await runtime.say("Reply only INDEX_READY. Do not read any document or delegate.", { requestId: "index" }); assert.equal(initial.status, "done");
  const masterId = (await runtime.snapshot()).identities.coordinatorConversationId;
  const firstMaster = requests.slice(initialRequestOffset).find(request => request.conversationId === masterId)?.messages ?? [];
  pass("coordinator initial prepared request is index-only", has(firstMaster, marker) && ![topic, preference, legacyText].some(value => has(firstMaster, value)));
  await runtime.say("Use projects_knowledge_read on research/topic.md and reply with its exact contents.", { requestId: "topic" });
  pass("coordinator retrieves topic only on demand", (await runtime.snapshot()).coordinator.messages.some(message => message.text.includes(topic)));
  await runtime.say("Use projects_knowledge_read on preferences.md and reply with its exact contents.", { requestId: "preferences" });
  pass("preferences are absent until demanded", !has(firstMaster, preference) && (await runtime.snapshot()).coordinator.messages.some(message => message.text.includes(preference)));
  const workerId = randomUUID(), workerThreadId = randomUUID(), workerRequestAt = requests.length;
  await runtime.plan({ work: [{ id: workerId, threadId: workerThreadId, role: "worker", text: "Read research/topic.md with projects_knowledge_read and report its exact text. Do not mutate anything." }] });
  const workerPlan = await waitFor(async () => { const view = await runtime.planSnapshot(); return view.work.some(work => work.id === workerId && work.status === "completed") ? view : null; }, "UUID worker topic retrieval");
  assert.equal(workerPlan.work.find(work => work.id === workerId)?.threadId, workerThreadId);
  const workerRequests = requests.slice(workerRequestAt).filter(request => request.conversationId !== masterId), firstWorker = workerRequests[0]?.messages ?? [];
  pass("UUID worker retrieves topic and its first prepared prompt is index-only", has(firstWorker, marker) && ![topic, preference, legacyText].some(value => has(firstWorker, value)) && workerRequests.some(request => has(request.messages, topic)));
  document = await writeKnowledge({ dir: primary.dir, path: document.path, text: `${topic}\nHUMAN_EDIT`, expectedRevision: document.revision, author: "human" });
  await runtime.say("Read research/topic.md and reply with the exact contents.", { requestId: "human-edit" });
  pass("human edit is visible on next request", (await runtime.snapshot()).coordinator.messages.some(message => message.text.includes("HUMAN_EDIT")));
  // Read-only gates workers only; the coordinator always maintains knowledge.
  await runtime.say("Call projects_knowledge_write for research/topic.md with text COORDINATOR_WRITE and its current revision. Do not retry.", { requestId: "readonly-coordinator-write" });
  const beforeDenied = await readKnowledge(primary.dir, document.path);
  pass("read-only scope still permits coordinator writes", beforeDenied.text === "COORDINATOR_WRITE");
  await boundedClose(runtime); runtime = undefined;

  // Maintain receives a distinct persisted conversation/project; changing an option
  // cannot retroactively alter a previously persisted thread's tool set.
  const maintainedProject = makeProject("Durable knowledge maintain E2E");
  await ensureKnowledge(maintainedProject.dir);
  const maintainedSeed = await writeKnowledge({ dir: maintainedProject.dir, path: "research/topic.md", text: "MAINTAIN_TOPIC", expectedRevision: null, author: "fixture" });
  runtime = await openDurableProject({ project: maintainedProject.project, dir: maintainedProject.dir, ...options("maintain") });
  await runtime.say("Read research/topic.md, then use projects_knowledge_write once with its returned revision to append MAINTAINED. Reply MAINTAINED.", { requestId: "maintain" });
  pass("distinct maintain scope permits revision-checked update", (await readKnowledge(maintainedProject.dir, maintainedSeed.path)).text.includes("MAINTAINED"));
  await boundedClose(runtime); runtime = undefined;

  const race = await Promise.allSettled([writeKnowledge({ dir: primary.dir, path: document.path, text: "A", expectedRevision: beforeDenied.revision, author: "A" }), writeKnowledge({ dir: primary.dir, path: document.path, text: "B", expectedRevision: beforeDenied.revision, author: "B" })]);
  pass("concurrent same-revision updates conflict", race.filter(value => value.status === "fulfilled").length === 1 && race.filter(value => value.status === "rejected").length === 1);
  const history = await historyKnowledge(primary.dir, document.path);
  pass("history retains full prior bytes", history.some(entry => entry.priorText === beforeDenied.text) && history.every(entry => typeof entry.text === "string"));
  const editedLegacy = await writeKnowledge({ dir: primary.dir, path: legacy.path, text: `${legacyOriginal}\nHUMAN_CORRECTION`, expectedRevision: legacy.revision, author: "human" });
  await ensureKnowledge(primary.dir);
  pass("migration preserves every original note byte", [...originalNoteBytes].every(([name, bytes]) => bytes.equals(readFileSync(join(primary.dir, "notes", name)))));
  pass("repeat migration preserves originals and human corrections", (await readKnowledge(primary.dir, legacy.path)).revision === editedLegacy.revision && notes(primary.dir).some(value => value.text === legacyText));
  runtime = await openDurableProject({ project: primary.project, dir: primary.dir, ...options("read-only") });
  await boundedClose(runtime); runtime = undefined;
  runtime = await openDurableProject({ project: primary.project, dir: primary.dir, ...options("read-only") });
  pass("restart preserves copied-fixture documents", (await readKnowledge(primary.dir, document.path)).text.length > 0 && existsSync(join(fixture, "topic.original.md")));
  await boundedClose(runtime); runtime = undefined;

  // Read before taking the fixture lock: readKnowledge calls ensureKnowledge,
  // which legitimately takes writer.sqlite itself.
  const lockRevision = (await readKnowledge(primary.dir, document.path)).revision;
  const db = join(primary.dir, "knowledge", ".knowledge", "writer.sqlite");
  const holder = child("import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(JSON.parse(process.argv[1]).db); db.exec('BEGIN IMMEDIATE'); console.log('READY'); setInterval(()=>{},1000)", { db }, "READY");
  await holder.ready;
  const writer = child("const x=JSON.parse(process.argv[1]); const {writeKnowledge}=await import(x.module); console.log('READY'); console.log(JSON.stringify(await writeKnowledge(x.input)))", { module: source("knowledge.ts"), input: { dir: primary.dir, path: document.path, text: "POST_SIGKILL", expectedRevision: lockRevision, author: "fixture" } }, "READY");
  await writer.ready; await sleep(50); pass("native SQLite contention blocks owned separate writer", !writer.exited());
  holder.childProcess.kill("SIGKILL"); await holder.done;
  const receipt = await writer.done; assert.equal(receipt.code, 0, receipt.stderr);
  pass("SIGKILL releases native SQLite lock", (await readKnowledge(primary.dir, document.path)).text === "POST_SIGKILL");
  save("report.json", { ok: true, checks, sourceRoot, artifacts: { root, requests: join(root, "model-requests.json"), fixture } });
  process.stdout.write(`${join(root, "report.json")}\n`);
} catch (error) {
  const failure = { ok: false, checks, sourceRoot, error: error instanceof Error ? error.stack : String(error), reports };
  save("failure.json", failure); save("report.json", failure);
  throw error;
} finally {
  await boundedClose(runtime);
  await Promise.all([...ownedChildren].map(async childProcess => { if (!childProcess.killed) childProcess.kill("SIGKILL"); await Promise.race([new Promise(resolveDone => childProcess.once("exit", resolveDone)), sleep(5000)]); }));
}
