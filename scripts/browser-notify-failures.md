# Browser notifications: failure cases

Owner decision: Notification API for needs-you items, results and errors when the tab is hidden; a toggle in Settings. `scripts/browser-notify-e2e.mjs` checks these with a fake model in headless Chrome.

1. A notification shows while the tab is visible (the page already shows it).
2. Nothing shows while hidden for a question, an approval, a finished result or a coordinator error; or notices of other projects/chats are missed (only the open chat is watched).
3. The same notice shows twice (re-render, reconnect, page reload replays old notices).
4. The toggle is on by default, does not ask for permission, or claims "on" when permission is denied.
5. The toggle does not persist across reloads, or turning it off does not stop notifications.
6. Clicking a notification does not focus the tab, or opens the wrong project/chat.
7. Notification text includes raw secrets or unbounded text (body must be clipped).
8. Polling the feed when the toggle is off costs requests, or a feed error breaks the page.
9. The host feed is unbounded in memory or on disk.
10. The feed misses a turn that starts and finishes between two scans, or a result settled while the host was down is never reported (or old ones flood after restart).
11. A Follow PRs "Project is paused" error stays after resume until the next poll.

## Live report: owner enabled notifications and got none (added before the fix)
Live host evidence (read-only): `notifications.json` holds 66 notices since 07:15 (results, a worker failure, a coordinator error; Telegram delivered from the same feed), so the feed works and the browser side dropped them. Code paths that drop every notice:
12. The window is on screen but another app is focused (owner working in a terminal/editor beside the browser): `visibilityState` stays `visible`, the poll takes the notices and discards them because only `hidden` counted. Most likely cause.
13. The tab was hidden long enough to be throttled or frozen (Arc/Chrome energy saver): no poll ran while away; the first poll after returning sees the backlog while visible and discards it.
14. The host restarted (the orchestrator restarts it after each task; 19 starts in `host.log`): each start minted a new token, so an open tab's `notify-feed` polls got 401 forever, swallowed by `catch {}` while Settings still said "On".
15. Any other feed failure is silent too (no state, no retry message).
16. The permission prompt was dismissed (answer `default`) or blocked quietly: the toggle flips back to "Off." with no reason.
17. The browser has permission but the OS suppresses it (macOS notification settings for the browser, Focus): the page cannot detect this; there is no way to test delivery.
