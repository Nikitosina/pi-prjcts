# Jobs report delivery failures

- A Ready wakeup repeats the closing answer and all evidence instead of a concise handback; full details must remain available through `agents report` without waking the worker.
- A long helper, scout, failure, Ready or checkpoint answer becomes an unbounded notification; notification previews must be explicitly marked, retain actionable status and point to the exact unabridged report.
- Reading an older notification after another Ready or helper answer returns the latest evidence instead of the original full report; report references must be immutable and conversation-scoped, including failures before preparation.
- A checkpoint is mistaken for Ready or failure, becomes approvable, or resumes without a new instruction after restart or project resume.
- Ordinary steers rearm an unchanged stall; a quiet background service wakes the coordinator despite visible execution progress.
- A recovered worker cannot raise a genuinely new stall, or an actionable helper answer is suppressed while the coordinator awaits the owner.
- A queued stall survives the worker's completion and consumes the next coordinator request; retract only still-queued obsolete stall submissions, never placed inputs or real results.

- Two steers answered by the same turn must not post duplicate failure reports to the coordinator.
- The newest steer must settle the agent and Job and post the full Ready payload, whether the oldest or newest reporter sees their shared answer first.
- A shared quota failure must start one recovery path, not one per reporter.
- Repeating `agents send` with the same request id must deliver one message.
- Distinct follow-up answers, Ready reports, restart continuation and stop must retain their existing behavior.

- Deployment mistakes a paused helper's retained running identity for execution, or ignores its still-draining owned tasks; resume must reuse the same helper and workspace intent.
- The old host's `afterFailedRun: keep` queue cannot be recovered via a new public owner input without dropping or duplicating the parked message; verify that ordinary admission advances both inputs exactly once.

## Activity reflects what runs (2026-11-05, owner: "the display bugs should be resolved, and the host should identify it correctly")

Live cause: a project pause aborted every chat with its background tasks, including the reporter of a worker that had just called `job ready` and was writing its last reply. The aborted reporter never ended the agent, so the project and its chat showed "working" for two days with nothing running. In another project a compaction summary queued for a worker's next turn stayed queued after that worker ended, and kept the project "working", paused or not.

- A1 A reporter aborted after its Job already ended (Ready, checkpoint, failed or stopped) leaves the agent with no end time, so the agent counts as live forever.
- A2 Agents left that way by an older host stay live after a restart; opening the project must end them, and must not end an agent whose Job is still running or a helper still settling.
- A3 `busy()` counts an agent as work from its bookkeeping alone (`endedAt === null`) instead of from tasks that can still run; a Ready Job's worker, or a scout whose reporter is gone, keeps the project busy.
- A4 A queued passive write (a compaction summary waiting for the next turn of an ended agent) counts as work; only unfinished runnable tasks and queued or placed input do.
- A5 A blocked task (missing definition or restart limit) counts as work; it runs nothing and needs the owner, not a spinner.
- A6 Project activity has no `paused` state: a paused project shows "working" or "idle" and the tree cannot tell it apart.
- A7 A chat counts as working because one of its agents has no end time while nothing of that agent runs.
- A8 The tree shows a paused project with the working dot, or with no sign that it is paused.

## Review budget, auto-checkpoint, did not start (retro 2026-11-09)

Owner rule: one full review, then at most `review.rechecks` re-checks (project setting, 0-5, default 2), each on the fix diff and the still-open findings. The host enforces it at the worker's `subagent` tool, not only in the prompt.

- R1 The three axis reviewers of a `pr-review` round count as three rounds, so the re-checks are spent before the first fix.
- R2 A fourth `full` reviewer, or a `full` reviewer after the first re-check, is admitted: a worker restarts the review from scratch instead of re-checking.
- R3 A re-check without a full review first is admitted.
- R4 The count lives in memory or in the conversation only: a host restart or a follow-up to the same Job resets it.
- R5 A replayed `subagent` call (restart mid-review) counts twice and refuses the reviewer it already started.
- R6 A refusal says only "refused": the worker loops or stops without a report instead of reporting Ready with the remaining findings as gaps.
- R7 Scouts count against the review budget.
- R8 The project setting is ignored, or accepts a value outside 0-5, or a settings save needs a host restart to apply.
- C1 A worker that ends its turn without `job ready` or `job checkpoint` fails the Job; its question or partial work looks like a crash.
- C2 The automatic checkpoint is indistinguishable from one the worker recorded, or offers Approve, or drops the worker's workspace.
- C3 The automatic checkpoint notifies the Coordinator twice, or not at all.
- S1 A failure in workspace preparation reads like a model failure ("failed"); the Job card and report must say "did not start" with the cause.
