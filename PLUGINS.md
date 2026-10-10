# Provider plugins

Core ships Git and GitHub only. Other checkout kinds and PR services (an internal VCS, GitLab, ...) are separate modules loaded at host start.

## Enabling

Primary: `$PI_PROJECTS_HOME/plugins.json` (persistent, per host home)

```json
{ "plugins": ["/abs/path/to/plugin-dir-or-module.ts"] }
```

Additive: env `PI_PROJECTS_PLUGINS=/path/a:/path/b` (tests, one-off runs). A path is a module file, or a directory with `index.ts|mjs|js` or a package.json `main`; relative paths resolve against the home. Restart the host to apply. A plugin that is missing, throws, has the wrong shape, conflicts with another or hangs (`PI_PROJECTS_PLUGIN_TIMEOUT_MS`, 15 s) is recorded and skipped: see the `plugins` RPC, `/health`, the host log (`plugin-failed`) and the banner in the browser UI.

## Writing one

Export `{ name, register(api) }` (default or named). `register` calls `api.provide({...})` once or more; nothing is visible until it returns. Types: `src/plugin-types.ts` (`HostPluginApi`). Use `api.lib` (Durable, typebox, chord context) instead of importing your own copies.

| capability | purpose |
|---|---|
| `vcs` | checkout kind: root marker, status, diffs, PR-head snapshots, branch continuation, private dirs, worker rule |
| `workspace` | workspace-grant provider: one-click preview, worktree backend (frozen receipts), worker binding (plan/attach: tools, shell guard, instructions), cleanup facts, setup cards |
| `prs` | PR provider: generic card data, detail, `#` refs, watch/hide validation, status, worker-published ids, watch document kind |
| `follow` | Follow PRs for publication receipts: observe, fix brief, auto-merge (host supplies receipts and review kit) |
| `coordinatorTools` | tools and an instruction snippet for matching projects |
| `rpc` | namespaced host RPCs: `{ action: "plugin", plugin, method, id?, params? }`; context offers `withRoot`, `mutateIdle` |
| `uncertainWrites` | blocks automatic admission while a plugin write outcome is unknown |

State: `api.stateDir` = `$PI_PROJECTS_HOME/plugins/<name>/`; provider-owned top-level project records (`project.json` keys such as `<x>Authorization`) and Durable documents are kept verbatim by core even when the plugin is not loaded. Without the plugin the UI says "provider plugin not loaded", workers do not start, cleanup leaves the plugin's worktrees alone, and everything returns when the plugin is loaded again.

PR watch documents store ids as strings; documents written with numeric ids are read as strings.

Tests: `scripts/vcs-plugins-e2e.mjs` with the fake plugin in `scripts/fixtures/` (failure modes: `scripts/vcs-plugins-failures.md`).
