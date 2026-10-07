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
