# Failure modes: declarative plugin sections

Written before the code. Owner decision (A), 2026-11-26: a plugin declares `sections` with a title, a place (`settings` or `chat`), an optional `refreshMs` and a `read(context)` function that returns a `SectionView` (rows with text, label, status, detail lines, links and buttons). Buttons call the plugin's own `rpc` methods that have an `rpcPolicy` entry. `web.script`, `web.style`, `web.sidebar`, `web.routes` and `window.piProjects.register` are removed (REMOTE_SPEC.md, decisions 15 and 16).

Modules: `src/plugin-types.ts`, `src/plugins.ts` (declaration and view checks), the `plugin-section` action in `src/host-server.ts`, `web/sections.js` (renderer), `web/plugins.js` (Settings → Plugins cards), `web/sidebar.js` (right panel). E2E: `scripts/plugin-sections-e2e.mjs` (two private hosts, a local relay, fake model, headless Chrome, the fixture `scripts/fixtures/sections/`, the tasks plugin and the network-gate fixture). The converted plugins keep their own cases: `plugins/tasks/FAILURES.md` 17 to 21 (`scripts/tasks-plugin-e2e.mjs`) and `plugins/simulator/FAILURES.md` "Settings section" (`scripts/simulator-section-e2e.mjs`). Numbers appear in check labels.

Browser code is gone
1. A plugin that still declares `web` (script, style, sidebar or routes) gets its files or routes served, or fails to load completely. Its other capabilities still load and `web` is dropped with one log line. `/plugins/<name>/ui.js`, `ui.css` and every former route answer 404. The page never requests anything under `/plugins/` and `window.piProjects` is undefined.
2. The page loads a script or style that is not one of core `web/` files. Every `<script>` and stylesheet of the page comes from the page's own origin, and the CSP keeps `script-src 'self'`.

Declarations
3. A malformed declaration loads silently or breaks other plugins. The plugin fails to load with an error that names the field, and other plugins load. Covers: a bad id, an empty title or one longer than 60 characters, an unknown place, `refreshMs` below 2000 or not an integer, `read` that is not a function, more than 4 sections.
4. The `plugins` action lists sections of a plugin that failed, or of one that is off for the project. Settings sections show in their plugin's card and chat sections under Workers and Pull requests, in load order. Only plugins that are on for the project are listed, and turning one off removes its sections at once.

Views
5. Plugin text is inserted as HTML. The title, row text, label, status, detail lines, link labels, button labels, confirmation text, empty text, footer and error messages all render as text, and an `<img onerror>` in any of them never runs.
6. A link that is not http or https (`javascript:`, `data:`, relative) becomes an `href`. The host refuses the view, and the browser checks the protocol again before it sets an `href`. Links open in a new tab with `noopener noreferrer`.
7. An oversized or malformed view renders partly, or the section hangs in loading. The host refuses it with an error that names the field, and the section shows that error while other sections keep working. Covers: more than 50 rows, text over its limit, an unknown tone, params that are not JSON or over 2 KB.
8. A button for a method missing from `rpc`, or one without an `rpcPolicy` entry, is shown. The host refuses the view.
9. Fields outside the schema (`html`, `script`, `onclick`) reach the browser. The host answers only the schema's fields.
10. A `read` that throws leaves the section blank or loading forever. The section shows the error, and a later successful read replaces it. A failed refresh keeps the last rows and says it could not refresh.

Buttons
11. A `read` or `write` button sends nothing, sends twice, or reaches another plugin or project. One click sends exactly one `plugin` call with the section's plugin, the section's project and the button's params. The buttons are disabled while it runs, and the section is read again after it. After a call that may have landed, the drawn buttons carry stale params (a full list computed before the call), so they stay disabled until the fresh view is drawn.
12. A `dangerous` button runs without confirmation. This holds for a static policy and for a function policy that answers `dangerous` for these params. The row shows an inline confirmation with the plugin's text, Cancel sends nothing, and Confirm sends once. The host refuses a view with a dangerous button that has no `confirm` text.
13. A failed call disappears, or a call whose answer was lost is retried. An answered refusal shows its error in the section. A lost answer, or one that arrives but cannot be read, says the result is unknown and asks to check after reconnecting, and the write is never sent again.
14. A periodic refresh while a confirmation is open closes it or swaps its button. The confirmation stays until it is confirmed or cancelled, and the newer view is drawn after that.

Lifecycle
15. A project or chat change keeps showing the previous selection's rows, or a late answer for it draws into the new one. Each selection reads with its own context, and an answer for an older selection is discarded.
16. Polling stacks up across reopenings, or keeps running after Settings closes, the section goes away or the plugin is turned off. Only one read runs at a time, reads come at `refreshMs`, none while the page is hidden, and none after the section is gone.
17. A section read reaches a plugin that is off for the project, or a chat section is read without a project and chat. The host refuses both. Settings sections get no `chatId`; chat sections get the selected chat.

Remote host (through its tunnel)
18. A remote host's sections are not shown, are read from the local host, or load a script or style from the remote or the relay. With the remote host selected, Settings → Plugins and the chat's right panel show its Tasks and network-gate sections with its own data, read through the tunnel. No request goes to `/plugins/` and no script comes from anywhere but local `web/`. Markup in the remote plugin's text shows literally.
19. A button of a remote section calls the local host. The call goes through the tunnel and reaches only the remote host.
20. An inbox of the old API version talks to a host with the new `plugins` shape. The API version is raised to 2, so a mismatched host shows "needs update" before any section is read.

Converted plugins
21. The network-gate section loses information that the panel showed. It shows the phase, the VPN state, failed samples, repair attempts out of 3, the last repair, paused projects and the error, and refreshes every 3 seconds.
