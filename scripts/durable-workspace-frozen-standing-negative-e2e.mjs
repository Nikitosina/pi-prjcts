#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDurableProject } from "../src/durable-runtime.ts";
import { projectDir, saveProject } from "../src/state.ts";

const root = resolve("artifacts", `durable-workspace-frozen-standing-negative-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const state = join(root, "state");
const sha = value => createHash("sha256").update(value).digest("hex");
const fileSha = path => sha(readFileSync(path));
const git = (...args) => execFileSync("/usr/bin/git", args, { encoding: "utf8" }).trim();
const sourceFiles = ["src/durable-standing.ts", "src/durable-planning.ts", "src/durable-runtime.ts", "src/durable-workspace-binding.ts"];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(path => [path, fileSha(path)]));
const observed = path => existsSync(path) ? { path, bytes: readFileSync(path).length, sha: fileSha(path) } : { path, absent: true };
const save = () => {
  const path = join(root, "report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};
const stat = path => { const value = lstatSync(path, { bigint: true }); return { path, dev: value.dev.toString(), ino: value.ino.toString() }; };

mkdirSync(root, { recursive: true });
process.env.PI_PROJECTS_HOME = state;
const originalStanding = "Worker standing instruction: preserve the assigned workspace.";
const changedStanding = "Worker standing instruction: inspect the assigned workspace.";
const report = { sourceBefore: sourceHashes(), events: [] };
let runtime;
const requests = [];
const streams = [];
let preparedMetadata;
const preparationMetadata = [];
let preparationCalls = 0;
const toolRecords = (from = 0, to = requests.length) => {
  const selected = requests.slice(from, to);
  const calls = selected.flatMap((request, requestIndex) => request.messages
    .filter(message => message.role === "assistant" && Array.isArray(message.content))
    .flatMap(message => message.content.filter(part => part.type === "toolCall").map(part => ({ conversationId: request.conversationId, requestIndex: from + requestIndex, callId: part.id ?? part.toolCallId ?? null, name: part.name, arguments: part.arguments }))));
  const results = selected.flatMap((request, requestIndex) => request.messages
    .filter(message => message.role === "toolResult")
    .map(message => ({ conversationId: request.conversationId, requestIndex: from + requestIndex, toolCallId: message.toolCallId ?? null, toolName: message.toolName, isError: message.isError, details: message.details, content: message.content })));
  const unique = (records, identity) => { const seen = new Map(); for (const record of records) { const key = identity(record); if (!seen.has(key)) seen.set(key, record); } return [...seen.values()]; };
  return { calls: unique(calls, record => `${record.conversationId}:${record.callId ?? JSON.stringify(record)}`), results: unique(results, record => `${record.conversationId}:${record.toolCallId ?? JSON.stringify(record)}`) };
};
const resultJson = result => {
  const text = Array.isArray(result?.content) ? result.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
  try { return JSON.parse(text); } catch { return null; }
};
const assertPreparationMetadata = (metadata, expectedThreadId, expectedWorkId = null) => {
  for (const field of ["conversationId", "workId", "threadId", "cwd", "bindingRevision"]) {
    assert.ok(metadata && metadata[field] !== undefined && metadata[field] !== null, `preparation metadata missing ${field}`);
    assert.ok(typeof metadata[field] === (field === "conversationId" ? "number" : "string"), `preparation metadata type ${field}`);
    if (field !== "conversationId") assert.ok(metadata[field].length > 0, `preparation metadata empty ${field}`);
  }
  if (expectedWorkId) assert.equal(metadata.workId, expectedWorkId);
  assert.equal(metadata.threadId, expectedThreadId);
};
try {
  const owner = join(root, "owner");
  const approvedRoot = join(root, "alloc");
  mkdirSync(owner);
  mkdirSync(approvedRoot);
  git("init", "-b", "main", owner);
  git("-C", owner, "config", "user.email", "e2e@example.invalid");
  git("-C", owner, "config", "user.name", "e2e");
  writeFileSync(join(owner, "AGENTS.md"), `${originalStanding}\n`);
  mkdirSync(join(owner, "owned"));
  writeFileSync(join(owner, "owned", "sentinel.txt"), "OWNER\n");
  git("-C", owner, "add", ".");
  git("-C", owner, "commit", "-m", "fixture");
  const baseRevision = git("-C", owner, "rev-parse", "HEAD");
  const scopeId = randomUUID();
  const threadId = randomUUID();
  const workId = randomUUID();
  const projectId = randomUUID();
  const ownerId = `agent-session-${randomUUID()}`;
  const assignedRelative = "owned/write.txt";
  const project = {
    version: 1, id: projectId, name: "frozen standing negative", cwd: owner, objective: "frozen standing negative",
    createdAt: new Date().toISOString(), model: "openai-codex/gpt-5.6-terra",
    models: { worker: "openai-codex/gpt-5.6-terra", scout: "openai-codex/gpt-5.6-terra", reviewer: "openai-codex/gpt-5.6-terra" },
    sessionFile: null, phase: "ready", problem: null, runs: [],
    workspaceAuthorization: { version: 1, provider: "github", owner: ownerId, repositories: [{ repositoryId: "local", provider: "github", ownerCheckout: owner, approvedRoot, fileOwnershipPrefix: "owned" }], scopes: [{ id: scopeId, repositoryId: "local", files: [assignedRelative], baseRevision }] },
  };
  const authorizationBaseline = JSON.parse(JSON.stringify(project.workspaceAuthorization));
  saveProject(project);
  // Use the host preparation callback for a real baseline allocation, then release it at once.
  const preparationHeld = Promise.resolve();
  const open = () => openDurableProject({ project, dir: projectDir(projectId), workerCap: 1,
    testAfterWorkerPreparation: async metadata => { assertPreparationMetadata(metadata, threadId); preparationCalls++; preparationMetadata.push(metadata); report.events.push({ at: Date.now(), kind: "prepared", metadata }); if (!preparedMetadata) preparedMetadata = metadata; await preparationHeld; report.events.push({ at: Date.now(), kind: "preparation-released" }); },
    onModelRequest: request => requests.push({ conversationId: request.conversationId, at: Date.now(), messages: request.messages }),
    onGenerationLifecycle: event => streams.push(event),
  });
  runtime = await open();
  const beforeCode = {
    owner: stat(owner), assigned: observed(join(owner, assignedRelative)), peer: observed(join(owner, "owned", "peer.txt")),
    head: git("-C", owner, "rev-parse", "HEAD"), branch: git("-C", owner, "branch", "--show-current"),
    status: git("-C", owner, "status", "--porcelain=v1", "--untracked-files=all"), inventory: git("-C", owner, "worktree", "list", "--porcelain"),
  };
  const ownerPaths = { assigned: observed(join(owner, assignedRelative)), peer: observed(join(owner, "owned", "peer.txt")), sentinel: observed(join(owner, "owned", "sentinel.txt")) };
  report.preimage = { ...beforeCode, ownerPaths };
  await runtime.plan({ work: [{ id: workId, threadId, role: "worker", workspaceScopeId: scopeId, text: "You must use the offered assigned-workspace tools. Read owned/write.txt, then call the offered workspace write tool for path owned/write.txt with exactly BASELINE\\n and the read revision (null if absent). Do not answer until the write result is returned." }] });
  const deadline = Date.now() + 60000;
  while (!preparedMetadata && Date.now() < deadline) await sleep(25);
  if (!preparedMetadata) throw new Error("pause-after-baseline timeout");
  let baselineSnapshot;
  while (Date.now() < deadline) {
    baselineSnapshot = await runtime.planSnapshot();
    const baselineWork = baselineSnapshot.work.find(candidate => candidate.id === workId);
    if (baselineWork?.status === "completed" || baselineWork?.status === "failed" || baselineWork?.status === "blocked") break;
    await sleep(25);
  }
  const baselineWork = baselineSnapshot?.work.find(candidate => candidate.id === workId);
  assert.equal(baselineWork?.status, "completed", JSON.stringify(baselineSnapshot));
  assert.equal(baselineWork.id, workId);
  assertPreparationMetadata(preparedMetadata, threadId, workId);
  assert.equal(preparedMetadata.workId, baselineWork.id);
  assert.equal(baselineWork.threadId, threadId);
  assert.equal(baselineWork.role, "worker");
  for (const field of ["model", "thinking", "instructions", "cwd", "toolNames", "bindingRevision", "standingRevision"]) assert.ok(baselineWork.attempt?.[field] !== undefined && baselineWork.attempt?.[field] !== null, `baseline profile missing ${field}`);
  assert.equal(baselineWork.attempt.cwd, preparedMetadata.cwd);
  assert.equal(baselineWork.attempt.bindingRevision, preparedMetadata.bindingRevision);
  const baselineRequestCount = requests.length;
  const baselineStreamCount = streams.length;
  assert.ok(baselineRequestCount > 0);
  assert.ok(baselineStreamCount > 0, "baseline must have genuine generation lifecycle events");
  const baselineTools = toolRecords(0, baselineRequestCount);
  const baselineWriteCall = baselineTools.calls.find(call => call.name.endsWith("_write") && call.arguments?.path === assignedRelative && call.arguments?.text === "BASELINE\n" && call.arguments?.expectedRevision === null);
  assert.ok(baselineWriteCall?.callId, JSON.stringify(baselineTools.calls));
  const baselineWriteResult = baselineTools.results.find(result => result.toolCallId === baselineWriteCall.callId && result.toolName === baselineWriteCall.name && result.isError === false && resultJson(result)?.path === assignedRelative);
  assert.ok(baselineWriteResult, JSON.stringify(baselineTools.results));
  const baselineEffect = resultJson(baselineWriteResult);
  assert.equal(baselineEffect.revision, sha(Buffer.from("BASELINE\n")));
  assert.equal(baselineEffect.bytes, 9);
  assert.ok(baselineEffect.effect && baselineEffect.receipt);
  assert.equal(typeof baselineEffect.receipt, "string");
  assert.ok(baselineEffect.receipt.length > 0);
  assert.equal(baselineEffect.effect.endsWith(`:${baselineWriteCall.callId}`), true);
  assert.equal(baselineWriteCall.conversationId, preparedMetadata.conversationId);
  assert.equal(baselineWriteResult.conversationId, baselineWriteCall.conversationId);
  assert.equal(baselineEffect.bytes, Buffer.byteLength("BASELINE\n"));
  assert.equal(observed(join(preparedMetadata.cwd, assignedRelative)).bytes, Buffer.byteLength("BASELINE\n"));
  assert.equal(readFileSync(join(preparedMetadata.cwd, assignedRelative), "utf8"), "BASELINE\n");
  const baselineObservation = observed(join(preparedMetadata.cwd, assignedRelative));
  const baselineOwner = { assigned: observed(join(owner, assignedRelative)), peer: observed(join(owner, "owned", "peer.txt")), sentinel: observed(join(owner, "owned", "sentinel.txt")) };
  assert.deepEqual(baselineOwner, ownerPaths);
  const beforePause = await runtime.planSnapshot();
  const pausing = runtime.pausePlan();
  let pausedBeforeRelease;
  while (Date.now() < deadline) {
    const snapshot = await runtime.planSnapshot();
    if (snapshot.paused) { pausedBeforeRelease = snapshot; break; }
    await sleep(25);
  }
  if (!pausedBeforeRelease) throw new Error("pause-after-baseline timeout");
  report.events.push({ at: Date.now(), kind: "pause-requested-after-baseline", snapshot: pausedBeforeRelease });
  const pausedDisk = { owner: stat(owner), workspace: stat(preparedMetadata.cwd), assigned: observed(join(preparedMetadata.cwd, assignedRelative)), peer: observed(join(preparedMetadata.cwd, "owned", "peer.txt")), head: git("-C", preparedMetadata.cwd, "rev-parse", "HEAD"), branch: git("-C", preparedMetadata.cwd, "branch", "--show-current"), status: git("-C", preparedMetadata.cwd, "status", "--porcelain=v1", "--untracked-files=all"), inventory: git("-C", preparedMetadata.cwd, "worktree", "list", "--porcelain") };
  const paused = await pausing;
  await sleep(500);
  const afterPause = await runtime.planSnapshot();
  const afterPauseDisk = { owner: stat(owner), workspace: stat(preparedMetadata.cwd), assigned: observed(join(preparedMetadata.cwd, assignedRelative)), peer: observed(join(preparedMetadata.cwd, "owned", "peer.txt")), head: git("-C", preparedMetadata.cwd, "rev-parse", "HEAD"), branch: git("-C", preparedMetadata.cwd, "branch", "--show-current"), status: git("-C", preparedMetadata.cwd, "status", "--porcelain=v1", "--untracked-files=all"), inventory: git("-C", owner, "worktree", "list", "--porcelain") };
  assert.equal(afterPause.paused, true);
  assert.equal(requests.length, baselineRequestCount);
  assert.equal(streams.length, baselineStreamCount);
  assert.deepEqual({ assigned: ownerPaths.assigned, peer: ownerPaths.peer, sentinel: ownerPaths.sentinel }, { assigned: observed(join(owner, assignedRelative)), peer: observed(join(owner, "owned", "peer.txt")), sentinel: observed(join(owner, "owned", "sentinel.txt")) });
  await runtime.close(); runtime = undefined;

  const originalOwnerStandingBytes = readFileSync(join(owner, "AGENTS.md"));
  writeFileSync(join(owner, "AGENTS.md"), `${changedStanding}\n`);
  const changedOwnerHash = fileSha(join(owner, "AGENTS.md"));
  report.standing = {
    ownerFile: "AGENTS.md",
    originalOwnerBytes: originalOwnerStandingBytes.length,
    originalOwnerHash: sha(originalOwnerStandingBytes),
    changedOwnerBytes: readFileSync(join(owner, "AGENTS.md")).length,
    changedOwnerHash,
    source: "owner AGENTS.md bytes captured directly",
  }; 
  report.events.push({ at: Date.now(), kind: "approved-owner-standing-mutation", path: "AGENTS.md" });
  runtime = await open();
  const reopened = await runtime.planSnapshot();
  const resumed = await runtime.resumePlan();
  let followUpAttempt;
  let admissionError;
  try { followUpAttempt = await runtime.followUp(threadId, "Resume the same worker thread.", { requestId: `frozen-standing-${randomUUID()}` }); } catch (error) { admissionError = { name: error?.name ?? "Error", message: error instanceof Error ? error.message : String(error) }; }
  assert.ok(admissionError?.message.includes("Existing durable thread profile does not match frozen role/settings/tool bindings"), JSON.stringify(admissionError));
  const rejection = admissionError;
  const rejectionOwner = { paths: { assigned: observed(join(owner, assignedRelative)), peer: observed(join(owner, "owned", "peer.txt")), sentinel: observed(join(owner, "owned", "sentinel.txt")) }, head: git("-C", owner, "rev-parse", "HEAD"), branch: git("-C", owner, "branch", "--show-current"), status: git("-C", owner, "status", "--porcelain=v1", "--untracked-files=all") };
  const changedOwnerStandingAtRejection = readFileSync(join(owner, "AGENTS.md"));
  assert.deepEqual(changedOwnerStandingAtRejection, Buffer.from(`${changedStanding}\n`));
  const changedOwnerObservationAtRejection = { bytes: changedOwnerStandingAtRejection.length, sha: sha(changedOwnerStandingAtRejection), base64: changedOwnerStandingAtRejection.toString("base64") };
  assert.equal(changedOwnerObservationAtRejection.sha, changedOwnerHash);
  report.standing.rejectedChangedOwnerObservation = changedOwnerObservationAtRejection;
  assert.deepEqual(rejectionOwner.paths, ownerPaths);
  assert.equal(rejectionOwner.head, beforeCode.head);
  assert.equal(rejectionOwner.branch, beforeCode.branch);
  assert.equal(rejectionOwner.status, "M AGENTS.md");
  assert.deepEqual(observed(join(preparedMetadata.cwd, assignedRelative)), pausedDisk.assigned);
  assert.equal(readFileSync(join(preparedMetadata.cwd, assignedRelative), "utf8"), "BASELINE\n");
  assert.equal(preparationCalls, 1);
  assert.equal(requests.length, baselineRequestCount);
  assert.equal(streams.length, baselineStreamCount);
  const negativePreparationCalls = preparationCalls;
  const negativeRequests = requests.length;
  const negativeStreams = streams.length;
  assert.equal(negativePreparationCalls - 1, 0);
  assert.equal(negativeRequests - baselineRequestCount, 0);
  assert.equal(negativeStreams - baselineStreamCount, 0);
  const failureDisk = { owner: stat(owner), workspace: stat(preparedMetadata.cwd), assigned: observed(join(preparedMetadata.cwd, assignedRelative)), peer: observed(join(preparedMetadata.cwd, "owned", "peer.txt")), head: git("-C", preparedMetadata.cwd, "rev-parse", "HEAD"), branch: git("-C", preparedMetadata.cwd, "branch", "--show-current"), status: git("-C", preparedMetadata.cwd, "status", "--porcelain=v1", "--untracked-files=all"), inventory: git("-C", preparedMetadata.cwd, "worktree", "list", "--porcelain"), ownerHead: git("-C", owner, "rev-parse", "HEAD"), ownerBranch: git("-C", owner, "branch", "--show-current"), ownerStatus: git("-C", owner, "status", "--porcelain=v1", "--untracked-files=all"), ownerInventory: git("-C", owner, "worktree", "list", "--porcelain") };
  const negativeIdentities = (await runtime.snapshot()).identities;
  await runtime.close(); runtime = undefined;
  writeFileSync(join(owner, "AGENTS.md"), originalOwnerStandingBytes);
  assert.deepEqual(readFileSync(join(owner, "AGENTS.md")), originalOwnerStandingBytes);
  runtime = await open();
  const restorationOpened = await runtime.planSnapshot();
  const restorationResumed = await runtime.resumePlan();
  const restorationRequestId = `frozen-standing-restore-${randomUUID()}`;
  const restorationAttemptReceipt = await runtime.followUp(threadId, "Restore owned/write.txt by calling the offered workspace write tool with exactly RESTORED\\n and expectedRevision equal to the prior BASELINE file revision. Do not answer until the successful write result is returned.", { requestId: restorationRequestId });
  const restorationAttemptId = restorationAttemptReceipt.attemptId ?? restorationAttemptReceipt;
  const restorationDeadline = Date.now() + 60000;
  let restorationSnapshot;
  while (Date.now() < restorationDeadline) {
    restorationSnapshot = await runtime.planSnapshot();
    const candidate = restorationSnapshot.work.filter(work => work.threadId === threadId).at(-1);
    if (candidate?.status === "completed" || candidate?.status === "failed" || candidate?.status === "blocked") break;
    await sleep(25);
  }
  const restorationWork = restorationSnapshot?.work.filter(work => work.threadId === threadId).at(-1);
  assert.equal(restorationWork?.status, "completed", JSON.stringify(restorationSnapshot));
  assert.equal(restorationWork.id, restorationAttemptId);
  const restorationTools = toolRecords(negativeRequests);
  const restorationCall = restorationTools.calls.find(call => call.name.endsWith("_write") && call.arguments?.path === assignedRelative && call.arguments?.text === "RESTORED\n" && call.arguments?.expectedRevision === baselineEffect.revision);
  assert.ok(restorationCall?.callId, JSON.stringify(restorationTools.calls));
  const restorationResult = restorationTools.results.find(result => result.toolCallId === restorationCall.callId && result.toolName === restorationCall.name && result.isError === false && resultJson(result)?.path === assignedRelative);
  assert.ok(restorationResult, JSON.stringify(restorationTools.results));
  const restorationEffect = resultJson(restorationResult);
  assert.equal(restorationEffect.revision, sha(Buffer.from("RESTORED\n")));
  assert.equal(restorationEffect.bytes, 9);
  assert.ok(restorationEffect.effect && restorationEffect.receipt);
  assert.equal(restorationEffect.effect.endsWith(`:${restorationCall.callId}`), true);
  assert.equal(restorationEffect.receipt, baselineEffect.receipt);
  const recordedAllocationIdentity = { receipt: baselineEffect.receipt, conversationId: preparedMetadata.conversationId, workspace: preparedMetadata.cwd };
  assert.equal(restorationEffect.receipt, recordedAllocationIdentity.receipt);
  assert.notEqual(restorationEffect.effect, baselineEffect.effect);
  assert.equal(restorationCall.conversationId, preparedMetadata.conversationId);
  assert.equal(restorationResult.conversationId, restorationCall.conversationId);
  assert.equal(readFileSync(join(preparedMetadata.cwd, assignedRelative), "utf8"), "RESTORED\n");
  const restorationDisk = { owner: stat(owner), workspace: stat(preparedMetadata.cwd), assigned: observed(join(preparedMetadata.cwd, assignedRelative)), peer: observed(join(preparedMetadata.cwd, "owned", "peer.txt")), head: git("-C", preparedMetadata.cwd, "rev-parse", "HEAD"), branch: git("-C", preparedMetadata.cwd, "branch", "--show-current"), status: git("-C", preparedMetadata.cwd, "status", "--porcelain=v1", "--untracked-files=all"), inventory: git("-C", preparedMetadata.cwd, "worktree", "list", "--porcelain") };
  const restorationIdentities = (await runtime.snapshot()).identities;
  assert.equal(preparationCalls, 2);
  const restoredMetadata = preparationMetadata.at(-1);
  assert.ok(restoredMetadata);
  assertPreparationMetadata(restoredMetadata, threadId, restorationWork.id);
  for (const field of ["conversationId", "threadId", "cwd", "bindingRevision"]) assert.equal(restoredMetadata[field], preparedMetadata[field], field);
  assert.equal(restoredMetadata.workId, restorationWork.id);
  assert.deepEqual(restorationWork.attempt && { model: restorationWork.attempt.model, thinking: restorationWork.attempt.thinking, instructions: restorationWork.attempt.instructions, toolNames: restorationWork.attempt.toolNames, cwd: restorationWork.attempt.cwd, bindingRevision: restorationWork.attempt.bindingRevision, standingRevision: restorationWork.attempt.standingRevision }, baselineWork.attempt && { model: baselineWork.attempt.model, thinking: baselineWork.attempt.thinking, instructions: baselineWork.attempt.instructions, toolNames: baselineWork.attempt.toolNames, cwd: baselineWork.attempt.cwd, bindingRevision: baselineWork.attempt.bindingRevision, standingRevision: baselineWork.attempt.standingRevision });
  assert.deepEqual(project.workspaceAuthorization, authorizationBaseline);
  assert.deepEqual(restorationDisk.workspace, afterPauseDisk.workspace);
  assert.deepEqual(restorationDisk.peer, afterPauseDisk.peer);
  assert.equal(restorationDisk.head, afterPauseDisk.head);
  assert.equal(restorationDisk.branch, afterPauseDisk.branch);
  assert.equal(restorationDisk.status, afterPauseDisk.status);
  assert.equal(restorationDisk.inventory, afterPauseDisk.inventory);
  assert.equal(restorationIdentities.projectId, negativeIdentities.projectId);
  assert.equal(restorationIdentities.coordinatorConversationId, negativeIdentities.coordinatorConversationId);
  report.restoration = { requestId: restorationRequestId, attemptId: restorationAttemptId, receipt: restorationAttemptReceipt, opened: restorationOpened, resumed: restorationResumed, snapshot: restorationSnapshot, work: restorationWork, call: restorationCall, result: restorationEffect, allocationIdentity: recordedAllocationIdentity, phaseCounts: { before: { requests: baselineRequestCount, lifecycleEvents: baselineStreamCount }, negative: { requests: negativeRequests - baselineRequestCount, lifecycleEvents: negativeStreams - baselineStreamCount }, restoration: { requests: requests.length - negativeRequests, lifecycleEvents: streams.length - negativeStreams } }, disk: restorationDisk, identities: restorationIdentities, noNewAllocation: preparationCalls === 2 && restorationDisk.workspace.dev === afterPauseDisk.workspace.dev && restorationDisk.workspace.ino === afterPauseDisk.workspace.ino, authorization: { baseline: authorizationBaseline, restored: project.workspaceAuthorization }, limitations: ["The public identities snapshot exposes no worker map entries; continuity is asserted through preparation metadata, returned work IDs, profiles, binding revision, receipt identity, and physical workspace observations.", "The public result effect is recorded and correlated, but task internals are not introspectable without private APIs."] };
  report.identities = { projectId, threadId, workId, preparedConversationId: preparedMetadata.conversationId, reopened: negativeIdentities, restoration: restorationIdentities };
  assert.deepEqual({ assigned: observed(join(owner, assignedRelative)), peer: observed(join(owner, "owned", "peer.txt")), sentinel: observed(join(owner, "owned", "sentinel.txt")) }, ownerPaths);
  assert.equal(git("-C", owner, "rev-parse", "HEAD"), beforeCode.head);
  assert.equal(git("-C", owner, "branch", "--show-current"), beforeCode.branch);
  assert.equal(git("-C", owner, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.equal(readFileSync(join(owner, "AGENTS.md"), "utf8"), `${originalStanding}\n`);
  report.workspace = { prepared: preparedMetadata, restored: restoredMetadata, ownerDirectory: stat(owner), workspaceDirectory: stat(preparedMetadata.cwd), assigned: observed(join(preparedMetadata.cwd, assignedRelative)), baselineObservation, restoredObservation: observed(join(preparedMetadata.cwd, assignedRelative)), peer: observed(join(preparedMetadata.cwd, "owned", "peer.txt")), ownerPaths: { before: ownerPaths, baseline: baselineOwner, rejection: rejectionOwner.paths, restored: { assigned: observed(join(owner, assignedRelative)), peer: observed(join(owner, "owned", "peer.txt")), sentinel: observed(join(owner, "owned", "sentinel.txt")) } } };
  report.disk = { beforeCode, pausedAfterBaseline: pausedDisk, afterPause: afterPauseDisk, failure: failureDisk }; 
  report.snapshots = { beforePause, pausedAfterBaseline: pausedBeforeRelease, paused, afterPause, reopened, resumed, rejection, restorationOpened, restorationResumed }; report.resolvedInstructions = { baseline: beforePause.work.find(work => work.id === workId)?.attempt?.instructions ?? null, reopened: reopened.work.find(work => work.id === workId)?.attempt?.instructions ?? null, restoration: restorationWork?.attempt?.instructions ?? null, source: "public plan snapshots" }; 
  const messages = requests.flatMap(request => request.messages);
  report.observers = { modelRequests: requests, generationLifecycle: streams, toolCalls: toolRecords().calls, toolResults: toolRecords().results };
  report.boundary = { operation: "public followUp after public resumePlan on the same thread", followUpAttempt, admissionError, rejection, negativeAtRejection: { preparationCalls: negativePreparationCalls - 1, modelRequests: negativeRequests - baselineRequestCount, lifecycleEvents: negativeStreams - baselineStreamCount }, restoration: { preparationCalls: preparationCalls - negativePreparationCalls, modelRequests: requests.length - negativeRequests, lifecycleEvents: streams.length - negativeStreams }, labels: { lifecycle: "events" } };
  report.sourceAfter = sourceHashes();
  assert.deepEqual(report.sourceAfter, report.sourceBefore);
  assert.deepEqual(afterPauseDisk, pausedDisk);
  assert.deepEqual(failureDisk.workspace, afterPauseDisk.workspace);
  assert.deepEqual(failureDisk.assigned, afterPauseDisk.assigned);
  assert.deepEqual(failureDisk.peer, afterPauseDisk.peer);
  assert.equal(failureDisk.head, afterPauseDisk.head);
  assert.equal(failureDisk.branch, afterPauseDisk.branch);
  assert.equal(failureDisk.status, afterPauseDisk.status);
  assert.equal(failureDisk.inventory, afterPauseDisk.inventory);
  assert.deepEqual(failureDisk.owner, beforeCode.owner);
  assert.equal(fileSha(join(owner, "AGENTS.md")), report.standing.originalOwnerHash);
  report.standing.restoredOwnerBytes = readFileSync(join(owner, "AGENTS.md")).length;
  report.standing.restoredOwnerHash = fileSha(join(owner, "AGENTS.md"));
  assert.notEqual(changedOwnerHash, report.standing.originalOwnerHash);
  assert.equal(report.standing.restoredOwnerHash, report.standing.originalOwnerHash);
  const reportPath = save();
  console.log(`${reportPath}\nsha256:${fileSha(reportPath)}`);
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  const reportPath = save();
  console.error(`${reportPath}\nsha256:${fileSha(reportPath)}`);
  throw error;
} finally {
  if (runtime) await runtime.close();
}
