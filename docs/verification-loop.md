# Automatic verification loop

Opt in per project in Settings → Verification. It is off by default. Enabling it requires a separately chosen verifier model and an installed verification skill; neither falls back to the worker or coordinator choices.

## Flow

1. A top-level, scoped worker finishes a turn. The planner records a content hash of its exact worktree, including modified and untracked non-ignored files, and admits a **fresh verifier thread**. The worker stays paused while that attempt runs.
2. The verifier reads the frozen skill and runs it against the worker's worktree with `projects_verify_run`. It records one structured verdict with `projects_verification_verdict`: every criterion is `pass | fail | blocked`, with a reason and evidence (run ids and artifacts). The host derives the overall result; every passing criterion needs a normally finished run.
3. Pass keeps the work completed and reports `VERIFIED` with commands and log links. A failure with attempts left and visible progress returns the verdict to the **same worker**, whose repair is checked by another fresh verifier. A cycle has at most three attempts.
4. Blocked, stale, no verdict, the same failure twice, a failed repair, or attempt exhaustion escalates as `NOT VERIFIED`. The work is blocked rather than reported complete. Stopping the worker or verifier ends the cycle without a completion report.

## Trusted execution contract

The verifier is **trusted like the worker, not sandboxed**. Its commands run as the host user in the worker's worktree, with the worker's environment and best-effort shell policy. Shell text checks and revision checks are accident/evidence guardrails, not confinement: trusted commands can write files, reach services and inherit credentials. Run verification only for projects and skills the owner trusts.

- **Existing grants only.** Verification adds no workspace, publication, MCP or delegation grant. The verifier has read-only code tools, its skill reader, run/verdict tools, and the existing lease/background-command tools. It has no edit/write tools, publication tools or recursive delegation. A workspace provider whose shell policy lives in an unavailable plugin is blocked rather than run under a weaker policy.
- **Shared resources.** Commands naming a simulator, container runtime, fixed browser debugging port or desktop session need a matching lease from the host-wide lease table. Leases are advisory coordination, not access control. Failed, stopped and finished attempts release their leases and background commands; a host restart frees the in-memory lease table and reaps recorded orphan process groups.
- **Exact target and drift.** Each attempt stores its starting revision and manifest. At the verdict, added, removed and modified files must be declared in `sourceWrites` with reasons. Undeclared drift or an unreadable target makes the attempt stale. Declared drift gets a final revision, which is checked again when the verdict settles; later changes are stale. Ignored dependency/build outputs are outside the content revision.
- **Evidence.** Commands, combined stdout/stderr logs, screenshots and verdicts belong to the verifier thread and survive attempt cleanup. There is no disposable source snapshot. Revision manifests remain as evidence. The verifier can inspect the parent's worktree and diff; changed proof files are listed in its brief and report.
- **Capacity and admission.** Verifiers share the bounded worker pool at high priority. A finished worker has released its slot, so cap 1 does not deadlock. Pausing between worker settlement and verifier admission defers the attempt until recovery instead of starting work behind the owner's back.
- **Durability.** Frozen model, skill and criteria, attempts, revisions, runs, source writes and verdicts live in the planning document. Restart recovery keeps the cycle open and never guesses a result. A settings change mid-cycle does not replace the judge.

## Limits

- Only scoped top-level workers in git workspaces are verified. A worker without an isolated worktree escalates as not verifiable. A child worker is checked only as part of its parent's final result; scouts and reviewers have no work product to verify.
- Revision hashing covers at most 50,000 files and 1 GiB. More than 20 criteria or a task over 24,000 characters is refused whole rather than truncated.
- The proof comes from the worker's tree, including its edits to skills, scripts and tests. Those edits are shown for review; the loop does not decide whether a check was weakened.
- A pass cannot cite a run that timed out, was aborted or was killed. Identical failing criteria, reasons, exit states and log hashes on two attempts count as no progress.
- The deterministic provider used by the E2Es sits at the existing model API seam. It proves routing, tools, the browser/host path and storage, not the behavior of a real model or provider credentials.

## Tests

- `node scripts/verification-unit.mjs`: verdict and escalation rules, exact revisions and drift, lease conflicts/release, worker shell policy, criteria limits and settings.
- `node scripts/verification-loop-e2e.mjs` (V0–V7): isolated host, real git and trusted commands. Fail → same-worker repair → fresh pass, undeclared drift, blocked, external drift, repeated failure, missing skill, cap 1 and disabled compatibility.
- `node scripts/verification-recovery-e2e.mjs` (R1–R8): three attempts, restart and frozen settings, saturated scheduling, failed repair, intact criteria, proof diffs, retained evidence and unscoped workers.
- `node scripts/verification-trusted-browser-e2e.mjs`: the canonical `verify-pi-prjcts` launch/doctor/drive/cleanup path inside verifier attempts, real isolated host and headless Chrome, actual browser failure → same-worker repair → fresh pass, screenshots and independent stored transcript.
- Browser settings journey: `verify-pi-prjcts` drive `verification-settings`.
