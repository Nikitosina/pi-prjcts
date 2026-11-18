# Failure modes: plugin sections in the chat's right panel

Written before the code. E2E: `scripts/plugin-sidebar-e2e.mjs` (fake model, private HOME, headless Chrome on the inbox at `/`, desktop and mobile viewports; the example plugin `docs/plugins/examples/notes` and the fixtures in `scripts/fixtures/sidebar/`; no live host). Module: `web/plugins.js` (shared with Settings panels) and `web/sidebar.js`. The browser contract is `window.piProjects.register({ name, sidebar: { mount(slot, section), action?(name, node, section) } })` with `section = { projectId, chatId, signal, rpc(method, params), fetch(route, query) }`; the plugin opts in with `web.sidebar: { title }`.

Placement and opt-in
1. A plugin without `web.sidebar` (a settings-only panel, a plugin without browser files, a failed plugin) gets a section or an informational row in the right panel. Only plugins that opt in get a section, and with none the container stays empty and hidden.
2. Two opted-in plugins do not both get a section, or the second replaces the first. Each mounts in its own section under Workers and Pull requests, in plugin load order.
3. A plugin that opts in with `sidebar` only (no `mount`) is refused by `register`, or leaves an empty "loading" panel in Settings → Plugins. Its Settings card shows no panel. A plugin that keeps only `mount` behaves exactly as before.
4. Workers and Pull requests change or disappear when plugin sections exist, or the mobile sheet cannot reach the sections.

Lifecycle and stale content
5. Selecting another chat keeps the previous chat's section. On a host with per-project disable, a disabled plugin still mounts, and disabling one in the selected project leaves its section and timers alive; it is removed and the changed enabled set aborts the old mounts, without affecting other projects. Re-enabling mounts it again. Each selection of a project or chat aborts the old `signal`, discards the old slot and mounts a fresh section with the new `chatId`.
6. A delayed answer for the previous chat (rpc or fetch) renders into the new chat's section. After the abort, `rpc` and `fetch` send nothing and reject with `AbortError`, also a call already sent, and core ignores that rejection. A read that rejects after the switch also rejects as `AbortError`, not with its own late error.
7. A normal refresh (a `sync`, a `jobs` or `chat` topic change, a reload of the PR list) remounts the sections, so mounts stack or flicker. An older status answer must not win over a newer one for the same chat, and a stream reconnect must re-read enablement. Sections mount once per selection, also when the same chat is re-selected while its first view is still loading, and when a plugin status refresh leaves the enabled set unchanged.
8. `section.rpc` or `section.fetch` reaches another plugin or project: they always send the own plugin and the section's project, and `fetch` adds `chat=<chatId>`.
9. A late write after the section went away is sent. A call after the abort is never sent.

Failures stay inside the section
10. A `mount` that throws or rejects, a `ui.js` that fails to load or never registers `sidebar`, or an `action` that throws shows an error in that section only. Other sections, Workers, PRs and the chat keep working.
11. Clicks inside a section reach core handlers (`data-cmd`, `data-profile`) or run another plugin's action; only `data-action` values prefixed with the plugin's name run its `action`.
12. Plugin text (title, error) is inserted as HTML. Core escapes it.

Settings and sidebar together
13. A plugin with both a Settings panel and a sidebar section loads its script twice, or an uncaught error shows only in one of them. One script load per page; an error shows in every mounted place of the plugin.
