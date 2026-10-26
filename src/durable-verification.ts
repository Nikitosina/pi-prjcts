import { closeSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ensureArtifactDir, openArtifact } from "./artifacts.ts";
import { DurablePlanning, type PlanningState } from "./durable-planning.ts";
import { home } from "./state.ts";
import { captureTarget, changedFromManifest, readManifest, snapshotTarget, writeManifest, type TargetManifest } from "./verification-target.ts";
import { failureSignature, judge, type RunRecord, type Verification, type VerificationAttempt } from "./verification-model.ts";
import { runSandboxed, sandboxAvailable, sandboxEnv } from "./verification-sandbox.ts";

export type AttemptPaths = { dir: string; target: string; scratch: string; manifest: string };
export const attemptPaths = (controlRoot: string, key: string): AttemptPaths => ({ dir: join(controlRoot, "verification", key), target: join(controlRoot, "verification", key, "target"), scratch: join(controlRoot, "verification", key, "scratch"), manifest: join(controlRoot, "verification", key, "manifest.json") });

/** Copies the worker's tree for one attempt. Idempotent per key: a replayed settlement rebuilds the same snapshot. */
export async function prepareAttemptTarget(controlRoot: string, key: string, sourcePath: string): Promise<{ manifest: TargetManifest; paths: AttemptPaths }> {
  const paths = attemptPaths(controlRoot, key), manifest = await captureTarget(sourcePath);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await snapshotTarget(sourcePath, paths.target, manifest);
  await mkdir(paths.scratch, { recursive: true, mode: 0o700 });
  await writeManifest(paths.manifest, manifest);
  const again = await captureTarget(sourcePath);
  if (again.revision !== manifest.revision) throw new Error("The worker's tree changed while it was being copied for verification");
  return { manifest, paths };
}

/** The disposable parts go; the manifest, run records and artifacts stay as evidence. */
export async function releaseAttemptTarget(controlRoot: string, key: string): Promise<void> {
  const paths = attemptPaths(controlRoot, key);
  await rm(paths.target, { recursive: true, force: true }); await rm(paths.scratch, { recursive: true, force: true });
}

export type VerificationToolDeps = { planRoot: () => ConversationId | undefined; controlRoot: string; currentRevision: (sourcePath: string) => Promise<string>; isClosed?: () => boolean };
type Own = { workerThreadId: string; verification: Verification; attempt: VerificationAttempt; verifierThreadId: string };

async function own(tx: Tx, root: ConversationId, conversationId: ConversationId): Promise<Own> {
  const state: PlanningState = await tx.doc(DurablePlanning, root);
  const entry = Object.entries(state.threads).find(([, thread]) => Number(thread.conversationId) === Number(conversationId));
  const latest = entry && Object.values(state.work).findLast(work => work.threadId === entry[0]);
  if (!entry || latest?.role !== "verifier" || !entry[1].parentThreadId) throw new Error("Only a verifier thread can use this tool");
  const verification = state.threads[entry[1].parentThreadId]?.verification, attempt = verification?.attempts.find(item => item.verifierThreadId === entry[0]);
  if (!verification || !attempt) throw new Error("This verifier has no verification attempt");
  if (attempt.state !== "running") throw new Error(`This attempt already ended as ${attempt.state}; start nothing more`);
  return { workerThreadId: entry[1].parentThreadId, verification, attempt, verifierThreadId: entry[0] };
}

const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const Evidence = Type.Object({ runId: Type.Optional(Type.String({ pattern: "^r[0-9]{1,3}$" })), artifact: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })), note: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false });

/** The verifier's two tools: sandboxed command execution in its snapshot, and one structured verdict. Both refuse any other thread. */
export function verificationTools(deps: VerificationToolDeps) {
  const root = () => { const id = deps.planRoot(); if (id === undefined) throw new Error("Project plan is unavailable"); return id; };
  const run = defineTool({
    name: "projects_verify_run",
    description: "Run one shell command in your verification snapshot (your working directory) under the OS sandbox: writes only to the snapshot, its scratch space and $PI_ARTIFACTS_DIR, no network beyond loopback, no credentials. Returns the exit code, the output tail, a run id to cite in the verdict and the log files (artifacts). Commands run one at a time.",
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 4000 }), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Default 600." })) }, { additionalProperties: false }),
    replay: "unsafe", executionMode: "sequential",
    async execute(args, api, context) {
      if (deps.isClosed?.()) return text("Project runtime is closing", true);
      if (!sandboxAvailable()) return text("No enforceable sandbox on this platform: nothing was run. Record a blocked verdict.", true);
      const mine = await api.commit(tx => own(tx, root(), api.conversationId), context);
      const paths = attemptPaths(deps.controlRoot, mine.attempt.key), artifacts = ensureArtifactDir(deps.controlRoot, mine.verifierThreadId);
      const id = `r${mine.attempt.runs.length + 1}`;
      if (mine.attempt.runs.length >= 200) return text("Run limit reached for this attempt; record the verdict", true);
      await mkdir(join(artifacts, "runs"), { recursive: true, mode: 0o700 });
      const files = { stdout: `runs/${id}.stdout.log`, stderr: `runs/${id}.stderr.log` };
      const result = await runSandboxed({
        command: args.command, cwd: paths.target, timeoutMs: (args.timeoutSeconds ?? 600) * 1000, signal: context.abortSignal,
        env: sandboxEnv(paths.scratch, artifacts), stdoutPath: join(artifacts, files.stdout), stderrPath: join(artifacts, files.stderr),
        policy: { writable: [paths.target, paths.scratch, artifacts], unreadable: [home(), deps.controlRoot], readable: [paths.dir, artifacts] },
      });
      const record: RunRecord = { id, command: args.command.slice(0, 2000), exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs, stdout: { path: files.stdout, bytes: result.stdoutBytes, sha256: result.stdoutSha256 }, stderr: { path: files.stderr, bytes: result.stderrBytes, sha256: result.stderrSha256 }, tail: result.tail.slice(-1500), at: Date.now() };
      await api.commit(async tx => { (await own(tx, root(), api.conversationId)).attempt.runs.push(record); }, context);
      const changed = await changedFromManifest(paths.target, await readManifest(paths.manifest));
      return text({ runId: id, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, aborted: result.aborted, durationMs: result.durationMs, logs: [files.stdout, files.stderr], tail: result.tail, ...(changed.length ? { warning: `This command changed ${changed.length} file(s) of the snapshot (${changed.slice(0, 5).join(", ")}). A verdict from a modified snapshot is recorded as blocked.` } : {}) }, result.exitCode !== 0);
    },
  });
  const verdict = defineTool({
    name: "projects_verification_verdict",
    description: "Record the verification verdict once: every criterion id with pass, fail or blocked, a reason and its evidence (run ids from projects_verify_run, artifact paths relative to your artifacts folder). The host derives the overall status; a pass needs a run per criterion. It is rejected, not recorded, when it is incomplete or cites evidence that does not exist.",
    parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 4000 }), criteria: Type.Array(Type.Object({ id: Type.String({ pattern: "^c[0-9]{1,2}$" }), status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")]), reason: Type.String({ maxLength: 2000 }), evidence: Type.Optional(Type.Array(Evidence, { maxItems: 12 })) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    replay: "unsafe", executionMode: "sequential",
    async execute(args, api, context) {
      const mine = await api.commit(tx => own(tx, root(), api.conversationId), context);
      const paths = attemptPaths(deps.controlRoot, mine.attempt.key);
      const exists = (path: string) => { try { closeSync(openArtifact(deps.controlRoot, mine.verifierThreadId, path).fd); return true; } catch { return false; } };
      const judged = judge(mine.verification.criteria, mine.attempt.runs, args, exists);
      if (!judged.ok) return text({ recorded: false, errors: judged.errors }, true);
      const changed = await changedFromManifest(paths.target, await readManifest(paths.manifest)).catch(() => ["(snapshot unreadable)"]);
      const current = await deps.currentRevision(mine.attempt.sourcePath).catch(() => null);
      const recorded = await api.commit(async tx => {
        const { attempt } = await own(tx, root(), api.conversationId);
        attempt.verdict = judged.verdict;
        if (changed.length) { attempt.state = "blocked"; attempt.reason = `The verifier modified the snapshot (${changed.slice(0, 5).join(", ")}); a verdict from changed files is not evidence of the worker's revision`; }
        else if (current !== attempt.revision) { attempt.state = "stale"; attempt.reason = "The worker's tree changed after the snapshot was taken, so this verdict does not describe the current work"; }
        else attempt.state = judged.verdict.status;
        attempt.signature = failureSignature(attempt);
        return { state: attempt.state, reason: attempt.reason };
      }, context);
      return text({ recorded: true, ...recorded });
    },
  });
  return { tools: [run, verdict], extension: defineExtension({ name: "projects.verification-tools", tools: [run, verdict] }) };
}
