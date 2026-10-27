import { closeSync, createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defineExtension, defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ensureArtifactDir, openArtifact } from "./artifacts.ts";
import type { BackgroundCommands } from "./background-commands.ts";
import { DurablePlanning, type PlanningState } from "./durable-planning.ts";
import type { ResourceLeases } from "./resource-leases.ts";
import { captureTarget, diffManifests, driftPaths, proofChanges, readManifest, writeManifest, type ProofChanges, type TargetManifest } from "./verification-target.ts";
import { failureSignature, judge, type RunRecord, type Verification, type VerificationAttempt } from "./verification-model.ts";
import { missingLease } from "./verification-resources.ts";
import { workerEnvironmentTools } from "./worker-environment-tools.ts";

export type AttemptPaths = { dir: string; manifest: string };
export const attemptPaths = (controlRoot: string, key: string): AttemptPaths => ({ dir: join(controlRoot, "verification", key), manifest: join(controlRoot, "verification", key, "manifest.json") });

/** Records the exact revision of the worker's tree that one attempt verifies. Idempotent per key: a replayed settlement rewrites the same manifest. */
export async function captureAttemptTarget(controlRoot: string, key: string, sourcePath: string, baseRevision: string): Promise<{ manifest: TargetManifest; proof: ProofChanges }> {
  const paths = attemptPaths(controlRoot, key), manifest = await captureTarget(sourcePath);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await writeManifest(paths.manifest, manifest);
  return { manifest, proof: await proofChanges(sourcePath, manifest, baseRevision) };
}

/** Shell policy the verifier's commands pass through: the one of the worker whose work is checked, or why the host cannot apply it. */
export type VerifierShell = { guard: (command: string) => string } | { refusal: string };
export type VerificationToolDeps = {
  projectId: string; planRoot: () => ConversationId | undefined; controlRoot: string;
  background: BackgroundCommands; leases: ResourceLeases;
  shell: (scopeId: string, cwd: string, branch: string | null) => VerifierShell;
  isClosed?: () => boolean;
};
type Own = { workerThreadId: string; verification: Verification; attempt: VerificationAttempt; verifierThreadId: string };

async function own(tx: Tx, root: ConversationId, conversationId: ConversationId): Promise<Own> {
  const state: PlanningState = await tx.doc(DurablePlanning, root);
  const entry = Object.entries(state.threads).find(([, thread]) => Number(thread.conversationId) === Number(conversationId));
  const latest = entry && Object.values(state.work).findLast(work => work.threadId === entry[0]);
  if (!entry || latest?.role !== "verifier" || !entry[1].parentThreadId) throw new Error("Only a verifier thread can use this tool");
  const verification = state.threads[entry[1].parentThreadId]?.verification, attempt = verification?.attempts.find(item => item.verifierThreadId === entry[0]);
  if (!verification || !attempt) throw new Error(`This verifier has no verification attempt (worker thread ${entry[1].parentThreadId}: ${verification ? `${verification.attempts.length} attempts, open=${verification.open}, outcome=${verification.outcome ?? "none"}, reason=${verification.reason ?? ""}` : "no cycle"})`);
  if (attempt.state !== "running") throw new Error(`This attempt already ended as ${attempt.state}; start nothing more`);
  return { workerThreadId: entry[1].parentThreadId, verification, attempt, verifierThreadId: entry[0] };
}

/** Plain copy that outlives the transaction (tracked document objects cannot be used after it settles). */
const detached = (value: Own): Own => JSON.parse(JSON.stringify(value));
const text = (value: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const Evidence = Type.Object({ runId: Type.Optional(Type.String({ pattern: "^r[0-9]{1,3}$" })), artifact: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })), note: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false });
const sha256Of = (path: string): Promise<string> => new Promise((resolve, reject) => { const hash = createHash("sha256"); createReadStream(path).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject); });
const shortList = (paths: readonly string[]) => paths.slice(0, 10).join(", ") + (paths.length > 10 ? `, … (${paths.length} in all)` : "");

/**
 * The verifier's tools: shell commands in the worker's worktree, one structured verdict, and the lease and background-command tools workers have.
 * The verifier is trusted like its worker: the commands run as the same user with the same environment and shell policy, and nothing confines them.
 * Drift detection and the verdict rules keep the evidence tied to one revision; they do not stop a command from doing anything.
 */
export function verificationTools(deps: VerificationToolDeps) {
  const root = () => { const id = deps.planRoot(); if (id === undefined) throw new Error("Project plan is unavailable"); return id; };
  const shellOf = (mine: Own): { guard: (command: string) => string } => {
    const shell = deps.shell(mine.verification.scopeId, mine.attempt.sourcePath, mine.attempt.branch);
    if ("refusal" in shell) throw new Error(shell.refusal);
    return shell;
  };
  const run = defineTool({
    name: "projects_verify_run",
    description: "Run one shell command in the finished worker's worktree (your working directory) and record it as evidence. It runs as the same user, with the same environment and shell policy as the worker's bash, and nothing confines it: use only what the skill and criteria call for, and do not edit the work. Commands naming a simulator, container runtime, fixed browser port or desktop session need your lease on it first (projects_lease_acquire). Returns the exit code, the output tail, a run id to cite in the verdict, the log artifact, and any change the command left in the worktree (declare those in the verdict's sourceWrites). Commands run one at a time.",
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 4000 }), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Default 600." })) }, { additionalProperties: false }),
    replay: "unsafe", executionMode: "sequential",
    async execute(args, api, context) {
      if (deps.isClosed?.()) return text("Project runtime is closing", true);
      const mine = await api.commit(async tx => detached(await own(tx, root(), api.conversationId)), context);
      if (mine.attempt.runs.length >= 200) return text("Run limit reached for this attempt; record the verdict", true);
      const shell = shellOf(mine), held = deps.leases.held(holder => holder.projectId === deps.projectId && holder.threadId === mine.verifierThreadId).map(item => item.resource);
      const missing = missingLease(args.command, held);
      if (missing) return text(`Not run: this command uses the ${missing.resource}, which other workers share, and you hold no lease for it. Take ${missing.hint} with projects_lease_acquire first. If the lease is held by someone else, or you lack the tool or grant, record the criterion that needs it as blocked.`, true);
      const id = `r${mine.attempt.runs.length + 1}`, artifacts = ensureArtifactDir(deps.controlRoot, mine.verifierThreadId), started = Date.now(), deadline = started + (args.timeoutSeconds ?? 600) * 1000;
      const job = deps.background.start(mine.verifierThreadId, { command: shell.guard(args.command), label: `verify ${id}`, cwd: mine.attempt.sourcePath, env: { ...process.env, PI_ARTIFACTS_DIR: artifacts } });
      let timedOut = false, aborted = false, status;
      for (;;) {
        status = await deps.background.wait(mine.verifierThreadId, job.id, { tailLines: 60, waitSeconds: Math.max(1, Math.min(30, Math.ceil((deadline - Date.now()) / 1000))), signal: context.abortSignal });
        if (status.state !== "running") break;
        aborted = context.abortSignal?.aborted === true; timedOut = !aborted && Date.now() >= deadline;
        if (aborted || timedOut) { await deps.background.stop(mine.verifierThreadId, job.id); status = await deps.background.wait(mine.verifierThreadId, job.id, { tailLines: 60, waitSeconds: 10 }); break; }
      }
      const logPath = `bg/${job.id}.log`, record: RunRecord = { id, command: args.command.slice(0, 2000), exitCode: status.code, signal: status.signal, timedOut, aborted, durationMs: Date.now() - started, log: { path: logPath, bytes: status.logBytes, sha256: await sha256Of(join(artifacts, logPath)).catch(() => "") }, tail: status.tail.slice(-1500), at: Date.now() };
      await api.commit(async tx => { (await own(tx, root(), api.conversationId)).attempt.runs.push(record); }, context);
      const paths = attemptPaths(deps.controlRoot, mine.attempt.key);
      const drift = await captureTarget(mine.attempt.sourcePath).then(async now => diffManifests(await readManifest(paths.manifest), now)).catch(() => undefined);
      const changed = drift ? driftPaths(drift) : [];
      return text({ runId: id, exitCode: status.code, signal: status.signal, timedOut, aborted, durationMs: record.durationMs, log: logPath, tail: status.tail, ...(changed.length ? { sourceChanges: { added: drift!.added.slice(0, 10), removed: drift!.removed.slice(0, 10), modified: drift!.modified.slice(0, 10) }, warning: `The worktree now differs from the revision you verify in ${changed.length} file(s): ${shortList(changed)}. Declare each in the verdict's sourceWrites with its reason; an undeclared change makes the attempt stale.` } : {}) }, status.code !== 0);
    },
  });
  const verdict = defineTool({
    name: "projects_verification_verdict",
    description: "Record the verification verdict once: every criterion id with pass, fail or blocked, a reason and its evidence (run ids from projects_verify_run, artifact paths relative to your artifacts folder). The host derives the overall status; a pass needs a run per criterion that finished normally. It is rejected, not recorded, when it is incomplete or cites evidence that does not exist. If the worktree differs from the revision you were given, list every changed path in sourceWrites with its reason; an undeclared change makes the attempt stale.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      criteria: Type.Array(Type.Object({ id: Type.String({ pattern: "^c[0-9]{1,2}$" }), status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")]), reason: Type.String({ maxLength: 2000 }), evidence: Type.Optional(Type.Array(Evidence, { maxItems: 12 })) }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
      sourceWrites: Type.Optional(Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), reason: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }), { maxItems: 100 })),
    }, { additionalProperties: false }),
    replay: "unsafe", executionMode: "sequential",
    async execute(args, api, context) {
      const mine = await api.commit(async tx => detached(await own(tx, root(), api.conversationId)), context);
      const paths = attemptPaths(deps.controlRoot, mine.attempt.key);
      const exists = (path: string) => { try { closeSync(openArtifact(deps.controlRoot, mine.verifierThreadId, path).fd); return true; } catch { return false; } };
      const judged = judge(mine.verification.criteria, mine.attempt.runs, args, exists);
      if (!judged.ok) return text({ recorded: false, errors: judged.errors }, true);
      const now = await captureTarget(mine.attempt.sourcePath).catch(() => null);
      const drift = now ? driftPaths(diffManifests(await readManifest(paths.manifest), now)) : null;
      const declared = new Map((args.sourceWrites ?? []).map(write => [write.path, write.reason]));
      const recorded = await api.commit(async tx => {
        const { attempt } = await own(tx, root(), api.conversationId);
        attempt.verdict = judged.verdict;
        const undeclared = drift?.filter(path => !declared.has(path)) ?? [];
        if (drift === null) { attempt.state = "stale"; attempt.reason = "The worker's tree could not be read to confirm it still matches the verified revision"; }
        else if (undeclared.length) { attempt.state = "stale"; attempt.reason = `The worker's tree no longer matches the verified revision and the verdict does not account for the change (${shortList(undeclared)}), so it does not describe the work`; }
        else {
          if (drift.length) { attempt.sourceWrites = drift.map(path => ({ path, reason: declared.get(path)! })); attempt.finalRevision = now!.revision; }
          attempt.state = judged.verdict.status;
        }
        attempt.signature = failureSignature(attempt);
        return { state: attempt.state, reason: attempt.reason };
      }, context);
      return text({ recorded: true, ...recorded });
    },
  });
  const environment = workerEnvironmentTools({ projectId: deps.projectId, leases: deps.leases, background: deps.background, target: async (api, context) => {
    const mine = await api.commit(async tx => detached(await own(tx, root(), api.conversationId)), context);
    const guard = (command: string): string => {
      const held = deps.leases.held(holder => holder.projectId === deps.projectId && holder.threadId === mine.verifierThreadId).map(item => item.resource), missing = missingLease(command, held);
      if (missing) {
        const message = `Not run: this command uses the ${missing.resource}, which other workers share, and you hold no lease for it. Take ${missing.hint} with projects_lease_acquire first.`;
        return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
      }
      return shellOf(mine).guard(command);
    };
    return { threadId: mine.verifierThreadId, cwd: mine.attempt.sourcePath, env: { ...process.env, PI_ARTIFACTS_DIR: ensureArtifactDir(deps.controlRoot, mine.verifierThreadId) }, guard };
  } });
  const tools = [run, verdict, ...environment];
  return { tools, extension: defineExtension({ name: "projects.verification-tools", tools }) };
}
