# Failure modes: the bundled plugin catalog in Settings → Plugins

Written before the code. Tests: `scripts/plugin-catalog-unit.mjs` (module, temp home, no host) and `scripts/plugin-catalog-e2e.mjs` (private host, fake model, headless Chrome, desktop and mobile, a real restart). Numbers appear in check labels. Decision: `decisions/bundled-plugin-catalog.md` (only plugins shipped with pi-prjcts are offered; no external catalog, no URL or arbitrary path in this interface; manually configured external plugins stay as they are).

Metadata
1. Listing a plugin imports its code (a broken or slow plugin breaks Settings). Entries come from static metadata in `src/bundled-plugins.ts`; the plugin module is imported only by the host at its start.
2. A bundled plugin is invisible until it is loaded, so the owner cannot find it. `tasks` and `simulator` are listed as available on a host that loaded neither.

Authority
3. The activation request names a path, a URL or a name outside the catalog (`../x`, `/tmp/x`, `https://...`, `github`). Only an id of the catalog is accepted, by schema and again in the module; nothing else is written.
4. The Host agent or a worker activates a plugin. `plugin-activate` is excluded for agents (`src/host-agent-tools.ts`); `plugin-catalog` is a read.
5. The request installs or fetches code. It only appends the absolute path of the directory already shipped inside this checkout.

Configuration
6. The write loses existing entries: external plugin paths, extra keys of `plugins.json`, an array-form file. Everything already there is kept verbatim and in order.
7. A duplicate request (double click, two tabs, the same id twice in parallel, a differently written path to the same directory such as a trailing slash or `..`) adds a second entry. Activation is idempotent: the file is not rewritten when the directory is already configured.
8. An unreadable or wrongly shaped `plugins.json` is overwritten. It is refused with the reason and left byte for byte.
9. A half written file after a crash. The write is a temporary file plus rename.
10. A plugin configured only through `PI_PROJECTS_PLUGINS` is written to the file as well. It counts as configured and nothing is written.
11. A plugin of the same name is already loaded from another source (an external copy). Activation is refused with that source, so the load does not fail with a name conflict after the restart.

States
12. The state is guessed from the file only. Four states are told apart: `available` (not configured), `configured` (in the config, not part of the running host: awaiting restart), `loaded`, `failed` (with the loader's error). A running host never reports `loaded` for a plugin it did not load at its start.
13. Activation hot-loads the plugin or restarts the host. It does neither; the card says that a restart is needed and names the existing Deploy (`npm run projects -- deploy`), which is the only restart. The nightly window restarts only when new code is pending, so the card does not promise it. A button that claims to restart while Settings has none is a dead end.
14. Activation changes the owner's live host in a test. Tests use a temp `PI_PROJECTS_HOME` and never a live one.

Found in review (red before the fix)
19. The owner listed the plugin by its entry file (`plugins/tasks/index.ts`): the catalog says available and activation adds a second entry that fails with a name conflict. The entry file the loader would pick for the directory counts as the same plugin; another file name does not.
20. `plugins.json` is a symlink to the owner's own file: the write replaces the link, so later manual edits no longer reach the host. The target is written and the link stays; a dangling link is refused.

UI
15. Names, descriptions and errors are inserted as HTML. They are escaped.
16. The button stays pressable after the click, so a second click sends a second request; it is disabled while the request runs and the row shows the new state after.
17. The catalog hides or replaces the loaded plugin cards and panels. It is an extra block above them; a loaded plugin's card and panel stay as they were.
18. The catalog overflows on a phone. At 390 px wide the rows wrap and the buttons stay reachable.
