# Automatic verification loop

Opt-in per project (Settings → Verification). Off by default; a project that never enables it behaves exactly as before.

## Flow

1. A top-level, scoped worker's turn ends. If verification is on, the planner does not report completion. It snapshots the worker's worktree (tracked, modified and untracked non-ignored files, content-hashed into a `revision`) and admits a **fresh verifier thread** (role `verifier`, child of the worker thread) whose read root is the snapshot.
2. The verifier reads the project verification skill (frozen when the cycle starts) and runs what it prescribes with `projects_verify_run`, then records one structured verdict with `projects_verification_verdict`: every criterion `pass | fail | blocked`, a reason, and evidence (run ids, artifacts). The host derives the overall status; a pass needs a recorded run.
3. Pass → the work stays `completed` and the coordinator gets "VERIFIED … after N attempt(s)" with the commands and log links.
   Fail with attempts left and visible progress → the verdict goes back to the **same worker thread** as a follow-up; its next result gets a fresh verifier. Max 3 verifier attempts per task.
   Blocked, stale, no verdict, same failure signature twice, or 3 failures → escalation: the work becomes `blocked` ("Verification did not pass") and the coordinator gets "NOT VERIFIED: reason" with the last verdict. Nothing is reported complete.
4. Stopping the worker or its verifier ends the cycle without a report.

## Guarantees and how they are enforced

- **Own model and skill.** `models.verifier` and `verification.skill` are separate Settings. Enabling needs both; no default and no fallback to the coordinator or worker model. Missing/uninstalled/unconfigured at settlement time escalates ("blocked"), it never passes.
- **Execution is sandboxed.** Verifier commands run under macOS `sandbox-exec`: writes only to the snapshot, its scratch dir and the verifier's artifacts folder; no non-loopback network; credentials, the Pi home and project data unreadable by content. No sandbox (non-macOS) → verification refused, never run unconfined.
- **Exact target, drift rejected.** The verdict is bound to the snapshot revision. If the verifier modified its snapshot, or the worker's tree no longer hashes to that revision when the verdict is used, the attempt is `blocked`/`stale` and escalates.
- **Parent frozen.** While an attempt is running the worker thread cannot be admitted new work or dispatched.
- **No source/publication/delegation.** The verifier's tools are code reading, the skill reader and its two tools only: no write/edit/shell/VCS/GitHub/knowledge/MCP/delegation tools.
- **Capacity.** Verifiers use the shared worker pool at high priority; a worker that finished its turn has released its slot, so cap 1 cannot deadlock (tested). They are children and count toward the same cap.
- **Durability.** The cycle (frozen model/skill/criteria, attempts, revisions, runs, verdicts) lives in the planning document, so it survives restart; snapshots are removed after use, manifests, run records and logs stay as evidence.

## Limits (honest)

- macOS only (sandbox-exec). `verify-pi-prjcts`-style browser runs need the sandbox to permit loopback and the browser; shared simulators/browsers are not yet leased per attempt, and the verifier's own browser is not leased against other agents.
- A verifier can only exercise what the sandbox allows; skills needing network or credentials report `blocked`.
- Only scoped top-level workers are verified; scouts, reviewers and nested children are not.
- Restart recovery relies on the durable planning state and is not covered by a dedicated restart test.
- Snapshot limit: 50k files / 1 GiB.

## Tests

`node scripts/verification-unit.mjs` (verdict judging, escalation rules, sandbox, settings) and `node scripts/verification-loop-e2e.mjs` (isolated host, deterministic model at the provider seam, real git/sandbox/commands: fail → fix → fresh pass, escape attempt, blocked, drift, repeated failure, missing skill, cap 1, disabled). Browser: `verify-pi-prjcts` drive `verification-settings`.
