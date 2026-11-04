# Streaming and transcript scroll: failure cases

- Switching between projects with cached older transcript pages queues a scroll event while the transcript is empty. It must not fetch older history, disable following, or leave the newest message out of view.
- Deliberately scrolling to the top must still fetch older history and preserve the visible message's position. Refreshes must preserve a paused reader's position.

## The inbox at `/` (classic inbox retired 2026-11-04)

`streaming-scroll-viewport-e2e.mjs` now drives the UI 2.0 client.

- R0 Switching between long projects does not show the newest messages, or loads older pages by itself.
- R0A/R4 Show earlier is missing on a long chat, sends more than one `chat-history` request, or jumps to the newest message.
- R1 A new exchange arriving while the owner reads older messages moves the text under them. (Red on the UI 2.0 client: `show`
  returns a sliding window of the newest turns, so the turn at the same scroll position changed from t106 to t110;
  artifacts/only-inbox/red-streaming-scroll-viewport.json. Fixed by keeping the first visible turn in place by its key.)
- R2 That re-render drops the owner's text selection. (Red: every render re-inserted all turns, detaching them. Fixed: only nodes
  that are out of order move.)
- R5S/R8S Sending from a scrolled-up position does not resume following.
- R8 The final rendered text differs from the host transcript.
- R9/R9S A chat switch does not show the newest message, or keeps the previous chat's messages.
- M1 At 390 px the composer leaves the screen, the page itself scrolls, or something overflows sideways.

Retired with the classic client: R3 (late media growth; its classic hook), R5's in-place history paging (Show earlier now opens at the
top of the loaded page), R6/R7 (classic paint cadence), R8L/R8T/R9D (classic live-selection hand-over).
Known, not fixed: after the window narrows to 390 px the feed is not re-pinned to the newest message.

R9 test defect (fixed 2026-11-04): the switch back clicked the first `#tree [data-chat="main"]`, which is the other project's Main when
the tree lists that project first (it orders by activity). It now clicks the selected project's Main; 4 of 4 runs pass (2 of 3 failed
before).
