# notes: example plugin

Short notes per project, kept as `<project id>.json` in the plugin's state directory. It shows the same behavior offered three ways:

- RPC methods `list`, `add` and `clear` for the owner's clients and the Host agent, with `rpcPolicy` `read`, `write` and `dangerous`.
- Coordinator tools `notes_read` and `notes_add` with an editable prompt block, and the worker tool `notes_worker_read`.
- A panel in Settings → Plugins (`ui.js`, `ui.css`) that lists the selected project's notes and adds one through `list` and `add`.
- A section in the chat's right panel (`web.sidebar`, `sidebar` in `ui.js`) with the three latest notes and the selected chat. It is the template for any plugin that wants its own UI there, for example a task list that reads its own RPC methods with `section.rpc` and the selected `section.chatId`; core has no knowledge of tasks.

From the pi-prjcts checkout:

```sh
(cd docs/plugins/examples/notes && node --test)
npm run projects -- plugin check docs/plugins/examples/notes
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch --plugin docs/plugins/examples/notes
```

The test imports Pi Durable and typebox from this checkout's `node_modules`. A copy outside the checkout needs them as development dependencies at the host's versions (`package.json` of pi-prjcts); the plugin itself always uses `api.lib`.

`scripts/plugin-dev-unit.mjs` runs this test and the check, and `scripts/plugin-panels-e2e.mjs` and `scripts/plugin-sidebar-e2e.mjs` use the panel and the section in a browser, so the example keeps matching the contract. The guide is [`docs/plugins/README.md`](../../README.md).
