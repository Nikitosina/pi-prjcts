#!/usr/bin/env node
/**
 * Positive-only host driver. This deliberately uses only the public host API.
 * After each owned host close, an unopened byte-exact SQLite archive is retained;
 * independent read-only probes are made only from that archive.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, statSync, writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { applyImmutable, decoder } from "@earendil-works/chord/delta";

const MODEL = "openai-codex/gpt-5.6-terra";
const ROLE_MODELS = { worker: "openai-codex/gpt-5.6-terra", scout: "openai-codex/gpt-5.6-luna", reviewer: "openai-codex/gpt-5.6-sol" };
const ROOT = resolve("artifacts", `durable-local-schedule-host-positive-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const HOME = join(ROOT, "state");
const WORKSPACE = join(ROOT, "plaincwd");
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
mkdirSync(HOME, { recursive: true, mode: 0o700 });
mkdirSync(WORKSPACE, { recursive: true, mode: 0o700 });
// This is the only project-home override. Existing SDK auth and SDK home remain untouched.
process.env.PI_PROJECTS_HOME = HOME;

const checks = [];
const observations = [];
const resources = { host: null, request: null };
const deadlineMs = 120_000;
const cleanupBudgetMs = 120_000;
const cleanupGraceMs = 45_000;
const cleanupTermMs = 10_000;
const cleanupKillMs = 10_000;
const cleanupCloseMs = 15_000;
const pass = (label, value) => { assert.ok(value, label); checks.push(label); process.stderr.write(`PASS ${label}\n`); };
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const errorCode = error => error && typeof error === "object" && "code" in error ? error.code : undefined;
const physical = path => {
  try {
    const value = lstatSync(path);
    return { path, exists: true, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink(), dev: value.dev, ino: value.ino, mode: value.mode, size: value.size, target: value.isSymbolicLink() ? readlinkSync(path) : null };
  } catch (error) { if (errorCode(error) === "ENOENT") return { path, exists: false, status: "ENOENT" }; throw error; }
};
const effectiveSettings = (path, receipt) => {
  if (!receipt.exists) return { path, status: "ENOENT", bytes: null, sha256: null, length: null };
  try {
    const target = statSync(path);
    const regular = target.isFile();
    if (!regular) return { path, exists: true, regular, dev: target.dev, ino: target.ino, mode: target.mode, bytes: null, sha256: null, length: null };
    const bytes = readFileSync(path);
    return { path, exists: true, regular, dev: target.dev, ino: target.ino, mode: target.mode, bytes, length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { path, status: "ENOENT", bytes: null, sha256: null, length: null };
    throw error;
  }
};
const preimage = path => {
  const receipt = physical(path);
  const effective = effectiveSettings(path, receipt);
  // Bytes are retained in memory only; the report contains no SDK/global-setting contents.
  return { ...receipt, bytes: effective.bytes, length: effective.length, sha256: effective.sha256, effective };
};

let sdkAgentDir;
let globalSettingsPath;
let projectSettingsPath;
let settingsPreimages;
let pathPreimages;
async function capturePreservationPreimages() {
  // This is the SDK's public normalization, including tilde expansion.
  ({ getAgentDir: sdkAgentDir } = await import("@earendil-works/pi-coding-agent"));
  globalSettingsPath = join(sdkAgentDir(), "settings.json");
  projectSettingsPath = join(WORKSPACE, ".pi", "settings.json");
  mkdirSync(join(WORKSPACE, ".pi"), { recursive: true, mode: 0o700 });
  if (!physical(projectSettingsPath).exists) writeFileSync(projectSettingsPath, "{}\n", { mode: 0o600 });
  settingsPreimages = { global: preimage(globalSettingsPath), project: preimage(projectSettingsPath) };
  pathPreimages = { state: physical(HOME), plaincwd: physical(WORKSPACE), globalSettings: physical(globalSettingsPath), projectSettings: physical(projectSettingsPath) };
}

function remaining(start, label) {
  const value = deadlineMs - (Date.now() - start);
  if (value <= 0) throw new Error(`${label} exceeded ${deadlineMs}ms`);
  return Math.min(value, 30_000);
}
async function bounded(operation, label, timeout = 30_000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout); })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(read, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  const left = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error(`${label} exceeded ${timeout}ms`);
    return value;
  };
  for (;;) {
    const value = await bounded(read, `${label} poll`, Math.min(left(), 30_000));
    if (predicate(value)) return value;
    await sleep(Math.min(250, left()));
  }
}

function api(socket) {
  return (input, timeout = 30_000) => bounded(() => new Promise((resolveReply, reject) => {
    let settled = false;
    const request = httpRequest({ socketPath: socket, path: "/api", method: "POST", headers: { "content-type": "application/json" } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("error", error => finish(error));
      response.on("end", () => {
        try { const reply = JSON.parse(body); settled = true; reply.ok ? resolveReply(reply.data) : reject(new Error(reply.error)); }
        catch (error) { finish(error); }
      });
    });
    const wall = setTimeout(() => request.destroy(new Error(`HTTP ${input.action} wall deadline exceeded`)), timeout);
    const finish = error => { if (settled) return; settled = true; clearTimeout(wall); if (error) reject(error); };
    request.once("error", finish);
    request.once("close", () => { clearTimeout(wall); if (!settled) finish(new Error(`HTTP ${input.action} closed without a response`)); });
    request.end(JSON.stringify(input));
  }), `HTTP ${input.action}`, timeout);
}

function health(socket, timeout = 1_000) {
  return bounded(() => new Promise(resolveReply => {
    const request = httpRequest({ socketPath: socket, path: "/health", method: "GET" }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { resolveReply(JSON.parse(body)); } catch { resolveReply(null); } });
      response.on("error", () => resolveReply(null));
    });
    const wall = setTimeout(() => request.destroy(new Error("health wall deadline exceeded")), timeout);
    request.once("error", () => { clearTimeout(wall); resolveReply(null); });
    request.once("close", () => clearTimeout(wall));
    request.end();
  }), "health request", timeout + 250).catch(() => null);
}

async function startHost(started) {
  const { socketPath } = await import("../src/state.ts");
  const socket = socketPath();
  const child = spawn(process.execPath, [resolve("src/host.ts")], { cwd: resolve("."), env: { ...process.env, PI_PROJECTS_HOME: HOME }, stdio: ["ignore", "ignore", "pipe"] });
  const host = { child, socket, startedAt: Date.now(), stderr: "", events: [], exitCode: null, signalCode: null, closed: false, spawnError: null, source: resolve("src/host.ts"), cwd: resolve("."), home: HOME, projectId: null, healthReply: null };
  // Register every lifecycle outcome before the first health request.
  resources.host = host;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { host.stderr += chunk; });
  child.on("error", error => { host.spawnError = error; host.events.push({ type: "error", error: String(error), code: errorCode(error) }); });
  child.on("exit", (code, signal) => { host.exitCode = code; host.signalCode = signal; host.events.push({ type: "exit", exitCode: code, signalCode: signal }); });
  child.on("close", (code, signal) => { host.closed = true; host.events.push({ type: "close", exitCode: code, signalCode: signal }); });
  const healthReply = await waitFor(() => {
    if (host.spawnError) throw new Error(`host spawn failed: ${host.spawnError}`);
    if (host.closed && host.exitCode === null && host.signalCode === null) throw new Error("host closed before startup");
    return health(socket);
  }, value => value?.ok === true, "host startup", remaining(started, "host startup"));
  host.healthReply = healthReply;
  pass("health identifies exact owned PID/home", healthReply.data?.pid === child.pid && healthReply.data?.home === HOME);
  pass("host identity has exact source/cwd/argv", child.pid > 0 && child.spawnfile === process.execPath && child.spawnargs[0] === process.execPath && child.spawnargs[1] === resolve("src/host.ts") && host.cwd === resolve("."));
  return host;
}

function hostIsExactActive(host) {
  return host.source === resolve("src/host.ts") && host.cwd === resolve(".") && host.child.pid > 0 && host.child.spawnfile === process.execPath && host.child.spawnargs[0] === process.execPath && host.child.spawnargs[1] === host.source && host.child.exitCode === null && host.child.signalCode === null && host.exitCode === null && host.signalCode === null && !host.closed;
}
async function stopHost(host, request) {
  let ack = null;
  let fallback = null;
  let primaryError = null;
  const fallbackErrors = [];
  const cleanupDeadline = Date.now() + cleanupBudgetMs;
  const stageLeft = (label, stageDeadline) => {
    const left = Math.min(cleanupDeadline - Date.now(), stageDeadline - Date.now());
    if (left <= 0) throw new Error(`${label} exceeded its reserved cleanup window`);
    return left;
  };
  const settled = () => host.exitCode !== null || host.signalCode !== null || host.spawnError !== null || host.closed;
  const hasValidExit = () => (host.exitCode !== null) !== (host.signalCode !== null);
  const waitSettled = (label, stageDeadline) => waitFor(() => settled(), value => value, label, stageLeft(label, stageDeadline));
  const waitClosed = (label, stageDeadline) => waitFor(() => host.closed, value => value, label, stageLeft(label, stageDeadline));
  const graceDeadline = Date.now() + cleanupGraceMs;
  let closureObservation = null;
  let closureObserved = false;
  const ownedReceipt = () => ({ pid: host.child.pid, source: host.source, home: host.home ?? HOME, projectId: host.projectId ?? null, socket: host.socket, health: host.healthReply, ack });
  const observePidDisappearance = async () => {
    const receipt = { ...ownedReceipt(), startedAt: Date.now() };
    try {
      const error = await waitFor(() => {
        try { process.kill(host.child.pid, 0); return null; }
        catch (syscallError) { if (errorCode(syscallError) === "ESRCH") return syscallError; throw syscallError; }
      }, value => value !== null, "owned PID disappearance", stageLeft("owned PID disappearance", graceDeadline));
      receipt.error = errorReceipt("owned PID disappearance", error);
      receipt.code = errorCode(error);
      receipt.syscall = error.syscall;
      receipt.ok = receipt.code === "ESRCH";
    } catch (error) {
      receipt.error = errorReceipt("owned PID disappearance", error);
      receipt.code = errorCode(error);
      receipt.syscall = error?.syscall;
      receipt.ok = false;
    }
    receipt.finishedAt = Date.now();
    receipt.durationMs = receipt.finishedAt - receipt.startedAt;
    return receipt;
  };
  const observeSocketDisappearance = async () => {
    const receipt = { ...ownedReceipt(), startedAt: Date.now(), event: null, error: null, ok: false };
    let connection = null;
    let timer = null;
    try {
      const socketTimeout = Math.min(5_000, stageLeft("owned socket disappearance", graceDeadline));
      const result = await new Promise(resolveReply => {
        let settled = false;
        const finish = result => { if (!settled) { settled = true; resolveReply(result); } };
        connection = netConnect(host.socket);
        timer = setTimeout(() => finish({ event: "timeout" }), socketTimeout);
        connection.once("connect", () => finish({ event: "connect" }));
        connection.once("error", error => finish({ event: "error", error }));
        connection.once("close", () => finish({ event: "close" }));
      });
      receipt.event = result.event;
      if (result.error) receipt.error = errorReceipt("owned socket disappearance", result.error);
      receipt.ok = result.event === "error" && ["ENOENT", "ECONNREFUSED"].includes(errorCode(result.error));
    } catch (error) {
      receipt.error = errorReceipt("owned socket disappearance", error);
    } finally {
      clearTimeout(timer);
      if (connection) connection.destroy();
      receipt.finishedAt = Date.now();
      receipt.durationMs = receipt.finishedAt - receipt.startedAt;
    }
    return receipt;
  };
  const observeOwnedClosure = async () => {
    const pidDisappearance = await observePidDisappearance();
    const socketDisappearance = await observeSocketDisappearance();
    closureObservation = { ...ownedReceipt(), pidDisappearance, socketDisappearance, observedAt: Date.now() };
    observations.push({ ownedClosure: closureObservation });
    closureObserved = true;
    safeCheck("owned PID disappears with actual ESRCH", pidDisappearance.ok);
    safeCheck("owned socket rejects bounded nonstarting connection", socketDisappearance.ok);
    if (!pidDisappearance.ok || !socketDisappearance.ok) throw new Error("owned closure observation failed");
  };
  const recordFallbackError = (stage, error) => { fallbackErrors.push({ stage, error: String(error), code: errorCode(error) }); };
  try {
    if (host.spawnError) {
      fallback = { at: Date.now(), state: "nonstarted", source: host.source, pid: host.child.pid, spawnError: String(host.spawnError), code: errorCode(host.spawnError) };
      throw new Error(`host spawn failed before cleanup: ${host.spawnError}`);
    }
    if (host.closed || host.exitCode !== null || host.signalCode !== null) {
      const normal = host.exitCode === 0 && host.signalCode === null && host.closed && hasValidExit();
      safeCheck("already-settled host has normal zero-exit and observed close", normal);
      safeCheck("already-settled host has successful shutdown ACK", false);
      throw new Error("host was already settled before shutdown ACK");
    }
    const ackAt = Date.now();
    ack = await request({ action: "shutdown" }, Math.min(5_000, stageLeft("shutdown ACK", graceDeadline)));
    observations.push({ shutdownAckAt: ackAt, shutdownAck: ack });
    if (!(ack?.stopping === true)) throw new Error("host shutdown ACK was not successful");
    safeCheck("host shutdown returns graceful ACK", true);
    await waitFor(() => !existsSync(host.socket), value => value, "host socket close", stageLeft("graceful socket close", graceDeadline));
    await waitSettled("host process exit", graceDeadline);
    await waitClosed("host process close", graceDeadline);
    if (!(host.exitCode === 0 && host.signalCode === null && host.closed && hasValidExit())) throw new Error("host shutdown was not a normal zero-exit close");
    safeCheck("host exits normally with observed close", true);
    await observeOwnedClosure();
  } catch (error) {
    primaryError = error;
    // ChildProcess identity is the ownership proof; do not inspect or reuse a PID.
    if (hostIsExactActive(host)) {
      fallback = { at: Date.now(), signal: "SIGTERM", pid: host.child.pid, source: host.source, state: "active" };
      const termDeadline = Date.now() + cleanupTermMs;
      try {
        host.child.kill("SIGTERM");
        await waitSettled("owned SIGTERM exit", termDeadline);
      } catch (termError) {
        recordFallbackError("SIGTERM", termError);
        fallback.termError = String(termError);
        if (hostIsExactActive(host)) {
          fallback = { ...fallback, secondSignalAt: Date.now(), signal2: "SIGKILL", state2: "active" };
          try { host.child.kill("SIGKILL"); }
          catch (killError) {
            fallback.killError = String(killError);
            // ESRCH is an observed child-already-exited receipt, not permission to reuse a PID.
            if (errorCode(killError) !== "ESRCH") recordFallbackError("SIGKILL send", killError);
          }
          if (!settled()) {
            const killDeadline = Date.now() + cleanupKillMs;
            try { await waitSettled("owned SIGKILL exit", killDeadline); }
            catch (killWaitError) { recordFallbackError("SIGKILL", killWaitError); }
          }
        }
      }
      if (!settled()) {
        const fallbackDeadline = Date.now() + cleanupKillMs;
        try { await waitSettled("owned fallback exit", fallbackDeadline); }
        catch (exitError) { recordFallbackError("fallback exit", exitError); }
      }
    } else if (!settled()) {
      recordFallbackError("ownership", new Error("cannot terminate unconfirmed host child"));
    } else {
      fallback = fallback ?? { at: Date.now(), state: "nonstarted-or-settled", source: host.source, pid: host.child.pid, spawnError: host.spawnError ? String(host.spawnError) : null };
    }
    // ChildProcess close is a separate receipt from exit. Wait for it after every
    // branch, including an exited child and a spawn/non-start failure.
    const closeDeadline = Date.now() + cleanupCloseMs;
    try { await waitClosed("owned child close", closeDeadline); }
    catch (closeError) { recordFallbackError("close", closeError); }
    if (!host.closed) recordFallbackError("close receipt", new Error("owned child close was not confirmed"));
    if (!host.spawnError && !hasValidExit()) recordFallbackError("exit receipt", new Error("child exit had neither exactly one code nor one signal"));
    if (!closureObserved) {
      try { await observeOwnedClosure(); }
      catch (closureError) { recordFallbackError("owned closure observations", closureError); }
    }
    observations.push({ fallback, fallbackErrors });
    if (fallbackErrors.length) primaryError.message = `${primaryError.message}; fallback cleanup: ${fallbackErrors.map(item => `${item.stage}: ${item.error}`).join(" | ")}`;
    throw primaryError;
  } finally {
    observations.push({ hostStop: { socket: host.socket, pid: host.child.pid, ack, fallback, fallbackErrors, closureObservation, exitCode: host.exitCode, signalCode: host.signalCode, closed: host.closed, events: host.events, stderr: host.stderr } });
  }
}

function immutableProject(project, expectedId) {
  const expected = { version: 1, id: expectedId, name: "Host positive schedule", cwd: WORKSPACE, objective: "Host positive schedule acceptance", runtime: "durable", model: MODEL, models: ROLE_MODELS, sessionFile: null };
  for (const [key, value] of Object.entries(expected)) pass(`project immutable field ${key}`, JSON.stringify(project[key]) === JSON.stringify(value));
  pass("project create has only documented mutable state differences", Object.keys(project).sort().join(",") === ["createdAt", "cwd", "id", "model", "models", "name", "objective", "phase", "problem", "runs", "runtime", "sessionFile", "version"].join(","));
}
function exactIntent(view, requestId, stableId) {
  return view.intents.find(item => item.requestId === requestId && item.stableId === stableId);
}
function sqliteInventory(dir) {
  return Object.fromEntries(readdirSync(dir).filter(name => name === "durable.sqlite" || name.startsWith("durable.sqlite-")).sort().map(name => {
    const path = join(dir, name);
    const value = physical(path);
    return [name, { ...value, sha256: value.exists && value.isFile && !value.isSymbolicLink ? sha(path) : null }];
  }));
}
function equalInventory(before, after, label, strictPhysical = true) {
  if (!before || !after) return [`${label} inventory unavailable`];
  const errors = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = before[name];
    const right = after[name];
    const physicalLeft = left && { exists: left.exists, isFile: left.isFile, isDirectory: left.isDirectory, isSymbolicLink: left.isSymbolicLink, size: left.size, ...(strictPhysical ? { dev: left.dev, ino: left.ino, mode: left.mode } : {}), target: left.target };
    const physicalRight = right && { exists: right.exists, isFile: right.isFile, isDirectory: right.isDirectory, isSymbolicLink: right.isSymbolicLink, size: right.size, ...(strictPhysical ? { dev: right.dev, ino: right.ino, mode: right.mode } : {}), target: right.target };
    if (!left || !right || JSON.stringify(physicalLeft) !== JSON.stringify(physicalRight)) errors.push(`${label} physical receipt changed: ${name}`);
    if (left?.sha256 !== right?.sha256) errors.push(`${label} bytes changed: ${name}`);
  }
  return errors;
}
function copySqlitePack(toDir, sourceInventory, errors, label) {
  try { mkdirSync(toDir, { recursive: true, mode: 0o700 }); }
  catch (error) { errors.push(errorReceipt(`${label} pack construction`, error)); return; }
  for (const receipt of Object.values(sourceInventory ?? {})) {
    try {
      const target = join(toDir, receipt.path.split("/").pop());
      cpSync(receipt.path, target);
      // Preserve the source mode in the unopened archive; probes are the only paths
      // that a read-only SQLite connection may mutate.
      if (receipt.mode !== undefined) chmodSync(target, receipt.mode & 0o7777);
    } catch (error) { errors.push(errorReceipt(`${label} pack copy ${receipt.path}`, error)); }
  }
}

function decodedCursorReceipts(records) {
  return {
    submissions: records.submissions.map(row => ({ id: Number(row.id), conversationId: Number(row.conversation_id), status: row.record?.status ?? row.status })),
    entries: records.entries.map(row => ({ id: Number(row.id), conversationId: Number(row.conversation_id), commitSeq: Number(row.commit_seq), head: row.head === null ? null : Number(row.head) })),
    tasks: records.tasks.map(row => ({ id: Number(row.id), conversationId: Number(row.conversation_id), status: row.status })),
    conversations: records.conversations.map(row => ({ id: Number(row.id), ownerConversationId: row.owner_conversation_id === null ? null : Number(row.owner_conversation_id), ownerTaskId: row.owner_task_id === null ? null : Number(row.owner_task_id) })),
    documents: records.documents.map(row => ({ id: Number(row.id), ownerId: Number(row.owner_id), createdAt: Number(row.created_at) })),
    revisions: records.revisions.map(row => ({ documentId: Number(row.document_id), seq: Number(row.seq) })),
  };
}

async function inspectSqliteProbe(probeDir, archiveBefore, projectId, expected, label, errors, probeReceipt) {
  const probeErrors = probeReceipt.errors;
  probeReceipt.archiveBefore = archiveBefore;
  probeReceipt.probeDir = probeDir;
  copySqlitePack(probeDir, archiveBefore, probeErrors, `${label} probe`);
  const probeBefore = (() => { try { return sqliteInventory(probeDir); } catch (error) { probeErrors.push(errorReceipt(`${label} probe-before inventory`, error)); return null; } })();
  probeReceipt.probeBefore = probeBefore;
  let archiveProbeComparison = [];
  try { archiveProbeComparison = equalInventory(archiveBefore, probeBefore, `${label} unopened archive to fresh probe`, false); }
  catch (error) { probeErrors.push(errorReceipt(`${label} archive-to-probe comparison`, error)); archiveProbeComparison = [`${label} archive-to-probe comparison failed`]; }
  probeReceipt.archiveProbeComparison = archiveProbeComparison;
  const archiveMain = archiveBefore?.["durable.sqlite"];
  const probeMain = probeBefore?.["durable.sqlite"];
  const validArchiveMain = archiveMain?.exists === true && archiveMain.isFile === true && archiveMain.isSymbolicLink === false && Number.isSafeInteger(archiveMain.size) && archiveMain.size > 0 && typeof archiveMain.sha256 === "string" && /^[a-f0-9]{64}$/.test(archiveMain.sha256);
  const validProbeMain = probeMain?.exists === true && probeMain.isFile === true && probeMain.isSymbolicLink === false && Number.isSafeInteger(probeMain.size) && probeMain.size > 0 && probeMain.size === archiveMain?.size && typeof probeMain.sha256 === "string" && /^[a-f0-9]{64}$/.test(probeMain.sha256);
  if (!validArchiveMain) probeErrors.push({ stage: `${label} archive main validation`, error: "durable.sqlite archive receipt is not a present regular nonsymlink file with a valid SHA-256 and size" });
  if (!validProbeMain) probeErrors.push({ stage: `${label} probe main validation`, error: "durable.sqlite probe receipt is not a present regular nonsymlink file with a valid SHA-256 and expected size" });
  if (probeErrors.length || archiveProbeComparison.length || !validArchiveMain || !validProbeMain) {
    safeCheck(`${label} fresh probe matches a valid unopened archive before SQLite open`, false);
    errors.push(...probeErrors);
    return { label, probeDir, archiveBefore, probeBefore, probeAfter: null, archiveProbeComparison, errors: probeErrors };
  }
  safeCheck(`${label} fresh probe matches a valid unopened archive before SQLite open`, true);
  probeReceipt.rawRows = {};
  probeReceipt.records = { submissions: [], entries: [], tasks: [], conversations: [], documents: [], revisions: [] };
  probeReceipt.cursors = { submissions: [], entries: [], tasks: [], conversations: [], documents: [], revisions: [] };
  const inspectionErrors = probeErrors;
  const inspectionCheck = (text, value) => { const ok = safeCheck(text, value); if (!ok) inspectionErrors.push(errorReceipt(`${label} inspection assertion`, new Error(text))); return ok; };
  let database = null;
  let inspection = null;
  try {
    database = new DatabaseSync(join(probeDir, "durable.sqlite"), { readOnly: true });
    const readRows = (name, query, decode) => {
      let rawRows;
      try { rawRows = database.prepare(query).all(); }
      catch (error) { probeErrors.push(errorReceipt(`${label} cursor ${name}`, error)); return probeReceipt.records[name]; }
      probeReceipt.rawRows[name] = rawRows;
      for (const [index, row] of rawRows.entries()) {
        try { probeReceipt.records[name].push(decode(row)); }
        catch (error) { probeErrors.push(errorReceipt(`${label} row ${name}[${index}] decode`, error)); }
        try { probeReceipt.cursors = decodedCursorReceipts(probeReceipt.records); }
        catch (error) { probeErrors.push(errorReceipt(`${label} cursor ${name}[${index}] receipt`, error)); }
      }
      return probeReceipt.records[name];
    };
    const decodeRecord = row => ({ ...row, record: row.record === undefined ? undefined : JSON.parse(row.record) });
    const submissions = readRows("submissions", "SELECT * FROM submissions ORDER BY id", decodeRecord);
    const entries = readRows("entries", "SELECT * FROM entries ORDER BY id", decodeRecord);
    const tasks = readRows("tasks", "SELECT * FROM tasks ORDER BY id", decodeRecord);
    const conversations = readRows("conversations", "SELECT * FROM conversations ORDER BY id", decodeRecord);
    const documents = readRows("documents", "SELECT * FROM documents ORDER BY id", decodeRecord);
    const revisions = readRows("revisions", "SELECT document_id, seq, kind, version, content FROM document_revisions ORDER BY document_id, seq", row => ({ ...row, content: JSON.parse(row.content) }));
    const records = probeReceipt.records;
    const cursors = probeReceipt.cursors;
    probeReceipt.records = records;
    probeReceipt.cursors = cursors;
    inspectionCheck(`${label} decoded SQL records/entries/submissions/tasks/conversations/docs/revisions/cursors are nonempty`, Object.values(records).every(rows => rows.length > 0) && Object.values(cursors).every(rows => rows.length > 0));
    const byId = (rows, id) => rows.find(row => Number(row.id) === Number(id));
    const docs = [];
    for (const document of documents) {
      const ownRevisions = revisions.filter(row => Number(row.document_id) === Number(document.id));
      let latest = null;
      try {
        for (const revision of ownRevisions) latest = revision.kind === "base" ? revision.content : applyImmutable(latest, decoder().decode(revision.content));
      } catch (error) { inspectionErrors.push(errorReceipt(`${label} document ${document.id} revision decode`, error)); }
      inspectionCheck(`${label} document ${document.id} has finite ordered revisions`, ownRevisions.length > 0 && ownRevisions.every((row, index) => Number.isSafeInteger(Number(row.seq)) && (index === 0 || Number(row.seq) > Number(ownRevisions[index - 1].seq))));
      docs.push({ ...document, kind: String(document.kind).replaceAll('"', ""), revisions: ownRevisions, latest });
      probeReceipt.documents = docs;
    }
    probeReceipt.documents = docs;
    probeReceipt.inspection = { records, cursors, documents: docs };
    const identity = docs.find(document => document.kind === "projects.durable-identity");
    inspectionCheck(`${label} durable identity document proves actual project scope`, identity?.latest?.projectId === projectId && Number.isSafeInteger(Number(identity?.owner_id)));
    const correlated = [];
    for (const target of [expected.event, expected.schedule]) {
      const submission = submissions.find(row => Number(row.id) === target.submissionId && row.record?.requestId === target.requestId);
      const conversationId = Number(submission?.conversation_id);
      inspectionCheck(`${label} native submission ${target.label} has actual numeric id/request`, Number.isSafeInteger(Number(submission?.id)) && submission?.record?.requestId === target.requestId && submission?.record?.type === "input");
      inspectionCheck(`${label} native submission ${target.label} is successful done receipt`, submission?.record?.status === "done");
      const input = byId(entries, submission?.record?.entry);
      const answer = byId(entries, submission?.record?.answer);
      inspectionCheck(`${label} native ${target.label} input/answer IDs are actual numeric entries`, Number.isSafeInteger(Number(input?.id)) && Number.isSafeInteger(Number(answer?.id)) && Number(input?.conversation_id) === conversationId && Number(answer?.conversation_id) === conversationId);
      const user = input?.record?.model?.find(message => message.role === "user");
      const assistant = answer?.record?.model?.find(message => message.role === "assistant");
      const text = typeof assistant?.content === "string" ? assistant.content : assistant?.content?.filter?.(part => part?.type === "text").map(part => part.text).join("");
      inspectionCheck(`${label} native ${target.label} has exact full assistant text`, text === target.marker && text !== target.prompt);
      inspectionCheck(`${label} native ${target.label} answer has stop and no error`, assistant?.stopReason === "stop" && !Object.hasOwn(assistant ?? {}, "errorMessage"));
      inspectionCheck(`${label} native ${target.label} input is the actual user prompt`, user?.content === target.prompt);
      const taskId = answer?.record?.byTaskId;
      const generation = tasks.find(row => Number(row.id) === Number(taskId));
      inspectionCheck(`${label} native ${target.label} answer points to exact generation task`, Number.isSafeInteger(Number(taskId)) && Number(generation?.id) === Number(taskId));
      let nativeKind = false;
      try { nativeKind = generation?.record?.kind === "pi.generation" || JSON.parse(generation?.kind ?? "null") === "pi.generation"; } catch (error) { inspectionErrors.push(errorReceipt(`${label} native kind`, error)); }
      inspectionCheck(`${label} native ${target.label} generation has parsed native kind`, nativeKind);
      inspectionCheck(`${label} native ${target.label} generation matches conversation/input/outcome`, generation?.record?.conversationId === conversationId && JSON.stringify(generation?.record?.input) === "{}" && generation?.record?.state?.status === "terminal" && generation?.record?.state?.outcome?.status === "completed" && generation?.record?.state?.outcome?.result?.entryId === answer?.id);
      correlated.push({ target, submission: { id: submission?.id, conversationId: submission?.conversation_id, record: submission?.record }, input: { id: input?.id, conversationId: input?.conversation_id, commitSeq: input?.commit_seq }, answer: { id: answer?.id, conversationId: answer?.conversation_id, commitSeq: answer?.commit_seq, record: answer?.record }, generation: generation ? { id: generation.id, conversationId: generation.conversation_id, state: generation.record.state, input: generation.record.input } : null });
    }
    const actualConversationId = Number(correlated[0]?.submission?.conversationId ?? submissions.find(row => row.id === expected.event.submissionId)?.conversation_id);
    inspectionCheck(`${label} native conversations are project-scoped and nonempty`, conversations.length > 0 && Number.isSafeInteger(actualConversationId) && conversations.some(row => Number(row.id) === actualConversationId));
    inspectionCheck(`${label} native identity owner/latest coordinator match actual conversation`, Number(identity?.owner_id) === actualConversationId && Number(identity?.latest?.coordinatorConversationId) === actualConversationId);
    inspectionCheck(`${label} native entries expose ordered input-before-answer cursors`, correlated.every(item => Number.isSafeInteger(Number(item.input.commitSeq)) && Number.isSafeInteger(Number(item.answer.commitSeq)) && Number(item.input.commitSeq) < Number(item.answer.commitSeq)));
    inspectionCheck(`${label} native task rows expose terminal successful generation`, correlated.every(item => item.generation?.state?.status === "terminal" && item.generation.state.outcome.status === "completed"));
    inspection = { label, conversations, correlated, records: { ...records, cursors }, documents: docs.map(doc => ({ id: doc.id, kind: doc.kind, ownerId: doc.owner_id, revisions: doc.revisions.map(row => ({ seq: row.seq, kind: row.kind, version: row.version })), latest: doc.latest })) };
    probeReceipt.inspection = inspection;
  } catch (error) { inspectionErrors.push(errorReceipt(`${label} inspection`, error)); }
  finally { if (database) try { database.close(); } catch (error) { inspectionErrors.push(errorReceipt(`${label} database close`, error)); } }
  const probeAfter = (() => { try { return sqliteInventory(probeDir); } catch (error) { probeErrors.push(errorReceipt(`${label} probe-after inventory`, error)); return null; } })();
  probeReceipt.probeAfter = probeAfter;
  const probeIntegrity = [];
  const ignoredSidecars = new Set(["durable.sqlite-wal", "durable.sqlite-shm"]);
  const strictBefore = probeBefore && Object.fromEntries(Object.entries(probeBefore).filter(([name]) => !ignoredSidecars.has(name)));
  const strictAfter = probeAfter && Object.fromEntries(Object.entries(probeAfter).filter(([name]) => !ignoredSidecars.has(name)));
  let probeInventoryComparison = [];
  try { probeInventoryComparison = equalInventory(strictBefore, strictAfter, `${label} probe inventory except WAL/SHM`, true); }
  catch (error) { probeErrors.push(errorReceipt(`${label} probe inventory comparison`, error)); probeInventoryComparison = [`${label} probe inventory comparison failed`]; }
  probeReceipt.probeInventoryComparison = probeInventoryComparison;
  const mainBefore = probeBefore?.["durable.sqlite"];
  const mainAfter = probeAfter?.["durable.sqlite"];
  let mainDiff = [];
  try { mainDiff = equalInventory(mainBefore ? { "durable.sqlite": mainBefore } : null, mainAfter ? { "durable.sqlite": mainAfter } : null, `${label} probe main`, true); }
  catch (error) { probeErrors.push(errorReceipt(`${label} probe main comparison`, error)); mainDiff = [`${label} probe main comparison failed`]; }
  probeIntegrity.push(...probeInventoryComparison);
  safeCheck(`${label} probe main SQLite remains byte exact`, mainDiff.length === 0);
  safeCheck(`${label} probe inventory remains exact except WAL/SHM`, probeInventoryComparison.length === 0);
  safeCheck(`${label} probe captures actual WAL/SHM before/after receipts`, probeBefore !== null && probeAfter !== null);
  const sidecars = {
    before: Object.fromEntries(Object.entries(probeBefore ?? {}).filter(([name]) => ignoredSidecars.has(name))),
    after: Object.fromEntries(Object.entries(probeAfter ?? {}).filter(([name]) => ignoredSidecars.has(name))),
  };
  probeReceipt.sidecars = sidecars;
  probeErrors.push(...probeIntegrity);
  errors.push(...probeErrors);
  return { ...inspection, probeDir, archiveProbeComparison, probeBefore, probeAfter, sidecars, probeInventoryComparison, errors: probeErrors };
}

async function forensicCopy(projectId, expected, sourceRoot, label = "closed") {
  const sourceDir = join(sourceRoot, projectId);
  const forensicErrors = [];
  const integrityErrors = [];
  const archiveDir = join(ROOT, `sqlite-archive-pack-${label}`);
  const phaseReceipt = { label, projectId, sourceDir, archiveDir, sourceBefore: null, archiveBefore: null, probes: [], integrityErrors, forensicErrors };
  observations.push({ forensic: phaseReceipt });
  const readInventory = (path, side) => {
    try { return sqliteInventory(path); }
    catch (error) { const receipt = errorReceipt(`${label} ${side} inventory`, error); forensicErrors.push(receipt); return null; }
  };
  const sourceBefore = readInventory(sourceDir, "source-before");
  phaseReceipt.sourceBefore = sourceBefore;
  safeCheck(`${label} owned durable SQLite source exists`, Boolean(sourceBefore && Object.hasOwn(sourceBefore, "durable.sqlite")));
  if (!sourceBefore || !Object.hasOwn(sourceBefore, "durable.sqlite")) forensicErrors.push({ stage: `${label} source-before`, error: "durable.sqlite missing" });
  copySqlitePack(archiveDir, sourceBefore, forensicErrors, `${label} unopened archive`);
  const archiveBefore = (() => { try { return sqliteInventory(archiveDir); } catch (error) { const receipt = errorReceipt(`${label} archive-before inventory`, error); forensicErrors.push(receipt); return null; } })();
  phaseReceipt.archiveBefore = archiveBefore;
  try { integrityErrors.push(...equalInventory(sourceBefore, archiveBefore, `${label} source-to-unopened-archive`, false)); }
  catch (error) { forensicErrors.push(errorReceipt(`${label} source/archive comparison`, error)); }
  phaseReceipt.sourceArchiveComparison = integrityErrors.slice();
  for (const name of new Set([...Object.keys(sourceBefore ?? {}), ...Object.keys(archiveBefore ?? {})])) safeCheck(`${label} unopened archive is byte exact ${name}`, Boolean(sourceBefore?.[name] && archiveBefore?.[name] && sourceBefore[name].sha256 === archiveBefore[name].sha256));
  const sourceMain = sourceBefore?.["durable.sqlite"];
  const archiveMain = archiveBefore?.["durable.sqlite"];
  const validSourceMain = sourceMain?.exists === true && sourceMain.isFile === true && sourceMain.isSymbolicLink === false && Number.isSafeInteger(sourceMain.size) && sourceMain.size > 0 && typeof sourceMain.sha256 === "string" && /^[a-f0-9]{64}$/.test(sourceMain.sha256);
  const validArchiveMain = archiveMain?.exists === true && archiveMain.isFile === true && archiveMain.isSymbolicLink === false && Number.isSafeInteger(archiveMain.size) && archiveMain.size > 0 && typeof archiveMain.sha256 === "string" && /^[a-f0-9]{64}$/.test(archiveMain.sha256);
  if (!validSourceMain) forensicErrors.push({ stage: `${label} source main validation`, error: "durable.sqlite source receipt is not a present regular nonsymlink file with a valid SHA-256 and size" });
  if (!validArchiveMain) forensicErrors.push({ stage: `${label} archive main validation`, error: "durable.sqlite archive receipt is not a present regular nonsymlink file with a valid SHA-256 and size" });
  if (forensicErrors.length || integrityErrors.length || !validSourceMain || !validArchiveMain) throw new Error(`${label} forensic source/archive construction is invalid; no probe was opened`);

  const probes = [];
  const safeDiff = (before, after, comparisonLabel) => {
    try { return equalInventory(before, after, comparisonLabel, true); }
    catch (error) { forensicErrors.push(errorReceipt(`${comparisonLabel} comparison`, error)); return [`${comparisonLabel} comparison failed`]; }
  };
  for (const probeName of ["probe-a", "probe-b"]) {
    const probeDir = join(ROOT, `readonly-sqlite-${label}-${probeName}`);
    const probeReceipt = { label: `${label} ${probeName}`, probeDir, sourceBefore, archiveBefore, probeBefore: null, probeAfter: null, sourceAfter: null, archiveAfter: null, sourceComparison: null, archiveComparison: null, probe: null, errors: [] };
    phaseReceipt.probes.push(probeReceipt);
    let probe = null;
    try {
      probe = await inspectSqliteProbe(probeDir, archiveBefore, projectId, expected, `${label} ${probeName}`, forensicErrors, probeReceipt);
      probeReceipt.probe = probe;
      probeReceipt.probeBefore = probe.probeBefore;
      probeReceipt.probeAfter = probe.probeAfter;
    } catch (error) {
      const receipt = errorReceipt(`${label} ${probeName} inspection`, error);
      probeReceipt.errors.push(receipt);
      forensicErrors.push(receipt);
    }
    if (probe) probes.push(probe);
    const sourceAfterProbe = readInventory(sourceDir, `${probeName} source-after`);
    const archiveAfterProbe = readInventory(archiveDir, `${probeName} archive-after`);
    probeReceipt.sourceAfter = sourceAfterProbe;
    probeReceipt.archiveAfter = archiveAfterProbe;
    const sourceDiff = safeDiff(sourceBefore, sourceAfterProbe, `${label} source after ${probeName}`);
    const archiveDiff = safeDiff(archiveBefore, archiveAfterProbe, `${label} archive after ${probeName}`);
    probeReceipt.sourceComparison = sourceDiff;
    probeReceipt.archiveComparison = archiveDiff;
    integrityErrors.push(...sourceDiff, ...archiveDiff);
    safeCheck(`${label} source remains byte/physical exact after ${probeName}`, sourceDiff.length === 0);
    safeCheck(`${label} unopened archive remains byte/physical exact after ${probeName}`, archiveDiff.length === 0);
  }
  const recordsEqual = probes.length === 2 && probes.every(probe => probe.records) && JSON.stringify(probes[0]?.records) === JSON.stringify(probes[1]?.records);
  safeCheck(`${label} independent fresh probe A/B decoded records and cursors are byte-equivalent`, recordsEqual);
  if (!recordsEqual) integrityErrors.push(`${label} independent probe records/cursors differ or are unavailable`);
  const finalSource = readInventory(sourceDir, "source-final");
  const finalArchive = readInventory(archiveDir, "archive-final");
  phaseReceipt.sourceAfter = finalSource;
  phaseReceipt.archiveAfter = finalArchive;
  integrityErrors.push(...safeDiff(sourceBefore, finalSource, `${label} source final`), ...safeDiff(archiveBefore, finalArchive, `${label} archive final`));
  const allErrors = [...forensicErrors, ...integrityErrors, ...probes.flatMap(probe => probe.errors ?? [])];
  if (allErrors.length) throw new Error(`${label} forensic integrity: ${allErrors.map(error => typeof error === "string" ? error : JSON.stringify(error)).join(" | ")}`);
  return { ...probes[0], sourceBefore, sourceAfter: finalSource, archiveBefore, archiveAfter: finalArchive, probes };
}

function publicNativeIdentity(show) {
  const inspection = show.durableInspection;
  return {
    conversationId: inspection?.coordinator?.conversationId,
    messageIds: inspection?.coordinator?.messages?.map(message => message.id),
    submissionIds: inspection?.coordinator?.submissions?.map(submission => submission.id),
    generationTaskIds: inspection?.coordinator?.generationTasks?.map(task => task.taskId),
  };
}
function assertPublicInspection(show, id, expected) {
  const inspection = show.durableInspection;
  pass("owner-native inspection identifies exact project/conversation", inspection?.identity?.projectId === id && inspection.identity.coordinatorConversationId === inspection.coordinator.conversationId && Number.isSafeInteger(inspection.coordinator.conversationId));
  const expectedSubmissions = [
    { requestId: expected.eventRequestId, id: expected.eventSubmissionId },
    { requestId: expected.scheduleRequestId, id: expected.scheduleSubmissionId },
  ];
  pass("owner-native inspection retains exact submission/entry IDs", expectedSubmissions.every(item => inspection?.coordinator?.submissions?.some(submission => submission.requestId === item.requestId && submission.id === item.id && submission.status === "done" && Number.isSafeInteger(submission.answerId) && inspection.coordinator.messages.some(message => message.id === submission.answerId))));
  const answerIds = new Set(inspection?.coordinator?.submissions?.map(submission => submission.answerId));
  pass("owner-native inspection ties native generation IDs to answer entries", expectedSubmissions.every(item => { const submission = inspection?.coordinator?.submissions?.find(value => value.requestId === item.requestId); return inspection?.coordinator?.generationTasks?.some(task => task.outcome?.result?.entryId === submission?.answerId && task.conversationId === inspection.coordinator.conversationId); }) && answerIds.size >= 2);
  pass("owner-native inspection polls successful generation tasks while host is alive", inspection?.coordinator?.generationTasks?.length >= 2 && inspection.coordinator.generationTasks.every(task => task.kind === "pi.generation" && task.conversationId === inspection.coordinator.conversationId && task.terminal && task.state === "terminal" && task.outcome?.status === "completed" && Number.isSafeInteger(task.outcome.result?.entryId)));
}
async function hostPhase(started) {
  const phaseErrors = [];
  const phaseReceipt = { startedAt: Date.now(), source: resolve("src/host.ts"), responses: [], health: [], errors: phaseErrors };
  observations.push({ hostPhase: phaseReceipt });
  const host = await startHost(started);
  phaseReceipt.host = { pid: host.child.pid, home: host.home, source: host.source, cwd: host.cwd, socket: host.socket };
  const recordRequest = transport => async (input, timeout) => {
    const requestStartedAt = Date.now();
    const timeoutReceipt = timeout === undefined ? {} : { timeout };
    try {
      const response = await transport(input, timeout);
      phaseReceipt.responses.push({ startedAt: requestStartedAt, durationMs: Date.now() - requestStartedAt, input, ...timeoutReceipt, response });
      return response;
    } catch (error) {
      const receipt = errorReceipt(`host phase ${input.action}`, error);
      phaseErrors.push(receipt);
      phaseReceipt.responses.push({ startedAt: requestStartedAt, durationMs: Date.now() - requestStartedAt, input, ...timeoutReceipt, error: receipt });
      throw error;
    }
  };
  const request = recordRequest(api(host.socket));
  resources.request = request;
  const readHealth = async (label, socket = host.socket) => {
    const at = Date.now();
    const response = await health(socket);
    phaseReceipt.health.push({ label, at, durationMs: Date.now() - at, socket, response });
    return response;
  };
  const created = await request({ action: "create", cwd: WORKSPACE, name: "Host positive schedule", objective: "Host positive schedule acceptance", model: MODEL });
  pass("public create returns actual UUID durable project", created.runtime === "durable" && /^[a-f0-9-]{36}$/.test(created.id));
  immutableProject(created, created.id);
  const id = created.id;
  host.projectId = id;
  phaseReceipt.host.projectId = id;
  phaseReceipt.created = created;
  phaseReceipt.projectId = id;
  const initial = await request({ action: "schedule-snapshot", id });
  phaseReceipt.initial = initial;
  pass("event opt-in is disabled by default", initial.eventOptIn === false);
  const quiet = await request({ action: "schedule-create", id, scheduleId: `disabled-${randomUUID()}`, atMs: Date.now() + 60_000, text: "disabled" });
  phaseReceipt.quiet = quiet;
  pass("one-shot schedule is disabled by default", quiet.enabled === false && quiet.kind === "once" && quiet.projectId === id);

  const eventId = `host-event-${randomUUID()}`;
  const eventPrompt = `[Owner-local event owner-local]\nReply exactly HOST_POSITIVE_EVENT`;
  const eventMarker = "HOST_POSITIVE_EVENT";
  await request({ action: "event-opt-in", id, enabled: true });
  const event = await request({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "Reply exactly HOST_POSITIVE_EVENT" });
  phaseReceipt.eventAdmission = event;
  pass("event admission returns exact request and native numeric result id", event.requestId === `event:${eventId}` && Number.isSafeInteger(event.submissionId) && event.submissionId > 0 && event.status === "submitted");
  const eventView = await waitFor(() => request({ action: "schedule-snapshot", id }), value => exactIntent(value, event.requestId, eventId)?.status === "submitted" && exactIntent(value, event.requestId, eventId)?.outcome === "completed", "event successful completion");
  phaseReceipt.eventView = eventView;
  const eventIntent = exactIntent(eventView, event.requestId, eventId);
  phaseReceipt.eventIntent = eventIntent;
  pass("event intent is submitted/completed, never done", eventIntent?.status === "submitted" && eventIntent?.outcome === "completed" && Number.isSafeInteger(eventIntent?.submissionId));

  const scheduleId = `host-schedule-${randomUUID()}`;
  const schedulePrompt = "Reply exactly HOST_POSITIVE_SCHEDULE";
  const schedule = await request({ action: "schedule-create", id, scheduleId, atMs: Date.now() + 1_000, text: schedulePrompt });
  phaseReceipt.scheduleAdmission = schedule;
  pass("enabled one-shot has exact public schedule fields", schedule.id === scheduleId && schedule.projectId === id && schedule.kind === "once" && schedule.text === schedulePrompt && schedule.enabled === false && Number.isSafeInteger(schedule.atMs));
  await request({ action: "schedule-enable", id, scheduleId, enabled: true });
  const scheduleView = await waitFor(() => request({ action: "schedule-snapshot", id }), value => exactIntent(value, `schedule:${scheduleId}:tick:${scheduleId}:${schedule.atMs}`, scheduleId)?.status === "submitted" && exactIntent(value, `schedule:${scheduleId}:tick:${scheduleId}:${schedule.atMs}`, scheduleId)?.outcome === "completed", "scheduled successful completion");
  phaseReceipt.scheduleView = scheduleView;
  const scheduleRequestId = `schedule:${scheduleId}:tick:${scheduleId}:${schedule.atMs}`;
  const scheduleIntent = exactIntent(scheduleView, scheduleRequestId, scheduleId);
  phaseReceipt.scheduleIntent = scheduleIntent;
  pass("one-shot uses exact tick request ID and is consumed", scheduleIntent?.requestId === scheduleRequestId && scheduleIntent.status === "submitted" && scheduleIntent.outcome === "completed" && scheduleView.schedules.find(item => item.id === scheduleId)?.enabled === false);

  const firstShow = await request({ action: "show", id });
  phaseReceipt.firstShow = firstShow;
  pass("first public show has exact documented schema", Object.keys(firstShow).sort().join(",") === "activeRuns,busy,durableInspection,evidence,inbox,jobs,messages,notes,project,runStates");
  pass("first public show has exact project identity/models", firstShow.project.id === id && firstShow.project.model === MODEL && JSON.stringify(firstShow.project.models) === JSON.stringify(ROLE_MODELS));
  pass("first public show exposes actual successful answers, not prompts", firstShow.messages.some(message => message.role === "assistant" && message.text === eventMarker && message.text !== eventPrompt) && firstShow.messages.some(message => message.role === "assistant" && message.text === "HOST_POSITIVE_SCHEDULE" && message.text !== schedulePrompt));
  const firstSchedule = await request({ action: "schedule-snapshot", id });
  phaseReceipt.firstSchedule = firstSchedule;
  const firstProject = JSON.parse(JSON.stringify(firstShow.project));
  const firstRecords = { eventRequestId: event.requestId, eventSubmissionId: event.submissionId, scheduleRequestId, scheduleSubmissionId: scheduleIntent.submissionId };
  phaseReceipt.firstProject = firstProject;
  phaseReceipt.firstRecords = firstRecords;
  assertPublicInspection(firstShow, id, firstRecords);
  const firstHealth = await readHealth("first-live");
  pass("first live checkpoint has exact health PID/home/source", firstHealth?.data?.pid === host.child.pid && firstHealth.data.home === HOME && host.source === resolve("src/host.ts"));

  await stopHost(host, request);
  resources.host = null; resources.request = null;
  const firstClosed = await forensicCopy(id, { event: { label: "event", requestId: event.requestId, submissionId: event.submissionId, prompt: eventPrompt, marker: eventMarker }, schedule: { label: "schedule", requestId: scheduleRequestId, submissionId: scheduleIntent.submissionId, prompt: schedulePrompt, marker: "HOST_POSITIVE_SCHEDULE" } }, HOME, "first-closed");
  phaseReceipt.firstClosed = firstClosed;
  const reopenedStarted = Date.now();
  const reopenedHost = await startHost(reopenedStarted);
  reopenedHost.projectId = id;
  phaseReceipt.reopenedHost = { pid: reopenedHost.child.pid, home: reopenedHost.home, source: reopenedHost.source, cwd: reopenedHost.cwd, socket: reopenedHost.socket, projectId: id };
  const reopenedRequest = recordRequest(api(reopenedHost.socket));
  resources.host = reopenedHost; resources.request = reopenedRequest;
  const reopenedShow = await reopenedRequest({ action: "show", id });
  phaseReceipt.reopenedShow = reopenedShow;
  const reopenedSchedule = await reopenedRequest({ action: "schedule-snapshot", id });
  phaseReceipt.reopenedSchedule = reopenedSchedule;
  pass("reopened public show preserves exact project immutable fields", reopenedShow.project.id === id && reopenedShow.project.model === MODEL && JSON.stringify(reopenedShow.project.models) === JSON.stringify(ROLE_MODELS));
  immutableProject(reopenedShow.project, id);
  pass("reopened public show preserves exact assistant full replies", reopenedShow.messages.some(message => message.role === "assistant" && message.text === eventMarker) && reopenedShow.messages.some(message => message.role === "assistant" && message.text === "HOST_POSITIVE_SCHEDULE"));
  assertPublicInspection(reopenedShow, id, firstRecords);
  const reopenedHealth = await readHealth("reopened-live", reopenedHost.socket);
  pass("reopened live checkpoint has exact health PID/home/source", reopenedHealth?.data?.pid === reopenedHost.child.pid && reopenedHealth.data.home === HOME && reopenedHost.source === resolve("src/host.ts"));
  pass("reopened public show preserves exact public schema", Object.keys(reopenedShow).sort().join(",") === Object.keys(firstShow).sort().join(","));
  pass("reopened schedule preserves exact event/schedule IDs/status/outcomes", JSON.stringify(reopenedSchedule) === JSON.stringify(firstSchedule));
  const duplicateBeforeShow = await reopenedRequest({ action: "show", id });
  const duplicateBeforeIds = publicNativeIdentity(duplicateBeforeShow);
  const duplicateBefore = await reopenedRequest({ action: "schedule-snapshot", id });
  phaseReceipt.duplicateBefore = { show: duplicateBeforeShow, identity: duplicateBeforeIds, state: duplicateBefore };
  const duplicate = await reopenedRequest({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "Reply exactly HOST_POSITIVE_EVENT" });
  phaseReceipt.duplicateAdmission = duplicate;
  pass("duplicate event returns same native result id, not a new submission", duplicate.requestId === event.requestId && duplicate.submissionId === event.submissionId && duplicate.status === "submitted");
  const afterDuplicate = await reopenedRequest({ action: "schedule-snapshot", id });
  const duplicateAfterShow = await reopenedRequest({ action: "show", id });
  phaseReceipt.duplicateAfter = { state: afterDuplicate, show: duplicateAfterShow, identity: publicNativeIdentity(duplicateAfterShow) };
  pass("duplicate event produces no new owner-native identity set", JSON.stringify(publicNativeIdentity(duplicateAfterShow)) === JSON.stringify(duplicateBeforeIds));
  pass("duplicate event preserves exact completed public state", JSON.stringify(afterDuplicate) === JSON.stringify(duplicateBefore) && afterDuplicate.intents.filter(item => item.requestId === event.requestId).length === 1);
  const conflictBefore = await reopenedRequest({ action: "schedule-snapshot", id });
  let conflictError = null;
  try { await reopenedRequest({ action: "event-ingest", id, eventId, kind: "owner-local", payload: "conflicting payload" }); } catch (error) { conflictError = error; }
  const conflictAfter = await reopenedRequest({ action: "schedule-snapshot", id });
  phaseReceipt.conflictingEvent = { before: conflictBefore, error: conflictError && errorReceipt("conflicting event", conflictError), after: conflictAfter };
  pass("conflicting event ID is rejected", conflictError instanceof Error);
  pass("conflicting event rejection preserves exact state", JSON.stringify(conflictAfter) === JSON.stringify(conflictBefore));
  const scheduleConflictBefore = await reopenedRequest({ action: "schedule-snapshot", id });
  let scheduleConflictError = null;
  try { await reopenedRequest({ action: "schedule-create", id, scheduleId, atMs: schedule.atMs + 1, text: "conflicting schedule" }); } catch (error) { scheduleConflictError = error; }
  const scheduleConflictAfter = await reopenedRequest({ action: "schedule-snapshot", id });
  phaseReceipt.conflictingSchedule = { before: scheduleConflictBefore, error: scheduleConflictError && errorReceipt("conflicting schedule", scheduleConflictError), after: scheduleConflictAfter };
  pass("conflicting schedule ID is rejected", scheduleConflictError instanceof Error);
  pass("conflicting schedule rejection preserves exact state", JSON.stringify(scheduleConflictAfter) === JSON.stringify(scheduleConflictBefore));
  const consumedBefore = await reopenedRequest({ action: "schedule-snapshot", id });
  let consumedError = null;
  try { await reopenedRequest({ action: "schedule-enable", id, scheduleId, enabled: true }); } catch (error) { consumedError = error; }
  const consumedAfter = await reopenedRequest({ action: "schedule-snapshot", id });
  phaseReceipt.consumedSchedule = { before: consumedBefore, error: consumedError && errorReceipt("consumed schedule", consumedError), after: consumedAfter };
  pass("consumed one-shot re-enable is rejected", consumedError instanceof Error);
  pass("consumed re-enable rejection preserves exact state", JSON.stringify(consumedAfter) === JSON.stringify(consumedBefore));
  const reopenedProject = JSON.parse(JSON.stringify(reopenedShow.project));
  phaseReceipt.reopenedProject = reopenedProject;
  for (const key of ["version", "id", "name", "cwd", "objective", "runtime", "model", "models", "sessionFile"]) pass(`reopen preserves immutable configured field ${key}`, JSON.stringify(reopenedProject[key]) === JSON.stringify(firstProject[key]));
  await stopHost(reopenedHost, reopenedRequest);
  resources.host = null; resources.request = null;
  const secondClosed = await forensicCopy(id, { event: { label: "event", requestId: event.requestId, submissionId: event.submissionId, prompt: eventPrompt, marker: eventMarker }, schedule: { label: "schedule", requestId: scheduleRequestId, submissionId: scheduleIntent.submissionId, prompt: schedulePrompt, marker: "HOST_POSITIVE_SCHEDULE" } }, HOME, "second-closed");
  phaseReceipt.secondClosed = secondClosed;
  for (const table of ["submissions", "entries", "tasks", "conversations", "documents", "revisions", "cursors"]) pass(`first-closed and reopened-closed ${table} records are byte-equivalent`, JSON.stringify(firstClosed.records[table]) === JSON.stringify(secondClosed.records[table]));
  pass("first-closed and reopened-closed docs preserve latest revisions", JSON.stringify(firstClosed.documents) === JSON.stringify(secondClosed.documents));
  return { id, firstShow, reopenedShow, firstSchedule, reopenedSchedule: afterDuplicate, firstProject, reopenedProject, firstRecords, firstClosed, secondClosed, phaseReceipt };
}

async function modelAvailability() {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const models = await bounded(() => ModelRuntime.create({ allowModelNetwork: false }), "SDK model availability", 30_000);
  for (const model of [MODEL, ROLE_MODELS.scout, ROLE_MODELS.reviewer]) {
    const [provider, id] = model.split("/", 2);
    pass(`SDK exposes configured host model ${model}`, Boolean(models.getModel(provider, id)));
    pass(`SDK reports configured auth for ${provider}`, models.getProviderAuthStatus(provider).configured === true);
  }
}

function samePreservation(before, after) {
  if (!before || !after) return false;
  const physicalSame = before.exists === after.exists && before.isFile === after.isFile && before.isDirectory === after.isDirectory && before.isSymbolicLink === after.isSymbolicLink && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.target === after.target && before.status === after.status;
  if (!physicalSame) return false;
  const left = before.effective;
  const right = after.effective;
  if (!left || !right || left.status !== right.status || left.exists !== right.exists || left.regular !== right.regular || left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode || left.sha256 !== right.sha256 || left.length !== right.length) return false;
  return !left.bytes || left.bytes.equals(right.bytes);
}
function settingsReceipt(path) {
  const receipt = physical(path);
  const effective = effectiveSettings(path, receipt);
  return { ...receipt, bytes: effective.bytes, length: effective.length, sha256: effective.sha256, effective };
}
function safeCheck(label, value) { checks.push(label); process.stderr.write(`${value ? "PASS" : "FAIL"} ${label}\n`); return value; }
function errorReceipt(stage, error) {
  return { stage, name: error?.name ?? typeof error, message: error?.message ?? String(error), stack: error?.stack, code: errorCode(error) };
}
function safePhysical(path, stage, errors) {
  try { return physical(path); }
  catch (error) { const receipt = errorReceipt(stage, error); errors.push(receipt); return { path, error: receipt }; }
}
function safeEffectiveSettings(path, stage, errors) {
  try { return settingsReceipt(path); }
  catch (error) { const receipt = errorReceipt(stage, error); errors.push(receipt); return { path, error: receipt }; }
}
function appendErrors(base, entries, label) {
  if (!entries.length) return base;
  const suffix = `${label}: ${entries.map(error => typeof error === "string" ? error : JSON.stringify(error)).join(" | ")}`;
  if (base) { base.message = `${base.message}; ${suffix}`; return base; }
  return new Error(suffix);
}
function stderrReceipt(stage, error) {
  try { process.stderr.write(`ERROR ${stage}: ${String(error)}\\n`); } catch { /* stderr itself may be unavailable */ }
}
function publicSettingsReceipt(value) {
  if (!value) return value;
  const { bytes, effective, ...receipt } = value;
  return { ...receipt, effective: effective && (({ bytes: ignoredBytes, ...safe }) => safe)(effective) };
}
async function main() {
  const started = Date.now();
  let failure = null;
  const cleanupErrors = [];
  const preservationErrors = [];
  const inventoryErrors = [];
  try {
    // Static setup and preimages precede SDK availability and every host operation.
    await capturePreservationPreimages();
    await modelAvailability();
    const result = await hostPhase(started);
    observations.push({ pathPreimages: { ...pathPreimages, settings: { global: publicSettingsReceipt(settingsPreimages.global), project: publicSettingsReceipt(settingsPreimages.project) } }, hostPhase: result.phaseReceipt, firstClosed: result.firstClosed, secondClosed: result.secondClosed });
  } catch (error) { failure = error; }
  finally {
    // Keep the owned resource until stopHost has observed its close; never mask the primary failure.
    if (resources.host) {
      try {
        await stopHost(resources.host, resources.request);
        if (resources.host.closed) { resources.host = null; resources.request = null; }
      } catch (error) { cleanupErrors.push(errorReceipt("host cleanup", error)); }
    }
    let settingsCompare = null;
    const settingsBefore = { global: settingsPreimages?.global, project: settingsPreimages?.project };
    try {
      const globalAfter = safeEffectiveSettings(globalSettingsPath, "global settings final read", inventoryErrors);
      const projectAfter = safeEffectiveSettings(projectSettingsPath, "project settings final read", inventoryErrors);
      settingsCompare = { global: { before: publicSettingsReceipt(settingsBefore.global), after: publicSettingsReceipt(globalAfter) }, project: { before: publicSettingsReceipt(settingsBefore.project), after: publicSettingsReceipt(projectAfter) } };
      const globalOk = samePreservation(settingsBefore.global, globalAfter);
      const projectOk = samePreservation(settingsBefore.project, projectAfter);
      safeCheck("global settings final physical preimage/bytes unchanged", globalOk);
      safeCheck("project settings final physical preimage/bytes unchanged", projectOk);
      if (!globalOk) preservationErrors.push("global settings preservation mismatch");
      if (!projectOk) preservationErrors.push("project settings preservation mismatch");
    } catch (error) { preservationErrors.push(errorReceipt("settings comparison", error)); }
    observations.push({ settingsCompare, cleanupErrors, preservationErrors, inventoryErrors });

    let inventory;
    try {
      const paths = {};
      for (const [name, path] of [["root", ROOT], ["state", HOME], ["plaincwd", WORKSPACE], ["globalSettings", globalSettingsPath], ["projectSettings", projectSettingsPath]]) paths[name] = safePhysical(path, `failure inventory ${name}`, inventoryErrors);
      inventory = { paths, settings: settingsCompare, preimages: { global: publicSettingsReceipt(settingsBefore.global), project: publicSettingsReceipt(settingsBefore.project) }, cleanupErrors, preservationErrors, inventoryErrors, source: "failure inventory records physical paths/status/hashes only; SDK/global-setting bytes are never dumped" };
    } catch (error) {
      inventoryErrors.push(errorReceipt("failure inventory construction", error));
      inventory = { paths: {}, cleanupErrors, preservationErrors, inventoryErrors, source: "failure inventory construction failed; receipts are in metadata" };
    }
    try {
      writeFileSync(join(ROOT, "failure-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      const receipt = errorReceipt("failure inventory write", error);
      inventoryErrors.push(receipt);
      stderrReceipt("failure inventory write", error);
    }
  }
  const attached = [...cleanupErrors, ...preservationErrors, ...inventoryErrors];
  failure = appendErrors(failure, attached, "cleanup/preservation/inventory");
  let report = null;
  try {
    report = failure ? { ok: false, checks, observations, error: String(failure) } : { ok: true, checks, observations, source: sha(new URL(import.meta.url).pathname) };
  } catch (error) {
    const receipt = errorReceipt("report construction", error);
    stderrReceipt("report construction", error);
    failure = appendErrors(failure, [receipt], "report");
    report = { ok: false, checks, observations, error: String(failure) };
  }
  try {
    writeFileSync(join(ROOT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    const receipt = errorReceipt("report write", error);
    stderrReceipt("report write", error);
    failure = appendErrors(failure, [receipt], "report");
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ ok: true, root: ROOT, checks: checks.length, scope: "host-positive-only" }));
}
try { await main(); } catch (error) { throw error; }
