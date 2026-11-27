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
26. A code fence split mid-block leaves an unclosed `<pre>`.
27. A link with `"` or `javascript:` in its URL becomes a broken or unsafe `href`.
28. snake_case words or `2*3*4` turn into italics.
29. A message longer than 4,096 characters after escaping is clipped (content lost, including by the notice feed) or split inside a tag, entity or emoji (surrogate pair), so a chunk has unbalanced tags or broken text.
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
41. Answering by button in one chat resolves or hides another chat's question, or a paused project (waking the chat deferred) leaves the card up until a reload.
42. Ordinary text to a chat with an open question resolves it (only a button or a reply to the question's own message answers), or a replayed answer update wakes the chat twice.

## Telegram setup in Settings → Notifications, added before the change
Owner decision (2026-11-04): the classic inbox is retired, and it was the only place to save the bot token and pair. The same card
moves to the new client's Settings → Notifications; host behaviour is unchanged. Proof: `scripts/telegram-e2e.mjs` (T1/T2/T5/T6/T22, 43-45).
43. Settings → Notifications only says whether Telegram is paired: no token field, no Pair, Unpair or Remove, or a refused token is
    not said in place.
44. Pairing finished in Telegram leaves an open Settings page on "not paired" until it is reopened, or the page learns it by polling
    instead of a host topic.
45. Remove bot works on one press, the typed token stays in the field after Save, or a redraw drops what the owner is typing.

## Job progress over a broken network, added before the change (2026-11-06)
46. A network failure while sending or editing a Job progress message rejects the fire-and-forget `progress()` call, and the
    unhandled rejection exits the host. Each restart cuts off running work, until durable tasks are parked. Progress is best-effort:
    the failure is recorded as a delivery error, and the next progress update for that Job tries again.

## Slash command suggestions (setMyCommands), added before the change
Telegram shows a command menu only when the bot registers one. The list must be what `command()` in `src/telegram.ts` answers. Proof: `scripts/telegram-jobs-unit.mjs` (fake Bot API).
47. The menu lists a command the handler does not answer, or omits one it does (projects, project, chats, chat, status, models, model).
48. The scope is wider than private chats, so groups the bot sits in also show the menu.
49. One failed `setMyCommands` (502, 429 with retry_after, dropped connection) is never retried, or retrying blocks `getUpdates`, or its error stops the host.
50. After a success the call repeats on every poll or restart of the loop instead of once per bot, or a changed bot is not registered again.
51. Registering messages a chat, changes pairing, or the Bot API error leaks the token.

## One uncertain attachment must not stop the outbox, added before the change (2026-11-19)
Incident on the deployed host: `sentSeq` 1119, `sentPart` for seq 1120 had `parts: 0`, `pendingMedia: true` (one album of two images, never delivered), and 57 later notices were never sent. `flush` and `sendNotice` returned on `pendingMedia`, so the cursor never moved. Proof: `scripts/telegram-media-unit.mjs` (fake Bot API; red before, green after).
52. A lost response (dropped connection, 200 with an incomplete result) for one media or album blocks every later notice, in the same run or after a restart.
53. State persisted by the old release (`sentPart.pendingMedia`, with or without a plan) still blocks the feed after upgrade.
54. The uncertain notice is dropped or marked delivered without the owner saying so, so the attachment is lost without trace; or it is sent again automatically (duplicate).
55. The record of the held notice loses its plan, the count of confirmed parts or the anchor message, so a recovery resends confirmed parts or breaks reply routing.
56. A recovery resends the backlog, or a held notice after the bot or paired account changed (isolation), or runs while a flush is sending, sharing its cursor.
57. A recovery that is lost again leaves no record (it must stay held), or one that fails cleanly (429) loses its progress.
58. A legacy record without a plan is resent by guessing; it must only be markable delivered.

59. The owner is replaced (unpair and pair another chat) while a held notice resends: a later part, caption or follow-up goes to the replacement, or the part that reached the old chat is routed for the new account or not counted as confirmed. Proof: `scripts/telegram-media-unit.mjs` (red before, green after).
60. A progress message of the old account is edited in the new chat, or a progress or message record is written for the new owner by a send that began for the old one. Proof: `scripts/telegram-jobs-unit.mjs`.

## One topic per coordinator chat in the private chat, added before the change (2026-11-27)
Owner decision: with Threaded Mode on for the bot (`getMe` says `has_topics_enabled`), every coordinator chat gets its own topic in the paired private chat, created lazily with `createForumTopic` and named `<Project> · <Chat title>`. The mapping (project, chat, `message_thread_id`) is Telegram state. Telegram had private-topic regressions in 2026 (tdlib/telegram-bot-api 847, 905, 944), so a topic problem never blocks the notice queue. Proof: `scripts/telegram-e2e.mjs` (fake Bot API with topics; T61-T68).
61. With topics off (`has_topics_enabled` false or missing) any request carries `message_thread_id` or calls a topic method, or the existing flow changes.
62. A notice, progress message, media or album, or a command reply goes to the general thread (or to another chat's topic) although its coordinator chat has a topic; a notice with no chat does not go to the project's Main topic; a later part of one notice (second chunk, spillover, album) uses another thread than its first part.
63. Two notices or a notice and a progress update for the same chat arrive together and create two topics, or the mapping is lost across a restart so a second topic appears.
64. A message in a topic goes to the `/projects` route or the wrong chat instead of the topic's chat; a reply to a question inside a topic does not answer it; a message in the general thread stops using the reply target and `state.route`; a message in an unknown thread is dropped.
65. The owner deletes a topic: the next notice fails forever, is lost, or is sent twice. It must drop the mapping, create a new topic and send once.
66. `createForumTopic` fails (400, 5xx, dropped connection, a malformed result): the notice is stuck retrying, blocks the notices behind it, or is lost. It must go to the general thread once, and the next notice tries the topic again after a short wait, not on every call.
67. Re-pairing to another chat or changing the bot keeps the old mapping, so a new owner's notice is sent to a thread of the old chat. A bot whose topics were turned off keeps sending thread ids.
68. Archiving a chat leaves its topic open, or renaming a chat leaves the old topic name; a failure of `closeForumTopic` or `editForumTopic` fails the chat update or the notice queue.
69. The owner is replaced while `editMessageText` of a progress message is in flight and Telegram answers "message to edit not found": the replacement is sent to the former owner (the check ran only before the edit). Proof: `scripts/telegram-jobs-unit.mjs` (red before, green after).
