import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { defineExtension, defineTool, ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import { ensureArtifactDir } from "./artifacts.ts";
import type { BackgroundCommands } from "./background-commands.ts";
import { Jobs, type Job } from "./jobs.ts";
import type { ResourceLeases } from "./resource-leases.ts";
import { missingLease } from "./verification-resources.ts";
import { workerEnvironmentTools } from "./worker-environment-tools.ts";

const exec = promisify(execFile);

/** One command run for a Job: its log lives under the Job's artifacts, and the run is tied to the commit it ran on. */
export type ProofRun = {
  id: string;
  command: string;
  sha: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  log: string;
  at: number;
};

const runsFile = (controlRoot: string, jobId: string) => join(ensureArtifactDir(controlRoot, jobId), "proof-runs.json");
export function proofRuns(controlRoot: string, jobId: string): ProofRun[] {
  try {
    return JSON.parse(readFileSync(runsFile(controlRoot, jobId), "utf8")) as ProofRun[];
  } catch {
    return [];
  }
}
/**
 * Why these proof references cannot back a Ready report, or null. `r<n>` and `run:r<n>` name runs of this Job: they must exist, have
 * run on the candidate commit and have finished with exit code 0. `artifact:<path>` names a file under the Job's artifacts.
 * Other references are free text.
 */
export function checkProofRefs(controlRoot: string, job: Pick<Job, "id" | "candidate">, refs: readonly string[]): string | null {
  const runs = proofRuns(controlRoot, job.id);
  const dir = ensureArtifactDir(controlRoot, job.id);
  const problems: string[] = [];
  for (const ref of refs) {
    const run = /^(?:run:)?(r\d{1,4})$/.exec(ref.trim())?.[1];
    if (run) {
      const found = runs.find((item) => item.id === run);
      if (!found) problems.push(`${ref}: no such run`);
      else if (found.timedOut || found.aborted || found.exitCode !== 0)
        problems.push(`${ref}: the run did not pass (exit ${found.exitCode ?? "none"}${found.timedOut ? ", timed out" : ""})`);
      else if (job.candidate && found.sha !== job.candidate)
        problems.push(`${ref}: it ran on ${found.sha.slice(0, 8)}, not the candidate ${job.candidate.slice(0, 8)}`);
      continue;
    }
    const artifact = /^artifact:(.+)$/.exec(ref.trim())?.[1];
    if (artifact) {
      const path = resolve(dir, artifact.startsWith(`${job.id}/`) ? artifact.slice(job.id.length + 1) : artifact);
      if (!path.startsWith(dir + sep) || !existsSync(path)) problems.push(`${ref}: no such artifact`);
    }
  }
  return problems.length
    ? `The proof does not hold: ${problems.join("; ")}. Cite only passing runs on the candidate, or list the check under gaps.`
    : null;
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export type ProofDeps = {
  projectId: string;
  controlRoot: string;
  background: BackgroundCommands;
  leases: ResourceLeases;
  /** The worker's shell policy for this Job, or why the host cannot apply it. */
  shell: (job: Job, cwd: string) => { guard: (command: string) => string } | { refusal: string };
  isClosed?: () => boolean;
};

/**
 * The verifier's tools: shell commands on the candidate in the Job's worktree with their logs kept, plus the lease and background tools workers have.
 * A verifier is trusted like its worker; nothing confines its commands, and the run record only ties each result to one commit.
 */
export function proofTools(deps: ProofDeps) {
  async function jobOf(api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, context: Context): Promise<Job> {
    const doc = await api.snapshot(Jobs, ROOT_CONVERSATION_ID, context);
    const id = doc?.subagents[String(api.conversationId)];
    const job =
      (id ? doc?.jobs[id] : undefined) ?? Object.values(doc?.jobs ?? {}).find((item) => item.workerConversation === api.conversationId);
    if (!job) throw new Error("Only a Job's worker or its subagents can use this tool");
    return job as Job;
  }
  const headOf = async (cwd: string) => (await exec("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
  const run = defineTool({
    name: "projects_verify_run",
    description:
      "Run one shell command in the Job's worktree (your working directory) on the candidate commit and keep its log. It runs as the same user, with the worker's environment and shell policy, and nothing confines it: use what the verify skill and criteria call for, and do not edit the work. " +
      "Commands naming a simulator, container runtime, fixed browser port or desktop session need your lease on it first (projects_lease_acquire). " +
      "Returns the exit code, the output tail and a run id (r1, r2, …) to cite as proof. A run is refused when the worktree is not on the candidate commit. Commands run one at a time.",
    parameters: Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 4000 }),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Default 600." })),
      },
      { additionalProperties: false },
    ),
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      if (deps.isClosed?.()) return text("Project runtime is closing", true);
      const job = await jobOf(api, context);
      const cwd = (await api.agent(context)).cwd;
      if (!cwd) return text("This conversation has no working directory", true);
      if (!job.candidate) return text("The Job has no candidate yet: the worker records one with job candidate after pushing.", true);
      const head = await headOf(cwd).catch(() => "");
      if (head !== job.candidate)
        return text(
          `Not run: the worktree is on ${head.slice(0, 8) || "an unknown commit"}, not the candidate ${job.candidate.slice(0, 8)}. Verify the candidate or ask the worker to record the new one.`,
          true,
        );
      const shell = deps.shell(job, cwd);
      if ("refusal" in shell) return text(shell.refusal, true);
      const held = deps.leases
        .held((holder) => holder.projectId === deps.projectId && holder.threadId === job.id)
        .map((item) => item.resource);
      const missing = missingLease(args.command, held);
      if (missing)
        return text(
          `Not run: this command uses the ${missing.resource}, which other workers share, and you hold no lease for it. Take ${missing.hint} with projects_lease_acquire first. If the lease is held by someone else, or you lack the tool or grant, list the check under gaps.`,
          true,
        );
      const artifacts = ensureArtifactDir(deps.controlRoot, job.id);
      const runs = proofRuns(deps.controlRoot, job.id);
      const id = `r${runs.length + 1}`;
      const started = Date.now();
      const deadline = started + (args.timeoutSeconds ?? 600) * 1000;
      const running = deps.background.start(job.id, {
        command: shell.guard(args.command),
        label: `verify ${id}`,
        cwd,
        env: { ...process.env, PI_ARTIFACTS_DIR: artifacts },
      });
      let timedOut = false,
        aborted = false,
        status;
      for (;;) {
        status = await deps.background.wait(job.id, running.id, {
          tailLines: 60,
          waitSeconds: Math.max(1, Math.min(30, Math.ceil((deadline - Date.now()) / 1000))),
          signal: context.abortSignal,
        });
        if (status.state !== "running") break;
        aborted = context.abortSignal?.aborted === true;
        timedOut = !aborted && Date.now() >= deadline;
        if (aborted || timedOut) {
          await deps.background.stop(job.id, running.id);
          status = await deps.background.wait(job.id, running.id, { tailLines: 60, waitSeconds: 10 });
          break;
        }
      }
      const log = `bg/${running.id}.log`;
      const record: ProofRun = {
        id,
        command: args.command.slice(0, 2000),
        sha: head,
        exitCode: status.code,
        signal: status.signal,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        log,
        at: Date.now(),
      };
      mkdirSync(artifacts, { recursive: true, mode: 0o700 });
      writeFileSync(runsFile(deps.controlRoot, job.id), JSON.stringify([...proofRuns(deps.controlRoot, job.id), record]), { mode: 0o600 });
      return text(
        {
          runId: id,
          sha: head.slice(0, 8),
          exitCode: status.code,
          signal: status.signal,
          timedOut,
          aborted,
          durationMs: record.durationMs,
          log,
          tail: status.tail,
        },
        status.code !== 0,
      );
    },
  });
  const environment = workerEnvironmentTools({
    projectId: deps.projectId,
    leases: deps.leases,
    background: deps.background,
    target: async (api, context) => {
      const job = await jobOf(api, context);
      const cwd = (await api.agent(context)).cwd ?? deps.controlRoot;
      const guard = (command: string): string => {
        const held = deps.leases
          .held((holder) => holder.projectId === deps.projectId && holder.threadId === job.id)
          .map((item) => item.resource);
        const missing = missingLease(command, held);
        if (missing) {
          const message = `Not run: this command uses the ${missing.resource}, which other workers share, and you hold no lease for it. Take ${missing.hint} with projects_lease_acquire first.`;
          return `printf '%s\\n' '${message.replaceAll("'", "'\\''")}' >&2; exit 126`;
        }
        const shell = deps.shell(job, cwd);
        if ("refusal" in shell) throw new Error(shell.refusal);
        return shell.guard(command);
      };
      return { threadId: job.id, cwd, env: { ...process.env, PI_ARTIFACTS_DIR: ensureArtifactDir(deps.controlRoot, job.id) }, guard };
    },
  });
  const tools = [run, ...environment];
  return { tools, extension: defineExtension({ name: "projects.proof-tools", tools }) };
}
