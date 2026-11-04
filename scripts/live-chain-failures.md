# Live chain, knowledge tree, rail order: failure cases

Found with real coordinators (`gpt-5.6-sol` on the owner's live project, `gpt-6-luna` on `pi-prjcts`): during a multi-step turn the streamed text vanished when the coordinator moved on to tools, nothing showed it was still working, and the final answer appeared later on its own. `scripts/live-chain-e2e.mjs` checks these with a fake model.

## Live chain (coordinator transcript)
1. Text streamed before a tool call disappears when the tool round starts, before the transcript shows it. Committed steps must stay visible for the rest of the turn.
2. The live bubble is hidden while the transcript refresh is still in flight. This happens when a poll is already running and the refresh after a commit is only queued.
3. Nothing shows the coordinator is still working between steps (thinking, tools) or after the owner scrolls up. A working indicator must be visible for the whole run.
4. A model that thinks instead of writing preamble text (`gpt-5.6-sol`) leaves no trace of the step. Reasoning summaries must show live, and as a quiet "thought" line in the transcript.
5. A long turn (more than 30 tool rows) pushes the owner's own message and the first steps out of the transcript, because the host returns only the last 30 rows and empty assistant rows count against that.
6. The live status shows raw tool names (`projects_knowledge_list`) instead of human labels.

## Knowledge tree
7. Nested paths (`decisions/x.md`, `research/legacy/<id>.md`) show as a flat list of full paths instead of a folder tree.
8. Folders cannot be collapsed. Noisy `research/legacy/` is expanded by default.
9. The rail Knowledge card is not a tree, or its file rows do not open the document.
10. Long file names overflow the rail card horizontally instead of truncating.

## Rail order
11. Recent results comes before Knowledge. Knowledge must come first.

## Regressions to keep
12. ui-polish, coordinator-live, coordinator-workers-ui, workers-card-ui, worker-chat-ui and projects-chat-md keep passing.

## The inbox at `/` (classic inbox retired 2026-11-04)
The chain is sampled from `#feed` turns, `#live-turn` and the status bar's activity item, which stays visible while the reader
scrolls up (LC3; the classic floating working pill is retired). LC4 thoughts are collapsed Thinking lines with a preview; LC7 checks
the order of message, thought, text, tool row, thought, text, tool row and answer inside the turn. KT4 opens the decision from the
Memory node. Retired with the classic layout: O1 and KT1-KT3 (rail Knowledge card and the Knowledge tab folder tree; the new Memory
groups entries by kind instead) and LC6 (the new client shows tool names on purpose).

## Load failures on the inbox at `/` (found 2026-11-04, full suite and parallel runs)
13. LC1/LC2: at a tool-round commit the live turn drops the step text and shows only "Working…" for 50–100 ms before the refreshed
    transcript shows that step (`STEP-ONE vanished mid-turn`, `STEP-TWO vanished mid-turn`). Red: 5 of 6 staggered parallel runs.
    The live content must stay until the transcript that contains it has rendered, without showing the step twice.
14. LC3: the status bar's activity item reads `idle` for one 50 ms sample in the middle of the run (`No working indicator in 1
    samples`). Red: 3 of 6 staggered parallel runs. Activity must follow the run until it really ends.

Fixed (`web/chat.js` `held`, `web/statusline.js`): when a frame commits a step or ends the run, its last live text and thinking
stay in `#live-turn` until a transcript read that started after that frame (or that already contains the step) renders, and
activity keeps `writing`/`thinking` for that moment instead of `idle`. A commit frame itself still leaves the live turn as drawn
so `renderFeed` keeps the reader's place (streaming-follow-intent `near-bottom-up`). Green: 12 of 12 parallel runs
(`artifacts/only-inbox/{red,green}-live-chain-parallel.log`).
