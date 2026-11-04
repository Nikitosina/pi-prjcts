
## The inbox at `/` (classic inbox retired 2026-11-04)
Found while porting (written before the fix): in the worker view a tool call the worker is still running shows a ✓ (done), because
the row's status falls back to the coordinator's live state (`state.live`), not the worker's. While the coordinator streams, the
reverse happens: a worker's finished-turn call without a result shows a spinner. C2 now requires the unfinished call of the worker's
running turn to show as running.

Kept on the new client: C14, C7, C2, C3 (task above, composer below), C4 (draft survives live refreshes), C1 (ok and failed rows expand
to their result), C15/C17 (reports carry internal origin and never render as the owner's message), C6, C5 (Back stays closed) and C8
(latest turns with older history above, 390 px). Retired with the classic client: C9 (the new client shows tool rows and thoughts on
purpose), C10-C13/C16 (classic renderer module checks), C18 (checkpoint pane injected through classic modules) and tool icon colours.

### C6 under load: Enter right after opening a worker did nothing (found 2026-11-04)
The worker view rendered its composer at once but attached the Enter and submit handlers only after `thread-history` returned. On a
busy machine the owner could type and press Enter in that window and nothing was sent. Red: 3 of 6 parallel runs timed out on
"follow-up" (`artifacts/only-inbox/red-worker-chat-ui-send-before-load.log`). Fix: `renderWorker` binds the composer before the first
load. Green: 6 of 6 parallel runs (`artifacts/only-inbox/green-worker-chat-ui-send-before-load.log`).
