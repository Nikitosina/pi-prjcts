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

- **macOS only** (`sandbox-exec`). Elsewhere verification is refused (escalated), never run unconfined.
- **Machine-wide resources are not leased.** A verifier run holds no lease on simulators, the owner's apps or fixed browser ports. Instead they are made unavailable: `projects_verify_run` refuses commands naming `simctl`, `xcodebuild`, `osascript`, `screencapture`, `open -a`, `--remote-debugging-port`; the sandbox denies the CoreSimulator service and signalling processes outside the sandbox. A skill that needs them gets `blocked` (escalated), not a weaker pass. Headless browsers on a private profile and loopback ports work. The refusal is a command-name filter plus the sandbox rules, not a general resource broker.
- **Only scoped top-level workers are verified.** With verification on, a top-level worker without an isolated worktree is escalated as "Verification does not apply" and its work is blocked (not reported complete). That path is covered by the code and not by an e2e. Scouts, reviewers and nested child workers are not verified; their parent worker's result is.
- A verifier can only do what the sandbox allows; skills needing network or credentials report `blocked`.
- Snapshot limit: 50k files / 1 GiB.
- **Restart:** a host kill leaves the project paused with the verifier interrupted and the attempt open; the owner resumes with the existing recovery action and the same verifier thread continues on the same snapshot. Until then the worker stays frozen and its dependents wait.

## Frozen at cycle start

Verifier model, skill and criteria are stored in the cycle, and every verifier thread of the cycle is created with that model and skill (`frozen` on the plan work). Changing Settings mid-cycle does not change the judge; if the frozen model is no longer configured the attempt escalates instead of falling back.

## Tests

- `node scripts/verification-unit.mjs`: verdict rules, escalation rules, snapshots, sandbox (writes, reads, network, signals, simulator service, global-resource refusal), settings.
- `node scripts/verification-loop-e2e.mjs` (V0–V7): isolated host, deterministic model at the provider seam, real git/sandbox/commands. Fail → fix → fresh pass, escape attempt, blocked, drift, repeated failure, missing skill, cap 1, disabled.
- `node scripts/verification-recovery-e2e.mjs` (R1–R3): three real attempts then exhaustion; host SIGKILL mid-attempt, restart, resume, settings changed meanwhile and still frozen; cap 2 with three parents where the finished parent's verifier is scheduled ahead of queued work.
- Browser: `verify-pi-prjcts` drive `verification-settings`.
