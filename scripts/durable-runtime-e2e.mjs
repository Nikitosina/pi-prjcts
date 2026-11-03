import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FAKE_MODEL, startFakeModel } from "./fake-model.mjs";

// Failure cases: blocked admission, duplicate/replayed messages, lost identities,
// cross-project submission access, unsafe storage, ignored memory denial, hidden mutation.
const base = resolve("artifacts", `durable-runtime-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(base, { recursive: true });
const fake = await startFakeModel(base); // offline: private SDK home with only the fake model
process.env.PI_PROJECTS_HOME = join(base, "state");
const { openDurableProject, durableReport } = await import("../src/durable-runtime.ts");
const { projectDir, saveProject, notes } = await import("../src/state.ts");
const { readKnowledge, writeKnowledge } = await import("../src/knowledge.ts");
const { durableHostActivity } = await import("../src/durable-host.ts");
const id = randomUUID(),
  dir = projectDir(id),
  workspace = join(base, "workspace");
mkdirSync(workspace, { recursive: true });
const model = FAKE_MODEL;
const project = {
  version: 1,
  id,
  runtime: "durable",
  name: "Runtime E2E",
  cwd: workspace,
  objective: "Verify local durable conversations safely",
  createdAt: new Date().toISOString(),
  model,
  models: { worker: model, scout: model, reviewer: model },
  sessionFile: null,
  phase: "ready",
  problem: null,
  runs: [],
};
saveProject(project);
const checks = [],
  diagnostics = [],
  modelRequests = [];
let runtime,
  workerContextSawSecret = false;
function pass(name) {
  checks.push(name);
  process.stderr.write(`PASS ${name}\n`);
}
async function open() {
  return openDurableProject({
    project,
    dir,
    onReport: (value) => diagnostics.push(value),
    onModelRequest: (value) => {
      modelRequests.push(JSON.stringify(value.messages));
      if (secretForWorkerContext && JSON.stringify(value.messages).includes(secretForWorkerContext)) workerContextSawSecret = true;
    },
  });
}
async function until(predicate, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const view = await runtime.snapshot();
    writeFileSync(join(base, "latest.json"), JSON.stringify(view, null, 2));
    if (await predicate(view)) return view;
    await sleep(500);
  }
  throw new Error("Timed out waiting for runtime state");
}
async function spawnWorker(text, requestId) {
  const spawned = await runtime.spawn(undefined, { role: "worker", title: "Probe", acceptance: ["Done"], brief: text, requestId });
  assert.ok(spawned.id, spawned.text);
  return spawned.id;
}
async function untilSettled(jobId, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const view = await runtime.jobs();
    writeFileSync(join(base, "latest-jobs.json"), JSON.stringify(view, null, 2));
    const job = view.jobs.find((item) => item.id === jobId);
    if (job && job.status !== "running") return job;
    await sleep(500);
  }
  throw new Error("Timed out waiting for the Job to settle");
}
let secretForWorkerContext;
try {
  runtime = await open();
  await assert.rejects(open(), /owned/);
  pass("Concurrent storage ownership rejected");
  await assert.rejects(runtime.admit("test", { requestId: "" }));
  pass("Admission requires idempotency key");
  const started = Date.now(),
    first = await runtime.admit("Reply exactly ADAPTER_READY.", { requestId: "first" });
  assert.ok(Date.now() - started < 5000);
  pass("Admission returns without waiting for a model");
  assert.equal((await runtime.admit("Reply exactly ADAPTER_READY.", { requestId: "first" })).submissionId, first.submissionId);
  pass("Admission retry is deduplicated");
  const answer = await runtime.wait(first.submissionId);
  assert.equal(answer.status, "done");
  assert.match(answer.text, /ADAPTER_READY/);
  pass("Fake-model coordinator answers");
  assert.ok(modelRequests.some((request) => request.includes("After asking for an owner decision, end your turn")));
  assert.ok(modelRequests.some((request) => request.includes("agents report")));
  pass("Coordinator receives quiet-wait and on-demand evidence instructions");
  const ownerHistory = await runtime.chatHistory();
  assert.equal(ownerHistory.items.find((item) => item.kind === "message" && item.role === "user").origin, "owner");
  assert.equal(
    (await runtime.snapshot()).coordinator.history.items.find((item) => item.kind === "message" && item.role === "user").origin,
    "owner",
  );
  pass("History and snapshot preserve owner admission provenance");
  await assert.rejects(runtime.result(99999999));
  pass("Unknown submission rejected");
  const before = await runtime.snapshot();
  await runtime.close();
  runtime = await open();
  assert.deepEqual((await runtime.snapshot()).identities, before.identities);
  assert.equal((await runtime.result(first.submissionId)).text, answer.text);
  pass("Restart preserves identity and completed answer");
  assert.equal(await runtime.isBusy(), false, "a settled runtime is deployment idle");
  fake.hold.ms = 300;
  fake.hold.failNext = true;
  const failing = await runtime.admit("Reply exactly FAIL_ONCE.", { requestId: "fail-once" });
  while (!fake.requests.some((item) => item.user.includes("FAIL_ONCE"))) await sleep(10);
  const graph = await runtime.taskDiagnostics();
  assert.ok(
    graph.tasks.some((task) => typeof task.kind === "string" && ["pending", "running", "waiting", "sleeping"].includes(task.status)) &&
      graph.totalTasks >= graph.tasks.length &&
      Array.isArray(graph.reports) &&
      !/FAIL_ONCE/.test(JSON.stringify(graph)),
    JSON.stringify(graph).slice(0, 600),
  );
  pass("R3 the live task graph is readable, bounded and content-free");
  const queued = await runtime.admit("Reply exactly QUEUED_SURVIVED.", { requestId: "queued-after-failure" });
  assert.equal((await runtime.result(queued.submissionId)).status, "queued");
  assert.equal(await runtime.isBusy(), true, "queued input protects deployment");
  await until(async () => (await runtime.result(failing.submissionId)).status === "unanswered");
  assert.equal((await runtime.result(failing.submissionId)).reason, "model_error");
  await until(async () => (await runtime.result(queued.submissionId)).status === "done", 10000);
  assert.match((await runtime.result(queued.submissionId)).text, /QUEUED_SURVIVED/);
  assert.equal(fake.requests.filter((item) => item.user.includes("FAIL_ONCE")).length, 1, "failed input is not retried");
  fake.hold.ms = 0;
  pass("A failed turn advances queued owner work without replay or withdrawal");
  fake.hold.ms = 300;
  const retainedId = await spawnWorker("Reply exactly PAUSED_WORKER.", "paused-worker");
  while (!fake.requests.some((item) => item.user.includes("PAUSED_WORKER"))) await sleep(10);
  assert.equal((await durableHostActivity(runtime, id)).working, true);
  await runtime.pause();
  const pausedPlan = await runtime.jobs();
  assert.equal(pausedPlan.jobs.find((item) => item.id === retainedId).status, "running");
  assert.equal(pausedPlan.agents.find((item) => item.id === retainedId).endedAt, null);
  assert.equal(await runtime.isBusy(), false);
  const idleActivity = await durableHostActivity(runtime, id);
  assert.equal(idleActivity.working, false, "paused drained worker does not light the project working dot");
  assert.equal(idleActivity.chats.main.working, false, "paused retained identity does not light the chat dot");
  await runtime.close();
  runtime = await open();
  assert.equal(await runtime.isBusy(), false, "reopened paused identities are idle too");
  assert.equal((await runtime.jobs()).jobs.find((item) => item.id === retainedId).status, "running");
  fake.hold.ms = 0;
  await runtime.resume();
  await untilSettled(retainedId);
  pass("Paused drained runtime and sidebar are idle across reopen while worker identity remains resumable");
  const secret = `TOPIC_${randomUUID()}`;
  secretForWorkerContext = secret;
  await writeKnowledge({ dir, path: "research/proof.md", text: secret, expectedRevision: null, author: "owner" });
  const workerId = await spawnWorker(
    'Read research/proof.md using projects_knowledge_read and report its exact text. Do not mutate anything. FAKE-CALL projects_knowledge_read {"path":"research/proof.md"}',
    "knowledge-worker",
  );
  await untilSettled(workerId);
  assert.ok(workerContextSawSecret, "worker tool result was not present in a subsequent actual model request");
  pass("Worker reads topic on demand and receives its tool result in context");
  const workerRequest = modelRequests.findLast(
    (request) => request.includes("Role profile: worker.") && request.includes(secretForWorkerContext),
  );
  assert.ok(workerRequest.includes("job checkpoint"));
  assert.ok(workerRequest.includes("End with one short acknowledgment"));
  pass("Independent worker receives checkpoint and nonduplicated closing-report instructions");
  await until((view) =>
    view.coordinator.history.items.some((item) => item.kind === "message" && item.role === "user" && item.origin === "internal"),
  );
  pass("Worker reports carry internal origin in coordinator history");
  const workerHistory = await runtime.workerRead(workerId);
  const storedReport = workerHistory.items.find(
    (item) => item.kind === "message" && item.origin === "internal" && item.text.startsWith(`[worker ${workerId} `),
  );
  assert.ok(storedReport?.at > 0, "full report remains readable and timestamped in worker history");
  pass("Archived worker report is available through the live transcript reader");
  await runtime.say('Record a note. FAKE-CALL projects_note {"text":"COORDINATOR_NOTE"} FAKE-SAY noted', { requestId: "coordinator-note" });
  assert.ok(notes(dir).some((note) => note.text === "COORDINATOR_NOTE"));
  pass("Coordinator may record notes");
  const telemetry = runtime.telemetrySnapshot();
  const phases = telemetry.metrics.filter((metric) => metric.name === "pi.durable.phase.duration");
  assert.ok(
    phases.some((metric) => metric.attributes.task && metric.count > 0 && metric.sum >= 0 && metric.max >= metric.min),
    JSON.stringify(telemetry).slice(0, 800),
  );
  assert.ok(!/COORDINATOR_NOTE|Record a note/.test(JSON.stringify(telemetry)), "telemetry holds no prompt or argument text");
  const { localTelemetry } = await import("../src/local-telemetry.ts");
  const bounded = localTelemetry({ maxSeries: 8 });
  for (let n = 0; n < 50; n++) bounded.context.metrics.histogram("x").record(n, { task: `t${n}` });
  assert.equal(bounded.snapshot().metrics.length, 8);
  assert.equal(bounded.snapshot().droppedSeries, 42);
  pass("R2 Durable phase timing is kept locally, bounded and content-free");
  await untilSettled(
    await spawnWorker(
      'Attempt projects_note once, observe the denial, do not retry. FAKE-CALL projects_note {"text":"FORBIDDEN_NOTE"} FAKE-SAY denied',
      "denied-worker",
    ),
  );
  assert.ok(!notes(dir).some((note) => note.text === "FORBIDDEN_NOTE"));
  pass("Read-only worker note mutation denied");
  const memory = await readKnowledge(dir, "MEMORY.md");
  writeFileSync(join(dir, "knowledge", "MEMORY.md"), "x".repeat(3001));
  // The generated memory index replaced MEMORY.md in the prompt (docs/ui2-contract.md "Memory"), so a damaged file no longer blocks a turn.
  const oversized = await runtime.say("Reply exactly OVERSIZED_STILL_RUNS.", { requestId: "oversized" });
  assert.match(oversized.text ?? "", /OVERSIZED_STILL_RUNS/);
  pass("Oversized MEMORY.md is not injected and does not block a request");
  const damaged = await readKnowledge(dir, "MEMORY.md");
  await writeKnowledge({ dir, path: "MEMORY.md", text: memory.text, expectedRevision: damaged.revision, author: "owner" });
  assert.match((await runtime.say("Reply exactly REPAIRED.", { requestId: "repair" })).text, /REPAIRED/);
  pass("Repair restores the same conversation");
  await runtime.close();
  runtime = undefined;
  const ownerPath = join(dir, "durable-owner.sqlite");
  rmSync(ownerPath);
  symlinkSync(join(workspace, "outside"), ownerPath);
  await assert.rejects(open(), /symlink/);
  pass("Dangling storage symlink rejected");
  assert.deepEqual(
    durableReport("p1", new Error("boom"), {
      type: "task_faulted",
      reason: "threw",
      extension: "projects.jobs",
      task: { id: 7, kind: "pi.tool", conversationId: 3 },
    }),
    {
      kind: "durable-report",
      projectId: "p1",
      message: "boom",
      type: "task_faulted",
      reason: "threw",
      extension: "projects.jobs",
      task: { id: 7, kind: "pi.tool", conversationId: 3 },
    },
  );
  assert.deepEqual(durableReport("p1", "plain").type, undefined);
  pass("R1 a Durable report names its type, extension and task");
  writeFileSync(join(base, "report.json"), JSON.stringify({ ok: true, checks, diagnostics }, null, 2));
} catch (error) {
  writeFileSync(join(base, "report.json"), JSON.stringify({ ok: false, checks, diagnostics, error: String(error) }, null, 2));
  throw error;
} finally {
  await runtime?.close();
  fake.close();
  process.stderr.write(`${join(base, "report.json")}\n`);
}
