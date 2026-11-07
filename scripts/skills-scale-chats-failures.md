# Skill scale + multi-chat follow-ups: failure cases

Written before code. `scripts/skills-scale-chats-e2e.mjs` checks these with a fake model, headless Chrome and a private HOME.

## B. Multi-chat follow-ups
10. Usage counts only Main and workers; a non-Main chat's tokens are missing from the total and rows.
11. Usage rows do not name the chat, or Main is still labelled "Coordinator" next to other chats.
12. Observability trace shows one "Coordinator" node; other chats, their busy state and the workers they delegated are not visible.
13. Health "Coordinator" says idle while a non-Main chat is busy.
14. A failed turn in chat B is invisible while viewing Main: `project.problem`/`phase` come from the viewed chat only.
15. Viewing a healthy chat clears another chat's failure (problem flips with the selected chat).
16. A non-viewed chat's job stays queued/running in the ledger forever because only the viewed chat is reconciled, so its failure is never seen.
17. The chat bar does not mark which chat needs attention.
18. At 390px width the chat bar overflows the viewport horizontally, pills/tools overlap, or New chat is pushed off-screen.
19. (Removed with the legacy runtime; the 95817c3 host is no longer started.) A project written by the pre-multi-chat code (commit 95817c3: no `projects.chats` doc, jobs without `chatId`) fails to open, shows no chat, shows something other than Main, or loses its transcript; a new message to it fails.

## Regressions
20. multi-chat, live-chain, ui-polish, coordinator-live, github-quick-ui, coordinator-workers-ui, projects-chat-md, workers-card-ui, worker-chat-ui and coordinator-github-skills keep passing.

## The inbox at `/` (classic inbox retired 2026-11-04)
F17 is the Broken chat's "needs you" dot in the tree while Main is open (the classic Main warning banner with Open chat is retired).
F6 reads the `coordinator-skills` catalog over the host API: the classic Settings skills picker is retired and the new client has no
skills picker yet (gap: per-role skill profiles are editable only over `settings-update` or the Host agent). F10-F13 and L1 keep the
usage data checks over `usage-snapshot`; the classic Observability tab is retired. F18 checks the tree at 390 px.
