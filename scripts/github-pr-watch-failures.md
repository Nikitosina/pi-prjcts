# GitHub PR watching: failure modes (written before the code)

Scope: built-in `github` PR provider (`src/github-prs.ts`, registered through the plugin registry's built-in path), the generic monitor additions in `src/pr-monitor.ts` (CI recovered, changes requested, approved, new review threads; `followCovers`), the coordinator tool `projects_github_pr` (`src/coordinator-github-tools.ts`), the failed-check detail in the Follow PRs auto-fix brief (`src/durable-follow.ts`). E2E: `scripts/github-pr-watch-e2e.mjs` (fake `gh` with a stateful JSON store and a call log, fake model, headless Chrome; no real gh, network or live host). Artifact: `artifacts/github-pr-watch-<stamp>/`.

Data source
1. gh binary missing (`PI_PROJECTS_GH_CLI` points nowhere): the card shows one visible error line ("GitHub CLI not found"), no crash, host keeps serving; recovers on the next refresh once gh exists.
2. gh unauthenticated (exit 4, "gh auth login"): visible "not signed in" error, no rows invented, token-looking text never shown.
3. GraphQL returns `errors` with partial/no `data`, invalid JSON, a `null` repository (renamed/deleted/no access), `null` nodes: card error, last good rows kept with the error ("showing the last list"), never an empty "No open PRs" that hides a failure.
4. Rate limit (primary 403, secondary "secondary rate limit", 429, GraphQL type RATE_LIMITED): `RateLimitedError`, jittered growing backoff through pr-cache; refreshes and monitor polls during backoff make zero gh calls (asserted by call count); card says rate limited; no tight loop.
5. Many browsers/tabs/projects: concurrent refreshes make exactly one GraphQL list call; plain reads are served from the cache.
6. Hostile text (HTML in a title/check name/review thread body, prompt-injection text): clipped, escaped on the card, only after the untrusted header in `#` blocks and the tool result.
7. PR without checks, with `null` statusCheckRollup, unknown conclusions/states, status contexts (not check runs), 100+ contexts: classified none/running, never throws.
8. `mergeable: UNKNOWN` (GitHub still computing) is not a conflict and must not flap a conflict event.
9. Project without a GitHub authorization, archived/deleted project: provider does not apply, zero gh calls.
10. Project folder below the repo root: PRs touching it (files) are included, the file query only happens for such projects; a root-level project never fetches files.

Relevance (what the card lists)
11. Authored by the gh viewer: listed. Authored by someone else: not listed unless watched, worker-published or touching the project folder.
12. Worker-published PR by another login: listed and monitored (published receipt), and an explicitly watched foreign PR is listed even though it is not authored by me.
13. Merged/closed PRs never appear on the card.

Watch / hide
14. Watch by `123`, `#123` or a PR URL of the bound repo; URL of another repo, `0`, `-1`, `abc`, `99999999999`, an issue URL: rejected before anything is stored. Idempotent, stored as strings, survives a host restart.
15. Hide: PR leaves the card and monitoring; hiding a watched PR unwatches it; unhide takes a fresh baseline (what changed while hidden is not replayed); hidden ids of merged PRs are pruned.

Transitions (monitor) - each once, never replayed after a re-poll or restart
16. First sight of a PR is a silent baseline (already failing/conflicting/changes-requested produce nothing).
17. CI failed -> notice + event once (Follow PRs and the monitor must not both announce it: exactly one notice, one event line).
18. CI recovered (failed -> green): one notice; event once.
19. Merge conflict appears: one notice + event (monitor only; Follow does not report it).
20. Review changes requested; approved; new unresolved review threads (count goes up): one notice each; the event line comes from Follow PRs (no duplicate); resolving threads or a lower count raises nothing.
21. Merged, closed without merge: confirmed by a status read after the PR vanished from the open list; a failed read is retried, not reported as merged. Merged raises one notice; closed raises none.
22. Host restart between polls, a crash after delivery but before the state commit: no duplicate event or notice (`sent` ids persisted).
23. Follow PRs off: monitor idle, no gh calls from it. Project paused/archived: nothing delivered.
24. A gh error during a monitor poll: `lastError` on the card, no events, baseline untouched (no phantom "merged" because the list failed).

References (`#`)
25. `#123`, `PR #123`, PR URL of the bound repo resolve; `a#123`, `foo/bar#123`, URL of another repo, and a project without GitHub do not. Unreadable PR (issue number, 404) is one line, not an error; max 5; stored job text keeps the owner words only.
26. Referenced block is appended after the owner words under the untrusted header; hostile PR text stays inside it.

Coordinator tool
27. Only offered to coordinators of projects with a current GitHub authorization; read-only (only GraphQL queries run, no mutations - asserted from the call log); untrusted marker on every result.
28. Without a number: the owner's open PRs. With a number: state, checks (name, conclusion, summary, details_url), failed checks, unresolved review threads; unknown PR is a tool error, not a crash. Repository argument must be authorized.

Follow PRs auto-fix brief
29. Failed check detail (name, conclusion, title/summary, details_url, head sha) is in the fix task, flattened, clipped per field, http(s) links only, capped at ~4 KB with an untrusted marker; failing commit statuses included; a hostile summary cannot break out of the block.
30. Detail building must not add calls to a green poll, must survive a missing `output`, and must not change when a fix is dispatched (cap, once per head, recorded before dispatch) or auto-merge behaviour.

Regressions
31. Arc plugin PR card and follow suites still pass against the changed API (`list` options, `published(root, project)`, `parseRefs(..., project)`, optional card fields, optional `followCovers`/`normalizeId`).
32. vcs-plugins, follow-prs, coordinator-github-skills, durable-worker-report, coordinator-stability, worker-chat-ui, coordinator-workers-ui unchanged.
