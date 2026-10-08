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
