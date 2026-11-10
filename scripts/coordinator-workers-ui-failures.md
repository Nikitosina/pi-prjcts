
## The inbox at `/` (classic inbox retired 2026-11-04)
A1/A2 read the chat's Workers list (`#workers`); dismissal is the `thread-dismiss` call (the classic row's Dismiss button is retired,
gap: the new client cannot dismiss an ended Job) and the list drops the Job by push. S1-S4 run on `#feed` and `#live-turn`; S3
re-pins by scrolling back to the bottom (no Jump to latest button in the new client).

## Active workers on top, ended ones in a collapsed history, context rings (2026-11-09)
H1 Ended workers (completed, failed, stopped, checkpoint, ready, approved) keep piling up as full cards under the running ones.
They must sit in one history list, collapsed by default, with its count visible on the toggle.
H2 The collapsed toggle hides why history matters: it must still say how many ended workers failed, need the owner (checkpoint,
No report, Ready with gaps) or are Ready, without drawing their cards.
H3 Expanding the history is lost on the next jobs push or a page reload, or leaks into another chat. It must stay open across both
within the same chat, and a different chat starts collapsed.
H4 A running agent whose Job record still says an ended status (the record lags the live `working` flag) is hidden in the history.
Anything `working` stays on top.
H5 Collapsing deletes or dismisses: the records, transcripts and Open/Approve controls must survive inside the expanded history.
C1 The context ring invents a number: it must come from `worker-contexts` (tokens over window), the same value the host returns.
C2 An unknown context (null entry, null or zero window) is drawn as 0 %. It must read as unknown, not zero.
C3 Context reads are unbounded: one request per jobs push, per worker, or more than 40 ids, or a transcript read just for the ring.
They must be batched (one request for the visible active workers, at most 40 ids) and throttled.
C4 A late `worker-contexts` answer from a previous chat or an older request paints over a newer one. It must be dropped.
C5 Ended workers in the history carry a ring. Only active workers get one.
