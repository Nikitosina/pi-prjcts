# Simulator ownership and lifecycle failure cases

Scope before implementation: `src/simulator.ts`, `src/simulator-tools.ts`, request schemas in `src/state.ts`, dispatch and shutdown in `src/host.ts`, authenticated image route in `src/web.ts`, coordinator/worker registration in `src/durable-runtime.ts` and `src/durable-workspace-binding.ts`.

Behavior: optional owner opt-in, owned clone receipts, async lifecycle, agent-scoped status/lifecycle/screenshots, read-only browser viewer. Only project-created clones may be reset/deleted. Source simulators, shared runtimes and global caches are never mutated.

Checks that must disprove an unsafe implementation:
- Disabled project cannot create, boot, capture, reset or delete; coordinator cannot opt itself in.
- Source must exist in the default device set and be shut down; never shut down or slim the source.
- No caller can adopt a pre-existing UDID; ownership requires a successful recorded clone result and matching device identity. Identity is the real directory path, inode and birth time; the volume device number changes across reboots and remounts and is ignored.
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

## Rotation failure cases

Written before the rotation code. Rotation sends the GSEvent device-orientation message to the clone's `PurpleWorkspacePort` through a small Swift helper compiled from `rotate.swift`.

- Targeting: only a booted, owned, identity-checked clone of an enabled, settled, active project rotates; a source simulator, another project's clone or an unknown UDID is refused before the helper runs.
- Lifecycle: rotation is refused while the clone has a pending operation, while a project lifecycle change runs and after host shutdown starts.
- Leases: a worker rotates only a clone whose canonical lease it holds; the coordinator is refused while any worker holds that clone's lease. The plugin's own maintenance holds do not count as worker holds.
- Orientation: only portrait, portrait-upside-down, landscape-left and landscape-right are accepted.
- Helper build: a missing Swift toolchain or a compile error is reported as a rotation error; no partial binary is ever executed (build into a temporary name, then rename). Concurrent first calls share one build. A source change rebuilds (binary name carries the source hash).
- Helper run: a missing PurpleWorkspacePort, a send timeout or a non-booted device fails with the helper's message; the call is bounded by a timeout and aborted at host shutdown.
- Screenshots: the cached frame of the rotated clone is dropped, so the next screenshot shows the new orientation.
- Worker binding: worker threads bound before rotation existed keep exactly their bound simulator tools; only new threads get the rotate tool.
- Known limit: an iPhone home screen stays portrait; apps that support landscape rotate.
- Storage: the Settings → Storage row counts only this project's owned clones and their stray testing clones; what it calls freeable is the data of exactly the clones the cleanup step would erase now (shut down, unleased, unused past the window) plus the strays it would delete. A failing inventory makes the row unknown, never zero.

## XcodeBuildMCP test products

Written before the code. Every simulator test run through XcodeBuildMCP leaves a 2-4 GB `.xctestproducts` folder under `~/Library/Developer/XcodeBuildMCP/workspaces/<key>/test-products`, and XcodeBuildMCP itself keeps up to 100 of them for 3 days per workspace; one busy project filled 70 GB in an afternoon. The plugin prunes them hourly and in the cleanup step. Proof: `scripts/workspace-cleanup-unit.mjs` (T1-T5).
- T5 The hourly sweep or one project's cleanup step prunes a workspace the project does not own, or a project that turned the plugin off. XcodeBuildMCP keys a workspace as the checkout's name plus `sha256(realpath)`; a project owns the keys of its folder and its `git worktree list` entries, the sweep prunes only each enabled project's keys, and an unowned workspace is never touched. Proof: `workspace-cleanup-unit` T5 (two projects sharing one XcodeBuildMCP root).

- T1 A run in progress is removed: a folder younger than the window, or whose owner process is alive and has not written the completion marker, is deleted.
- T2 The newest finished run of a workspace is deleted, so a test-without-building rerun has to build again.
- T3 Something other than an XcodeBuildMCP test products folder is deleted (DerivedData, result bundles, a file or folder whose name does not match XcodeBuildMCP's pattern), or a folder is followed out through a symlink.
- T4 A removed folder leaves its completion marker behind, a missing root throws, or the summary does not say how many folders and bytes were freed.

## Parallel-testing clones

Written before the code. Owner decision (2026-11-16): `xcodebuild` parallel testing clones a project's simulator into Xcode's `testing` set (`~/Library/Developer/XCTestDevices`, named `Clone N of <clone name>`) and leaves the clones behind when a run is killed; ten of them took 92 GB. They are copies of the project's own clones, so the cleanup step deletes them; Xcode makes new ones on the next run. Global caches (DerivedData, DocumentationCache, iOS DeviceSupport, runtimes) stay untouched. Proof: `scripts/workspace-cleanup-unit.mjs` (X1-X3, X5), `scripts/simulator-worker-unit.mjs` (X4, X6, X7).

- X1 A device that is not a testing clone of this project's simulators is deleted: a `default`-set device, a clone of another project's or of a non-project simulator, or a name that only contains the project prefix.
- X2 A testing clone that is booted, or was used in the last hour (a run starting or in progress), is deleted.
- X3 A clone whose owned simulator was already deleted stays forever because only owned clones are matched.
- X4 Cleanup deletes a testing clone while simulator management is off, or reports a deletion that `simslim` did not confirm (the clone is still listed) as done.
- X5 Settings → Storage does not count the testing clones, so their 10 GB each stay invisible and unclaimed.
- X6 The step's summary does not say how many testing clones it deleted.
- X7 A project that never used simulators runs `simslim` in every cleanup, so a host without it fails the routine of every project.

## Worker boot and shutdown by the lease holder

Written before the code (retro 2026-11-09). Owner decision: the worker that holds a clone's canonical lease may boot, shut down and reboot that clone itself (`projects_worker_simulator_boot`), authorized by its lease and without a maintenance lease. Create, reset and delete stay with the Coordinator. Proof: `scripts/simulator-worker-unit.mjs` (W1-W9, fake simslim, temp home).

- W1 A worker without the clone's lease boots or shuts it down. Refused before simslim runs, naming the lease to acquire.
- W2 The holder's boot is refused because its own lease counts as "a worker leases this clone", or the host takes a maintenance lease the holder already has and fails. The holder's lease authorizes it; no other lease is taken, and the holder still holds its lease afterwards.
- W3 Shutdown by the holder leaves the clone running, or reports success before simslim confirms the shut-down state.
- W4 Reboot runs boot before shutdown, or boots after a shutdown whose outcome is unknown.
- W5 A clone leased by another worker (under any alias) is booted or shut down by a worker that does not hold it.
- W6 The worker path reaches create, reset, delete or erase.
- W7 The Coordinator's lifecycle actions start working on a clone a worker leases. They stay refused.
- W8 A worker tool bound to one conversation acts for another.
- W9 A replayed call (same tool call) runs the effect again. Request ids derive from the tool call, so a replay finds its receipt.
- An operation already running, an unknown outcome, a disabled project or a lifecycle change refuse the worker's call as they refuse the Coordinator's.
- The tool waits for the outcome and stops waiting when the call is aborted; the operation itself continues and stays recorded.
- Known limit: a holder that releases its lease while its boot runs lets another worker take the clone mid-boot; the pending operation still blocks other lifecycle calls.

## Settings section

Written before the change. The browser panel (`web/ui.js`, `mount(slot, panel)`) and the `/plugins/simulator/frame` route are removed with plugin browser code (REMOTE_SPEC.md decision 16). The plugin declares two settings sections instead (`section.ts`), drawn by core. RPC methods, request schemas, policies, ownership, tools, leases, lifecycle, cleanup and usage do not change; boot, shut down, create, reset and delete stay with the Coordinator and worker tools. The panel cases S1-S19 are retired with the panel. Proof: `scripts/simulator-section-e2e.mjs` (private HOME, fake model, a fake simslim that answers from a JSON device list; no real simulator).

- C1 The section hides management, or offers a switch that skips a confirmation when it turns management off. It shows On or Off with one button; Turn off asks inline and says the clones are kept, Cancel sends nothing, and each confirmed switch sends one `configure`.
- C2 A clone is missing, shows another project's clone, or hides who holds it. There is one row per owned clone with its name, state and lease holder, and another project shows only its own state.
- C3 An unknown outcome is hidden, its reason is drawn as markup, or acknowledging it retries the operation. The section shows the reason as text with one dangerous acknowledgement, which asks first and sends one `recover` with the project id; the switch is hidden meanwhile.
- C4 The saved simslim categories can no longer be changed by the owner, since no tool sets them. A second section, Simulator slimming, lists every category as kept or slimmed with one toggle; each press sends one `configure` with the whole new list, and the next create, boot or reset uses it.
- C5 Every read carries new request ids, so an unchanged state redraws on each poll; or an id repeats after a change, so the receipt replays a stale answer and the press does nothing. Ids stay the same while nothing changed and differ after each `configure` or `recover`, also after a host restart.
- C6 The frame route still answers, or an agent screenshot breaks with it. `/plugins/simulator/frame` answers 404; the screenshot tools keep using the plugin's capture, which this change does not touch.
- C7 At 390 px the sections overflow sideways. They fit the screen.
