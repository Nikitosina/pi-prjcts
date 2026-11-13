# Plugins

A plugin is a module the host loads at its start to add capabilities: RPC methods, coordinator or worker tools, cleanup and storage steps, browser routes, or a whole provider for a checkout kind or PR service. There is one plugin mechanism; "extension" is only the upstream Pi and Pi Durable term (Pi packages, `defineExtension`), never a separate kind of pi-prjcts add-on.

Core ships Git and GitHub only. GitHub is the built-in `github` plugin (see [The built-in GitHub plugin](#the-built-in-github-plugin)); no config. Other checkout kinds and PR services (an internal VCS, GitLab, ...) are separate plugins loaded at host start. Bundled: `plugins/simulator` (iOS simulators per project; not loaded unless configured).

## Author guide

Start with [`docs/plugins/README.md`](docs/plugins/README.md):

- [Getting started](docs/plugins/getting-started.md): `npm run projects -- plugin new|check`, the scaffold's test, a private host with `--plugin`.
- [Reference](docs/plugins/reference.md): the module shape, `HostPluginApi`, RPC methods versus `coordinatorTools` and `workerTools`, `rpcPolicy` and owner approval, state, resource leases, lifecycle, cleanup, storage, web routes and the panel in Settings → Plugins.
- [Development and activation](docs/plugins/development.md): testing, private verification, activation through `plugins.json` and a restart, troubleshooting, compatibility and current limits.
- [Example plugin](docs/plugins/examples/notes/): a checked-in plugin with RPC methods, tools and a Settings panel, tested by `scripts/plugin-dev-unit.mjs` and `scripts/plugin-panels-e2e.mjs`.

The contract is `HostPluginApi` and `PluginCapabilities` in `src/plugin-types.ts`; the loader is `src/plugins.ts`. The rest of this file covers the provider capabilities for a new checkout kind or PR service.

## Provider capabilities

| capability | purpose |
|---|---|
| `vcs` | checkout kind: root marker, status, diffs, branch continuation, private dirs, worker rule. `codeDiffPath: true` declares that `codeDiff` honors `helpers.path` (one file or directory relative to the checkout root, validated by the host); without it `code_diff` refuses `path` for this kind. The host counts files for `code_diff` mode `stat` from the returned diff text |
| `workspace` | workspace-grant provider: one-click preview, worktree backend (frozen receipts), worker binding (plan/attach: tools, shell guard, instructions), cleanup facts and removal (`atBase` for a settled reader's worktree), setup cards |
| `prs` | PR provider: generic card data (checks, conflicts, optional draft/review/unresolved threads), detail, `#` refs, watch/hide validation, status, worker-published ids, watch document kind; optional `normalizeId` (number/URL input), `transitions`/`noticeFor` (monitor kinds), `followCovers` (what Follow PRs already announces) |
| `follow` | Follow PRs for publication receipts: observe, fix brief (host supplies receipts) |
| `merge` | result acceptance for the checkout kind (`MergeProvider`, `kind` matches the `vcs` kind): `inspect` the PR (state, draft, head, base, `mergeable` yes/later/no), `merge` exactly the approved head, `enableAutoMerge` pinned to that head, and `pullMain` for the main checkout. Approve calls it, and Follow PRs calls `pullMain` (with `inspect` for the base) when a followed PR becomes merged; without it a Job of this kind cannot be approved |
| `uncertainWrites` | blocks automatic admission while a plugin write outcome is unknown |

A provider plugin can also use the general capabilities, for example `rpc` for the `connect` call of a setup card; the [reference](docs/plugins/reference.md) describes them.

Since 2026-11-06 readers get their own worktree through `workspace.task`, so `vcs.readHeads`, `vcs.readHeadMarker` and `workspace.readHeadEntry` are no longer part of the contract; the host ignores them. A provider whose old snapshots still sit on disk removes them in its `cleanup` step.

Merge contract (`src/plugin-types.ts`, used by `src/result-acceptance.ts`): `merge` must refuse when the PR head differs from `head`, and return `{ ok: false, refused }` when the provider answered and nothing merged. A throw means the outcome is unknown; Approve then reads the PR through `inspect` before deciding and reports `merge-uncertain` if it cannot confirm. `enableAutoMerge` returns `waiting: false` when the PR is already mergeable and nothing was armed. `pullMain` fast-forwards only a clean checkout on `base` and returns `{ pulled: false, reason }` for an expected skip instead of throwing; it must honor `signal` and be a no-op on a checkout already at the merge. A `follow` provider may set `base` in its PR state; otherwise Follow PRs reads it through `inspect`. The host resolves the provider with `plugins.mergeProvider(kind)`.

Provider state: provider-owned top-level project records (`project.json` keys such as `<x>Authorization`, read with `api.projects.record`) and Durable documents are kept verbatim by core even when the plugin is not loaded. Without the plugin the UI says "provider plugin not loaded", workers do not start, cleanup leaves the plugin's worktrees alone, and everything returns when the plugin is loaded again.

PR watch documents store ids as strings; documents written with numeric ids are read as strings.

Tests: `scripts/vcs-plugins-e2e.mjs` with the fake plugin in `scripts/fixtures/` (failure modes: `scripts/vcs-plugins-failures.md`).

## Coordinator and task workspaces

`workspace.coordinator` is an optional chat-ownership adapter with `plan(CoordinatorBindContext)` and `attach(CoordinatorAttachContext)`. The attachment supplies `workDir`, `start`, `checkOwned` and `detach`. Ownership checks must validate the frozen receipt, repository, real root, branch and lease while allowing advanced HEAD and dirty files. Detach drains runtime handles; it must not release or remove the allocation. Missing support blocks Coordinator execution for that provider.

Shared task helpers borrow that verified chat attachment. They do not call independent worker `plan`, `attach`, `tools` or publication hooks, and they never acquire the chat's ownership identity. Their processes, artifacts and host leases remain keyed to their real worker ID.

Isolated task helpers require the separate optional `workspace.task` adapter. `plan(TaskPlanContext)` receives the verified source chat workspace, actual worker identity and explicit `baseCommit`; it must return that exact base and a fresh branch, never fetch trunk as a substitute or continue another branch. Core freezes the resulting allocation intent before allocation. `attach(TaskAttachContext)` returns the same owned-attachment operations plus task instructions. Its checks must retain task-specific receipt and lease ownership, not relax Coordinator checks to accept arbitrary paths.

`helperGuard(command)` is the optional shell policy of every task helper, shared or isolated. Helpers never publish, so it should keep the provider's safety rules and refuse pushes and PR writes with a message that sends the work back to the Coordinator. Without it, core's Git helper policy applies.

Absent task support visibly refuses isolated task allocation. Existing independent `plan`/`attach` behavior remains unchanged. Task helpers receive core execution tools without independent worker publication hooks. Neither adapter gives permission to merge main, deploy or perform destructive actions.

## The built-in GitHub plugin

One plugin identity, `github`, holds GitHub. Core loads the bundled module `plugins/github` on every host before configured plugins, through the same loader and `register(api)` contract, with status source `built-in`. It needs no `plugins.json` entry, so existing authorized projects keep their tools with no migration. The name is reserved: a configured plugin named `github`, including a second listing of `plugins/github`, is refused and the built-in stays loaded.

What moved (stage 1): the Coordinator GitHub tools `projects_github_issue_read`, `projects_github_issues`, `projects_github_issue_write` and `projects_github_pr` (`plugins/github/coordinator-tools.ts`, its `coordinatorTools`). Names, schemas, replay policies and the Durable extension `projects.coordinator-github` are unchanged (`scripts/fixtures/github-coordinator-tools.json`), so recorded calls still resolve. They are offered while the project has a GitHub authorization and re-check it on every call: Coordinator caller, active project, the trusted owner, the current workspace fingerprint, an authorized repository, and for writes the pinned numeric repository id. Because the plugin is built in, its tools keep the GitHub group in Tools/access, and their rules stay the built-in `github` integration block (`src/role-prompts.ts`).

What remains built in for now: the `prs` provider below (`src/github-prs.ts`; joined to the same `github` entry, and kept even when the bundled module fails to load), the `gh api` transport (`githubApi` in `src/github-authorization.ts`, shared with `#` refs), GitHub authorization and the one-click grant, worker publication tools (`src/github-worker.ts`), Follow PRs, result acceptance (`githubMergeProvider`) and `projects_gh`. The bundled module imports those core modules directly; it is not a pattern for external plugins.

Without the bundled module (a failed load), the PR card still works, the GitHub tools are not offered, a call ends as unavailable without contacting GitHub, and the tools return when it loads again. Tests: `scripts/github-plugin-e2e.mjs` (failure modes: `scripts/github-plugin-failures.md`).

## GitHub PR watching (built in)

The `github` provider reads through `gh` (`PI_PROJECTS_GH_CLI`): one `gh api graphql` call per card refresh (open PRs with check runs and commit statuses, mergeability, review decision, unresolved threads), cached and shared by `pr-cache` (TTL `PI_PROJECTS_PR_TTL_MS`, jittered rate-limit backoff `PI_PROJECTS_PR_BACKOFF_MS`). Detail, status of a vanished PR and the coordinator tool `projects_github_pr` are one query each; nothing mutates. It applies to projects with a GitHub authorization (first repository).

- Card: the gh user's open PRs, worker-published PRs, watched PRs (any author; watch by `123`, `#123` or the PR URL) and, for a file-limited workspace grant, PRs touching the granted files. Hide removes a PR from the card and monitoring.
- Monitor (needs Follow PRs on): edge-triggered, once per revision: CI failed/recovered, conflicts, changes requested, approved, new unresolved threads (host notices for all; Follow PRs already says CI failed/merged/review lines, so the monitor does not repeat them), merged/closed confirmed by a status read.
- `#123` and PR URLs of the bound repository in a message append an untrusted block with the PR's state.
- Follow PRs auto-fix for a failed check run includes name, conclusion, title, summary and details_url (http(s) only), capped at 4 KB and marked untrusted.
- Limits: the repository's 50 most recently updated open PRs are listed; a branch without a review rule reports approval from the reviewers' latest reviews; a failing check counts as required unless GitHub reports the merge state UNSTABLE.
Tests: `scripts/github-pr-watch-e2e.mjs` (failure modes: `scripts/github-pr-watch-failures.md`).
