# Usage buckets and schedule outcomes

## `usage-snapshot`

The existing cumulative response fields are unchanged. The coordinator and each worker row now also include `timeBuckets` with:

- `hourly`: buckets for the last 48 hours, keyed by `at` (Unix milliseconds), each with the same token and cost counters as cumulative usage.
- `daily`: buckets for the last 30 days, with the same key and counters.
- `scannedEntries` and `truncated`: the number of transcript entries scanned and whether the 10,000-entry per-conversation bound stopped the scan.

Buckets use timestamps and usage attached to assistant and tool-result model messages. Entries outside the time windows, future timestamps, messages without valid usage or timestamps, and other entry kinds are ignored. Transcript data may omit usage for older SDK entries. This is a read-only scan and is not atomic with the cumulative UsageDoc snapshot.

## `telemetry-snapshot`

`{ action: "telemetry-snapshot", id }` returns Durable's own metrics for one project since the host started: `{ since, maxSeries, droppedSeries, metrics }`. Each metric series has `name`, `kind`, `unit`, `attributes`, `count`, `sum`, `min` and `max`. The series are `pi.durable.phase.duration` (milliseconds, by task, phase and outcome; a `sleeping` outcome is a durable wait such as a retry backoff), `pi.durable.reports` (by report type) and `pi.durable.tasks.active` (by task; `sum` is the current count). It is kept in memory only, at most 256 series, and is lost on restart. Spans and error text are not recorded, so it holds no prompts, tool arguments, outputs or secrets. Nothing is exported.

## `host-health`: `durable`

`host-health` also returns `durable: { tasks, totalTasks, reports }`. `tasks` is Durable's live task graph, oldest first, at most 200 entries: `id`, `kind`, `conversationId`, `owner` (the owning task), `status` (`pending`, `running`, `waiting`, `sleeping` or `completing`), `phase`, `on` (tasks it waits on), `until` (wake time), `blocked` (`missing_task`, `task_too_old`, `migration_failed` or `restart_limit`), `background` and `abortRequested`. `reports` holds the last 20 Durable reports since the host started, as metadata only (`type`, `reason`, `extension`, `callback`, `task`, `conversationId`), without the error text. It is read-only: no retry or abort.

## `schedule-history` with `kind: "intents"`

The existing page and intent items remain unchanged. The response adds `routines`, grouped by stable routine ID. Each group has up to 20 most recent recognized schedule-intent runs with `at` (recorded time), `outcome` (`ok`, `failed`, `skipped`, or `paused`), and `durationMs` (currently `null`, because schedule intents do not persist a completion time).

`ok` means the intent is submitted and its recorded outcome is `completed`. `failed` means its status is failed. `paused` means its status is interrupted. Other states are omitted until they have an outcome that can be classified; they are not treated as skipped. `skipped` is reserved for an explicit future skip record and is not currently emitted. This history is derived from retained schedule intents, not a new host action or permission.
