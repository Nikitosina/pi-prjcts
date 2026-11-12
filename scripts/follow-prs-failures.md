# Follow all PRs: failure cases

Owner decision: a per-project opt-in poller over the authorized GitHub repositories. PR opened/merged/closed, CI failed/passed, reviews and comments (bots included) become events for the coordinator. A CI failure on a project-published PR auto-dispatches a fix worker. Events land in Main or in the chat chosen in Settings. `scripts/follow-prs-e2e.mjs` checks these with a fake model and the fake `gh`.

## Opt-in and scope
1. Polling starts without an explicit owner opt-in, or keeps running after it is turned off.
2. The poller reads a repository the project is not authorized for, or runs when the project has no GitHub authorization (it must report a readable blocker instead).
3. Enabling follow while the host was down never polls: the poller only runs while somebody has the project open.

## First poll and duplicates
4. The first poll floods the coordinator with every existing PR, comment and old CI result (it must record a silent baseline).
5. The same change is delivered twice: on a second poll with nothing new, after a host restart, or because the batch event ID is not stable.
6. A comment or review already seen is re-delivered when the PR is updated for another reason.
7. CI that is still pending produces an event, or a passed/failed result is announced again for the same head.

## Event content and routing
8. Opened, merged, closed, CI failed, CI passed, review and bot comment are missing from the event, or the event text lets provider data pose as instructions (it must be marked untrusted).
9. Events go to Main when another chat is chosen in Settings; an archived or deleted chosen chat drops events instead of falling back to Main.
10. One poll with several changes starts several coordinator turns instead of one batched turn.
11. The transcript shows the event as a raw owner message instead of an event card.

## Auto-fix
12. A CI failure on a PR the project did not publish dispatches a fix worker.
13. A fix is dispatched twice for the same head SHA (re-poll, restart, duplicate failure).
14. A new head that fails again dispatches without limit; the per-PR cap (3) is not enforced or not reported to the coordinator.
15. A fix is dispatched while the previous fix for the same PR is still queued or running.
16. The fix worker has no repository scope or its report goes to a different chat than the event.
17. Auto-fix cannot be turned off separately from following.

## Failure handling
18. A `gh` failure (rate limit, 404, bad JSON) crashes the host, stops future polls, or advances the baseline so the change is lost.
19. A paused project still polls or dispatches.
20. Settings do not show follow status (last poll, error, fix attempts) or a Check now control.

## The inbox at `/` (classic inbox retired 2026-11-04)
Opt-in is now the Follow PRs switch in Settings → Automations (F9); the card names the chosen chat ("→ Alerts"), the last check and
fits 390 px (F20). The Alerts transcript in `#feed` shows the coordinator's answer and never the internal event (F11). Retired with
the classic Events form: choosing the event chat, cadence, auto-fix and fix cap in the browser (kept over `automation-update`), the
"Check now" button (kept over `follow-poll`) and the per-fix list (kept in `automation-snapshot`). Gaps: those controls in the new client.

## Pull the main checkout on merged (owner request 2026-11-09)
When Follow PRs sees a PR become merged (whoever merged it), the host fast-forwards the project's main checkout through the merge provider's `pullMain` and says the outcome in the event line.
21. A merged PR leaves a clean main checkout on the PR's base behind (the Coordinator only reports the merge).
22. A dirty checkout or a checkout on another branch is changed, or the skip is silent instead of "main checkout not pulled: <reason>" in the event.
23. A failing or hanging pull fails the follow poll, loses the event, or blocks the poll past its timeout; host shutdown waits for it.
24. One merge pulls more than once: on the next poll, on a replayed pending batch, or once per item instead of once per transition.
25. Two pulls of the same checkout run at once (two merges, or Follow PRs and Approve together), so one fails on git's lock.
26. A provider whose follow state has no base branch (the Arc plugin) pulls nothing or the wrong branch: the base comes from the merge provider's `inspect`.

## A GitHub write with an unknown outcome (owner request 2026-11-12)
A GitHub write whose outcome is unknown (`uncertain` in `projects.github-writes`) blocks automatic admission, so Follow PRs cannot deliver its batch. In Mari two such writes for PRs merged weeks earlier (their bodies had no marker) kept the first batch pending for five days: every poll replayed it, failed, and read nothing new, and nothing showed why.
27. An uncertain write whose PR is merged or closed blocks Follow PRs forever (it must become `moot` on the next poll and the pending batch must arrive).
28. An uncertain write whose PR is still open, or that no PR on GitHub answers for yet, stops blocking (absence is not proof).
29. A write turned `moot` reads as `done` or `uncertain` in `github-write-snapshot`, or lets a worker repeat the write.
30. A blocked poll loses the pending batch, delivers it twice once unblocked, or shows nothing: the Follow PRs card must name the problem and the open PR it waits on.
