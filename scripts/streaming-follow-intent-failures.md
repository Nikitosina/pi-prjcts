# Follow intent at streaming completion: failure cases

`streaming-follow-intent-e2e.mjs`, in the inbox at `/` since the classic inbox was retired (2026-11-04).

- F1 Pinned at the bottom: completion, or a late layout change above (an image growing), leaves the newest text out of view.
- F2 The owner scrolls up a little (20 px, inside the "near the bottom" band) while a reply streams: the completion or a re-render
  pulls them back to the bottom. A deliberate upward wheel, key or touch stops following until they return to the bottom.
  (Red on the UI 2.0 client: it re-pinned anything within 40 px on scroll and 80 px on render;
  artifacts/only-inbox/red-streaming-follow-intent.json.)
- F3 A scroll the page itself makes (not the owner's input) must not stop following.
- F4 The finished message differs from what the host stored, or loses streamed paragraphs.
