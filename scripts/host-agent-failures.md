# Host agent and owner approvals: failure modes

Recorded before the code. `host-agent-e2e` covers the ones marked (e2e); the rest are kept by design and noted where.

## Runtime

- A second process opens `<home>/host-agent/durable.sqlite` while the host holds it. The owner lock refuses it, as for projects.
- No usable model: send fails with a clear error naming Settings, instead of a run that never answers.
- Settings with a model missing from the live catalog are refused before saving; the old settings stay (e2e: refused ref).
- A stale `revision` on `host-agent-settings` changes nothing (e2e).
- An owner message while the agent works is lost or starts a second run. It must steer the running turn.
- Retried `host-agent-send` with the same `requestId` answers twice. Durable request ids keep it once.
- Restart loses the transcript or the pending inputs (e2e: history survives a restart).
- Stop leaves the conversation busy (e2e: busy clears after stop).
- Reset deletes history instead of starting a new context (e2e: earlier messages still page after reset).
- History renders owner messages as unclassified or as "internal" (e2e: owner origin on the owner's text, internal on approval outcomes).

## Tools

- A `Request` action is added and silently becomes callable, or silently stays unreachable. Every action needs a policy entry: allowed, dangerous or excluded with a reason. TypeScript enforces the map and the script checks it against the live union (e2e).
- The agent decides its own approvals. `approval-decide` is excluded (e2e).
- The agent drives itself through `host-agent-send`/`-stop`/`-reset`, recursing into its own conversation. These are excluded.
- Secrets reach the transcript: `web` returns the bearer token URL, `telegram-token` sets the bot token. Excluded.
- An invalid `host_call` input runs anyway, or opens a project runtime before validation. Input is parsed against `Request` first; an excluded or unknown action is refused before dispatch (e2e: unknown action refused).
- A huge result floods the context. Results are fitted to a bound.
- `ui_set` before the `ui-set` action exists throws. It answers "not available".

## Approvals

- A dangerous action runs without approval (e2e: archive is pending and the project is still active).
- A replayed tool call creates a second approval. The approval key is the tool task id, so the same call returns the same approval.
- Approve runs twice: double click, Telegram plus web, or a retry after a lost response (e2e: a second decide is refused and the project was archived once).
- A crash between "approved" and the result reruns the action blindly on restart. The approval is marked failed with an unknown outcome and never rerun.
- The stored request differs from what runs. The exact validated request is stored and executed; the owner sees it before deciding.
- Deny still runs the action (e2e: delete denied, project still listed).
- Pending approvals vanish on restart (e2e).
- The requester never learns the outcome. Approve and deny post one follow-up to the Host agent, or to the Coordinator chat that asked, with a stable request id so a restart does not post twice (e2e for both requesters).
- A Coordinator gates a non-dangerous action, or its tool runs the action itself. Only dangerous actions can be requested; the tool only creates the approval (e2e).
- A Coordinator approval names a chat that no longer exists. The outcome goes to Main.
- Notification failure (Telegram down) fails the approval. Telegram is best effort.

## Streams

- `/live?project=host` or `/changes?project=host` is rejected as an invalid project id, or opens a project named "host" (e2e: both stream).
- `ui_focus` is published but the browser has no stream carrying it (e2e: a `host-agent` topic frame with `focus`).
