# Failure modes: plugin panels in Settings → Plugins

Written before the code. E2E: `scripts/plugin-panels-e2e.mjs` (fake model, private HOME, headless Chrome on the inbox at `/`, the example plugin `docs/plugins/examples/notes` and the fixtures in `scripts/fixtures/panels/`; no live host). Module: `web/plugins.js`, used by the Plugins section of `web/settings.js`. The browser contract is `window.piProjects.register({ name, mount(slot, panel), action?(name, node, panel) })` with `panel = { projectId, signal, rpc(method, params), fetch(route, query) }`.

Placement and listing
1. A plugin's script or style is not loaded, so a declared panel never appears. Settings → Plugins must load every declared `ui.js` and `ui.css` of a loaded plugin and mount its panel in its own card.
2. A plugin can place its UI elsewhere through the API: the slot is the only element the API hands out, and the API has no dialog, toast or page helpers.
3. Plugins without browser files, and plugins that failed to load, disappear or show an empty panel: they must stay listed with name, version, state and capabilities or the error, without a panel.
4. Plugin names, versions, sources and errors are inserted as HTML (`<img onerror>` in an error runs). Everything core renders about a plugin is escaped.

Failures stay inside the plugin's card
5. A `ui.js` that throws while it loads breaks Settings or other panels. Its card must show the error (escaped) and other panels and sections keep working.
6. A `ui.js` that loads but never calls `register` leaves its card loading forever. The card must say that the script did not register.
7. A `mount` that throws or rejects breaks other panels or leaves a half-mounted panel without explanation. The card shows the error; other panels mount.
8. An `action` that throws or rejects is swallowed. The card shows the error; the panel stays mounted and usable.
9. A registration under another plugin's name, outside the script's first run, or with the retired context-panel hooks (`render`, `tick`, `projectChanged`, `hide`) is accepted. It must be refused with a reason, shown on the plugin whose script tried.
10. A broken plugin prevents core Settings use: another section must open and work while the broken cards are shown.

Lifecycle
11. Reopening Settings or the Plugins section loads the script again, so `register` runs twice or handlers stack up. Each script and style is inserted once per page; one click on a plugin button reaches the host exactly once after several reopenings.
12. Closing Settings, leaving the section or changing project leaves the old mount running. Every mount's `signal` aborts when its panel goes away.
13. A result for the previous project renders into the next project's panel. `panel.rpc` and `panel.fetch` reject with an `AbortError` once the signal aborts, even when the answer arrives later, and the core ignores that rejection.
14. A project change while Settings is open keeps showing the previous project's panel. The section remounts each panel with the new `projectId`.

Host access
15. `panel.rpc` calls another plugin's methods or another project: it always sends `plugin: <own name>` and `id: <panel's projectId>`.
16. `panel.fetch` loses the bearer token or the project: a route answers through it, and the same route without the token answers 401.

Example
17. The example plugin's panel drifts from the contract or does not save: adding a note through the panel stores it for that project only, and it is shown again after Settings is reopened.
