#!/usr/bin/env node
/**
 * Business E2E for durable scheduling.  This driver intentionally creates two
 * unrelated homes: the host transport phase and the direct-runtime phase never
 * share a project, owner database, socket, or PID.  It is a real-model driver;
 * it has no fake clock, SDK replacement, HTTP fixture, or database writer.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const MODEL = "openai-codex/gpt-5.6-terra";
const ROOT = resolve("artifacts", `durable-local-schedule-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const hostHome = join(ROOT, "host-state");
const directHome = join(ROOT, "direct-state");
const hostWorkspace = join(ROOT, "host-workspace");
const directWorkspace = join(ROOT, "direct-workspace");
mkdirSync(hostWorkspace, { recursive: true, mode: 0o700 });
mkdirSync(directWorkspace, { recursive: true, mode: 0o700 });

const checks = [];
const observations = [];
const pass = (name, assertion) => { assert.ok(assertion, name); checks.push({ name, assertion: String(assertion) }); process.stderr.write(`PASS ${name}\n`); };
const failExpected = async (name, operation, pattern) => { await assert.rejects(operation, pattern); checks.push({ name, assertion: `rejects ${pattern}` }); };
const bounded = async (operation, label, timeout = 120_000) => {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]);
  } finally { clearTimeout(timer); }
};
const waitFor = (read, predicate, label, timeout = 120_000) => bounded(async () => {
  let latest;
  while (true) {
    latest = await read();
    if (predicate(latest)) return latest;
    await sleep(Math.min(250, Math.max(25, timeout / 100)));
  }
}, label, timeout);
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");

function apiClient(socketPath) {
  return async input => bounded(() => new Promise((resolveReply, reject) => {
    const req = httpRequest({ socketPath, path: "/api", method: "POST", timeout: 120_000, headers: { "content-type": "application/json" } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (!value.ok) reject(new Error(value.error)); else resolveReply(value.data);
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.end(JSON.stringify(input));
  }), `HTTP ${input.action}`);
}

async function startHost(home) {
  process.env.PI_PROJECTS_HOME = home;
  const { socketPath } = await import("../src/state.ts");
  const socket = socketPath();
  const child = spawn(process.execPath, [resolve("src/host.ts")], { cwd: resolve("."), env: { ...process.env, PI_PROJECTS_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => { try { return await new Promise((resolveReply, reject) => { const req = httpRequest({ socketPath: socket, path: "/health", timeout: 1_000 }, response => { let b = ""; response.on("data", c => { b += c; }); response.on("end", () => resolveReply(JSON.parse(b))); }); req.on("error", reject); req.end(); }); } catch { return null; } }, value => value?.ok === true, "host startup", 30_000);
  return { child, socket, stderr };
}

function project(id, cwd, name) {
  return { version: 1, id, name, cwd, objective: "Disposable real local schedule business E2E", runtime: "durable", createdAt: new Date().toISOString(), model: MODEL, models: { worker: MODEL, scout: MODEL, reviewer: MODEL }, sessionFile: null, phase: "ready", problem: null, runs: [] };
}

async function hostTransportPhase() {
  // Establish ownership before importing state or saving the disposable project.
  process.env.PI_PROJECTS_HOME = hostHome;
  const { saveProject, projectDir, socketPath } = await import("../src/state.ts");
  const id = randomUUID();
  saveProject(project(id, hostWorkspace, "Schedule host transport"));
  const host = await startHost(hostHome);
  const api = apiClient(host.socket);
  const initialFiles = readdirSync(projectDir(id)).sort();
  const listed = await api({ action: "list" });
  pass("host lists the explicitly created project", listed.some(item => item.id === id && item.runtime === "durable"));
  const scheduleId = "constructor";
  const quiet = await api({ action: "schedule-create", id, scheduleId, atMs: Date.now() + 60_000, text: "DISABLED_QUIET" });
  pass("disabled one-shot is quiet", quiet.enabled === false);
  await failExpected("disabled event ingress rejects", () => api({ action: "event-ingest", id, eventId: `disabled-${randomUUID()}`, kind: "owner-local", payload: "quiet" }), /disabled/);
  await failExpected("conflicting schedule ID rejects", () => api({ action: "schedule-create", id, scheduleId, atMs: quiet.atMs + 1, text: "conflict" }), /Conflicting schedule ID/);
  const eventId = "constructor";
  await api({ action: "event-opt-in", id, enabled: true });
  const event = await api({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "LOCAL_EVENT_✓" });
  assert.equal(event.kind, "event"); assert.equal(event.stableId, eventId); pass("enabled event records the actual intent", event.requestId === `event:${eventId}` && ["recorded", "submitted"].includes(event.status));
  const eventTerminal = await waitFor(() => api({ action: "schedule-snapshot", id }), view => view.intents.some(item => item.requestId === event.requestId && item.outcome === "completed"), "host event successful completion");
  pass("host event has a correlated successful terminal receipt", eventTerminal.intents.some(item => item.requestId === event.requestId && item.outcome === "completed"));
  const duplicate = await api({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "LOCAL_EVENT_✓" });
  pass("repeated event returns the stable request ID", duplicate.requestId === event.requestId);
  await failExpected("conflicting event ID rejects", () => api({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "different" }), /Conflicting event ID/);
  const memoryText = "🧠".repeat(3001);
  const memoryWrite = await api({ action: "knowledge-write", id, path: "research/local-schedule-memory.md", text: memoryText, expectedRevision: null });
  const memoryRead = await api({ action: "knowledge-read", id, path: "research/local-schedule-memory.md" });
  pass("knowledge memory guard accepts only the owned disposable file", memoryRead.text === memoryText && memoryWrite.path === "research/local-schedule-memory.md");
  const directSchedule = await api({ action: "schedule-create", id, atMs: Date.now() + 250, text: "Reply exactly LOCAL_SCHEDULE_E2E" });
  await api({ action: "schedule-enable", id, scheduleId: directSchedule.id, enabled: true });
  const terminal = await waitFor(() => api({ action: "schedule-snapshot", id }), view => view.intents.some(item => item.stableId === directSchedule.id && ["submitted", "failed", "interrupted", "uncertain"].includes(item.status)), "scheduled intent terminal admission");
  const intent = terminal.intents.find(item => item.stableId === directSchedule.id);
  pass("one-shot is consumed once", intent && terminal.schedules.find(item => item.id === directSchedule.id)?.enabled === false);
  await failExpected("consumed one-shot rejects re-enable", () => api({ action: "schedule-enable", id, scheduleId: directSchedule.id, enabled: true }), /Consumed one-shot/);
  const beforeReopen = JSON.parse(JSON.stringify(await api({ action: "show", id })));
  await api({ action: "shutdown" });
  await waitFor(() => new Promise(resolveReply => resolveReply(!existsSync(host.socket))), value => value === true, "host socket closure", 30_000);
  await waitFor(() => new Promise(resolveReply => { try { process.kill(host.child.pid, 0); resolveReply(false); } catch (error) { resolveReply(error?.code === "ESRCH"); } }), value => value === true, "host process ESRCH after acknowledged shutdown", 30_000);
  pass("normal host shutdown closes its Unix socket and process", !existsSync(host.socket));
  observations.push({ phase: "host", projectId: id, socket: host.socket, initialFiles, beforeReopen, stderr: host.stderr });
}

async function directRuntimePhase() {
  process.env.PI_PROJECTS_HOME = directHome;
  const [{ openDurableProject }, state] = await Promise.all([import("../src/durable-runtime.ts"), import("../src/state.ts")]);
  const id = randomUUID();
  state.saveProject(project(id, directWorkspace, "Schedule direct runtime"));
  const dir = state.projectDir(id);
  const modelRequests = [];
  const lifecycle = [];
  const hookObservations = { recorded: [], receipts: [], pauses: [] };
  const runtime = await openDurableProject({ project: state.loadProject(id), dir, onModelRequest: request => modelRequests.push(request), onGenerationLifecycle: event => lifecycle.push(event),
    afterScheduleIntentRecorded: value => { hookObservations.recorded.push({ ...value }); return Promise.resolve(); },
    beforeScheduleReceiptCommit: value => { hookObservations.receipts.push({ ...value }); return Promise.resolve(); },
    afterPausePersisted: value => { hookObservations.pauses.push({ ...value }); return Promise.resolve(); },
  });
  const ownerBefore = sha(join(dir, "durable-owner.sqlite"));
  const settingsBefore = existsSync(join(dir, "settings.json")) ? sha(join(dir, "settings.json")) : null;
  const disabled = await runtime.scheduleCreate({ id: "constructor", atMs: Date.now() + 60_000, text: "disabled" });
  pass("direct disabled schedule defaults quiet", disabled.enabled === false);
  await failExpected("direct disabled event rejects", () => runtime.ingestLocalEvent({ eventId: randomUUID(), kind: "owner-local", payload: "quiet" }), /disabled/);
  await runtime.scheduleSetEventOptIn(true);
  const unicode = "LOCAL_EVENT_世界_👩🏽‍💻";
  const eventId = "constructor";
  const event = await runtime.ingestLocalEvent({ eventId, kind: "owner-local", payload: unicode });
  pass("direct event uses actual public request and Unicode payload", event.requestId === `event:${eventId}` && event.text.includes(unicode));
  const eventDone = await waitFor(() => runtime.scheduleSnapshot(), view => view.intents.some(item => item.requestId === event.requestId && item.outcome === "completed"), "direct event successful completion");
  pass("direct event has a correlated successful terminal receipt", eventDone.intents.some(item => item.requestId === event.requestId && item.outcome === "completed"));
  const duplicate = await runtime.ingestLocalEvent({ eventId, kind: "owner-local", payload: unicode });
  pass("direct event repeat is idempotent", duplicate.requestId === event.requestId);
  await failExpected("direct conflicting event rejects", () => runtime.ingestLocalEvent({ eventId, kind: "owner-local", payload: "CONFLICT" }), /Conflicting event ID/);
  const schedule = await runtime.scheduleCreate({ id: `schedule-${randomUUID()}`, atMs: Date.now() + 250, text: "Reply exactly LOCAL_SCHEDULE_E2E" });
  await runtime.scheduleSetEnabled(schedule.id, true);
  const admitted = await waitFor(() => runtime.scheduleSnapshot(), view => view.intents.some(item => item.stableId === schedule.id), "direct schedule admission");
  const scheduleIntent = admitted.intents.find(item => item.stableId === schedule.id);
  pass("direct schedule has a real finite intent", Number.isFinite(scheduleIntent?.recordedAtMs) && scheduleIntent.requestId.startsWith(`schedule:${schedule.id}:`));
  await failExpected("direct consumed schedule rejects re-enable", () => runtime.scheduleSetEnabled(schedule.id, true), /Consumed one-shot/);
  const answer = scheduleIntent?.submissionId == null ? null : await waitFor(() => runtime.result(scheduleIntent.submissionId), result => result.status === "done", "scheduled model successful terminal receipt");
  pass("scheduled model gives actual correlated answer", answer?.status === "done" && answer.text?.includes("LOCAL_SCHEDULE_E2E"));
  const normal = await runtime.say("Reply exactly LOCAL_DIRECT_E2E", { requestId: `normal-${randomUUID()}` });
  pass("direct public runtime returns actual model answer", normal.status === "done" && normal.text?.includes("LOCAL_DIRECT_E2E"));
  const control = await runtime.planSnapshot();
  pass("plan snapshot exposes persisted pause control", typeof control.paused === "boolean" && typeof control.pausing === "boolean");
  const workId = randomUUID();
  await runtime.plan({ work: [{ id: workId, threadId: randomUUID(), role: "worker", text: "Reply exactly LOCAL_WORKER_E2E", requestId: `worker-${randomUUID()}` }] });
  const paused = await runtime.pausePlan();
  pass("actual root pause reaches persisted paused state", paused.paused === true && paused.pausing === false);
  pass("direct runtime fault hooks observe detached real values", hookObservations.recorded.some(value => value.requestId === event.requestId && value.submissionId === null) && hookObservations.receipts.some(value => Number.isSafeInteger(value.submissionId)) && hookObservations.pauses.some(value => value.paused === true && value.pausing === true));
  const drained = await runtime.planSnapshot();
  pass("ownerless worker is interrupted and drained by pause", drained.work.some(item => item.id === workId && item.status === "interrupted") && !drained.work.some(item => item.status === "running"));
  const held = await runtime.scheduleCreate({ id: `paused-${randomUUID()}`, atMs: Date.now() - 1, text: "paused" });
  await runtime.scheduleSetEnabled(held.id, true);
  const pausedView = await runtime.scheduleSnapshot();
  pass("paused overdue schedule does not submit", !pausedView.intents.some(item => item.stableId === held.id));
  await runtime.resumePlan();
  await runtime.close();
  const reopened = await openDurableProject({ project: state.loadProject(id), dir, onModelRequest: request => modelRequests.push(request) });
  const after = await reopened.scheduleSnapshot();
  const ownerAfter = sha(join(dir, "durable-owner.sqlite"));
  const settingsAfter = existsSync(join(dir, "settings.json")) ? sha(join(dir, "settings.json")) : null;
  pass("owner settings and schedule records survive reopen", after.schedules.some(item => item.id === schedule.id) && ownerAfter === ownerBefore && settingsAfter === settingsBefore);
  await reopened.close();
  observations.push({ phase: "direct", projectId: id, dir, modelRequests: modelRequests.length, lifecycle: lifecycle.length, settingsBefore, ownerBefore });
}

async function main() {
  await hostTransportPhase();
  await directRuntimePhase();
  writeFileSync(join(ROOT, "report.json"), `${JSON.stringify({ ok: true, checks, observations, source: { script: sha(new URL(import.meta.url).pathname) } }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, root: ROOT, checks: checks.length }));
}
try { await main(); } catch (error) {
  writeFileSync(join(ROOT, "report.json"), `${JSON.stringify({ ok: false, checks, observations, error: String(error) }, null, 2)}\n`);
  throw error;
}
