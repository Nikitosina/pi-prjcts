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
