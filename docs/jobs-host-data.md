# Jobs: host data for the UI

Jobs replace the plan/work model. One Job is one delegated request with one worker. Independent Jobs own PR delivery, verification and review; task helpers return their work to the Coordinator. Everything below is host RPC (`dispatch`) or CLI.

## Reads

| Action | Result |
| --- | --- |
| `jobs-snapshot {id}` | `JobsSnapshot` (below). Replaces `plan-snapshot`. |
| `thread-history {id, threadId}` | Transcript of an agent. `threadId` is a Job id (its worker) or the id of a scout/reviewer. |
| `worker-contexts {id, threadIds}` | Context tokens and window per agent id. |
| `show {id, chatId?}` | Chat snapshot. `workers` is keyed by agent id. |
| `notices` feed | `result` notices for Ready Jobs carry `jobId` and `mergeable`; failed Jobs raise `error` notices (`workId` = Job id). |

`JobsSnapshot = { paused, jobs[], agents[] }`

- `jobs[]`: `id` (= worker agent id), `chat` (conversation id of the spawning chat), `title`, `request`, `acceptance[]`, `status` (`running | completed | checkpoint | ready | ready-with-gaps | failed | stopped | approved`), `workerConversation`, `scopeId`, `branch`, `pr`, `candidate` (sha), `plan[]` (`{title, status: todo|doing|done, estimateMin, startedAt, doneAt}`), `ready` (`{summary, proof[], review, notFixed[{text,reason}], gaps[], at}` once reported), `checkpoint` (`{summary, proof[], gaps[], at, auto?}`; `auto` when the worker ended without a report), `reason` (stop/failure text), `failure` (`start | run` with status failed: the worker never started, or its run failed), `reviews` (`{full, rechecks}`: reviewers started against the review budget), `createdAt`, `endedAt`, `stalls`, `stalledAt` (non-null while a stall notice stands), plus live fields:
  - `workspace`, when present: `{kind: "shared"}` or `{kind: "isolated", baseCommit: "<full commit>"}` identifies a task helper. Omission, including old records, means independent Job delivery. Helper `completed` means an ordinary answer returned, not verified or approved delivery; helper PR and Ready report remain null.
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
| `work-submit {id, requestId, workspaceScopeId, text, threadId}` | Spawn an independent worker Job in Main from the host (`threadId` is ignored). It does not select task helper workspaces. |
| `pause` / `resume` | Pause aborts every running agent (they continue on resume). |

Removed: `plan-snapshot`, `work-archive`, `legacy-thread-history`, the `workerCap` setting (still accepted in old project files, unused) and the watchdog automation. New settings: `stallMinutes` (default 20) and `verification.rounds` (default 3).

## Coordinator task helpers

The chat's `agents` tool selects task helpers with explicit `workspace`. Shared helpers borrow that chat's persistent workspace; isolated helpers allocate from the supplied full commit. Paths and owner identities are host-resolved. Shared handoff lasts until actual agent settlement, not merely the start of a closing answer. A follow-up reruns the same worker in its frozen binding.

Helpers finish by returning their answer. They do not need a Ready report or worker PR, never offer Approve, and cannot be passed to result acceptance. The Coordinator receives a concise worker handback and owns inspection, branch integration and combined verification. `agents report {id, ref}` retrieves the exact full report named by a notification; omitting `ref` reads current facts and the latest answer. Full reports are immutable `projects.agent-report` entries in the worker conversation, outside model context. They remain readable in worker history and through `transcript-text` after later sends overwrite the current Job report. Transcripts and artifacts remain available through the existing reads.

Independent workers may call `job checkpoint` to end an unfinished stage with a summary, proof references and remaining gaps. A checkpoint is not a Ready report, cannot be approved and stays out of stall detection until new instructions resume the same worker. The workspace is retained for continuation. It does not add a host-owned decision or retry loop.

The main chat displays owner and Coordinator messages only. Worker details contain the internal reports and approval controls for Ready Jobs. Report time and cost describe cumulative Job totals, not the most recent checkpoint.

## Stall notices

A running Job with no progress for `stallMinutes` or the same tool call five times raises one notice to its Coordinator per stall; `stalledAt` is set until progress resumes, not merely until another message is sent. Background-process silence does not wake the Coordinator while its agent is making progress. A worker waiting on its active verifier is judged by the verifier. On recovery or settlement, still-queued obsolete stall inputs are withdrawn; already placed inputs and actual results remain intact. The detector never steers or stops.

## Telegram

One progress message per running Job (plan steps and ETA), edited in place; a Ready notice with `mergeable` offers Approve.
