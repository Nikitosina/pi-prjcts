# Status dots: failure cases

The original list was referenced by `scripts/status-dots-e2e.mjs` but never committed; the cases below are the ones the script checks.

## The inbox at `/` (classic inbox retired 2026-11-04)
- D1 A chat's dot in `#tree` does not show working (pulsing), needs you, idle, or the unread mark for work that finished while the
  owner looked elsewhere.
- D2 A working or needs-you dot does not say its state in words (aria-label).
- D4 The working dot does not pulse.
- D5 Opening a chat does not clear its unread mark, or the mark comes back after leaving.
- S1 The open project's head does not show red when any chat needs the owner.
- S2 Another project's head is not drawn from the list summary; S2b it loses its working state while another project is open;
  S2c it keeps working after its work finished; S2d it does not turn red after a failed coordinator turn; S2e a paused project shows
  the working dot or nothing, so it cannot be told apart from an idle one (jobs-failures.md A8).
- V1 Choosing a worker in `#workers` does not open the worker view with title, Back, conversation and composer; V2 Back does not
  return to the chat.
- N1/N2 At 390 px the inbox or the worker view scrolls horizontally.

Retired with the classic layout: D3 (no number bubbles: the tree shows hotkey digits and a questions count on purpose), S3 (collapsed
sidebar avatar dot), W1 (compact Jobs tree row with a context ring), V1's Steer/Stop, artifacts and evidence panes, V2b (browser Back)
and V3 (`?worker=` deep link). The limits bar checks B1-B6 are covered for the status line by `scripts/ui2-limits-e2e.mjs`.
Known gaps: no worker deep link or history entry; the classic machine status (B2b) has no place in the new status line.
