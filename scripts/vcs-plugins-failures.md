# Failure modes: VCS / PR provider plugins

Written before the code. E2E: `scripts/vcs-plugins-e2e.mjs` (fake model, private HOME, a FAKE test plugin in `scripts/fixtures/`; no real VCS, PR service, gh or live host). Artifact: `artifacts/vcs-plugins-<stamp>/report.json` + screenshots + host logs.

Loading
1. A configured plugin path does not exist: recorded as failed with the path and reason; the host starts and serves everything else.
2. A plugin module throws at import or in `register`: recorded; the capabilities it provided before throwing (a PR provider "ghost") are NOT registered (all-or-nothing).
3. A module without `register` / without a valid `name`: recorded as failed, not loaded.
4. Two plugins claim the same name or the same capability id (vcs kind, workspace provider, PR provider): the second one fails, the first keeps working.
5. A provider with a missing method (`parseRefs`, `isRoot`, ...) is refused at load, not at the first call in a project.
6. `plugins.json` is not valid JSON or has the wrong shape: one failed entry naming the file; the env list still loads.
7. Same plugin listed in `plugins.json` and in `PI_PROJECTS_PLUGINS`: loaded once.
8. A plugin that hangs in `register`: bounded by `PI_PROJECTS_PLUGIN_TIMEOUT_MS`, recorded (not covered by the E2E run time budget; exercised by the timeout test plugin only when the env knob is set).
9. Load failures are invisible to the owner: the `plugins` RPC, `/health`, the host log and a banner in the browser UI must all show them.

Capabilities
10. Plugin tools do not reach the coordinator (or reach non-matching projects), or are missing from the worker's tool set, or the plugin's worker/VCS rule text is not in the role instructions.
11. Plugin PR data is shown with the wrong shape or leaks into other projects: the PR card is grouped per provider, only for projects the provider `applies` to; a hostile title is escaped.
12. `#123` refs: block only from a provider that applies and finds ids; an unreadable PR is a line, never an error; the stored job keeps the owner's words only.
13. Watch/hide: ids are validated by the provider before they are stored; unknown provider rejected; watching is idempotent; ids stored as strings.
14. Monitor transitions: first sight is a silent baseline; CI-failed raises exactly one notice and an event; merged raises one notice; repeated polls do not repeat them.
15. Follow auto-fix: a failed check on a PR the project published dispatches one fix worker carrying the plugin's brief (untrusted marker intact), recorded before dispatch; never twice for the same head.
16. A plugin-owned uncertain write must block automatic admission (schedule snapshot reports it).
17. Plugin state dir `$PI_PROJECTS_HOME/plugins/<name>/` exists, is private to the plugin, and survives a restart.
18. Plugin RPC for a plugin/method that is not loaded fails with a clear error; a plugin RPC that changes a project while work is queued or running is refused.

Persistence without the plugin
19. Plugin removed from the config after it was used: the host opens the project; the provider's project record (`fakeAuthorization`), its workspace grant (`provider: "fake"`), its watch/hide document, its worktree receipts and Follow records are kept byte for byte.
20. Without the plugin the project says so: PR card note "provider plugin not loaded", Owner setup note, a worker dispatch fails with that reason instead of falling back to git; cleanup never removes the plugin's worktrees; Follow PRs does not pretend to follow.
21. Plugin loaded again: watched/hidden PRs, the grant and the connection are back; the plugin's worktrees are cleaned up through its backend.
22. The workspace grant provider is `github` or a plugin id: a plugin must not be able to register `github`/`git` ids.

Regression guards
23. GitHub-only projects behave as before: no provider group, no provider cards, no `#` menu; the generic `prs`/`pr-watch`/`pr-hide` RPCs refuse them.
24. The core source tree contains no plugin-specific provider names, CLIs, env seams or hosts (checked by grep in this E2E).
