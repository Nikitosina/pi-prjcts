# Telegram two-way: failure cases

Owner decision: one bot per host, token supplied in Settings. Long-polling `getUpdates` (no public URL). Outbound: needs-you questions (inline answer buttons), approvals, finished results, errors. Inbound: answers, approvals and plain messages routed to a chosen project chat. Only the paired owner chat is accepted. `scripts/telegram-e2e.mjs` checks these with a fake model and a local fake Bot API server (`PI_PROJECTS_TELEGRAM_API`), never real Telegram.

## Token
1. The token is written world-readable, returned by an RPC/HTTP snapshot, shown in the page, or appears in host logs or error text (fetch errors carry the URL with the token).
2. A wrong token is saved silently and polling spins against 401 forever (it must be refused on save via `getMe`; a later 401 stops polling with a visible error).
3. Changing to a different bot keeps the old offset or the old paired chat.

## Pairing
4. Any Telegram user who finds the bot can talk to projects (before pairing, or a second user after pairing).
5. A pairing code never expires, can be guessed by brute force (no attempt cap), or is reusable after pairing.
6. A group chat pairs (only private chats may pair).
7. Messages and button presses from non-owner chats change anything or get project data back.

## Polling
8. Updates are processed twice after a host restart (offset not persisted, or persisted after a crash window with a non-idempotent effect).
9. A plain message retried after a crash admits two coordinator turns (admission must use a request ID derived from the update).
10. A failing Bot API (5xx, network) makes a hot loop; there must be backoff, and polling must recover when it comes back.
11. Polling keeps running after host shutdown or after the token is removed; shutdown hangs on the long poll.
12. Two hosts/bots: a 409 conflict is not surfaced.

## Routing
13. Plain text goes to an unexpected project or chat; no project picked gives no hint.
14. `/project` or `/chat` with an unknown, archived or deleted target is accepted.
15. Text sent to a paused/archived project is lost silently (the owner must get the error back).
16. Reply-to on a result message does not go to that message's project/chat.

## Outbound
17. Questions, approvals, results or errors are not sent, are sent twice (also across restarts), or old history floods the chat on first pairing.
18. Question buttons do not record the answer, record it twice, or a stale button answers an already answered question differently.
19. Approval buttons approve something other than the exact pending record (fingerprint), or approve with execution consent.
20. A message longer than Telegram's limit fails to send and blocks the outbox.
21. A Bot API failure loses the notice (it must be retried in order).

## UI
22. Settings do not show bot, pairing state, code with instructions, route and last error; the card overflows on a 390 px screen.

## Formatting (Markdown → Telegram HTML), added before the change
23. Messages arrive as raw Markdown (`**bold**`, `` ``` `` fences, `# Heading`, `[text](url)`) because no `parse_mode` is sent.
24. Model text containing `<`, `>` or `&` is not escaped, so Telegram rejects the message (400 "can't parse entities") or renders injected tags.
25. Unsupported tags are produced (`<h1>`, `<ul>`, `<li>`, `<p>`, `<br>`): headings must become bold, lists `•`/numbered lines.
26. A code fence clipped mid-block (notice text is clipped at 3,500 chars) leaves an unclosed `<pre>`.
27. A link with `"` or `javascript:` in its URL becomes a broken or unsafe `href`.
28. snake_case words or `2*3*4` turn into italics.
29. A message longer than 4,096 characters after escaping is clipped (content lost) or split inside a tag/entity, so a chunk has unbalanced tags.
30. A multi-part message re-sends earlier parts after a mid-way send failure (duplicates), or reply-to on a later part does not route.
31. Telegram still refuses the HTML (400 "can't parse entities"): the notice is stuck retrying forever instead of falling back to plain text.
32. Bot command replies (help, /projects with names containing `<`) break because they are now parsed as HTML.

## `/status` with subscription limits, added before the change
Owner decision: limits refresh only on an explicit owner request (`scripts/limits-manual-failures.md`). `/status` is one, so it sends one `limits-refresh` through the normal dispatch and reports what that returns. Proof: `scripts/telegram-jobs-unit.mjs` (fake Bot API, fake dispatch).
33. `/status` loses the route line, or fails without a picked project instead of still reporting host-wide limits.
34. `/status` polls providers itself, polls more than once per command, or starts a timer; or it skips the refresh and only reads the cache.
35. A provider with no reading shows a fabricated `0%` or `$0` instead of "no data", "unavailable" or its reason.
36. A cached reading kept after a failed or rate-limited refresh is shown as fresh: its age, the failure reason and the Retry-After wait are missing.
37. Providers hidden in Settings are listed, or all hidden gives an empty reply.
38. A failed `limits-refresh` gives no reply; the last cached snapshot must be shown with the error, or the error alone if there is none.
39. A long provider reason makes the reply exceed Telegram's limit, or the plain-text reply is sent with a `parse_mode`.

## Questions answered from Telegram, added before the change
40. A question answered in Telegram stays open in an open UI2 tab: the card stays until a reload, or reappears after one.
41. Text the owner sends to the asking chat while its only question is open (plain routed text, or a reply to another message of that chat) reaches the coordinator as a plain message: work continues, the question stays open everywhere.
42. That text answers a question of another chat, or picks one of several open questions in the chat; or a replayed update answers twice or admits a second turn.
