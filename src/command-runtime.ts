import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTool, type Conversation, type Tx, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { loadProject, type Project, type OperationSpec } from "./state.ts";
import type { OperationApprovals } from "./operation-approvals.ts";
import { captureEvidenceBytes, readEvidence } from "./evidence.ts";
import type { CommandProfile } from "./command-profile-types.ts";
import { commandProgram, validateCommandRisk } from "./command-profiles.ts";
import { DurablePlanning } from "./durable-planning.ts";
import { authorizationFingerprint, trustedOwner } from "./workspace-authorization.ts";
import { withWorkspaceMutationLock, type WorkspaceAuthority, type WorkspaceWriteLock } from "./workspace-capabilities.ts";

type Output = { bytes: number; capturedBytes: number; sha256: string; capturedSha256?: string };
type Result = { code: number | null; signal: string | null; reason: "exit" | "aborted" | "timeout" | "output-limit" | "spawn-error" | "group-unknown"; stdout: Output; stderr: Output; failureFingerprint: string | null };
type Identity = { evidenceId?: string; evidenceSha256?: string; approvalId?: string; approvalFingerprint?: string; key: string; resource: string; requestId: string; profileId: string; profileRevision: string; scopeId: string; workId: string; conversationId: number; taskId: number; callId: string; startedAt: string };
type Intent = Identity & ({ state: "uncertain"; observation?: Result } | { state: "done"; result: Result });
const Commands = defineDoc<{ items: Intent[] }>({ kind: "projects.command-intents", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }) });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function copyResult(result: Result): Result { return { ...result, stdout: { ...result.stdout }, stderr: { ...result.stderr } }; }
function copyIdentity(row: Identity): Identity {
  return { key: row.key, resource: row.resource, requestId: row.requestId, profileId: row.profileId, profileRevision: row.profileRevision, scopeId: row.scopeId,
    workId: row.workId, conversationId: row.conversationId, taskId: row.taskId, callId: row.callId, startedAt: row.startedAt,
    ...(row.approvalId ? { approvalId: row.approvalId, approvalFingerprint: row.approvalFingerprint } : {}),
    ...(row.evidenceId ? { evidenceId: row.evidenceId } : {}), ...(row.evidenceSha256 ? { evidenceSha256: row.evidenceSha256 } : {}) };
}

export function commandToolName(scopeId: string, profileId: string) { return `projects_command_${hash(`${scopeId}:${profileId}`).slice(0, 24)}`; }
export async function hasUncertainCommands(tx: Tx, root: Conversation["id"], resource?: string) {
  return (await tx.doc(Commands, root)).items.some(item => item.state === "uncertain" && (resource === undefined || item.resource === resource));
}
export function commandResource(authority: WorkspaceAuthority) { return `workspace:${authority.receiptId}:${authority.attemptId}`; }
export async function commandIntentsSnapshot(root: Conversation, options: { offset?: number; limit?: number } = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid command intent page");
  return root.commit(async tx => {
    const rows = (await tx.doc(Commands, root.id)).items;
    const items = rows.slice(offset, offset + limit).map(row => row.state === "done" ? { ...copyIdentity(row), state: "done" as const, result: copyResult(row.result) } : { ...copyIdentity(row), state: "uncertain" as const, ...(row.observation ? { observation: copyResult(row.observation) } : {}) });
    return { items, total: rows.length, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
  }, BACKGROUND_CONTEXT);
}

export async function commandIntentInspect(input: { root: Conversation; dir: string; projectId: string; key: string; confirm: string; isSettling: () => boolean }) {
  if (input.confirm !== input.projectId || !/^[a-f0-9]{64}$/.test(input.key)) throw new Error("Command inspection requires project confirmation and an exact intent key");
  const selected = await input.root.commit(async tx => {
    const row = (await tx.doc(Commands, input.root.id)).items.find(item => item.key === input.key);
    if (!row) throw new Error("Unknown owned command intent");
    return row.state === "done" ? { ...copyIdentity(row), state: "done" as const, result: copyResult(row.result) }
      : { ...copyIdentity(row), state: "uncertain" as const, ...(row.observation ? { observation: copyResult(row.observation) } : {}) };
  }, BACKGROUND_CONTEXT);
  if (selected.state === "done") return { intent: selected, finalized: false, retryAllowed: false };
  const held = (reason: string) => ({ intent: selected, finalized: false, reason, retryAllowed: false });
  if (input.isSettling()) return held("Command settlement is still active");
  const observed = selected.observation;
  if (!observed || !(observed.reason === "spawn-error" || observed.reason === "exit" && observed.code !== null && observed.signal === null)) return held("No recorded normal termination; uncertainty is retained");
  if (!selected.evidenceId || !selected.evidenceSha256) return held("No completed output artifact; uncertainty is retained");
  let artifact: Awaited<ReturnType<typeof readEvidence>>;
  try { artifact = await readEvidence(input.dir, selected.evidenceId); }
  catch { return held("Output artifact is unavailable; uncertainty is retained"); }
  const origin = artifact.record.native;
  if (artifact.record.sha256 !== selected.evidenceSha256 || !origin || !("sourceKind" in origin) || origin.sourceKind !== "command-output" || origin.commandKey !== selected.key
    || origin.projectId !== input.projectId || origin.scopeId !== selected.scopeId || origin.workId !== selected.workId || origin.conversationId !== selected.conversationId || origin.taskId !== selected.taskId || origin.callId !== selected.callId) return held("Output artifact provenance does not match; uncertainty is retained");
  return input.root.commit(async tx => {
    const rows = (await tx.doc(Commands, input.root.id)).items, index = rows.findIndex(item => item.key === input.key), row = rows[index];
    if (!row) throw new Error("Command intent disappeared during inspection");
    if (row.state === "done") return { intent: { ...copyIdentity(row), state: "done" as const, result: copyResult(row.result) }, finalized: false, retryAllowed: false };
    if (input.isSettling()) return held("Command settlement is still active");
    if (JSON.stringify(copyIdentity(row)) !== JSON.stringify(copyIdentity(selected)) || !row.observation || JSON.stringify(copyResult(row.observation)) !== JSON.stringify(observed)) throw new Error("Command observation changed during inspection");
    const completed: Intent = { ...copyIdentity(row), state: "done", result: copyResult(observed) };
    rows[index] = completed;
    return { intent: completed, finalized: true, basis: "recorded-normal-termination-and-native-output-artifact", effectsVerified: false, retryAllowed: false };
  }, BACKGROUND_CONTEXT);
}

function environment() {
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Command execution refuses NODE_OPTIONS or PI_PACKAGE_DIR overrides");
  const values: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]) if (process.env[name] !== undefined) values[name] = process.env[name];
  return values;
}

async function runCommand(profile: CommandProfile, cwd: string, signal: AbortSignal | undefined) {
  signal?.throwIfAborted();
  const env = environment();
  return new Promise<{ result: Result; stdout: string; stderr: string; stdoutBase64: string; stderrBase64: string; uncertain: boolean }>(resolve => {
    const stdoutHash = createHash("sha256"), stderrHash = createHash("sha256");
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, captured = 0;
    let reason: Result["reason"] = "exit", failureFingerprint: string | null = null, finished = false, leaderExited = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let pipeDrain: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(profile.program.path, [...profile.arguments], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    const signalOwned = (name: NodeJS.Signals) => {
      if (finished || leaderExited || child.exitCode !== null || child.signalCode !== null || pid === undefined || child.pid !== pid) return;
      try { process.kill(-pid, name); }
      catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) failureFingerprint = hash(error instanceof Error ? error.message : "Command signal failed"); }
    };
    const stop = (cause: Result["reason"]) => {
      if (finished) return;
      if (reason === "exit") reason = cause;
      signalOwned("SIGTERM");
      escalation ??= setTimeout(() => signalOwned("SIGKILL"), 1000);
    };
    const abort = () => stop("aborted");
    const timer = setTimeout(() => stop("timeout"), profile.timeoutMs);
    const collect = (chunk: Buffer, target: Buffer[], digest: ReturnType<typeof createHash>, stream: "stdout" | "stderr") => {
      if (finished) return;
      digest.update(chunk);
      if (stream === "stdout") stdoutBytes += chunk.length; else stderrBytes += chunk.length;
      const remaining = Math.max(0, profile.maxOutputBytes - captured), take = Math.min(remaining, chunk.length);
      if (take > 0) { target.push(Buffer.from(chunk.subarray(0, take))); captured += take; }
      if (stdoutBytes + stderrBytes > profile.maxOutputBytes) stop("output-limit");
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, stdout, stdoutHash, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, stderr, stderrHash, "stderr"));
    child.on("error", error => { reason = "spawn-error"; failureFingerprint = hash(error.message); });
    child.once("exit", () => {
      leaderExited = true;
      if (escalation !== undefined) clearTimeout(escalation);
      pipeDrain = setTimeout(() => {
        if (finished) return;
        reason = "group-unknown";
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1000);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("close", (code, terminated) => {
      finished = true;
      clearTimeout(timer);
      if (escalation !== undefined) clearTimeout(escalation);
      if (pipeDrain !== undefined) clearTimeout(pipeDrain);
      signal?.removeEventListener("abort", abort);
      let groupGone = pid === undefined;
      if (pid !== undefined) {
        try { process.kill(-pid, 0); }
        catch (error) { groupGone = typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"; }
      }
      if (!groupGone) reason = "group-unknown";
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      const result: Result = { code, signal: terminated, reason, failureFingerprint,
        stdout: { bytes: stdoutBytes, capturedBytes: out.length, sha256: stdoutHash.digest("hex"), capturedSha256: createHash("sha256").update(out).digest("hex") },
        stderr: { bytes: stderrBytes, capturedBytes: err.length, sha256: stderrHash.digest("hex"), capturedSha256: createHash("sha256").update(err).digest("hex") } };
      resolve({ result, stdout: out.toString("utf8"), stderr: err.toString("utf8"), stdoutBase64: out.toString("base64"), stderrBase64: err.toString("base64"), uncertain: !groupGone || !["exit", "spawn-error"].includes(reason) || reason === "exit" && (code === null || terminated !== null) });
    });
  });
}

export function commandExecution() {
  let closed = false, unknownGroup = false;
  let closeOperation: Promise<void> | undefined;
  const active = new Set<{ controller: AbortController; task: ReturnType<typeof runCommand> }>();
  const settlements = new Set<Promise<unknown>>();
  function track<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) throw new Error("Command execution is stopping");
    const task = operation();
    settlements.add(task);
    task.then(() => settlements.delete(task), () => settlements.delete(task));
    return task;
  }
  const abort = () => { for (const item of active) item.controller.abort(); };
  async function run(profile: CommandProfile, cwd: string, signal?: AbortSignal) {
    if (closed) throw new Error("Command execution is stopping");
    const controller = new AbortController();
    const task = runCommand(profile, cwd, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
    const item = { controller, task };
    active.add(item);
    try { const value = await task; unknownGroup ||= value.result.reason === "group-unknown"; return value; }
    finally { active.delete(item); }
  }
  async function drain() {
    closed = true;
    const pending = [...active];
    abort();
    const outcomes = await Promise.allSettled(pending.map(item => item.task));
    await Promise.allSettled([...settlements]);
    if (unknownGroup || outcomes.some(item => item.status === "fulfilled" && item.value.result.reason === "group-unknown")) throw new Error("Owned command process-group termination is uncertain; retain resources");
    const failures = outcomes.flatMap(item => item.status === "rejected" ? [item.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Command execution drain failed");
  }
  function close() {
    closeOperation ??= drain();
    return closeOperation;
  }
  return { run, track, abort, close, isSettling: () => settlements.size > 0 };
}

export async function commandWorkerTools(input: { executor: ReturnType<typeof commandExecution>; approvals?: () => OperationApprovals; project: Project; root: Conversation; authority: WorkspaceAuthority; scopeId: string; conversationId: number; workId: string; lock: WorkspaceWriteLock }) {
  const profiles = (input.project.commandProfiles ?? []).filter(profile => profile.enabled && profile.repositoryId === input.authority.repositoryId && profile.scopeIds.includes(input.scopeId));
  if (profiles.length === 0) return [];
  const path = await realpath(input.authority.workspaceRoot), pin = await lstat(path, { bigint: true });
  if (!pin.isDirectory() || (await lstat(input.authority.workspaceRoot)).isSymbolicLink()) throw new Error("Command workspace must be an allocated regular directory");
  const resource = commandResource(input.authority);
  async function active(profile: CommandProfile, api: ToolExecutionApi, context: Context) {
    context.abortSignal?.throwIfAborted();
    validateCommandRisk(profile);
    if (profile.provider === "arc" || input.authority.provider === "arc") throw new Error("Arc command execution is deferred; no command will run");
    if (["arc", "arcanum"].includes(basename(profile.program.path))) throw new Error("Command executable does not match the selected VCS provider");
    const expires = Date.parse(input.authority.expiresAt);
    if (Number(api.conversationId) !== input.conversationId || input.authority.projectId !== input.project.id || !Number.isFinite(expires) || expires <= Date.now()) throw new Error("Command worker/lease identity does not match");
    const current = loadProject(input.project.id), configured = current.commandProfiles?.find(item => item.id === profile.id);
    if (current.archived || current.deleted || profile.owner !== trustedOwner() || !configured?.enabled || configured.revision !== profile.revision || configured.workspaceRevision !== authorizationFingerprint(current) || authorizationFingerprint(current) !== authorizationFingerprint(input.project) || configured.repositoryId !== input.authority.repositoryId || !configured.scopeIds.includes(input.scopeId) || (configured.provider === "github" ? "git" : "arc") !== input.authority.provider) throw new Error("Command authorization changed");
    const lexical = await lstat(input.authority.workspaceRoot, { bigint: true }), now = await lstat(path, { bigint: true });
    if (lexical.isSymbolicLink() || !lexical.isDirectory() || await realpath(input.authority.workspaceRoot) !== path || now.dev !== pin.dev || now.ino !== pin.ino) throw new Error("Command workspace physical identity changed");
    await api.commit(async tx => { await assertWork(tx); }, context);
  }
  async function assertWork(tx: Tx) {
    const state = await tx.doc(DurablePlanning, input.root.id), work = state.work[input.workId];
    if (state.paused || state.pausing || !work || work.role !== "worker" || work.status !== "running" || work.workspaceScopeId !== input.scopeId || Number(work.conversationId) !== input.conversationId || state.threads[work.threadId]?.activeWorkId !== work.id) throw new Error("Command requires the active scoped worker");
  }
  return profiles.map(profile => defineTool({
    name: commandToolName(input.scopeId, profile.id),
    description: `Run owner-enabled fixed command profile ${profile.label} in this allocated worktree. Only a request UUID is accepted; executable, argv, cwd and environment cannot be supplied. Declared effect: ${profile.effect}. Repository code is trusted, not OS-sandboxed. Output is bounded untrusted data. Unknown outcomes never permit blind retries.`,
    parameters: Type.Object({ requestId: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }) }, { additionalProperties: false }), replay: "unsafe", executionMode: "sequential",
    execute(args, api, context) {
      return input.executor.track(async () => {
      await active(profile, api, context);
      let approvalIdentity: { approvalId: string; approvalFingerprint: string } | undefined;
      async function approvalRequired() {
        if (profile.effect === "workspace") return null;
        if (!input.approvals) throw new Error("Separate command approval binding is unavailable");
        const threadId = await api.commit(async tx => {
          await assertWork(tx);
          return (await tx.doc(DurablePlanning, input.root.id)).work[input.workId]?.threadId;
        }, context);
        if (!threadId) throw new Error("Command approval requires its owned thread identity");
        const operation: OperationSpec = { provider: profile.provider, kind: "command", repositoryId: profile.repositoryId, scopeId: input.scopeId, threadId,
          profileId: profile.id, profileRevision: profile.revision, effect: profile.effect, receiptId: input.authority.receiptId, allocationAttemptId: input.authority.attemptId, requestId: args.requestId };
        const digest = hash(JSON.stringify(operation));
        const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const approvals = input.approvals();
        const record = await approvals.request({ action: "operation-request", id: input.project.id, requestId: operationId, operation });
        if (record.status !== "approved" || record.executionApproved !== true) return { needsApproval: true, operationId: record.id, fingerprint: record.fingerprint, status: record.status, executionRequired: true, commandProfileId: profile.id, requestId: args.requestId, permissionChanged: false };
        const approved = await approvals.approved({ id: input.project.id, operationId: record.id, fingerprint: record.fingerprint, confirm: input.project.id });
        if (JSON.stringify(approved.operation) !== JSON.stringify(operation)) throw new Error("Command approval target does not match this launch");
        approvalIdentity = { approvalId: approved.id, approvalFingerprint: approved.fingerprint };
        return null;
      }
      const pending = await approvalRequired();
      if (pending) return { content: [{ type: "text" as const, text: JSON.stringify(pending) }], isError: true };
      environment();
      return withWorkspaceMutationLock({ ...input.lock, waitMs: 0 }, async () => {
        await active(profile, api, context);
        const program = await commandProgram(profile.executable);
        if (JSON.stringify(program) !== JSON.stringify(profile.program)) throw new Error("Command executable changed; obtain a new owner grant");
        await active(profile, api, context);
        const pending = await approvalRequired();
        if (pending) return { content: [{ type: "text" as const, text: JSON.stringify(pending) }], isError: true };
        const key = hash(JSON.stringify({ profile: profile.revision, resource, requestId: args.requestId }));
        const previous = await api.commit(async tx => {
          await assertWork(tx);
          const rows = (await tx.doc(Commands, input.root.id)).items;
          const existing = rows.find(item => item.key === key);
          if (existing) {
            if (existing.state === "uncertain") throw new Error("Command outcome is uncertain; execution will not be repeated");
            return { result: copyResult(existing.result), evidenceId: existing.evidenceId ?? null, evidenceSha256: existing.evidenceSha256 ?? null };
          }
          if (rows.some(item => item.resource === resource && item.state === "uncertain")) throw new Error("Workspace has an unresolved command; execution is blocked");
          if (rows.length >= 4096) throw new Error("Command intent limit reached");
          rows.push({ ...approvalIdentity, evidenceId: randomUUID(), key, resource, requestId: args.requestId, profileId: profile.id, profileRevision: profile.revision, scopeId: input.scopeId, workId: input.workId, conversationId: input.conversationId, taskId: Number(api.taskId), callId: api.callId, startedAt: new Date().toISOString(), state: "uncertain" });
          return null;
        }, context);
        if (previous) return { content: [{ type: "text" as const, text: JSON.stringify({ reused: true, key, ...previous, outputInReceipt: false, untrusted: true }) }], isError: previous.result.code !== 0 };
        await active(profile, api, context);
        const completed = await input.executor.run(profile, path, context.abortSignal);
        const evidenceId = await input.root.commit(async tx => {
          const record = (await tx.doc(Commands, input.root.id)).items.find(item => item.key === key);
          if (record?.state !== "uncertain" || record.taskId !== Number(api.taskId) || record.callId !== api.callId || !record.evidenceId) throw new Error("Command intent changed before output retention");
          record.observation = completed.result;
          return record.evidenceId;
        }, BACKGROUND_CONTEXT);
        const artifact = await captureEvidenceBytes({ dir: input.lock.controlRoot, id: evidenceId, filename: `command-${args.requestId}.json`, title: `Command output: ${profile.label}`, sessionFile: null,
          native: { projectId: input.project.id, scopeId: input.scopeId, workId: input.workId, conversationId: input.conversationId, taskId: Number(api.taskId), callId: api.callId, sourceKind: "command-output", commandKey: key },
          bytes: Buffer.from(JSON.stringify({ version: 1, key, profileId: profile.id, profileRevision: profile.revision, requestId: args.requestId, state: completed.uncertain ? "uncertain" : "observed", result: completed.result,
            stdoutBase64: completed.stdoutBase64, stderrBase64: completed.stderrBase64, encoding: "base64", untrusted: true, retryAllowed: false }), "utf8") });
        await input.root.commit(async tx => {
          const record = (await tx.doc(Commands, input.root.id)).items.find(item => item.key === key);
          if (record?.state !== "uncertain" || record.evidenceId !== artifact.id || record.taskId !== Number(api.taskId) || record.callId !== api.callId) throw new Error("Command intent changed before artifact linkage");
          record.evidenceSha256 = artifact.sha256;
        }, BACKGROUND_CONTEXT);
        if (!completed.uncertain) {
          await active(profile, api, context);
          await api.commit(async tx => {
            await assertWork(tx);
            const rows = (await tx.doc(Commands, input.root.id)).items, index = rows.findIndex(item => item.key === key);
            const retained = rows[index];
            if (index < 0 || !retained || retained.state !== "uncertain") throw new Error("Command intent changed before completion");
            rows[index] = { ...copyIdentity(retained), state: "done", result: completed.result };
          }, context);
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ key, evidenceId: artifact.id, evidenceSha256: artifact.sha256, state: completed.uncertain ? "uncertain" : "done", result: completed.result, stdout: completed.stdout, stderr: completed.stderr, encoding: "utf8-replacement", untrusted: true, retryAllowed: false }) }], isError: completed.uncertain || completed.result.code !== 0 };
      });
      });
    },
  }));
}
