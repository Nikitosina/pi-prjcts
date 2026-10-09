# Arcanum PR card, PR monitoring, coordinator PR tool, `#` references: failure cases (written before code)

Scope: `src/arcanum-prs.ts` (shared host-side PR list/detail service, `ya whoami` login), `src/durable-arc-watch.ts` (transition monitor -> coordinator events), `src/coordinator-arcanum-tools.ts` (`projects_arcanum_pr`, read-only), host actions `arc-prs` / `arc-pr-watch`, `#NNN` resolution in `message`, web card + `#` menu. E2E: `scripts/arc-pr-card-e2e.mjs` (fake ya / arc / arcanum / model only).

## Data and polling
1. Real `ya`/arcanum touched: every call goes through `cli.ya()` / `cli.arcanum()` seams; E2E asserts every recorded call came from the fakes and none left the temp root.
2. `ya whoami` unavailable, unparsable or empty: card shows one quiet line "Sign in: ya whoami failed", no throw, no PR calls with an empty `--author`. Login cached after the first success only.
3. Auth missing / Arcanum errors (REMOTE_ERROR, AUTH): card keeps the last good rows (stale marker) or a single quiet error line; never an empty "no PRs" that hides a failure.
4. RATE_LIMITED (exit 75): back off with jitter (>= 60 s base, doubling to 15 min), never retry in a loop; browser refresh and a manual refresh during backoff do not call Arcanum (cache + "rate limited, retry in ~N s"). Asserted via call count.
5. Many browsers / projects / tabs: one in-flight list call shared by all callers; cache TTL (default 90 s); concurrent `arc-prs` requests make exactly one `pr list` (asserted).
6. Paging: `has_next`/`next_offset` followed with a hard page cap (10); a cycle (next_offset not advancing) stops.
7. Row without checks, with unknown status strings, missing `active_diff_set`, huge summaries or HTML in a summary: classified "no checks"/running, text clipped and escaped in the card (asserted with an `<img onerror>` summary).
8. Per-PR detail (`pr get`) failing for one PR (NOT_FOUND, REMOTE_ERROR): that row renders without auto-merge info; others unaffected.
9. Merged/discarded PRs vanish from `pr list`: they disappear from the card on the next refresh and, if watched, produce a final event (see 14).

## Card
10. Git project (not Arc): no card in the DOM-visible sidebar, `arc-prs` answers `{arc:false}` and makes no ya/arcanum call.
11. Status mapping: red = failed required check or conflicts; amber = required check running/unfinished; green = every required check satisfied; grey = no checks; non-required failure shows in counts without turning the row red. Sorted failing, running, green. Each row <= 2 lines, `#id summary` links to `https://a.yandex-team.ru/review/<id>` (rel noopener), auto-merge badge when auto-merge is on.
12. Readable in light and dark (contrast scan), no layout overflow at the sidebar width, long summary truncated with ellipsis (not wrapped).
13. Watch toggle: persisted per project (survives host restart), idempotent (watching twice stores once), cap 50 watched PRs, id validated as a positive safe integer.

## Monitoring (coordinator events)
14. Exactly one event per (PR, diff-set, transition): required check -> failed, conflicts -> true, auto-merge on and status shows merge failure, PR merged, PR discarded. Re-polling the same state, flapping inside one diff-set, and host restart produce no duplicates (sent ids persisted). A new diff-set may report again.
15. First sight of a PR is a silent baseline (no event for an already failing PR); a PR that appears later in the set is baselined, not announced.
16. Monitored set = watched ids + PRs touching the project dir (`pr list --author <me> --path /<repo-relative dir>`) + PRs opened by the project's workers. For worker PRs the existing Follow PRs code already reports CI failures and merges: the monitor reports only conflicts, merge failure and vanish for those (no duplicate CI lines, asserted). Someone else's PR with the same path is never monitored (author filter).
17. Project dir at the repo root (empty relative path): no `--path` call (would match everything); only watched + worker PRs.
18. Monitoring only runs while Follow PRs is on, the project is active (not paused/archived/deleted/closed) and is an Arc project; off or paused: no calls, no events, card shows "Monitoring off" quietly.
19. A PR vanishing from the list is resolved with `pr get`: merged -> "merged", discarded -> "closed"; any other status or a failing get is not an event (retried next poll), never a false "merged".
20. Events go to the chosen events chat via the existing ingest path (`arc.follow`), payload marks Arcanum text untrusted, clipped (summary 120, check names 80, max 60 lines); a rate-limited poll records the error and sends nothing.

## Coordinator tool
21. `projects_arcanum_pr` is offered only for Arc projects, read-only (no write argv ever: asserted by scanning recorded arcanum calls for `pr get|checks|comment list|pr list` only), validates id as integer, returns checks + status + merge_allowed + auto_merge + (optional) open-issue comments clipped; Arcanum errors become a tool error with the closed code, not a crash; text marked untrusted.
22. Git projects never see the tool; existing GitHub tools unchanged.

## `#` references
23. `#` opens the menu only at a word start (`#` after start/whitespace), not inside `abc#1` or a URL fragment; filters by id or summary; Enter/Tab inserts `PR #12345 `; Escape closes; `/` skill menu unaffected (and `/skill:x #1` still works).
24. Menu on a git project or while the list is unavailable: no menu (the `#` stays literal text, e.g. markdown headers `# Title` at line start with a space are not hijacked: menu requires a non-space char or nothing after `#` only when followed by digits/letters, never `# `).
25. On send the host resolves distinct `#NNN` / `PR #NNN` ids (max 5): summary, status, failing checks, url appended as an untrusted block after the owner's text; unknown/unreadable id yields a line saying so, never blocks the send; skill expansion and attachments still work together; the stored job text and the transcript show the owner's own words (the block renders as chips, not a wall of text).
26. Prompt injection: PR summary/check text containing instructions stays inside the untrusted block (asserted in the model-visible user message).
27. Git project: `#123` is plain text, no resolution, no ya/arcanum call.

## Regressions
arc-pr, arc-follow, arc-workers, settings-polish, theme E2Es keep passing; `npm run check` gains no error beyond the known `src/workspace-capabilities.ts(169,21)`.

## Notifications (scope added by the owner: CI failure, PR merged)
N1. A monitored PR whose required check fails raises exactly one host notice (browser feed + Telegram) per (PR, diff-set): text "✕ CI failed · PR #id summary · check", in the events chat. Already-failing PRs at first sight, merge failures, conflicts, discarded PRs and unmonitored PRs raise none.
N2. Re-polls and host restarts never raise a second notice (keys persisted with the monitor state; the notifier keeps its own seen set in notifications.json).
N3. A merged PR (confirmed by `pr get`) raises one "✓ Merged · PR #id summary" notice; worker-opened PRs notify too (their event lines stay with Follow PRs).
N4. Telegram receives each notice exactly once (fake Bot API only). GitHub Follow PRs now raises the same two notices (CI failed on an open PR, PR merged) through the same list; covered by the follow-prs/browser-notify regressions, not by a new GitHub E2E.

## Hiding PRs (owner request: hide PRs from monitoring and the card), recorded before implementation
- H1 Hide only removes the row from the card; the monitor still sends events/notices for that PR (watched, touching the project dir, or opened by a worker).
- H2 Hiding a watched PR leaves it in `watched`, so unhiding silently resumes watching (or hide is lost when watch is toggled).
- H3 Hidden PRs are lost on host restart (stored only in memory/browser).
- H4 No way back: hidden PRs are not listed anywhere, so they cannot be unhidden.
- H5 Hidden list grows forever: merged/discarded PRs stay in it.
- H6 Hide button is a data-action disabled while busy, or misclicks Watch (buttons too close / same handler).
- H7 Unhiding a PR whose transition happened while hidden fires a stale event (baseline must be retaken).
- H8 Invalid ids or non-Arc projects accepted.
