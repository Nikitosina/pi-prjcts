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

## Plugin extraction failure cases

Written before the move out of core. The behavior above must survive unchanged; these cover the plugin seam.

- Not configured: the host starts; no simulator RPCs, card, coordinator or worker simulator tools, or `/plugins/simulator/*` routes; a project's `simulator.json` is never read or changed.
- Loaded: existing `simulator.json` (v1 and v2) is read in place; coordinator tool names and the extension name `projects.coordinator-simulator` stay identical, so recorded calls and recovered coordinators still resolve.
- Worker binding: a thread already bound with the worker simulator tools keeps them; a thread bound without them never gains them; only new whole-repository threads of enabled projects get them.
- Leases: a bare clone UUID and `simulator:<uuid>` in any case still name the same lease while the plugin is loaded; other resource names are unchanged.
- Maintenance leases belong to the plugin: a project stop does not release them and the worker card does not list them as worker holds.
- Lifecycle: archive, delete, pause and resume are refused while a simulator operation runs; simulator management is refused while the lifecycle changes, and resumes after it, also when the change fails.
- Host shutdown aborts outstanding simulator commands and captures through the plugin close hook.
- RPCs: management goes through `{ action: "plugin", plugin: "simulator" }` with the existing bearer authentication; host-rejected requests still reach the browser as rejected (no "response unconfirmed" retry state).
- Routes: the screenshot route needs the bearer token and a valid project id; only the plugin's declared browser files are served, never another path below the plugin directory.
- Browser: a plugin script that fails to load or throws leaves the app working; the card stays hidden; polling and captures stop on project change, another tab or a hidden page.
