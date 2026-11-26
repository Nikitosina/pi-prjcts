# Plugins

A plugin author starts a private host with a plugin under development and checks what the host loaded: Settings → Plugins lists each plugin with its name, version, state and capabilities, or its source and error when it failed, with each plugin's settings sections. The right context panel shows chat sections of plugins that declare them, under Workers and Pull requests.

## Sub-features

- `load`: `launch --plugin <dir>` (repeatable) loads the plugin through `PI_PROJECTS_PLUGINS` on the private host; the scratch home has no `plugins.json`.
- `list`: Settings → Plugins (`#settings .plugin-row`, one `.plugin-row` per plugin with `data-plugin` and `data-state`) shows name, version, `loaded` or `failed`, and capabilities or the error.
- `status`: the `plugins` RPC (read-only, allowlisted) is the second view of the same statuses, with `sections` listing every declared section.
- `settings sections`: Settings → Plugins (`#settings .plugin-card`, `.plugin-section[data-plugin][data-section][data-state=loading|ready|failed]`, `.plugin-error`, `.plugin-slot`) draws each section with `place: "settings"` from its `read`.
- `chat sections`: `#plugin-sections > .plugin-section[data-plugin][data-section][data-state]` in the right context panel, read once per project or chat selection and on `refreshMs`.

Rows are `.section-row` with `.section-label`, `.section-text`, `.section-status[data-tone]`, `.section-detail`, `.section-links a` and `button[data-kind]`; an inline confirmation is `.section-confirm` with `[data-cancel]` and `[data-confirm]`. `.section-empty` and `.section-foot` hold the view's `empty` and `footer`.

## How to get to it (user POV)

- Open the inbox, then Settings → Plugins. It lists the plugins the host loaded at its start, the same in every project.
- Settings (⌘,), then Plugins (X). Each card has the plugin's status and its settings sections for the selected project.

## Driving it with browser CDP

Preconditions: `launch --plugin <dir>` succeeded, doctor `ok: true`. A scaffold from `npm run projects -- plugin new <dir>` is enough.

- `load` + `list` + `status`, scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> plugins`. It reads the `plugins` RPC into `host-plugins.json`, opens the inbox on Main, waits for the Plugins rows, screenshots `01-plugins`, writes `plugins-dom.json`, and asserts that every launched plugin's row shows its name, version, state and error (if any). The Plugins section clips an error over 300 characters with `…`, so the drive accepts the full error or a clipped start of it. To cover a long error, add `--plugin scripts/fixtures/long-error.mjs` to the launch. A drive without `--plugin` fails with that reason. The drive then screenshots `02-settings-plugins`, writes `sections-dom.json`, and fails when a settings section of a launched plugin is not `ready`.
- Section contract (escaping, links, buttons and confirmations, refused views, polling, project and chat switches, a remote host through a local relay): scripted in `scripts/plugin-sections-e2e.mjs` with the probe in `scripts/fixtures/sections/`, not in the skill. Chat sections of your own plugin and a manual check on the private host are unscripted.

## Gotchas

- The list is what the host loaded at its start. Edit the plugin and launch again (or restart the host) to see a change; nothing reloads live.
- No plugin code runs in the page: `window.piProjects` is gone, and `/plugins/<name>/...` answers 404.
- The built-in `github` plugin (source `built-in`, `prs` and `coordinatorTools`) loads on every host and is listed first, also without `--plugin`; the drive checks only the launched plugins.
