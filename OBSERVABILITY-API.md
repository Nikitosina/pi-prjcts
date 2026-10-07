# Observability API

All requests below use the existing authenticated host `/api` endpoint. Each request is validated by the host's closed request schema. Responses are scoped to the supplied project ID and current Durable owner. Unknown projects, non-Durable projects where Durable is required, lifecycle transitions, and malformed or out-of-range paging parameters return the existing `{ ok: false, error }` response. No action here grants permissions or performs work.

## `plan-snapshot`

Request: `{ "action": "plan-snapshot", "id": "<project UUID>" }`.

Returns `{ paused, pausing, workerCap, work }`. Each work entry retains its existing `id`, `threadId`, `role`, `text`, `dependsOn`, `status`, `blocker`, and `attempt` fields, and now includes `startedAt` and `endedAt`, each a Unix timestamp in milliseconds or `null`. Existing persisted work without the new optional stored timestamps remains readable. Start time is set when dispatch begins; end time is set when a running attempt settles. For older entries, timestamps fall back to the corresponding attempt timestamps when available.

## `usage-snapshot`

Request: `{ "action": "usage-snapshot", "id": "<project UUID>", "offset?": 0, "limit?": 100 }`. Offset is 0 through 1,000,000. Limit is 1 through 100.

The existing response keeps its coordinator, worker-page totals, cumulative usage counters, worker counts, page fields, observation timestamp, and accounting note. Each registered Durable worker row now also has `role` and `title`, joined by `threadId` from the current plan work. Both fields are `null` when that thread has no current work item. Legacy-only worker rows also return `null` for both fields. These counters remain cumulative; time buckets are not yet exposed.

## `owner-setup-snapshot`

Request: `{ "action": "owner-setup-snapshot", "id": "<project UUID>" }`.

The existing response includes `profiles` with configured command-profile state and `grants` with skill-grant status. Each grant lists its ID, revision, enabled state, scope IDs, and granted catalog IDs/names. `configuredCatalog.available` remains `false` when the standalone host cannot read a trusted already-loaded configured Pi skill snapshot.

## Not yet available

The following items are not part of the API yet: tool-call transcript fields, event-log paging, host-health snapshot, per-routine outcome grouping, time-bucketed usage, and per-thread Changes/Evidence. Do not infer these from unrelated fields. In particular, existing evidence records do not carry a Durable thread identity, and the current workspace authorization does not establish a safe complete diff for arbitrary per-thread edits. A design that provides that view must use the existing scope/workspace boundaries and link evidence at capture time; this implementation does not redesign workspace isolation or infer thread ownership.
