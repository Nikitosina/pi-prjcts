# notes: example plugin

Short notes per project, kept as `<project id>.json` in the plugin's state directory. It shows the same behavior offered three ways:

- RPC methods `list`, `add` and `clear` for the owner's clients and the Host agent, with `rpcPolicy` `read`, `write` and `dangerous`.
- Coordinator tools `notes_read` and `notes_add` with an editable prompt block, and the worker tool `notes_worker_read`.
- Two declarative sections that core draws as text. `notes` (place `settings`) shows the count, the latest notes and a Clear button that calls `clear`; core asks for confirmation because `clear` is dangerous. `latest` (place `chat`) shows the three latest notes and the selected chat in the chat's right panel. The plugin ships no browser code.

From the pi-prjcts checkout:

```sh
(cd docs/plugins/examples/notes && node --test)
npm run projects -- plugin check docs/plugins/examples/notes
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch --plugin docs/plugins/examples/notes
```

The test imports Pi Durable and typebox from this checkout's `node_modules`. A copy outside the checkout needs them as development dependencies at the host's versions (`package.json` of pi-prjcts); the plugin itself always uses `api.lib`.

`scripts/plugin-dev-unit.mjs` runs this test and the check, and `scripts/plugin-sections-e2e.mjs` loads the example in a browser, so it keeps matching the contract. The guide is [`docs/plugins/README.md`](../../README.md).
