# Follow intent at streaming completion: failure cases

`streaming-follow-intent-e2e.mjs`, in the inbox at `/` since the classic inbox was retired (2026-11-04).

- F1 Pinned at the bottom: completion, or a late layout change above (an image growing), leaves the newest text out of view.
- F2 The owner scrolls up a little (20 px, inside the "near the bottom" band) while a reply streams: the completion or a re-render
  pulls them back to the bottom. A deliberate upward wheel, key or touch stops following until they return to the bottom.
  (Red on the UI 2.0 client: it re-pinned anything within 40 px on scroll and 80 px on render;
  artifacts/only-inbox/red-streaming-follow-intent.json.)
- F3 A scroll the page itself makes (not the owner's input) must not stop following.
- F4 The finished message differs from what the host stored, or loses streamed paragraphs.

## Following in the Coordinator and worker transcripts (2026-11-11)

The owner's own input stops following: an upward wheel, touch or navigation key, a drag that starts on the transcript (its scrollbar
or a text selection), or opening a detail. Besides input, only a scroll that moves the view up past the 40 px band while the
transcript keeps its height on screen stops it (find in page, a link into the transcript); content growing never moves the view up. A scroll event that follows a layout change never does,
since the browser may deliver it after the layout already changed. Each transcript keeps its own following state.

- F5 A scroll event that arrives after the transcript changed size (the window narrows, a panel opens) stops following, so the
  stream stops at the old bottom. (Red: coordinator-workers-ui-e2e S1 failed 2 of 6 runs under load with `gap 882`; the trace showed
  the event of a programmatic pin dispatched after the 390 px resize, read as the owner leaving the bottom.) A transcript that
  changes size while following is not re-pinned to the newest line.
- F6 A drag up while a reply streams (the scrollbar, or a text selection past the top edge) is pulled back to the bottom by the next
  chunk. Headless Chrome on macOS has overlay scrollbars, so the test drags a selection.
- F7 Returning to the bottom (End, or scrolling down to the end) does not resume following.
- F8 Opening a detail (a tool group or summary line) jumps: the line moves away from the pointer, or the next chunk pulls the view to
  the bottom.
- F9 Going to a worker and back moves the Coordinator transcript: a reader at the bottom does not see what arrived while away, or a
  reader of earlier turns returns to another place. Opening a detail in the worker transcript stops the Coordinator's following.
- F10 The worker transcript does not follow its new turns at the bottom, pulls back a reader who scrolled up a little (inside the old
  40 px band), or does not resume after they return to the bottom.
- F12 A scroll the browser makes far up on the reader's behalf (find in page, `scrollIntoView`) is pulled back to the bottom by the
  next chunk. (Red on the first follower, which ignored every scroll event: the verify skill's ui2 drive timed out on "worker missing
  artifact note".)
- F11 A summary going from pending to ready moves the place of a reader who scrolled up with the wheel (tool-summaries-e2e D6).
- F13 A change of height inside the turn being read, above the line read (its thinking hidden, a summary arriving), moves that line:
  only the turn's top is kept. (Red in tool-summaries-e2e D6: the reply moved from 10 px to -22 px.)
