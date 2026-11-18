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
- R9 A reviewer that never answered (its model failed, or its call was cancelled with a failed sibling) still holds its place in the budget, so the retry is refused with no review done (live 2026-11-11: one quota failure and two cancelled siblings spent the whole full round). Only a reviewer that answered, or is still running, counts; Jobs recorded before reviewer children carried their kind count theirs the same way.
- C1 A worker that ends its turn without `job ready` or `job checkpoint` fails the Job; its question or partial work looks like a crash.
- C2 The automatic checkpoint is indistinguishable from one the worker recorded, or offers Approve, or drops the worker's workspace.
- C3 The automatic checkpoint notifies the Coordinator twice, or not at all.
- S1 A failure in workspace preparation reads like a model failure ("failed"); the Job card and report must say "did not start" with the cause.

## Waiting workers wake the Coordinator (live 2026-11-09, Mari: owner "исполнители ждут координатора, а он не отвечает ни им, ни спрашивает у меня")

Live cause: the Coordinator answered "yes, I continue, next I start the full check" and ended its turn without a tool call. Every worker of the chat was parked in checkpoint, waiting for it, and nothing it started was running, so no report could wake it. The chat stayed silent for nine hours until the owner asked for progress. The same happened after a turn the owner stopped.

- I1 The Coordinator ends its turn while independent workers of its chat wait in checkpoint and nothing started from that chat runs; nobody wakes it.
- I2 The wake repeats for an unchanged waiting set: on every tick, after the Coordinator answered it, or after a host restart.
- I3 It wakes while something started from the chat still runs (a running Job, a live scout or reviewer, a report on its way) or while the Coordinator is busy or has queued input.
- I4 It wakes right after the turn ends, before the owner had a few minutes to answer.
- I5 A dismissed checkpoint, a Ready Job (it waits for the owner, not the Coordinator) or a completed task helper counts as waiting.
- I6 A paused project wakes its chats.
- I7 A worker that returns to checkpoint with a new answer after the wake is never announced again.

## A reviewer reads a new revision in the same conversation (owner 2026-11-18: "переиспользовать reviewer, а не спавнить новых каждый раз")

`agents send` to an idle reviewer that reads a full commit may carry `readRef`: the full SHA of the new revision. The reviewer keeps its conversation; the new turn gets a new frozen checkout, and the old one stays bound to the old SHA.

- V1 A send with a new SHA still reads the first checkout: the stored binding of the reviewer is reused, so the turn reads A while the message says B.
- V2 The new binding replaces or edits the old one: the old report's checkout, a restart of the old turn, or cleanup no longer matches the SHA the old report names.
- V3 The report of a turn does not name the commit it read, or names the latest one when a newer send already arrived; the old report stops identifying A.
- V4 An unavailable SHA (not in the repository, malformed, an option-like ref, a branch name) is accepted, or leaves the reviewer labelled with B although it read nothing; a later plain send then reads or claims B.
- V5 Two sends with different SHAs race: both start, or the second silently replaces the first turn's revision while it runs. Only an idle reviewer changes revision.
- V6 A retry of the same `requestId` starts a second turn or a second checkout; a retry after the host restarted mid-prepare binds a different SHA than the first attempt.
- V7 `readRef` on send widens access: it is accepted for a worker, a scout, a reviewer of another chat, a reviewer that reads an agent's worktree or the project checkout, or a paused project.
- V8 A frozen binding whose SHA differs from the SHA requested for the turn is used anyway.
- V9 The reviewer is not told that its working directory now holds another commit, and answers from the file contents of the old one.
- V10 A reviewer is stopped while its turn prepares and a new commit is accepted at once: the old turn prepares the new commit and labels its answer with the old one. A new commit is taken only after every earlier message of the reviewer has been reported, also when a newer message settled first.
- V11 A failed first SHA, or a plain send that cannot be prepared, is reported as read. Every turn records the commit it was to read and whether its checkout was prepared; only a prepared turn says "Read revision".
- V12 A turn stopped before its checkout was prepared becomes the commit the next plain send reads.
- V13 A worker given a `readRef` gets revision evidence, or a reviewer's reused checkout is not at the commit its report names (git provider: HEAD moved or files changed). Plugin providers cannot be checked this way.
- V14 Reopening the host stops on a reviewer whose new commit is unavailable instead of reporting it from its own reporter.
