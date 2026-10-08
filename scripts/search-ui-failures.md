# Full-text search UI + worker-failure notices: failure cases (written before code)

Search (one project at a time; chats, worker threads, knowledge, uploads):
- S1 A word said only in a non-Main chat, an archived chat or an old turn outside the 30-message window is not found.
- S2 A word said only inside a worker thread (incl. a nested child thread) is not found; or only the coordinator's copy of the worker report is found.
- S3 Knowledge documents and upload text (PDF/text) are not searched, or deleted/edited ones still match (stale cache).
- S4 Results do not say where they come from (chat title, worker role/task, doc path, file name), or snippets are unbounded / HTML-injected (XSS through transcript text).
- S5 Ranking ignores rarity: a common word drowns the rare word that identifies the message; no result cap.
- S6 A stop-word-only or empty query throws an unexplained error, or a query that hits nothing shows a blank list.
- S7 Clicking a chat hit opens the wrong chat, or the right chat but the message is outside the rendered window, not scrolled to, not highlighted; or the 2 s refresh/live stream scrolls away or drops the highlight.
- S8 Clicking an old chat hit permanently breaks the normal window (tail no longer shown after the owner moves on: sends a message or switches chat).
- S9 Clicking a worker hit does not open that thread at the page containing the message, or does not highlight it.
- S10 Clicking a knowledge hit does not open the doc / scroll to the matching place; an upload hit past the first 20 000 characters is never shown.
- S11 Cmd/Ctrl+K does not open search (or only when focus is outside inputs); Escape does not close; arrow keys + Enter cannot pick a result; the "/" composer shortcut breaks.
- S12 Search requests race: a slow earlier query overwrites the results of a later one; switching project during a query shows the other project's results.
- S13 At 390 px the search dialog or result rows overflow horizontally; highlight hidden under the composer.
- S14 Search of a large transcript set rereads/tokenizes everything every keystroke (no debounce, no cache) and stalls the host.
- S15 A legacy (non-Durable) project errors instead of searching knowledge only.
- S16 Search exposes another project's data (wrong id) or works without the browser token.

Worker-failure notices (src/notify.ts, open issue from the notifications slice):
- W1 A worker whose work item ends `failed` produces no notice in the feed, so neither browser nor Telegram hears about it.
- W2 The notice goes to the wrong chat (not the chat that delegated the work) or lacks the worker role/task/blocker.
- W3 The same failure is reported twice (every scan, or again after a host restart), or a retry's new failure is swallowed as a duplicate.
- W4 On upgrade, every historic failed work item of existing projects floods out at once.
- W5 Stopped/interrupted (owner stop, pause) work is reported as a failure.
- W6 Browser notifications ignore the new notice kind, or the click does not open the chat.
