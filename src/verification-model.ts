import { createHash } from "node:crypto";

/** Fresh verifier attempts per worker task (the owner's policy); each ends in a verdict or in an escalation. */
export const MAX_VERIFICATION_ATTEMPTS = 3;
export const VERIFIER_PRIORITY = 1000;

export type Criterion = { id: string; text: string };
export type EvidenceRef = { runId?: string; artifact?: string; note?: string };
export type CriterionStatus = "pass" | "fail" | "blocked";
export type CriterionResult = { id: string; status: CriterionStatus; reason: string; evidence: EvidenceRef[] };
/** A command the host ran for the verifier. Logs are artifact files of the verifier thread (relative paths). */
export type RunRecord = { id: string; command: string; exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; durationMs: number; stdout: { path: string; bytes: number; sha256: string }; stderr: { path: string; bytes: number; sha256: string }; tail: string; at: number };
export type Verdict = { status: CriterionStatus; summary: string; criteria: CriterionResult[]; recordedAt: number };
/** `stale`: the worker's tree no longer matches the verified revision, so the result proves nothing about the current work. */
export type AttemptState = "running" | "pass" | "fail" | "blocked" | "stale";
export type VerificationAttempt = {
  n: number; verifierWorkId: string; verifierThreadId: string; key: string;
  /** Exact content revision of the worker's tree (uncommitted and untracked work included) that was copied for the verifier. */
  revision: string; head: string | null; branch: string | null; sourcePath: string; targetPath: string;
  /** Skill, script, test and CI files the worker changed in this revision: the proof the verifier runs may differ from the one the owner expects. */
  proofFiles?: string[];
  state: AttemptState; reason?: string; verdict?: Verdict; runs: RunRecord[]; signature?: string; startedAt: number; endedAt?: number;
};
export type Verification = {
  /** Frozen when the cycle starts, so a Settings change cannot swap the judge mid-loop. */
  model: string; skill: string; criteria: Criterion[];
  attempts: VerificationAttempt[];
  /** Worker work ids this cycle covers; they stay unfinished for dependents until the cycle ends. */
  workIds: string[];
  open: boolean; outcome?: "verified" | "escalated"; reason?: string;
};

/** A verdict answers criteria by id c1..c20, and the verifier's brief carries the whole task. Beyond these the cycle is refused (blocked), never cut short. */
export const MAX_CRITERIA = 20;
export const MAX_TASK_CHARS = 24000;
const HEADER = /^Acceptance criteria\b[^\n]*:\s*$/m;
/** Criteria are the bullet list the delegation appended to the brief; a brief without one is a single criterion. Nothing is truncated: the caller refuses what does not fit. */
export function parseCriteria(brief: string): Criterion[] {
  const header = HEADER.exec(brief);
  const items = header ? brief.slice(header.index + header[0].length).split("\n").map(line => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim()).filter((item): item is string => Boolean(item)) : [];
  const texts = items.length ? items : [brief.trim() || "The task as briefed"];
  return texts.map((text, index) => ({ id: `c${index + 1}`, text }));
}
/** Why a brief cannot be verified intact, or null. */
export function criteriaProblem(task: string, criteria: readonly Criterion[]): string | null {
  if (criteria.length > MAX_CRITERIA) return `The task lists ${criteria.length} acceptance criteria and a verdict can answer ${MAX_CRITERIA}; none were dropped, so it is not verified. Split the task`;
  if (task.length > MAX_TASK_CHARS) return `The task brief is ${task.length} characters; a verifier receives at most ${MAX_TASK_CHARS} intact, so it is not verified. Shorten or split the task`;
  return null;
}

export type VerdictInput = { summary: string; criteria: { id: string; status: CriterionStatus; reason: string; evidence?: EvidenceRef[] }[] };

/**
 * The host derives the overall status; the verifier cannot claim a pass the criteria do not carry. A pass needs a recorded run (or an
 * existing artifact) behind it, and every criterion must be answered exactly once.
 */
export function judge(criteria: readonly Criterion[], runs: readonly RunRecord[], input: VerdictInput, artifactExists: (path: string) => boolean): { ok: true; verdict: Verdict } | { ok: false; errors: string[] } {
  const errors: string[] = [], seen = new Set<string>(), known = new Set(criteria.map(item => item.id));
  for (const item of input.criteria) {
    if (!known.has(item.id)) errors.push(`Unknown criterion ${item.id}; answer only ${[...known].join(", ")}`);
    else if (seen.has(item.id)) errors.push(`Criterion ${item.id} answered twice`);
    seen.add(item.id);
    if (!item.reason.trim()) errors.push(`Criterion ${item.id} needs a reason`);
    const evidence = item.evidence ?? [];
    for (const ref of evidence) {
      if (ref.runId !== undefined && !runs.some(run => run.id === ref.runId)) errors.push(`Criterion ${item.id} cites run ${ref.runId}, which was not executed in this verification`);
      if (ref.artifact !== undefined && !artifactExists(ref.artifact)) errors.push(`Criterion ${item.id} cites artifact ${ref.artifact}, which is not in your artifacts folder`);
    }
    if (item.status === "pass" && !evidence.some(ref => ref.runId !== undefined)) errors.push(`Criterion ${item.id} passes without a run; cite the runId that shows it`);
    if (item.status === "pass") for (const ref of evidence) {
      const run = ref.runId === undefined ? undefined : runs.find(candidate => candidate.id === ref.runId);
      if (run && (run.timedOut || run.aborted || run.signal !== null)) errors.push(`Criterion ${item.id} passes on run ${run.id}, which was ${run.timedOut ? "timed out" : run.aborted ? "aborted" : `killed by ${run.signal}`}; that run proves nothing, rerun it or mark the criterion blocked`);
    }
  }
  for (const id of known) if (!seen.has(id)) errors.push(`Criterion ${id} is missing from the verdict`);
  if (errors.length) return { ok: false, errors };
  const results = input.criteria.map(item => ({ id: item.id, status: item.status, reason: item.reason.trim().slice(0, 2000), evidence: (item.evidence ?? []).slice(0, 12).map(ref => ({ ...ref, ...(ref.note ? { note: ref.note.slice(0, 500) } : {}) })) }));
  const status: CriterionStatus = results.some(item => item.status === "blocked") ? "blocked" : results.some(item => item.status === "fail") ? "fail" : "pass";
  return { ok: true, verdict: { status, summary: input.summary.trim().slice(0, 4000), criteria: results, recordedAt: Date.now() } };
}

/**
 * What failed and how it looked: per failing criterion its status and reason, and for each run behind it the exit code, signal and output hashes.
 * Equal signatures on consecutive attempts mean the worker's fix changed nothing observable; any change in the output or the reasons counts as progress.
 */
export function failureSignature(attempt: Pick<VerificationAttempt, "verdict" | "runs">): string {
  const failing = (attempt.verdict?.criteria ?? []).filter(item => item.status !== "pass").map(item => {
    const runs = item.evidence.flatMap(ref => ref.runId ? [attempt.runs.find(run => run.id === ref.runId)] : []).map(run => run ? [run.exitCode ?? "x", run.signal ?? "", run.timedOut ? "T" : "", run.stdout.sha256, run.stderr.sha256].join(":") : "missing");
    return `${item.id}|${item.status}|${item.reason.trim().replace(/\s+/g, " ")}|${runs.join(",")}`;
  }).sort();
  return createHash("sha256").update(failing.join("\n")).digest("hex");
}

export type NextStep = { kind: "verified" } | { kind: "retry" } | { kind: "escalate"; reason: string };
/** What follows a settled attempt. Only a fail with attempts left and visible progress goes back to the worker; everything else that is not a pass goes to the coordinator. */
export function nextStep(verification: Pick<Verification, "attempts">, attempt: VerificationAttempt): NextStep {
  switch (attempt.state) {
    case "pass": return { kind: "verified" };
    case "running": return { kind: "escalate", reason: "The verifier ended without recording a verdict" };
    case "blocked": return { kind: "escalate", reason: attempt.reason ?? attempt.verdict?.summary ?? "Verification was blocked" };
    case "stale": return { kind: "escalate", reason: attempt.reason ?? "The work changed while it was being verified" };
    case "fail": {
      const previous = verification.attempts.find(item => item.n === attempt.n - 1);
      if (attempt.n >= MAX_VERIFICATION_ATTEMPTS) return { kind: "escalate", reason: `Verification failed ${MAX_VERIFICATION_ATTEMPTS} times; attempts exhausted` };
      if (previous?.state === "fail" && previous.signature !== undefined && previous.signature === attempt.signature) return { kind: "escalate", reason: "The same criteria failed the same way twice; the worker's fix changed nothing observable" };
      return { kind: "retry" };
    }
    default: { const _exhaustive: never = attempt.state; return _exhaustive; }
  }
}

const clip = (text: string, size: number) => text.length > size ? `${text.slice(0, size)}…` : text;
/** The verdict as the parent worker or the coordinator reads it: criteria first, then the commands behind each failure. Artifact refs resolve in the project. */
export function verdictText(verification: Verification, attempt: VerificationAttempt): string {
  const lines = (attempt.verdict?.criteria ?? []).map(item => {
    const text = verification.criteria.find(criterion => criterion.id === item.id)?.text ?? item.id;
    const runs = item.evidence.flatMap(ref => ref.runId ? [attempt.runs.find(run => run.id === ref.runId)] : []).filter(run => run !== undefined);
    const shown = item.status === "pass" ? [] : runs.map(run => `    run ${run.id}: \`${clip(run.command, 300)}\` exit ${run.exitCode ?? run.signal ?? "?"}${run.timedOut ? " (timed out)" : ""}\n${clip(run.tail.trim(), 700).split("\n").map(line => `      ${line}`).join("\n")}`);
    const artifacts = item.evidence.flatMap(ref => [...(ref.artifact ? [ref.artifact] : []), ...(ref.runId ? (() => { const run = attempt.runs.find(candidate => candidate.id === ref.runId); return run ? [run.stdout.path, run.stderr.path] : []; })() : [])]).map(path => `[${path}](artifact:${attempt.verifierThreadId}/${path})`);
    return [`- ${item.id} ${item.status.toUpperCase()}: ${clip(text, 200)}\n  ${clip(item.reason, 600)}${artifacts.length ? `\n  evidence: ${artifacts.join(", ")}` : ""}`, ...shown].join("\n");
  });
  return `Verification attempt ${attempt.n} of ${MAX_VERIFICATION_ATTEMPTS} (verifier thread ${attempt.verifierThreadId}) on revision ${attempt.revision.slice(0, 12)}${attempt.branch ? ` (${attempt.branch}` + (attempt.head ? ` @ ${attempt.head.slice(0, 9)}, plus uncommitted work)` : ")") : ""}: ${attempt.state.toUpperCase()}${attempt.reason ? ` (${attempt.reason})` : ""}${attempt.proofFiles?.length ? `\nProof files the worker changed (skills, scripts, tests, CI; review them): ${attempt.proofFiles.slice(0, 12).join(", ")}${attempt.proofFiles.length > 12 ? ", …" : ""}` : ""}\n${attempt.verdict ? `${clip(attempt.verdict.summary, 1200)}\n${lines.join("\n")}` : "No verdict was recorded."}`;
}

/** Role text of every verifier thread. Fixed in code: the verifier's behavior is part of the loop's guarantees, not a Settings prompt. */
export const VERIFIER_RULES = `Role profile: verifier.
You decide whether finished work meets its criteria, by running the project's verification skill against a frozen snapshot of that work. Your evidence decides, whatever the worker claimed.
1. Read the verification skill named in your task with projects_skill_file, then the feature file it points to for the changed surface.
2. Run what the skill prescribes with projects_verify_run. Commands run in the snapshot under an OS sandbox: they write only the snapshot, their scratch space and $PI_ARTIFACTS_DIR, and reach only loopback. Save screenshots and logs in $PI_ARTIFACTS_DIR and run the skill's cleanup before you finish.
3. Judge each criterion by its own wording. A pass cites the run that shows the behavior; a criterion you cannot exercise is blocked, with the reason.
4. Call projects_verification_verdict once, answering every criterion id.
Fail means the work is wrong. Blocked means you cannot tell (skill missing, tool failing, environment unavailable). Report what the runs show: editing the snapshot, the criteria or the checks changes the question, and the host rejects a verdict from a modified snapshot. Your verdict goes back to the worker automatically.`;

export function verifierBrief(input: { proof?: { paths: string[]; diff: string }; skill: string; criteria: readonly Criterion[]; task: string; attempt: number; revision: string; branch: string | null; head: string | null }): string {
  return `Verify the finished work of a worker thread. Attempt ${input.attempt} of ${MAX_VERIFICATION_ATTEMPTS}; you start with no memory of earlier attempts.
Verification skill: ${input.skill}
Snapshot: your working directory, content revision ${input.revision.slice(0, 12)} of branch ${input.branch ?? "(detached)"} at ${input.head?.slice(0, 9) ?? "no commit"}, including the worker's uncommitted and untracked files.

Original task (authoritative; the worker's own summary is not):
${input.task}

${input.proof?.paths.length ? `The worker changed ${input.proof.paths.length} file(s) that define the proof (skills, scripts, tests, CI). Judge by the criteria, not by edited checks: treat weakened, skipped or deleted checks as a failure of the work, and say so in the reason.\n${input.proof.diff}\n\n` : ""}Criteria, answer each id in the verdict:
${input.criteria.map(item => `- ${item.id}: ${item.text}`).join("\n")}`;
}


/** What the plan snapshot, Settings and the coordinator see of a cycle: states and ids, not command output. */
export type VerificationSummary = { open: boolean; outcome: Verification["outcome"] | null; reason: string | null; model: string; skill: string; criteria: Criterion[]; attempts: { n: number; state: AttemptState; reason: string | null; revision: string; verifierThreadId: string; runs: number; proofFiles: string[]; criteria: { id: string; status: CriterionStatus }[] }[] };
export function summarizeVerification(cycle: Verification): VerificationSummary {
  return { open: cycle.open, outcome: cycle.outcome ?? null, reason: cycle.reason ?? null, model: cycle.model, skill: cycle.skill, criteria: cycle.criteria.map(item => ({ ...item })), attempts: cycle.attempts.map(item => ({ n: item.n, state: item.state, reason: item.reason ?? null, revision: item.revision, verifierThreadId: item.verifierThreadId, runs: item.runs.length, proofFiles: [...(item.proofFiles ?? [])], criteria: (item.verdict?.criteria ?? []).map(result => ({ id: result.id, status: result.status })) })) };
}
