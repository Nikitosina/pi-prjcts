# Provider plugins

Core ships Git and GitHub only. GitHub PR watching is a built-in `prs` provider on this same API (`src/github-prs.ts`, registered by the registry itself; no config). Other checkout kinds and PR services (an internal VCS, GitLab, ...) are separate modules loaded at host start.

## Enabling

Primary: `$PI_PROJECTS_HOME/plugins.json` (persistent, per host home)

```json
{ "plugins": ["/abs/path/to/plugin-dir-or-module.ts"] }
```

Additive: env `PI_PROJECTS_PLUGINS=/path/a:/path/b` (tests, one-off runs). A path is a module file, or a directory with `index.ts|mjs|js` or a package.json `main`; relative paths resolve against the home. Restart the host to apply. A plugin that is missing, throws, has the wrong shape, conflicts with another or hangs (`PI_PROJECTS_PLUGIN_TIMEOUT_MS`, 15 s) is recorded and skipped: see the `plugins` RPC, `/health`, the host log (`plugin-failed`) and the banner in the browser UI.

## Writing one

Export `{ name, register(api) }` (default or named). `register` calls `api.provide({...})` once or more; nothing is visible until it returns. Types: `src/plugin-types.ts` (`HostPluginApi`). Use `api.lib` (Durable, typebox, chord context) instead of importing your own copies.

The host uses Pi Durable and Chord 1.4.0. Durable tools return `output`, not `content`; adapters for Pi coding-agent or MCP tools must map their `content` to `output`. Plugin document definitions need an explicit `checkpointWhen` policy (`() => false` keeps changes as deltas). Plugin tasks must replace `runtime.sleep()` with a phase-ending `sleepUntil(until, checkpoint, context)` and handle the `sleeping` status. Check external plugins against these APIs before deploying the upgraded host.

| capability | purpose |
|---|---|
| `vcs` | checkout kind: root marker, status, diffs, PR-head snapshots, branch continuation, private dirs, worker rule |
| `workspace` | workspace-grant provider: one-click preview, worktree backend (frozen receipts), worker binding (plan/attach: tools, shell guard, instructions), cleanup facts, setup cards |
| `prs` | PR provider: generic card data (checks, conflicts, optional draft/review/unresolved threads), detail, `#` refs, watch/hide validation, status, worker-published ids, watch document kind; optional `normalizeId` (number/URL input), `transitions`/`noticeFor` (monitor kinds), `followCovers` (what Follow PRs already announces) |
| `follow` | Follow PRs for publication receipts: observe, fix brief (host supplies receipts) |
| `merge` | result acceptance for the checkout kind (`MergeProvider`, `kind` matches the `vcs` kind): `inspect` the PR (state, draft, head, base, `mergeable` yes/later/no), `merge` exactly the approved head, `enableAutoMerge` pinned to that head, and `pullMain` for the main checkout. Approve calls it; without it a Job of this kind cannot be approved |
| `coordinatorTools` | tools and an instruction snippet for matching projects |
| `rpc` | namespaced host RPCs: `{ action: "plugin", plugin, method, id?, params? }`; context offers `withRoot`, `mutateIdle` |
| `uncertainWrites` | blocks automatic admission while a plugin write outcome is unknown |
| `workerTools` | tools and an instruction snippet for whole-repository workers; offered to new threads, frozen with each thread's tool set |
| `leaseName` | canonical name for lease resources the plugin owns, so aliases share one lease |
| `lifecycle` | `pause(projectId)` around project pause/resume/archive/delete (throw to refuse; returns the resume) and `close()` at host shutdown |
| `web` | browser script and stylesheet (`/plugins/<name>/ui.js`, `ui.css`) and bearer-authenticated GET routes (`/plugins/<name>/<route>?project=<id>`) |

Merge contract (`src/plugin-types.ts`, used by `src/result-acceptance.ts`): `merge` must refuse when the PR head differs from `head`, and return `{ ok: false, refused }` when the provider answered and nothing merged. A throw means the outcome is unknown; Approve then reads the PR through `inspect` before deciding and reports `merge-uncertain` if it cannot confirm. `enableAutoMerge` returns `waiting: false` when the PR is already mergeable and nothing was armed. `pullMain` fast-forwards only a clean checkout on `base` and returns `{ pulled: false, reason }` for an expected skip instead of throwing. The host resolves the provider with `plugins.mergeProvider(kind)`.

Host API extras: `api.leases` (host-wide advisory leases; the plugin's own holds are not released by project stops), `api.projects.dir(id)`, `api.lib.value` (typebox `Value`).

Browser plugins call `window.piProjects.register({ name, mount(slot), projectChanged, render, tick, hide, action(name, node) })`. `data-action` names starting with `<name>-` go to the plugin. `piProjects` offers `state()`, `rpc(plugin, method, id, params)`, authenticated `fetch`, and the dialog, toast and escaping helpers. A failing browser plugin is logged and skipped.

Bundled: `plugins/simulator` (iOS simulators per project; not loaded unless configured).

State: `api.stateDir` = `$PI_PROJECTS_HOME/plugins/<name>/`; provider-owned top-level project records (`project.json` keys such as `<x>Authorization`) and Durable documents are kept verbatim by core even when the plugin is not loaded. Without the plugin the UI says "provider plugin not loaded", workers do not start, cleanup leaves the plugin's worktrees alone, and everything returns when the plugin is loaded again.

PR watch documents store ids as strings; documents written with numeric ids are read as strings.

Tests: `scripts/vcs-plugins-e2e.mjs` with the fake plugin in `scripts/fixtures/` (failure modes: `scripts/vcs-plugins-failures.md`).

## GitHub PR watching (built in)

The `github` provider reads through `gh` (`PI_PROJECTS_GH_CLI`): one `gh api graphql` call per card refresh (open PRs with check runs and commit statuses, mergeability, review decision, unresolved threads), cached and shared by `pr-cache` (TTL `PI_PROJECTS_PR_TTL_MS`, jittered rate-limit backoff `PI_PROJECTS_PR_BACKOFF_MS`). Detail, status of a vanished PR and the coordinator tool `projects_github_pr` are one query each; nothing mutates. It applies to projects with a GitHub authorization (first repository).

- Card: the gh user's open PRs, worker-published PRs, watched PRs (any author; watch by `123`, `#123` or the PR URL) and, for a file-limited workspace grant, PRs touching the granted files. Hide removes a PR from the card and monitoring.
- Monitor (needs Follow PRs on): edge-triggered, once per revision: CI failed/recovered, conflicts, changes requested, approved, new unresolved threads (host notices for all; Follow PRs already says CI failed/merged/review lines, so the monitor does not repeat them), merged/closed confirmed by a status read.
- `#123` and PR URLs of the bound repository in a message append an untrusted block with the PR's state.
- Follow PRs auto-fix for a failed check run includes name, conclusion, title, summary and details_url (http(s) only), capped at 4 KB and marked untrusted.
- Limits: the repository's 50 most recently updated open PRs are listed; a branch without a review rule reports approval from the reviewers' latest reviews; a failing check counts as required unless GitHub reports the merge state UNSTABLE.
Tests: `scripts/github-pr-watch-e2e.mjs` (failure modes: `scripts/github-pr-watch-failures.md`).
