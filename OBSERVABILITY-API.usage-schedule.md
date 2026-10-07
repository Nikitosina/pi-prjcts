# Usage buckets and schedule outcomes

## `usage-snapshot`

The existing cumulative response fields are unchanged. The coordinator and each worker row now also include `timeBuckets` with:

- `hourly`: buckets for the last 48 hours, keyed by `at` (Unix milliseconds), each with the same token and cost counters as cumulative usage.
- `daily`: buckets for the last 30 days, with the same key and counters.
- `scannedEntries` and `truncated`: the number of transcript entries scanned and whether the 10,000-entry per-conversation bound stopped the scan.

Buckets use timestamps and usage attached to assistant and tool-result model messages. Entries outside the time windows, future timestamps, messages without valid usage or timestamps, and other entry kinds are ignored. Transcript data may omit usage for older SDK entries. This is a read-only scan and is not atomic with the cumulative UsageDoc snapshot.

## `schedule-history` with `kind: "intents"`

The existing page and intent items remain unchanged. The response adds `routines`, grouped by stable routine ID. Each group has up to 20 most recent recognized schedule-intent runs with `at` (recorded time), `outcome` (`ok`, `failed`, `skipped`, or `paused`), and `durationMs` (currently `null`, because schedule intents do not persist a completion time).

`ok` means the intent is submitted and its recorded outcome is `completed`. `failed` means its status is failed. `paused` means its status is interrupted. Other states are omitted until they have an outcome that can be classified; they are not treated as skipped. `skipped` is reserved for an explicit future skip record and is not currently emitted. This history is derived from retained schedule intents, not a new host action or permission.
