# Simulator plugin

Optional iOS simulators per project, loaded through the host plugin API (`src/plugin-types.ts`). Enable it per host home:

```json
{ "plugins": ["/abs/path/to/pi-prjcts/plugins/simulator"] }
```

in `$PI_PROJECTS_HOME/plugins.json`, then restart the host. Without it, projects keep their `simulator.json` untouched and show no simulator sections or tools.

Settings → Plugins shows two sections for the selected project. iOS simulators shows whether management is on, with a button to turn it on or off (turning it off asks first), and one row per owned clone with its state and lease holder. Simulator slimming lists the simslim categories to keep. Clones are created from a shut-down source by the Coordinator; the source is not changed. The host uses `simslim` to slim and boot the clone, and XcodeBuildMCP to capture its screen for the screenshot tools. Both commands and Xcode must be installed on the Mac; missing tools do not prevent ordinary projects from working.

The sections show no screenshot and send no taps, gestures or keyboard input. Core reads them every 3 seconds only while Settings shows them and the page is visible.

Owner enablement grants coordinators `projects_simulator_status`, `projects_simulator_action` and `projects_simulator_screenshot`. For `create`, pass the `sourceUdid` of a shut-down source listed by `projects_simulator_status`. Record the base to use in the project instructions. Coordinators can create, boot, shut down, reset or delete only their project's recorded clones. Shutdown frees simulator resources without erasing app data. Reset erases that clone's apps and data; deletion permanently removes the clone. New whole-repository worker threads created after enablement can discover the assigned device and inspect screenshots with the worker simulator tools, and must acquire its `simulator:<UDID>` lease before use. Existing threads retain their frozen tool bindings. Worker activity and held leases block destructive maintenance. Existing devices, source simulators, shared runtimes and global caches are outside this grant.

Ownership and request receipts persist in the project's `simulator.json`. Disabling management keeps the clone and its data; deleting a clone keeps enablement so the coordinator can create a replacement. Uncertain or interrupted effects block further management instead of replaying operations. The owner can press **I inspected; acknowledge** in the iOS simulators section after checking the simulator list; it asks first. Acknowledgement retains matching recorded ownership, never adopts unknown devices or retries effects, and saves the previous receipt for inspection. Agents cannot acknowledge unknown outcomes. Project archive/deletion and host shutdown do not automatically erase simulators. Default slimming disables services that some app tests require, including push and iCloud; do not treat a slim-device run as verification of those features.

The cleanup routine's plugin step erases idle owned clones, deletes the parallel-testing clones `xcodebuild` left behind from the project's simulators (`~/Library/Developer/XCTestDevices`, shut down and unused for an hour), and, hourly and in that step, removes XcodeBuildMCP test products (`~/Library/Developer/XcodeBuildMCP/workspaces/*/test-products/*.xctestproducts`, 2-4 GB per simulator test run) that finished more than two hours ago, keeping each workspace's newest finished run for a rerun without building. XcodeBuildMCP alone keeps up to 100 of them for three days.

## Plugin seams

- `coordinatorTools`: `projects_simulator_status`, `projects_simulator_action`, `projects_simulator_screenshot`, `projects_simulator_rotate` (extension `projects.coordinator-simulator`).
- `workerTools`: `projects_worker_simulator_status`, `projects_worker_simulator_screenshot`, `projects_worker_simulator_rotate`, `projects_worker_simulator_boot` (boot, shutdown, reboot; lease holders only, under their lease) for new whole-repository threads of enabled projects.
- `leaseName`: bare clone UUIDs and `simulator:<uuid>` share one lease.
- `lifecycle`: refuses project lifecycle changes during an operation, pauses management during them, aborts commands at host shutdown.
- `rpc`: `snapshot`, `configure`, `action`, `recover`.
- `sections`: two Settings → Plugins sections drawn by core (`section.ts`). iOS simulators shows management on or off, one row per owned clone with its state and lease holder, and the acknowledgement of an unknown outcome. Simulator slimming lists the simslim categories with a Keep or Slim toggle. Boot, shut down, create, reset and delete are Coordinator and worker tools; the page has no screenshot view.

Rotation: `rotate.swift` sends the device-orientation event to the clone (headless, no Simulator.app window); it is compiled with `xcrun swiftc` on first use into the ignored `.build/`.

Failure cases: `FAILURES.md`. Section design notes: `NOTES.md`.

In **Settings → Plugins → Simulator slimming**, press Keep on each simslim category the project needs. For example, `photos` keeps the photo picker working and `search` keeps Recents in Files and the document picker working. The choice applies on the next create, boot or reset, not to running clones immediately. With no categories selected the plugin uses the default full slimming. Exclusions require simslim 0.15.0 or later. `projects_simulator_status` reports the saved `keepCategories` separately from each booted clone's current slimming status.
