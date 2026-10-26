# Installed models and host credentials

The picker reads `projectModelPicker` in `src/project-models.ts`. Each request opens an offline runtime through `createModelRuntime` in `src/provider-extensions.ts`.

- Pi's `getAgentDir()` selects the agent root, including `PI_CODING_AGENT_DIR` overrides.
- The SDK loads custom providers and models from that root's `models.json`.
- `src/model-store.ts` reads that root's `models-store.json`, preferring its provider catalogs over Projects' older catalogs. Projects-only provider catalogs remain available.
- Global Pi package extensions and native provider registrations load once per host. They supplement the SDK runtime. Project-local extensions do not execute for picker discovery.
- An explicit project `scopedModels` list wins. Otherwise `SettingsManager` reads the project's settings plus global `enabledModels`, and Pi's resolver matches those patterns.
- Discovery and authentication are separate. A model can be installed while its provider's credential template refers to an environment variable missing from the host process.

The response keeps usable `scoped` references separate from `unavailableScoped` references. Both use Pi's matching rules. The latter appear disabled in the default picker with a host-credential explanation. They never enter model cycling or become valid selections merely because they are installed. Searching uses the provider/model reference and display name, with punctuation normalized.

## PR13 acceptance failure

Read-only inspection on 2026-10-26 found the intended model in the normal Pi agent root:

- Provider `eliza-openrouter`, id `moonshotai/kimi-k3.1-pro`, display name `Kimi K3.1 Pro (Eliza)`.
- Both its API key and Authorization header use the `ELIZA_TOKEN` environment template. No token value was retrieved.
- Global `enabledModels` includes the exact provider/model reference. The affected project has no explicit scope or local settings override.
- The `projects-dev` host reports the model as installed but `configured: false`, with no extension errors. The other running `projects` host reports the same reference as configured and includes it in its usable scope.
- The dev LaunchAgent declares only Projects process flags and PATH, not the provider credential variable. Restarting that service does not supply a missing environment variable.

Pi's SDK resolver filters enabled models through `getAvailable()`. Previously the picker displayed only that filtered scope by default. Thus the model disappeared from the default list despite existing in `items`. It could still be found as a disabled search result. Refreshing catalogs cannot fix missing host credentials.

The owner checkout's main ref and relevant source/SDK files matched merged PR13 on disk. The dev process start time was after that merge. The current health endpoint exposes pid and project home, not an in-memory build hash, so these observations do not claim an exact running-source hash.

`scripts/scoped-model-environment-e2e.mjs` reproduces this provider shape with disposable environment templates and a loopback provider. It covers inherited and explicit scopes, disabled default visibility, id/display-name searches, rejection without credentials, and successful dispatch of the nested model id when the disposable host environment supplies the configured variable. It does not test the owner's remote provider or change a live host.

The remaining live action belongs to the owner: arrange credentials for the intended host using their approved secret-delivery method. No automatic fallback to another provider, copying credentials from another host, LaunchAgent edits, or host restart is part of this fix.
