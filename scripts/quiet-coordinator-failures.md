# Quiet coordinator, coordinator AGENTS.md, child fan-out, auto-fix receipts: failure cases, written before implementation

Covers C1 (reporting), C10 (coordinator repository instructions), C11 (b) child fan-out discipline and (e) plan-first prompting, and C5 (auto-fix eligibility). Verified by `scripts/quiet-coordinator-e2e.mjs` unless marked (inspection).

## Reporting (C1)
- Q1 Queued worker reports still run one coordinator turn each (harness `followUpMode` left at `one-at-a-time`), so N settled workers cost N turns.
- Q2 Batching drops or merges a report: one of the batched reports never reaches the coordinator, or its submission is never answered so the Report task never marks it delivered (redelivered after restart).
- Q3 The report prompt still asks for a per-worker summary for the owner ("Summarize the result for the user"), so every intermediate turn is an owner-facing essay.
- Q4 The coordinator cannot tell an intermediate report from the last one: the report does not say whether other work for that chat is still queued or running.
- Q5 The report echoes the whole task (up to 8000 chars), inflating every turn.
- Q6 A parent worker's turn that ends with children still queued or running (the "delegated, waiting" turn, or a conclusion on the first of several children) reports to the coordinator, so one parent with k children costs k+1 coordinator reports.
- Q7 Holding the parent's report loses it: when the last child settles, the parent's final answer is not reported either (no report at all), or a failed parent turn is held.
- Q8 A held report shows as `pending` forever in `projects_workers` / plan snapshots, or is redelivered after a restart.
- Q9 Intermediate status lines notify the owner ("Finished" in the browser/Telegram feed) although work is still running.
- Q10 The final report turn (nothing left running) no longer notifies.

## Coordinator repository instructions (C10)
- Q11 The coordinator never sees the repository AGENTS.md (only workers do).
- Q12 An edited AGENTS.md is not re-applied to an existing coordinator (or its chats) on reopen.
- Q13 A broken standing file (symlink, too large) now prevents the project from opening although workers already refuse it the same way (inspection: same loader, same errors as workers).

## Child fan-out (C11 b)
- Q14 A parent can still queue 4 children; the cap is not 2.
- Q15 Nothing tells workers to keep children for independent parallel work and to use one reviewer per head.

## Plan-first prompting (C11 e)
- Q16 Coordinator instructions still say "Summarize each result for the user and decide the next step" and contain no plan-first / prefer-follow-up / no-micro-delegation guidance.

## Scripted task (C11 E2E)
- Q17 A scripted multi-step owner request (one parent worker with two children plus one scout, with the coordinator busy while reports arrive) produces more than 4 threads or more than 2 coordinator report turns.

## Auto-fix eligibility (C5)
- Q18 A failing PR whose branch starts with the project's branch prefix but has no publication receipt is still treated as project-published (auto-fix dispatches a worker that cannot push).
- Q19 A failing PR with a receipt is no longer auto-fixed. (Covered by `scripts/follow-prs-e2e.mjs`.)
