# Plugins

A plugin author starts a private host with a plugin under development and checks what the host loaded: the Plugins section of the context panel lists each plugin with its name, version, state and capabilities, or its source and error when it failed. Settings → Plugins shows the same rows with each plugin's panel.

## Sub-features

- `load`: `launch --plugin <dir>` (repeatable) loads the plugin through `PI_PROJECTS_PLUGINS` on the private host; the scratch home has no `plugins.json`.
- `list`: the Plugins section (`#plugin-cards`, one `.plugin-row` per plugin with `data-plugin` and `data-state`) shows name, version, `loaded` or `failed`, and capabilities or the error.
- `status`: the `plugins` RPC (read-only, allowlisted) is the second view of the same statuses.
- `panel`: Settings → Plugins (`#settings .plugin-card`, `.plugin-panel[data-plugin][data-state=loading|ready|failed]`, `.plugin-error`, `.plugin-slot`) mounts the panel a plugin's `web.script` registers.

## How to get to it (user POV)

- Open the inbox and select any chat; the Plugins section is at the bottom of the right context panel, under Pull requests. It lists the plugins the host loaded at its start, the same in every project.
- Settings (⌘,), then Plugins (L). Each card has the plugin's status and, when it has a browser script, its panel for the selected project.

## Driving it with browser CDP

Preconditions: `launch --plugin <dir>` succeeded, doctor `ok: true`. A scaffold from `npm run projects -- plugin new <dir>` is enough.

- `load` + `list` + `status`, scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> plugins`. It reads the `plugins` RPC into `host-plugins.json`, opens the inbox on Main, waits for the Plugins rows, screenshots `01-plugins`, writes `plugins-dom.json`, and asserts that every launched plugin's row shows its name, version, state and error (if any). The Plugins section clips an error over 300 characters with `…`, so the drive accepts the full error or a clipped start of it. To cover a long error, add `--plugin scripts/fixtures/long-error.mjs` to the launch. A drive without `--plugin` fails with that reason. The drive then opens Settings → Plugins, screenshots `02-settings-plugins`, writes `panels-dom.json`, and fails when a launched plugin's panel is not `ready`.
- `panel` interaction, project switches, reopening and broken panels: scripted in `scripts/plugin-panels-e2e.mjs` (two projects, the example `notes` and the fixtures in `scripts/fixtures/panels/`), not in the skill. A manual check of your own panel on the private host is unscripted.

## Gotchas

- The list is what the host loaded at its start. Edit the plugin and launch again (or restart the host) to see a change; nothing reloads live.
- A page loads each plugin script once. After a host restart, reload the page too.
- The built-in GitHub provider is part of core and is not listed.
