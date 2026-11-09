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
10. File-limited workspace grant (no whole-repository scope): PRs touching the granted files are listed and monitored even when someone else wrote them; the files query only happens for such projects; a whole-repository project never fetches files.

Relevance (what the card lists)
11. Authored by the gh viewer: listed. Authored by someone else: not listed unless watched, worker-published or touching the project's granted files.
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
29. Failed check detail (name, conclusion, title/summary, details_url, head sha) is in the fix task, flattened, clipped per field, http(s) links only, capped at ~4 KB with an untrusted marker (check runs only; commit statuses are on the card and in the tool); a hostile summary cannot break out of the block.
30. Detail building must not add calls to a green poll, must survive a missing `output`, and must not change when a fix is dispatched (cap, once per head, recorded before dispatch) or auto-merge behaviour.

Regressions
31. Arc plugin PR card and follow suites still pass against the changed API (`list` options, `published(root, project)`, `parseRefs(..., project)`, optional card fields, optional `followCovers`/`normalizeId`).
32. vcs-plugins, follow-prs, coordinator-github-skills, durable-worker-report, coordinator-stability, worker-chat-ui, coordinator-workers-ui unchanged.

## The inbox at `/` (classic inbox retired 2026-11-04)
The browser check now reads the new client's PR list (`#prs .pr-row`): the project's PRs appear and a hostile title stays text.
Retired with the classic card: state ordering on the card, the watch toggles, the watch-by-URL input (the call is kept over RPC:
a PR URL is stored as its normalized id), hide/show hidden, the `#` PR menu in the composer and the card's contrast scans.
Gaps: the new client cannot watch, unwatch or hide a PR, or insert a `#` reference from a menu.

## PR links and Merge through the Coordinator (2026-11-09)
P1 A PR row is plain text: it must link to the provider's own `url` of that PR, opening a new tab without an opener.
P2 A URL that is not http(s) (for example `javascript:`) becomes a live link. Such a row stays text, no guessed URL.
P3 Merge calls a merge or approval endpoint. It must only submit an owner message to the Coordinator of the chat the owner sees,
and the fake gh log shows no mutation from it.
P4 Merge sends without asking. It must confirm first, naming the PR and the target chat; Cancel sends nothing.
P5 A double click on Confirm, or a second Merge while one is in flight, sends twice. Exactly one message per confirmation.
P6 The message is vague. It must name the provider, the PR reference, its URL and branch, and its head when the card has one.
P7 The target moves: switching chat while the dialog is open or the request is in flight retargets the message. The target is frozen
when the dialog opens.
P8 The composer draft is cleared or replaced by the merge request.
P9 A failed submission is silent. It must show the error and let the owner retry.
P10 Merge is offered on a draft PR, or on a PR the provider reports merged or closed. It is disabled with the reason; failing CI
is not a reason to hide it (the Coordinator decides).
