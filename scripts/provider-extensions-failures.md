# Provider extensions: failure cases

Owner request: the projects host loads model providers contributed by the owner's Pi packages/extensions (settings `packages`, agent-dir `extensions/`) so their models show in the picker and run coordinators/workers/scouts/reviewers. `scripts/provider-extensions-e2e.mjs` checks these with a fake package + extension under a private `PI_CODING_AGENT_DIR`, the local fake model server, no real provider/extension/network.

Discovery / loading
1. Extension providers never loaded: picker lacks their models; scoped list (`enabledModels`, incl. `@256k:fast`-style suffix entries) resolves to only built-in providers.
2. Only one code path loads them: picker sees them but settings-update validation or the durable runtime (`assertConfiguredModel`, session model lookup) does not, so a picked model is rejected or fails at run time.
3. Loader installs/downloads missing `npm:` packages, or hits the network (must resolve what is already installed only).
4. Host reads the owner's real `~/.pi/agent` in tests (must follow `PI_CODING_AGENT_DIR`); project-local `.pi/extensions` of the host cwd is loaded.
5. `./projects-mvp` (this repo) still listed in `packages` is loaded into itself (recursion / double host).
6. Disabled package or extension (settings filters) is loaded anyway.

Isolation
7. A throwing extension (import error, factory throw) stops host start, picker, or other extensions' providers.
8. A hanging extension (never resolves) blocks host start, picker or every later extension; no timeout.
9. Failing extension leaves partial provider registrations behind.
10. Error is only in a log: picker/RPC gives no hint which extension failed or why.
11. Provider registration that Pi rejects (invalid config) throws out of runtime creation instead of becoming a recorded error.
12. Extension registers a tool, command, shortcut, flag, or event handler: any of it reaches project agents (coordinator/worker/scout/reviewer tool lists, system prompts, handler hooks).
13. Extension code loaded per runtime creation (slow picker, duplicate side effects) instead of once per host.

Auth
14. `configured` for an extension provider ignores its auth (apiKey / stored credential): unconfigured provider selectable, or configured provider shown disabled.
15. Real auth/OAuth flow is started by the loader or picker (must not; only status).

Running
16. Coordinator turn on an extension model does not reach the extension provider's endpoint (request goes elsewhere / "model unavailable").
17. Worker/scout/reviewer role models pinned to an extension model fail at run or resolve to a different model.
18. Durable generation hooks/override of `streamSimple`/`getModel` (context-window override) are lost on the extension-aware runtime.
19. Broken extension at host start makes every project fail to open instead of only lacking those models.
