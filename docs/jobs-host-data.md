# Jobs: host data for the UI

Jobs replace the plan/work model. One Job is one owner request with one worker; the worker owns planning, verification and review. Everything below is host RPC (`dispatch`) or CLI.

## Reads

| Action | Result |
| --- | --- |
| `jobs-snapshot {id}` | `JobsSnapshot` (below). Replaces `plan-snapshot`. |
| `thread-history {id, threadId}` | Transcript of an agent. `threadId` is a Job id (its worker) or the id of a scout/reviewer. |
| `worker-contexts {id, threadIds}` | Context tokens and window per agent id. |
| `show {id, chatId?}` | Chat snapshot. `workers` is keyed by agent id. |
| `notices` feed | `result` notices for Ready Jobs carry `jobId` and `mergeable`; failed Jobs raise `error` notices (`workId` = Job id). |

`JobsSnapshot = { paused, jobs[], agents[] }`

- `jobs[]`: `id` (= worker agent id), `chat` (conversation id of the spawning chat), `title`, `request`, `acceptance[]`, `status` (`running | ready | ready-with-gaps | failed | stopped | approved`), `workerConversation`, `scopeId`, `branch`, `pr`, `candidate` (sha), `plan[]` (`{title, status: todo|doing|done, estimateMin, startedAt, doneAt}`), `ready` (`{summary, proof[], review, notFixed[{text,reason}], gaps[], at}` once reported), `reason` (stop/failure text), `createdAt`, `endedAt`, `stalls`, `stalledAt` (non-null while a stall notice stands), plus live fields:
  - `working`: the worker conversation is generating or running tools.
  - `leaf`: conversation id of the deepest working conversation (a verifier or reviewer the worker waits on); open its history for live progress.
  - `eta`: `{done, total, etaMin}` from the plan, scaled by estimate accuracy.
  - `children[]`: subagents the worker started (`id` = conversation id, `role` verifier|reviewer|scout, `title`, `working`).
  - `quota`: `{attempts, retryAt, lastError}` while waiting for provider quota; `modelMoves[]`: `{at, from, to}` fallback switches.
- `agents[]`: every spawned agent (workers, scouts, reviewers): `id`, `role`, `conversationId`, `chat`, `jobId|null`, `title`, `createdAt`, `endedAt|null`, `scopeId`, `readRef`, `working`.

## Writes

| Action | Effect |
| --- | --- |
| `thread-steer {id, threadId, requestId, text}` | Message a running agent. A finished Job runs again. |
| `thread-send {id, threadId, requestId, text}` | Queue a message after the agent's current answer. |
| `thread-stop {id, threadId}` | Stop an agent, its subagents and their background processes. Job becomes `stopped` with reason "Stopped by the owner". |
| `job-approve {id, jobId}` | Merge a Ready Job's candidate through result acceptance (same path as Telegram Approve). Returns the `AcceptanceOutcome`. A draft PR is marked ready first. When auto-merge is armed it answers `auto-merge-pending` at once; the flow finishes in an owner-scoped background task (aborted when the project closes), marks the Job approved and posts the result to the Job's chat. |
| `work-submit {id, requestId, workspaceScopeId, text, threadId}` | Spawn a worker Job from the host (`threadId` is ignored). |
| `pause` / `resume` | Pause aborts every running agent (they continue on resume). |

Removed: `plan-snapshot`, `work-archive`, `legacy-thread-history`, the `workerCap` setting (still accepted in old project files, unused) and the watchdog automation. New settings: `stallMinutes` (default 20) and `verification.rounds` (default 3).

## Stall notices

A running Job with no progress for `stallMinutes`, the same tool call five times, or a silent background process raises one notice in its chat per stall; `stalledAt` is set until progress resumes. A worker waiting on its active verifier is judged by the verifier. The detector never steers or stops.

## Telegram

One progress message per running Job (plan steps and ETA), edited in place; a Ready notice with `mergeable` offers Approve. Operation-approval notices no longer have buttons: decide them in the browser approval inbox.
