#!/usr/bin/env node
/** Positive-only local Durable scheduling acceptance driver. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { applyImmutable, decoder } from "@earendil-works/chord/delta";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { FAKE_MODEL, startFakeModel } from "./fake-model.mjs";

// Offline: every role uses the local fake model; the SDK home is private, so no owner credentials or real providers are reachable.
const MODEL = FAKE_MODEL;
const ROLE_MODELS = { worker: FAKE_MODEL, scout: FAKE_MODEL, reviewer: FAKE_MODEL };
const ROOT = resolve("artifacts", `durable-local-schedule-positive-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const home = join(ROOT, "projects-home"), workspace = join(ROOT, "workspace");
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const fake = await startFakeModel(ROOT);
process.env.PI_PROJECTS_HOME = home;
const failureInventory = ["race", "crash", "memory", "cancellation", "provider failure", "full F5/local feature milestone"];
const checks = [], observations = [];
const resources = { host: null, request: null, runtime: null };
const pass = (name, value) => { assert.ok(value, name); checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const bounded = async (operation, label, timeout = 120_000) => {
  let timer;
  try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]); }
  finally { clearTimeout(timer); }
};
// Direct opens are not cancellable. Register the result immediately, including a late result,
// and close it before exposing the timeout to the caller.
async function openOwned(open, label, timeout = 120_000) {
  let settled = false;
  const pending = Promise.resolve().then(open).then(async runtime => {
    if (settled) { try { await bounded(() => runtime.close(), `${label} late-result close`); } catch (error) { observations.push({ lateCloseError: String(error) }); } }
    else resources.runtime = runtime;
    return runtime;
  });
  try { return await bounded(() => pending, label, timeout); }
  finally { settled = true; }
}
async function waitFor(read, predicate, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${label} exceeded ${timeout}ms`);
    const value = await bounded(read, `${label} read`, Math.min(remaining, 5_000));
    if (predicate(value)) return value;
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const failExpected = async (name, operation, pattern) => { await assert.rejects(operation, pattern); checks.push(name); };
function project(id, name) { return { version: 1, id, name, cwd: workspace, objective: "Positive local schedule acceptance", runtime: "durable", createdAt: new Date().toISOString(), model: MODEL, models: { ...ROLE_MODELS }, sessionFile: null, phase: "ready", problem: null, runs: [] }; }
function api(socket) { return (input, timeout = 5_000) => bounded(() => new Promise((resolveReply, reject) => {
  const req = httpRequest({ socketPath: socket, path: "/api", method: "POST", headers: { "content-type": "application/json" } }, response => { let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; }); response.on("end", () => { try { const value = JSON.parse(body); value.ok ? resolveReply(value.data) : reject(new Error(value.error)); } catch (error) { reject(error); } }); });
  const deadline = setTimeout(() => req.destroy(new Error(`HTTP request wall deadline exceeded (${timeout}ms)`)), timeout);
  const finish = error => { clearTimeout(deadline); error ? reject(error) : undefined; };
  req.on("error", error => finish(error)); req.on("close", () => clearTimeout(deadline)); req.end(JSON.stringify(input));
}), `HTTP ${input.action}`, timeout); }
async function sdkAvailabilityProbe() {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const models = await bounded(() => ModelRuntime.create({ allowModelNetwork: false }), "SDK availability probe", 30_000);
  const [provider, id] = MODEL.split("/", 2);
  pass(`private SDK exposes only the fake fixture model ${MODEL}`, Boolean(models.getModel(provider, id)) && models.getProviderAuthStatus("openai-codex").configured !== true);
}
async function startHost() {
  const { socketPath } = await import("../src/state.ts");
  const socket = socketPath();
  const child = spawn(process.execPath, [resolve("src/host.ts")], { cwd: resolve("."), env: { ...process.env, PI_PROJECTS_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  // Register before any health request so startup failure is always owned and cleaned.
  const host = { socket, child, stderr: "", startupFailure: null };
  resources.host = host;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { host.stderr += chunk; });
  const health = await waitFor(() => new Promise(resolveReply => { const req = httpRequest({ socketPath: socket, path: "/health", timeout: 1_000 }, response => { let body = ""; response.on("data", c => { body += c; }); response.on("end", () => { try { resolveReply(JSON.parse(body)); } catch { resolveReply(null); } }); }); req.on("error", () => resolveReply(null)); req.on("timeout", () => req.destroy()); req.end(); }), value => value?.ok === true, "host startup", 30_000);
  pass("health identifies the owned host PID and projects home", health.data?.pid === child.pid && health.data?.home === home);
  return host;
}
async function stopHost(host, send) {
  const deadline = Date.now() + 120_000;
  let acknowledged = false, failure;
  const remaining = label => { const left = deadline - Date.now(); if (left <= 0) throw new Error(`${label} exceeded cleanup budget`); return Math.min(left, 30_000); };
  const alive = () => host.child.exitCode === null;
  const ownedActive = () => { if (!alive()) return false; try { process.kill(host.child.pid, 0); return true; } catch { return false; } };
  const exited = () => host.child.exitCode !== null;
  try {
    if (send) { const response = await bounded(() => send({ action: "shutdown" }), "host shutdown", remaining("host shutdown")); acknowledged = response?.stopping === true; }
    await waitFor(() => !existsSync(host.socket), value => value, "Unix socket close", remaining("Unix socket close"));
    await waitFor(exited, value => value, "host process exit", remaining("host process exit"));
    pass("owned host cleanup ACK/socket/PID verified", acknowledged);
  } catch (error) {
    failure = error;
    // The ChildProcess object, exact PID, argv and cwd captured at spawn establish ownership;
    // never inspect or signal an unrelated/reused PID.
    if (ownedActive()) {
      process.kill(host.child.pid, "SIGTERM");
      observations.push({ cleanup: "verified-owned-SIGTERM", pid: host.child.pid, argv: host.child.spawnargs, cwd: host.child.spawnfile });
      try { await waitFor(exited, value => value, "owned host SIGTERM exit", remaining("SIGTERM")); }
      catch (termError) {
        if (!ownedActive()) throw termError;
        process.kill(host.child.pid, "SIGKILL");
        observations.push({ cleanup: "verified-owned-SIGKILL", pid: host.child.pid });
        await waitFor(exited, value => value, "owned host SIGKILL exit", remaining("SIGKILL"));
      }
    }
    await waitFor(() => !existsSync(host.socket), value => value, "Unix socket close after termination", remaining("socket close after termination"));
    observations.push({ cleanupFailure: String(failure), acknowledged, pid: host.child.pid, socketClosed: true, childExited: exited() });
    throw failure;
  }
}
function successfulSubmission(value, label, marker, requestId, submissionId) {
  pass(`${label} preserves exact submission ID`, value?.id === submissionId);
  pass(`${label} preserves exact request ID`, value?.requestId === requestId);
  pass(`${label} has successful terminal status`, value?.status === "done");
  pass(`${label} has exact answer ID and marker reply`, Number.isSafeInteger(value?.answerId) && typeof value?.text === "string" && value.text.includes(marker));
  pass(`${label} has no terminal error`, value?.reason == null);
}
async function copyReadonlySdkRecords(dir, expected) {
  const evidence = join(ROOT, "readonly-sdk-records"); mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const files = readdirSync(dir).filter(name => name.startsWith("durable") && (name.endsWith(".sqlite") || name.includes(".sqlite-")));
  pass("owned SQLite record set is nonempty", files.length > 0);
  for (const name of files) { const source = join(dir, name), target = join(evidence, name); cpSync(source, target); chmodSync(target, 0o400); pass(`readonly SQLite copy is byte exact: ${name}`, sha(source) === sha(target) && statSync(source).size === statSync(target).size); }
  const databasePath = join(evidence, "durable.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => ({ ...row, record: row.record === undefined ? undefined : JSON.parse(row.record) }));
    const conversations = rows("conversations"), entries = rows("entries"), submissions = rows("submissions"), tasks = rows("tasks"), documents = rows("documents");
    const byId = (list, id) => list.find(row => Number(row.id) === Number(id));
    const correlated = [expected.event, expected.schedule, expected.normal].map(target => {
      const submission = byId(submissions, target.submissionId);
      pass(`native submission ${target.label} has exact request/status`, submission?.record?.requestId === target.requestId && submission?.record?.status === "done" && submission?.record?.type === "input");
      pass(`native submission ${target.label} owns exact conversation`, Number(submission?.record?.conversationId) === Number(target.conversationId));
      const input = byId(entries, submission?.record?.entry), answer = byId(entries, submission?.record?.answer);
      const assistant = answer?.record?.model?.find(message => message.role === "assistant");
      const content = assistant?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text).join("") : "";
      pass(`native ${target.label} has persisted input/answer entry IDs`, Number.isSafeInteger(Number(input?.id)) && Number.isSafeInteger(Number(answer?.id)) && Number(input?.conversation_id) === Number(target.conversationId) && Number(answer?.conversation_id) === Number(target.conversationId));
      pass(`native ${target.label} has complete successful assistant`, text === target.marker && assistant?.stopReason === "stop" && assistant?.errorMessage == null);
      return { target, submission: submission?.record, input: input?.record, answer: answer?.record };
    });
    // Durable 1.0 generation tasks carry no request ID; they link to the submission through the answer entry they produced.
    const answered = (row, item) => item.submission?.answer != null && Number(row.record?.state?.outcome?.result?.entryId) === Number(item.submission.answer);
    const taskRows = tasks.filter(row => correlated.some(item => answered(row, item)));
    for (const item of correlated) { const ownedTasks = taskRows.filter(row => answered(row, item)); pass(`native task exists for ${item.target.label} request`, ownedTasks.length > 0); }
    for (const row of taskRows) pass(`native task ${row.id} is terminal and successful`, row.record?.state?.status === "terminal" && row.record?.state?.outcome?.status === "completed" && (row.record?.state?.outcome?.result?.status === undefined || row.record?.state?.outcome?.result?.status === "completed"));
    const revisionRows = database.prepare("SELECT document_id, seq, kind, version, content FROM document_revisions ORDER BY document_id, seq").all();
    const revisions = new Map();
    for (const row of revisionRows) { const list = revisions.get(Number(row.document_id)) ?? []; list.push({ seq: Number(row.seq), kind: row.kind, version: Number(row.version), content: JSON.parse(row.content) }); revisions.set(Number(row.document_id), list); }
    const decodedDocuments = documents.map(row => {
      let value;
      for (const revision of revisions.get(Number(row.id)) ?? []) value = revision.kind === "base" ? revision.content : applyImmutable(value, decoder().decode(revision.content));
      pass(`native document ${row.id} has ordered decoded revisions`, (revisions.get(Number(row.id)) ?? []).every((revision, index, list) => index === 0 || revision.seq > list[index - 1].seq));
      return { record: row.record, revisions: revisions.get(Number(row.id)) ?? [], value };
    });
    pass("native persisted record IDs are finite and ordered", [...entries, ...submissions, ...tasks, ...documents].every(row => Number.isSafeInteger(Number(row.id))));
    observations.push({ readonlyRecordCopies: files.map(name => ({ name, source: join(dir, name), copy: join(evidence, name), sourceSha256: sha(join(dir, name)), copySha256: sha(join(evidence, name)) })), native: { conversations, correlated, tasks: taskRows.map(row => row.record), documents: decodedDocuments } });
  } finally { database.close(); }
}
async function hostPhase() {
  const host = await startHost(), request = api(host.socket); resources.request = request;
  const created = await request({ action: "create", cwd: workspace, name: "Positive schedule host", objective: "Positive schedule acceptance", model: MODEL });
  pass("public create returns configured Durable fake-model project", created.runtime === "durable" && created.model === MODEL && created.cwd === workspace);
  const id = created.id;
  // Create gives workers the built-in default role models; point them at the fake model too so nothing can reach a real provider.
  const settings = await request({ action: "settings-snapshot", id });
  await request({ action: "settings-update", id, confirm: id, expectedRevision: settings.revision, changes: { models: ROLE_MODELS } });
  pass("settings pin every role to the fake model", JSON.stringify((await request({ action: "show", id })).project.models) === JSON.stringify(ROLE_MODELS));
  const quiet = await request({ action: "schedule-create", id, scheduleId: "quiet", atMs: Date.now() + 60_000, text: "disabled" });
  pass("schedule is disabled by default", quiet.enabled === false);
  const eventId = `host-event-${randomUUID()}`;
  pass("event opt-in starts disabled", (await request({ action: "schedule-snapshot", id })).eventOptIn === false);
  await request({ action: "event-opt-in", id, enabled: true });
  const event = await request({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "Reply exactly LOCAL_POSITIVE_EVENT" });
  pass("host event has real request/submission IDs", event.requestId === `event:${eventId}` && Number.isSafeInteger(event.submissionId));
  const eventView = await waitFor(() => request({ action: "schedule-snapshot", id }), view => view.intents.some(item => item.requestId === event.requestId && item.outcome === "completed"), "host event completion");
  const eventIntent = eventView.intents.find(item => item.requestId === event.requestId);
  pass("host event receipt exactly matches request/submission pair", eventIntent?.requestId === event.requestId && eventIntent?.submissionId === event.submissionId && eventIntent?.status === "submitted" && eventIntent?.outcome === "completed");
  const scheduleId = `host-schedule-${randomUUID()}`;
  await request({ action: "schedule-create", id, scheduleId, atMs: Date.now() + 1_000, text: "Reply exactly LOCAL_POSITIVE_SCHEDULE" });
  await request({ action: "schedule-enable", id, scheduleId, enabled: true });
  const fired = await waitFor(() => request({ action: "schedule-snapshot", id }), view => view.intents.some(item => item.stableId === scheduleId && item.outcome === "completed"), "host scheduled completion");
  const intent = fired.intents.find(item => item.stableId === scheduleId);
  pass("host one-shot preserves exact request/submission pair and is consumed", intent?.requestId === `schedule:${scheduleId}:tick:${scheduleId}:${fired.schedules.find(item => item.id === scheduleId)?.atMs}` && Number.isSafeInteger(intent?.submissionId) && intent?.outcome === "completed" && fired.schedules.find(item => item.id === scheduleId)?.enabled === false);
  const before = await request({ action: "show", id });
  pass("host show exposes only actual public project/messages/jobs", before.project?.id === id && Array.isArray(before.messages) && Array.isArray(before.jobs) && !("coordinator" in before));
  const scheduleBefore = await request({ action: "schedule-snapshot", id });
  pass("host public messages contain owned assistant markers", before.messages.some(message => message.role === "assistant" && message.text.includes("LOCAL_POSITIVE_EVENT")) && before.messages.some(message => message.role === "assistant" && message.text.includes("LOCAL_POSITIVE_SCHEDULE")));
  await stopHost(host, request); resources.host = null; resources.request = null;
  const reopenedHost = await startHost(), reopenedRequest = api(reopenedHost.socket); resources.request = reopenedRequest;
  const after = await reopenedRequest({ action: "show", id }), scheduleAfter = await reopenedRequest({ action: "schedule-snapshot", id });
  pass("fresh host reopen preserves actual project/messages/jobs/models", after.project.id === id && JSON.stringify(after.project.models) === JSON.stringify(ROLE_MODELS) && after.project.model === MODEL && Array.isArray(after.messages) && Array.isArray(after.jobs));
  const oldIntent = scheduleBefore.intents.filter(item => item.requestId === event.requestId || item.requestId === intent.requestId);
  const newIntent = scheduleAfter.intents.filter(item => item.requestId === event.requestId || item.requestId === intent.requestId);
  pass("reopen preserves exact request/submission/outcome IDs", JSON.stringify(oldIntent) === JSON.stringify(newIntent));
  const duplicate = await reopenedRequest({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "Reply exactly LOCAL_POSITIVE_EVENT" });
  pass("duplicate event returns same request and submission ID", duplicate.requestId === event.requestId && duplicate.submissionId === event.submissionId);
  const afterDuplicate = await reopenedRequest({ action: "schedule-snapshot", id });
  pass("duplicate event preserves completed intent bytes with no new intent", JSON.stringify(afterDuplicate.intents) === JSON.stringify(scheduleAfter.intents) && afterDuplicate.intents.filter(item => item.requestId === event.requestId).length === 1 && afterDuplicate.intents.find(item => item.requestId === event.requestId)?.status !== "recorded");
  await stopHost(reopenedHost, reopenedRequest); resources.host = null; resources.request = null;
  observations.push({ phase: "host", id, before, after, scheduleBefore, scheduleAfter, event, duplicate, stderr: host.stderr });
}
async function directPhase() {
  const [{ openDurableProject }, state] = await Promise.all([import("../src/durable-runtime.ts"), import("../src/state.ts")]);
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const settingsManager = SettingsManager.create(workspace, getAgentDir());
  const settingsPath = settingsManager.settingsPaths.project;
  mkdirSync(resolve(settingsPath, ".."), { recursive: true, mode: 0o700 });
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, "{}\n", { mode: 0o600 });
  const id = randomUUID(); state.saveProject(project(id, "Positive schedule direct"));
  const dir = state.projectDir(id), requests = [], receipts = [];
  // Establish the owned lock-file fixture and capture its physical preimage before open.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ownerPath = join(dir, "durable-owner.sqlite");
  if (!existsSync(ownerPath)) writeFileSync(ownerPath, Buffer.alloc(0), { mode: 0o600 });
  const ownerBefore = readFileSync(ownerPath), ownerStatBefore = statSync(ownerPath), ownerShaBefore = sha(ownerPath), settingsBefore = readFileSync(settingsPath), settingsShaBefore = sha(settingsPath);
  pass("owner plain file preimage is physical", ownerStatBefore.isFile() && ownerBefore.length >= 0);
  const runtime = await openOwned(() => openDurableProject({ project: state.loadProject(id), dir, onModelRequest: value => requests.push(value), beforeScheduleReceiptCommit: value => receipts.push(value) }), "direct open");
  pass("owned project settings fixture is physical at SDK-supported location", existsSync(settingsPath) && statSync(settingsPath).isFile());
  const quiet = await bounded(() => runtime.scheduleCreate({ id: "quiet", atMs: Date.now() + 60_000, text: "disabled" }), "schedule create"); pass("direct schedule is disabled by default", quiet.enabled === false);
  pass("direct event opt-in starts disabled", (await bounded(() => runtime.scheduleSnapshot(), "direct initial snapshot")).eventOptIn === false);
  await bounded(() => runtime.scheduleSetEventOptIn(true), "event opt-in");
  const eventId = `direct-event-${randomUUID()}`;
  const event = await bounded(() => runtime.ingestLocalEvent({ eventId, kind: "owner-local", payload: "Reply exactly LOCAL_DIRECT_EVENT" }), "event ingest");
  pass("direct event has real request/submission IDs", event.requestId === `event:${eventId}` && Number.isSafeInteger(event.submissionId));
  const doneEvent = await waitFor(() => runtime.scheduleSnapshot(), view => view.intents.some(item => item.requestId === event.requestId && item.outcome === "completed"), "direct event completion");
  const eventIntent = doneEvent.intents.find(item => item.requestId === event.requestId); pass("direct event is completed", eventIntent?.outcome === "completed" && Number.isSafeInteger(eventIntent.submissionId));
  const eventResult = await bounded(() => runtime.wait(eventIntent.submissionId), "event result"); successfulSubmission(eventResult, "direct event model request", "LOCAL_DIRECT_EVENT", event.requestId, event.submissionId);
  const duplicate = await bounded(() => runtime.ingestLocalEvent({ eventId, kind: "owner-local", payload: "Reply exactly LOCAL_DIRECT_EVENT" }), "direct duplicate ingest"); pass("direct duplicate preserves same request/submission", duplicate.requestId === event.requestId && duplicate.submissionId === event.submissionId);
  await failExpected("conflicting event payload is rejected", () => bounded(() => runtime.ingestLocalEvent({ eventId, kind: "owner-local", payload: "CONFLICT" }), "conflicting event"), /Conflicting event ID/);
  const scheduleId = `direct-schedule-${randomUUID()}`;
  await bounded(() => runtime.scheduleCreate({ id: scheduleId, atMs: Date.now() + 1_000, text: "Reply exactly LOCAL_DIRECT_SCHEDULE" }), "direct schedule create"); await bounded(() => runtime.scheduleSetEnabled(scheduleId, true), "direct schedule enable");
  const completed = await waitFor(() => runtime.scheduleSnapshot(), view => view.intents.some(item => item.stableId === scheduleId && item.outcome === "completed"), "direct scheduled completion");
  const scheduleIntent = completed.intents.find(item => item.stableId === scheduleId); pass("direct one-shot has request/submission and completed outcome", scheduleIntent?.requestId.startsWith(`schedule:${scheduleId}:`) && Number.isSafeInteger(scheduleIntent.submissionId) && scheduleIntent.outcome === "completed");
  const scheduledResult = await bounded(() => runtime.wait(scheduleIntent.submissionId), "scheduled result"); successfulSubmission(scheduledResult, "direct scheduled model request", "LOCAL_DIRECT_SCHEDULE", scheduleIntent.requestId, scheduleIntent.submissionId);
  const normalRequestId = `normal-${randomUUID()}`, normal = await bounded(() => runtime.say("Reply exactly LOCAL_DIRECT_NORMAL", { requestId: normalRequestId }), "normal say"); successfulSubmission(normal, "direct normal model request", "LOCAL_DIRECT_NORMAL", normalRequestId, normal.id);
  pass("model observer retains actual messages", requests.length > 0 && requests.every(value => Array.isArray(value.messages)));
  pass("receipt observer retains exact event/schedule request-submission pairs", receipts.some(value => value.requestId === event.requestId && value.submissionId === event.submissionId) && receipts.some(value => value.requestId === scheduleIntent.requestId && value.submissionId === scheduleIntent.submissionId));
  const intentsBeforeClose = (await bounded(() => runtime.scheduleSnapshot(), "final direct snapshot")).intents;
  const directIdentity = (await bounded(() => runtime.snapshot(), "native correlation identity")).identities.coordinatorConversationId;
  await bounded(() => runtime.close(), "direct close"); resources.runtime = null;
  const reopened = await openOwned(() => openDurableProject({ project: state.loadProject(id), dir }), "direct reopen");
  const reopenedView = await bounded(() => reopened.scheduleSnapshot(), "reopened snapshot"); pass("direct reopen preserves byte-identical completed intents and exact IDs", JSON.stringify(reopenedView.intents) === JSON.stringify(intentsBeforeClose) && reopenedView.intents.some(item => item.requestId === event.requestId && item.submissionId === event.submissionId && item.outcome === "completed") && reopenedView.intents.some(item => item.stableId === scheduleId && item.outcome === "completed") && reopenedView.schedules.find(item => item.id === scheduleId)?.enabled === false);
  const reopenedDuplicate = await bounded(() => reopened.ingestLocalEvent({ eventId, kind: "owner-local", payload: "Reply exactly LOCAL_DIRECT_EVENT" }), "reopened duplicate ingest");
  pass("fresh-reopen duplicate preserves SDK submission ID and consumed status", reopenedDuplicate.requestId === event.requestId && reopenedDuplicate.submissionId === event.submissionId && reopenedDuplicate.status !== "recorded");
  await failExpected("consumed one-shot cannot be re-enabled after reopen", () => bounded(() => reopened.scheduleSetEnabled(scheduleId, true), "re-enable consumed one-shot"), /Consumed one-shot/);
  const ownerAfter = readFileSync(ownerPath), ownerStatAfter = statSync(ownerPath), settingsAfter = readFileSync(settingsPath);
  pass("owner bytes/SHA/dev/ino/mode physical preimage is preserved after final reopened close", ownerAfter.equals(ownerBefore) && sha(ownerPath) === ownerShaBefore && ownerStatAfter.dev === ownerStatBefore.dev && ownerStatAfter.ino === ownerStatBefore.ino && ownerStatAfter.mode === ownerStatBefore.mode);
  pass("SDK project settings bytes/SHA are preserved", settingsAfter.equals(settingsBefore) && sha(settingsPath) === settingsShaBefore);
  pass("reopened project preserves exact configured role models", state.loadProject(id).model === MODEL && JSON.stringify(state.loadProject(id).models) === JSON.stringify(ROLE_MODELS));
  await bounded(() => reopened.close(), "reopened close"); resources.runtime = null;
  await copyReadonlySdkRecords(dir, { event: { label: "event", requestId: event.requestId, submissionId: event.submissionId, conversationId: directIdentity, marker: "LOCAL_DIRECT_EVENT" }, schedule: { label: "schedule", requestId: scheduleIntent.requestId, submissionId: scheduleIntent.submissionId, conversationId: directIdentity, marker: "LOCAL_DIRECT_SCHEDULE" }, normal: { label: "normal", requestId: normalRequestId, submissionId: normal.id, conversationId: directIdentity, marker: "LOCAL_DIRECT_NORMAL" } });
  const ownerFinal = readFileSync(ownerPath), ownerFinalStat = statSync(ownerPath);
  pass("owner bytes/SHA/dev/ino/mode remain exact after final close", ownerFinal.equals(ownerBefore) && sha(ownerPath) === ownerShaBefore && ownerFinalStat.dev === ownerStatBefore.dev && ownerFinalStat.ino === ownerStatBefore.ino && ownerFinalStat.mode === ownerStatBefore.mode);
  observations.push({ phase: "direct", id, dir, modelRequests: requests, receipts, event, eventResult, duplicate, reopenedDuplicate, scheduledResult, normal, ownerShaBefore, ownerShaAfter: sha(ownerPath), settingsShaBefore, settingsShaAfter: sha(settingsPath), failureInventory });
}
async function main() {
  await sdkAvailabilityProbe();
  let primaryError = null; const cleanupErrors = [];
  try { await hostPhase(); await directPhase(); }
  catch (error) { primaryError = error; }
  finally {
    if (resources.runtime) { try { await bounded(() => resources.runtime.close(), "runtime cleanup", 30_000); } catch (error) { cleanupErrors.push(error); } resources.runtime = null; }
    if (resources.host) { try { await bounded(() => stopHost(resources.host, resources.request), "host cleanup", 120_000); } catch (error) { cleanupErrors.push(error); } resources.host = null; resources.request = null; }
  }
  if (primaryError) { observations.push({ cleanupErrors: cleanupErrors.map(String) }); throw primaryError; }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "resource cleanup failed");
  pass("every model request went to the fake model", fake.requests.length > 0 && fake.requests.every(item => item.model === "fake-model"));
  writeFileSync(join(ROOT, "report.json"), `${JSON.stringify({ ok: true, checks, observations, fakeModelRequests: fake.requests, failureInventory, source: sha(new URL(import.meta.url).pathname) }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, root: ROOT, checks: checks.length, deferred: failureInventory }));
}
try { await main(); } catch (error) { mkdirSync(ROOT, { recursive: true, mode: 0o700 }); writeFileSync(join(ROOT, "report.json"), `${JSON.stringify({ ok: false, checks, observations, fakeModelRequests: fake.requests, error: String(error) }, null, 2)}\n`); throw error; }
finally { fake.close(); }
