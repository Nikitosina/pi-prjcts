# Simulator ownership and lifecycle failure cases

Scope before implementation: `src/simulator.ts`, `src/simulator-tools.ts`, request schemas in `src/state.ts`, dispatch and shutdown in `src/host.ts`, authenticated image route in `src/web.ts`, coordinator/worker registration in `src/durable-runtime.ts` and `src/durable-workspace-binding.ts`.

Behavior: optional owner opt-in, owned clone receipts, async lifecycle, agent-scoped status/lifecycle/screenshots, read-only browser viewer. Only project-created clones may be reset/deleted. Source simulators, shared runtimes and global caches are never mutated.

Checks that must disprove an unsafe implementation:
- Disabled/default project cannot create, boot, capture, reset or delete; coordinator cannot opt itself in or choose a new source.
- Source must exist in the default device set and be shut down; never shut down or slim the source.
- No caller can adopt a pre-existing UDID; ownership requires a successful recorded clone result and matching device identity.
- A repeated request ID must not create another clone or replay another destructive operation. Same ID with different intent must fail.
- Clone command timeout, invalid result, crash between intent and receipt, and interrupted reset/delete remain uncertain. Never auto-adopt by name or automatically retry effects.
- Missing, renamed, replaced, wrong-set or wrong-project owned device must refuse effects and capture.
- Per-project serialization and a canonical simulator lease prevent worker/maintenance races; reset, shutdown and delete fail while a worker is using it. Running-worker guard covers lost in-memory leases after restart.
- Owner disable cannot race active effects or silently delete data. Delete retains owner opt-in and clears only the owned device after verified absence.
- A successful reset erases only the owned clone and re-applies simslim before reporting ready.
- Missing tools and non-Mac environments do not stop the ordinary app host.
- Screenshots require existing bearer authentication, project ownership, enabled feature and a booted device. No token in URLs; no cross-project frame cache; in-flight requests coalesce; temp capture file is removed.
- Agent tools reject worker callers for destructive lifecycle, do not accept arbitrary project/UDID, and return actual image content for screenshot inspection.
- Host stop aborts outstanding simulator commands and retains uncertainty without automatic cleanup or prolonged shutdown.

Proof stays in disposable local artifacts. Never restart the production host or mutate its project state to verify this feature.
