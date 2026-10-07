# Host observability API

Both actions use the authenticated `/api` endpoint and existing project ownership checks. Neither action grants permissions or performs work.

## `event-log`

Request: `{ "action": "event-log", "id": "<project UUID>", "offset": 0, "limit": 100 }`. Offset is 0 through 1,000,000 and limit is 1 through 100. Defaults are 0 and 100. Returns `{ events, offset, limit, total }`, newest first. Events include plan work dispatch/settlement timestamps, failed work, persisted schedule events and intents, and a bounded 500-entry in-memory buffer of host-observed pause/resume events since host start. Host-observed entries are explicitly labeled `source: "host-observed"`. This is a derived view, not a durable complete audit log. Approvals and errors unavailable from readable sources are not inferred.

## `host-health`

Request: `{ "action": "host-health", "id": "<project UUID>" }`. Returns host uptime, pid, Node version, readable host lease and project lock counts, project queued/running work, coordinator busy state, paused state, failed job count, and Mac-awake status. Mac-awake is `null` with a reason because no bounded platform probe is configured. No shell probe runs.
