# Writing pi-prjcts plugins

A plugin is a JavaScript or TypeScript module that a host loads at its start. It adds capabilities to that host: RPC methods, tools for coordinators and workers, cleanup and storage steps, a panel in Settings → Plugins, browser routes, or a whole provider for another checkout kind or PR service. Core ships Git and GitHub; everything else is a plugin. A plugin can live in any directory and needs no change to core.

## Pages

- [Getting started](getting-started.md): create a plugin, test it, check it with the host's loader, try it on a private host.
- [Reference](reference.md): the module shape, `HostPluginApi`, and every capability an ordinary plugin uses, with signatures and examples. It explains RPC methods versus agent tools, the approval policy, state, lifecycle and leases.
- [Development and activation](development.md): testing, private verification, activation on a host, troubleshooting, compatibility and current limits.
- [Example plugin](examples/notes/): `notes`, a working plugin with RPC methods, coordinator tools, worker tools and a Settings panel, and its test.
- [`PLUGINS.md`](../../PLUGINS.md): provider capabilities (`vcs`, `workspace`, `prs`, `follow`, `merge`) for a new checkout kind or PR service, and the built-in GitHub provider.

The source of truth is `HostPluginApi` and `PluginCapabilities` in [`src/plugin-types.ts`](../../src/plugin-types.ts) and the loader in [`src/plugins.ts`](../../src/plugins.ts). When this guide and those files disagree, the files win.

## The path in short

```sh
# from the pi-prjcts checkout
npm run projects -- plugin new ~/code/my-plugin      # scaffold
(cd ~/code/my-plugin && node --test)                  # its own test
npm run projects -- plugin check ~/code/my-plugin     # the host's loader, in a temporary home
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch --plugin ~/code/my-plugin   # private host
```

Activation is a separate, explicit step: add the directory to a host's `plugins.json` and restart that host. A running host never picks up source changes by itself. See [Development and activation](development.md#activation).

## Trust

A plugin is trusted code. It runs inside the host process as the host's user, with full Node access and no sandbox. It can read and write every project's files and state, run commands, and declare which of its own RPC methods are safe for agents. Load only plugins whose code you have read or written. The loader skips and reports a plugin that fails to load. After that, plugin code shares the host process, so a crash or a blocking loop in it affects the whole host.
