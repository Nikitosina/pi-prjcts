# Development and activation

## Testing

Test a plugin without a host. Call `register` with a stand-in `api`, collect what it passed to `provide`, and call that:

- RPC methods: `await provided.rpc.add({ projectId, params: { text: "x" } })`.
- Tools: build them with `provided.coordinatorTools.create({ projectId, root: () => undefined, isCoordinator: (id) => id === 1 })` or `provided.workerTools.create({ projectId, threadId, conversationId })`, then call `tool.execute(args, { conversationId })`. Calling `execute` directly skips the harness's argument validation, so test bad arguments through your own checks.
- Policy: assert the `rpcPolicy` value, so a later change to a method's classification shows up in review.

Give the stand-in only the `api` fields the plugin uses. When the plugin needs `api.lib`, the test can import the libraries at the host's pinned versions (see [`api.lib`](reference.md#apilib)). Use a temporary `stateDir`. The [example test](examples/notes/index.test.mjs) does all of this; this repository runs it in `scripts/plugin-dev-unit.mjs`.

Then run `npm run projects -- plugin check <dir>`. It is the only check that uses the host's real loader and validation.

## Private verification

A private host is the closest thing to a real one that is safe to break:

```sh
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch --plugin <dir> [--plugin <other-dir>] [--evidence <dir>]
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> plugins
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs cleanup --run <scratch>
```

- `launch` starts a host with a scratch home, a fake model provider and the plugins through `PI_PROJECTS_PLUGINS`. The scratch home has no `plugins.json`. Several `--plugin` flags load several plugins, which shows conflicts between them.
- `drive ... plugins` opens the inbox in headless Chrome, screenshots the Plugins section and saves the host's `plugins` status next to it. It fails when a launched plugin's row does not show its name, version, state and error. It then opens Settings → Plugins and fails when a launched plugin's panel does not mount.
- Open Settings → Plugins (⌘, then X) on the private host to use your panel yourself. A panel error shows in red in the plugin's card; the browser console has the stack.
- `rpc --run <scratch> plugins` prints the same status. The skill's `rpc` command only allows read-only core actions, so call your own methods over the socket as shown in [Getting started](getting-started.md#4-try-it-on-a-private-host).
- Coordinator tools: `profile-tools` over the same socket, with `{"action":"profile-tools","projectId":"<id>","profile":"coordinator"}`, lists them in the `plugin` group. `prompt-render` with the same fields shows a `prompt` block's text.
- The fake model does not call your tools. Prove tool behavior in tests; on the private host, prove that the tools are offered.

The full verification procedure, including proof for a change to core, is the [`verify-pi-prjcts` skill](../../.agents/skills/verify-pi-prjcts/SKILL.md) and its [plugins recipe](../../.agents/skills/verify-pi-prjcts/features/plugins.md).

## Inspecting a host

Every host shows what it loaded at its start, in five places:

- the Plugins section of the context panel: name, version, state and capabilities, or the source and error of a failure;
- Settings → Plugins: the same rows, each with the plugin's panel or the panel's error;
- the `plugins` RPC: `{ plugins: PluginStatus[], labels, web }`;
- `/health`;
- the host log: `plugin-loaded` and `plugin-failed` lines.

```ts
type PluginStatus = {
  source: string;               // the path as configured
  name: string | null;          // null when the module could not be read
  version: string | null;
  state: "loaded" | "failed";
  error?: string;
  provides: string[];           // capability keys
  loadedAtMs: number;
};
```

## Activation

Activation makes a plugin version run on a host. It is always explicit.

1. Check the version: `plugin check` and, for anything beyond a small RPC, a private host.
2. Add the directory to that host's `$PI_PROJECTS_HOME/plugins.json`:

   ```json
   { "plugins": ["/abs/path/to/my-plugin"] }
   ```

   Relative paths resolve against the host home, and `~/` against your home directory. `PI_PROJECTS_PLUGINS=/path/a:/path/b` adds more for one run (tests, one-off hosts); a path cannot contain `:`.
3. Restart that host. The plugin loads at the next start, and the Plugins section shows the version that loaded.

A running host keeps the plugins it loaded at its start: editing a plugin's source, its browser files or `plugins.json` changes nothing until the restart. On the owner's host, editing `plugins.json` changes the owner's configuration and needs the owner's go-ahead; the restart is the normal Deploy (`npm run projects -- deploy`), not a manual restart.

To deactivate, remove the entry and restart. The plugin's files in `api.stateDir` and in project directories stay on disk.

## Troubleshooting

| status `error` | cause |
| --- | --- |
| `no such file or directory: ...` | the configured path does not exist |
| `directory has no index.ts, index.mjs, index.js or package.json main: ...` | the directory has no entry module |
| `the module must export a name matching ...` | missing or invalid `name` |
| `the module's version must be a string of 1 to 40 characters without spaces` | invalid `version` |
| `import timed out after ... ms`, `register timed out after ... ms` | slow top-level code or `register`; move slow work out of `register` |
| `capability "<key>" was provided twice` | two `provide` calls with the same key |
| `<capability>.<method> must be a function` | a provider is missing a required method |
| `rpc.<method> must be a function with a kebab-case name` | an RPC method name with capitals or underscores |
| `rpcPolicy.<method> must name an rpc method and be ...` | a policy for a method that does not exist, or an unknown kind |
| `a plugin named "<name>" is already loaded`, `... is already provided by another plugin` | two plugins with one name, or one provider id or checkout kind |
| `plugins.json is unreadable: ...` | the file is not `{ "plugins": ["/path", ...] }` |

Panel errors show in the plugin's card in Settings → Plugins:

| panel error | cause |
| --- | --- |
| `ui.js did not register a panel ...` | the script never called `window.piProjects.register` while it first ran |
| `ui.js registered as "<other>"; ...` | `name` is not the plugin's own name |
| `ui.js uses the retired context-panel hooks ...` | a card written for the classic inbox; port it to `mount(slot, panel)` |
| `piProjects.register must be called while its ui.js runs` | `register` was called later, for example after an `await` |
| `ui.js could not be loaded from ...` | the host could not read the file at its start (it answers 404) |
| `ui.css could not be loaded from ...` | the same for the stylesheet; the panel still mounts |
| any other message | what your script, `mount` or `action` threw |

## Compatibility

- There is no published type package. The types are `src/plugin-types.ts` at the host's commit. A TypeScript plugin inside this repository can `import type { HostPluginApi } from "../../src/plugin-types.ts"`, as `plugins/simulator` does; a plugin elsewhere reads that file for the types.
- The contract changes with the host. Before you deploy a new host version, run `plugin check` for each configured plugin from that version's checkout.
- The host currently uses Pi Durable and Chord 1.4.0. Durable tools return `output`, not `content`; an adapter for a Pi coding-agent or MCP tool maps `content` to `output`. Plugin tasks replace `runtime.sleep()` with a phase-ending `sleepUntil(until, checkpoint, context)` and handle the `sleeping` status.
- Retired fields still load: the host ignores `follow.autoMerge` with one log line, and ignores `vcs.readHeads`, `vcs.readHeadMarker` and `workspace.readHeadEntry`.

## Current limits

- No hot reload. Every change waits for a host restart.
- No per-project installation. `plugins.json` is per host home, and a loaded plugin is loaded for every project on that host. Limit it with `coordinatorTools.applies`, `workerTools.offered` and your own checks of `projectId`.
- No sandbox. A plugin is trusted code in the host process (see [Trust](README.md#trust)).
- A browser panel lives only in Settings → Plugins. A plugin cannot add UI anywhere else in the inbox. The simulator plugin's card was written for the classic inbox and its retired hooks, so its panel shows an error until it is ported.
- No published type package (see Compatibility).
- `plugin check` does not run your RPC methods or tools, and the private host's fake model does not call your tools.
