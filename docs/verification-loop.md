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

## Sandbox contract (what is enforced)

Every `projects_verify_run` command runs under macOS `sandbox-exec` with a profile that starts from "allow default" and then denies, by class:

| Denied | How | Proof (`scripts/verification-unit.mjs`) |
|---|---|---|
| Writes outside the snapshot, its scratch dir and the verifier's artifacts | `deny file-write*` + allow list | write attempts to other paths and the source worktree fail |
| Reading any home directory's content (`/Users/*`, the real `$HOME`, credentials, project data) | `deny file-read-data` on `/Users` and `$HOME`, allow list for the snapshot, its artifacts and the running toolchain | a decoy file under the real home cannot be read; the artifacts folder inside the project home can |
| Every unix socket except one inside the run's scratch dir: the host control socket (no token, same user), Docker, mDNSResponder | `deny network*` then allow loopback TCP and `unix-socket (subpath scratch)` | a socket in tmp and a Docker-style socket are refused with EPERM; one in scratch works |
| DNS and the rest of the network | no mDNSResponder socket or mach service | `example.com` does not resolve; loopback TCP works |
| Mach services: LaunchServices, AppleEvents, securityd, CoreSimulator, dnssd | `deny mach-lookup`, `appleevent-send`, `lsopen`; allow list of the few services toolchains need | `open`, `osascript`, `security`, `launchctl`, `xcrun simctl` all fail instead of running |
| Signalling processes outside the sandbox | `deny signal (target others)` | a `kill -9` of an outside process fails |

`projects_verify_run` also refuses commands naming `simctl`, `xcodebuild`, `osascript`, `screencapture`, `launchctl`, `open -a`, `--remote-debugging-port` up front, for a clearer message; the sandbox is what enforces it.

**Not enforced**: loopback TCP is open (a verification's own servers need it), so services the owner runs on loopback ports are reachable from a verifier command. The platform's file-read rules outside `/Users` (system files, `/opt`, `/tmp`) stay open so toolchains run. Do not rely on this as protection against hostile code beyond the table above.

**Resources that are not leased are unavailable, not shared.** There is no lease binding for simulators, devices or the owner's browser. Skills that need them (iOS simulator work, Yandex Keyboard, headless Chrome with a GUI process: Chrome aborts under this profile) cannot run: the verifier records the criterion as `blocked`, and the cycle escalates as NOT VERIFIED with that reason. That is the intended result, not a bug, and it means this loop is **not ready** for skills such as `verify-keyboard` or Mari's browser/simulator flows until a leased, separately approved execution path exists.

## Limits (honest)

- **macOS only** (`sandbox-exec`, deprecated by Apple but present). Elsewhere verification is refused (escalated), never run unconfined.
- **Only scoped top-level workers are verified.** A top-level worker without an isolated worktree is escalated "Verification does not apply" and blocked (e2e R8). A child worker's report carries an explicit "NOT VERIFIED on its own" line; its output is checked as part of the parent's final result. Scouts and reviewers produce no work product to verify.
- Snapshot limit: 50k files / 1 GiB. The brief must fit intact: more than 20 criteria or more than 24000 characters of task are refused (blocked) rather than truncated.
- **The proof is the worker's tree.** The snapshot contains the worker's edits to skills, scripts and tests. They are listed and diffed for the verifier and named in the verdict report; the loop does not forbid them.
- Failure signature: failing criteria, their reasons, exit codes and output hashes. Identical on two consecutive attempts means no progress (escalate); any change counts as progress, bounded by the 3-attempt cap.
- A pass cannot cite a run that timed out, was aborted or was killed.
- A repair turn that fails closes the cycle (escalated, earlier completed turns become blocked, dependents block). A pause leaves the cycle open for the resume.
- **Restart:** a host kill leaves the project paused with the verifier interrupted and the attempt open; the owner resumes with the existing recovery action and the same cycle continues. Sandboxed commands left running by the dead host are killed on the next start (identity recorded per run; a reused pid is never signalled).

## Frozen at cycle start

Verifier model, skill and criteria are stored in the cycle, and every verifier thread of the cycle is created with that model and skill (`frozen` on the plan work). Changing Settings mid-cycle does not change the judge; if the frozen model is no longer configured the attempt escalates instead of falling back.

## Tests

- `node scripts/verification-unit.mjs`: verdict rules, escalation rules, snapshots, sandbox (writes, reads, network, signals, simulator service, global-resource refusal), settings.
- `node scripts/verification-loop-e2e.mjs` (V0–V7): isolated host, deterministic model at the provider seam, real git/sandbox/commands. Fail → fix → fresh pass, escape attempt, blocked, drift, repeated failure, missing skill, cap 1, disabled.
- `node scripts/verification-recovery-e2e.mjs` (R1–R8): three real attempts then exhaustion; host SIGKILL mid-attempt, restart, resume, settings changed meanwhile and still frozen (attempt 2 runs on the frozen model and skill); cap 2 with three parents where the finished parent's verifier is scheduled ahead of queued work; failed repair turn; 21 criteria refused and a 3000-character criterion kept whole; proof-file diff shown; no snapshot left behind; worker without a worktree escalated.
- Browser: `verify-pi-prjcts` drive `verification-settings`.
