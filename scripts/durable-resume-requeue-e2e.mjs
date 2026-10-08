#!/usr/bin/env node
// Failure inventory, written before implementation:
// F1 resume clears paused but pause-interrupted work stays "interrupted" and never runs again.
// F2 resumed work runs on a new thread/conversation or a different worktree instead of its own.
// F3 the retry reuses the aborted submission requestId, so Durable returns the old aborted answer and the work is interrupted again.
// F4 the scoped frozen-profile or binding-revision check rejects the retry ("no longer matches", "Session is poisoned").
// F5 explicitly stopped work restarts on resume.
// F6 a dependent of pause-interrupted work stays interrupted/blocked and never runs.
// F7 host restart (close + reopen without pause) leaves aborted work interrupted after resume.
// F8 runtime reports a poisoned session during pause/resume.
// Model-free: a local OpenAI-compatible fake provider answers "done" and can hold requests open.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.PI_PACKAGE_DIR) throw new Error("Run from a parent shell: PI_PACKAGE_DIR is set");
const artifacts = resolve(`artifacts/durable-resume-requeue-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const requestedRoot = join(tmpdir(), `durable-resume-requeue-${randomUUID()}`);
mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
const root = realpathSync(requestedRoot);
const checks = [], reports = [], modelCalls = [], held = new Set();
const pass = (name, evidence) => { checks.push({ name, evidence }); process.stderr.write(`PASS ${name}\n`); };
const save = (name, value) => writeFileSync(join(artifacts, name), JSON.stringify(value, null, 2) + "\n");
const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let hold = true;

function answer(response) {
  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`);
}
const server = createServer((request, response) => {
  let body = "";
  request.on("data", data => { body += data; });
  request.on("end", () => {
    const marker = /MARK-[A-Z0-9]+/.exec(body)?.[0] ?? "none";
    const call = { at: Date.now(), marker, resumed: body.includes("paused and has resumed"), held: hold };
    modelCalls.push(call);
    if (!hold) return answer(response);
    held.add(response);
    response.on("close", () => { held.delete(response); call.closedWhileHeld = true; });
  });
});
await new Promise(ok => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "fake-key", api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }] } } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECTS_HOME = join(root, "home");
process.env.PI_OFFLINE = "1";

const [{ openDurableProject }, { projectDir, saveProject }, { grantWholeRepository }] = await Promise.all([import("../src/durable-runtime.ts"), import("../src/state.ts"), import("../src/workspace-authorization.ts")]);
const skills = { getSkills: () => ({ skills: [], diagnostics: [] }) };
const runtimes = [];
const until = async (label, probe, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await probe(); if (value) return value; await sleep(100); } throw new Error(`timeout: ${label}`); };

function fixtureProject(name) {
  const owner = join(root, name, "owner"); mkdirSync(owner, { recursive: true });
  git(owner, "init", "-b", "main"); git(owner, "config", "user.email", "e2e@example.invalid"); git(owner, "config", "user.name", "E2E");
  writeFileSync(join(owner, "README.md"), "base\n"); git(owner, "add", "."); git(owner, "commit", "-m", "base");
  const model = "fake/fake-model";
  const base = { version: 1, id: randomUUID(), runtime: "durable", name, cwd: owner, objective: "resume fixture", createdAt: new Date().toISOString(), model, models: { worker: model, scout: model, reviewer: model }, sessionFile: null, phase: "ready", problem: null, runs: [] };
  const { project, scope } = grantWholeRepository(base, join(root, name, "worktrees"));
  saveProject(project);
  return { project, scope };
}
async function open(project) {
  const runtime = await openDurableProject({ project, dir: projectDir(project.id), workerCap: 2, configuredSkillLoader: skills, onReport: report => reports.push({ project: project.name, ...report, text: JSON.stringify(report) }), onModelRequest: request => modelCalls.push({ at: Date.now(), conversationId: request.conversationId, coordinator: JSON.stringify(request.messages).includes("persistent coordinator"), marker: /MARK-[A-Z0-9]+/.exec(JSON.stringify(request.messages))?.[0] ?? "none", observed: true }) });
  runtimes.push(runtime);
  return runtime;
}
const byId = (snapshot, id) => snapshot.work.find(work => work.id === id);
const conversationsFor = marker => [...new Set(modelCalls.filter(call => call.observed && !call.coordinator && call.marker === marker).map(call => call.conversationId))];

let failure = null;
try {
  // Scenario 1: pause mid-work, then resume.
  {
    const { project, scope } = fixtureProject("pause");
    const runtime = await open(project);
    const a = { id: randomUUID(), threadId: randomUUID(), role: "worker", workspaceScopeId: scope.id, text: "MARK-A edit the repo" };
    const b = { id: randomUUID(), threadId: randomUUID(), role: "worker", dependsOn: [a.id], text: "MARK-B follow A" };
    const c = { id: randomUUID(), threadId: randomUUID(), role: "worker", text: "MARK-C to be stopped" };
    await runtime.plan({ work: [a, b, c] });
    await until("A and C model requests held", () => held.size >= 2 && conversationsFor("MARK-A").length && conversationsFor("MARK-C").length);
    await runtime.stop(c.threadId);
    const running = await runtime.planSnapshot();
    save("pause-running.json", running);
    const cwdBefore = byId(running, a.id).attempt.cwd;
    const paused = await runtime.pausePlan();
    save("pause-paused.json", paused);
    assert.equal(paused.paused, true);
    assert.equal(byId(paused, a.id).status, "interrupted"); assert.equal(byId(paused, a.id).blocker, "Interrupted by project pause");
    assert.equal(byId(paused, b.id).status, "interrupted");
    assert.equal(byId(paused, c.id).status, "stopped");
    pass("pause interrupts running scoped work and queued dependent; stopped work stays stopped", { a: byId(paused, a.id).blocker, b: byId(paused, b.id).blocker, c: byId(paused, c.id).blocker });
    hold = false;
    const resumed = await runtime.resumePlan();
    save("pause-resumed.json", resumed);
    assert.equal(resumed.paused, false);
    assert.ok(["queued", "running", "completed"].includes(byId(resumed, a.id).status), byId(resumed, a.id).status);
    assert.ok(["queued", "running", "completed"].includes(byId(resumed, b.id).status), byId(resumed, b.id).status);
    pass("F1/F6 resume re-queues pause-interrupted work and its dependent", { a: byId(resumed, a.id).status, b: byId(resumed, b.id).status });
    const done = await until("A and B completed", async () => { const snapshot = await runtime.planSnapshot(); if ([a, b].some(work => ["failed", "blocked", "stopped"].includes(byId(snapshot, work.id).status))) throw new Error(JSON.stringify(snapshot.work)); return [a, b].every(work => byId(snapshot, work.id).status === "completed") ? snapshot : null; });
    save("pause-done.json", done);
    pass("F3/F4 resumed scoped work and dependent complete with the fake model", done.work.map(work => [work.text, work.status]));
    assert.equal(byId(done, a.id).threadId, a.threadId);
    assert.equal(byId(done, a.id).attempt.cwd, cwdBefore);
    assert.equal(conversationsFor("MARK-A").length, 1, JSON.stringify(conversationsFor("MARK-A")));
    assert.ok(modelCalls.some(call => call.marker === "MARK-A" && call.resumed && !call.held));
    pass("F2 resumed work keeps its thread, conversation and worktree", { cwd: cwdBefore, conversations: conversationsFor("MARK-A") });
    assert.equal(byId(done, c.id).status, "stopped");
    assert.ok(!modelCalls.some(call => call.marker === "MARK-C" && !call.held && !call.observed));
    pass("F5 explicitly stopped work is not restarted by resume", byId(done, c.id).blocker);
    await runtime.close();
  }
  // Scenario 2: host restart while work is running, then resume.
  {
    hold = true;
    const { project, scope } = fixtureProject("restart");
    let runtime = await open(project);
    const d = { id: randomUUID(), threadId: randomUUID(), role: "worker", workspaceScopeId: scope.id, text: "MARK-D survive restart" };
    await runtime.plan({ work: [d] });
    await until("D model request held", () => held.size >= 1 && conversationsFor("MARK-D").length);
    const cwdBefore = byId(await runtime.planSnapshot(), d.id).attempt.cwd;
    await runtime.close();
    runtime = await open(project);
    const reopened = await runtime.planSnapshot();
    save("restart-reopened.json", reopened);
    assert.equal(reopened.paused, true);
    assert.equal(byId(reopened, d.id).status, "interrupted"); assert.equal(byId(reopened, d.id).blocker, "Interrupted by project pause");
    pass("restart recovery pauses the project and marks running work pause-interrupted", byId(reopened, d.id).blocker);
    hold = false;
    await runtime.resumePlan();
    const done = await until("D completed", async () => { const snapshot = await runtime.planSnapshot(); if (["failed", "blocked", "stopped"].includes(byId(snapshot, d.id).status)) throw new Error(JSON.stringify(snapshot.work)); return byId(snapshot, d.id).status === "completed" ? snapshot : null; });
    save("restart-done.json", done);
    assert.equal(byId(done, d.id).attempt.cwd, cwdBefore);
    assert.equal(conversationsFor("MARK-D").length, 1);
    pass("F7 work aborted by host restart completes after resume on the same thread and worktree", { cwd: cwdBefore });
    await runtime.close();
  }
  const poisoned = reports.filter(report => /poison/i.test(report.text));
  assert.equal(poisoned.length, 0, JSON.stringify(poisoned));
  pass("F8 no poisoned-session reports", { reports: reports.length });
} catch (error) {
  failure = error;
} finally {
  for (const runtime of runtimes) await runtime.close().catch(() => {});
  for (const response of held) response.destroy();
  server.close();
  save("model-calls.json", modelCalls);
  save("reports.json", reports);
  save("report.json", { checks, failure: failure ? String(failure.stack ?? failure) : null, root });
}
if (failure) { console.error(failure); process.exit(1); }
console.log(`artifacts ${artifacts}`);
console.log(`PASS ${checks.length} checks`);
process.exit(0);
