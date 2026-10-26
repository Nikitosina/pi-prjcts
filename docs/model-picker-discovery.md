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

## Host shell environment startup

The owner subsequently authorized importing **all exported zsh startup variables**, including credentials, rather than a credential-name allowlist. On macOS, the stable `src/host.ts` entry now imports the shell environment before dynamically loading `src/host-server.ts`. SDKs, provider extensions and other environment-reading modules therefore initialize after the import. Both the detached launcher in `src/client.ts` and the LaunchAgent installed by `src/remote.ts` already call this entry. Their absolute Node executable and working directory do not change. Launcher readiness waits allow 25 seconds for shell capture plus host initialization.

Startup runs `/bin/zsh -ilc` with the launcher's inherited environment. Normal zsh login and interactive startup apply, including `.zshenv`, `.zprofile`, `.zshrc` and `.zlogin`, with zsh's usual `ZDOTDIR` behavior. This executes startup code and its commands, not merely assignments. Startup files are neither parsed nor edited. Non-exported shell locals, functions and aliases are not imported. Other platforms retain their existing inherited-environment behavior.

Shell stdout and stderr go to `/dev/null`, including startup noise or tracing. A separate pipe carries a framed, NUL-delimited `/usr/bin/env -0` snapshot directly into memory. The importer writes no export values to files, logs or browser responses. Startup scripts still run as trusted user code and can have their own side effects. The host logs only an event name and export/import counts. Capture has a 10-second deadline and a 2 MiB limit. Failure, malformed data or timeout aborts startup before the host opens its project store. Timed-out shell process groups are killed, and no partial capture is applied.

The launcher's values win for host identity and runtime controls, even when those values are absent:

- All `PI_PROJECTS_*` controls, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR` and `PI_ARTIFACTS_DIR`.
- `HOME`, `USER`, `LOGNAME`, working-directory/shell bookkeeping variables, and `TMPDIR`/`TMP`/`TEMP`. In particular, shell changes cannot redirect the default project store or the Unix socket location.
- Node preload, module lookup, IPC and debug controls: `NODE_OPTIONS`, `NODE_PATH`, `NODE_CHANNEL_FD`, `NODE_UNIQUE_ID`, `NODE_DEBUG` and `NODE_DEBUG_NATIVE`.

Agent-session markers `PI_SUBAGENT*` and `PI_SESSION_FILE` are removed. Other exported values, including credentials and PATH changes, enter the host environment. A shell `unset` removes an inherited non-protected export. Child processes inherit the resulting environment unless their existing launch path filters it. This means exported credentials can reach provider helpers, tools and workers; importing them does not grant any new tool or filesystem authorization. Shell startup is trusted code, not a sandbox.

`host-environment-unit.mjs` covers real zsh startup in a disposable HOME, export fidelity, non-exported locals, child inheritance, shell noise, failures, malformed/oversized capture, timeout cleanup, and protected launcher variables. `host-environment-e2e.mjs` starts the real host entry with a private HOME and Pi agent root, configures the intended model using a disposable `.zshrc` credential, and dispatches it to a loopback provider. Neither test runs the owner's startup files.

### Applying to the intended dev host

Read-only launcher inspection found the dev LaunchAgent already points to `src/host.ts` in the owner's checkout, with `PI_PROJECTS_HOME` pinned to its dev store. No plist rewrite or credential copy is required for this implementation. After the owner deploys the approved source change to that checkout, they must restart the existing dev service when the conversation is idle. Pulling source alone does not change an already-running Node process.

This task does not edit the owner checkout or `.zshrc`, write external LaunchAgent configuration, replace the live process, or make a real-provider request. The still-running host has not imported these exports. Live credential acceptance remains pending deployment and an owner-timed restart; isolated provider success is not a claim that the live host is already configured.
