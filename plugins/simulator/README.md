# Simulator plugin

Optional iOS simulators per project, loaded through the host plugin API (`src/plugin-types.ts`). Enable it per host home:

```json
{ "plugins": ["/abs/path/to/pi-prjcts/plugins/simulator"] }
```

in `$PI_PROJECTS_HOME/plugins.json`, then restart the host. Without it, projects keep their `simulator.json` untouched and show no simulator card or tools.

The coordinator screen has an optional Simulator card above Workers. Choose a shut-down iOS simulator as a clone source, enable management, then create the project's simulator. The source is not changed. The host uses `simslim` to slim and boot the clone, and XcodeBuildMCP to capture its screen. Both commands and Xcode must be installed on the Mac; missing tools do not prevent ordinary projects from working.

The card shows polled screenshots, not video, and can expand the image. It never sends taps, gestures or keyboard input. Screenshot fetching pauses when the page is hidden or another project/tab is selected. Screenshots use the existing browser authentication.

Owner enablement grants coordinators `projects_simulator_status`, `projects_simulator_action` and `projects_simulator_screenshot`. Coordinators can create, boot, shut down, reset or delete only their project's recorded clones. Shutdown frees simulator resources without erasing app data. Reset erases that clone's apps and data; deletion permanently removes the clone. New whole-repository worker threads created after enablement can discover the assigned device and inspect screenshots with the worker simulator tools, and must acquire its `simulator:<UDID>` lease before use. Existing threads retain their frozen tool bindings. Worker activity and held leases block destructive maintenance. Existing devices, source simulators, shared runtimes and global caches are outside this grant.

Ownership and request receipts persist in the project's `simulator.json`. Disabling management keeps the clone and its data; deleting a clone keeps enablement so the coordinator can create a replacement. Uncertain or interrupted effects block further management instead of replaying operations. The owner can use **Inspect / acknowledge** after checking the simulator list. Acknowledgement retains matching recorded ownership, never adopts unknown devices or retries effects, and saves the previous receipt for inspection. Agents cannot acknowledge unknown outcomes. Project archive/deletion and host shutdown do not automatically erase simulators. Default slimming disables services that some app tests require, including push and iCloud; do not treat a slim-device run as verification of those features.

## Plugin seams

- `coordinatorTools`: `projects_simulator_status`, `projects_simulator_action`, `projects_simulator_screenshot` (extension `projects.coordinator-simulator`).
- `workerTools`: `projects_worker_simulator_status`, `projects_worker_simulator_screenshot` for new whole-repository threads of enabled projects.
- `leaseName`: bare clone UUIDs and `simulator:<uuid>` share one lease.
- `lifecycle`: refuses project lifecycle changes during an operation, pauses management during them, aborts commands at host shutdown.
- `rpc`: `snapshot`, `configure`, `action`, `recover`.
- `web`: the card (`web/ui.js`, `web/ui.css`) and the authenticated screenshot route `/plugins/simulator/frame`.

Failure cases: `FAILURES.md`. Card design notes: `NOTES.md`.
