# Worker-skills catalog scale + multi-chat follow-ups: failure cases

Written before code. `scripts/skills-scale-chats-e2e.mjs` checks these with a fake model, headless Chrome and a private HOME.

## A. Owner worker-skills catalog above 64 skills (slice 10)
1. 89 configured skills make `worker-skills-catalog` throw "Configured skill catalog exceeds bounded capture limits" (or the combined "Owner skill catalog exceeds combined capture limits").
2. The returned catalog validates against a 64-item schema and fails after capture.
3. The 1 MiB captured-document budget trips before the count does (89 normal skills).
4. Paging is wrong: offsets above 64 are refused by the request schema, pages overlap or skip, `total` is not 89, `nextOffset` never reaches null.
5. The revision differs between pages of an unchanged catalog, so a grant built from page 6 is refused.
6. The UI grant dialog lists only the first 16 skills.
7. A skill on the last page cannot be granted (`worker-skills-grant-set` recaptures and refuses it).
8. Repository discovery still caps at 64 candidates, so a repo with more skills fails the same way.
9. Unbounded growth: a pathological catalog (thousands) is captured without any limit.

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
19. A project written by the pre-multi-chat code (commit 95817c3: no `projects.chats` doc, jobs without `chatId`) fails to open, shows no chat, shows something other than Main, or loses its transcript; a new message to it fails.

## Regressions
20. multi-chat, live-chain, ui-polish, coordinator-live, github-quick-ui, coordinator-workers-ui, projects-chat-md, workers-card-ui, worker-chat-ui and coordinator-github-skills keep passing.
