# Long owner messages

A long message the owner sent is clamped to six lines with a fade and a "Show more ▾ · N chars" hint. A click on the message, or Enter or Space on the hint, opens it; the same again closes it. Short messages stay plain.

## Sub-features

- `clamp`: a message taller than eight lines gets `data-overflow="1"`, a visible `.msg-more` button and a clamped `.msg-body`. A shorter one has neither.
- `toggle`: a click on the text, or Enter or Space on the focused hint, flips `aria-expanded` and the `open` class. Focus stays on the hint.
- `no-false-toggle`: a drag selection, a double click on a word (open or collapsed), a click on a link, button or image, and a click on a short message do not toggle.
- `refresh`: an open message stays open when a new turn re-renders the feed. Opening state is cleared when another chat is selected.

## How to get to it (user POV)

- Send a long message (several paragraphs, or a ten-item list) in a chat, then click it.

## Driving it with browser CDP

Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> message-collapse`. It sends a short message, a five-paragraph message with a link and a ten-item list through the composer, then asserts every sub-feature with real pointer clicks, a real drag and double click, and real key presses. Screenshots `01-long-collapsed`, `02-long-expanded`, `03-list-collapsed`, `04-list-expanded`, `05-transcript-top` at 1440 px and `06` to `09` at 390 px. Not scripted: Brief messages in worker transcripts and the Host agent (same renderer), a message with images.

## Gotchas

- The fake provider answers `VERIFY-LONG` with a long reply; do not put that word in these messages.
- Opening is done in place (`aria-expanded`, the CSS reads it with `:has`), not by re-rendering, so selection, focus and scroll stay put.
- A message without an `entryId` (not yet stored) renders plain and never clamps.
- A click on the text of an open message collapses it after 300 ms, so a double click can select a word instead; the hint collapses at once.
