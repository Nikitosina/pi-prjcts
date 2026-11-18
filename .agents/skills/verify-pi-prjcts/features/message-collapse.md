# Long owner messages

A long message the owner sent is clamped to six lines with a fade and a "Show more ▾ · N chars" hint when the owner enters a chat. A click on the text, or Enter or Space on the hint, reveals it. A revealed message never collapses again and has no "Show less": it stays open through new replies, refreshes and clicks, until the owner navigates to another chat and comes back, or reloads the page. Short messages stay plain.

## Sub-features

- `clamp`: a message taller than eight lines gets `data-overflow="1"`, a visible `.msg-more` button and a clamped `.msg-body`. A shorter one has neither.
- `reveal`: a click on the text, or Enter or Space on the focused hint, sets `aria-expanded="true"`; the hint is hidden and keyboard focus moves to the `.msg-body`. Further clicks change nothing.
- `no-false-reveal`: a drag selection, a click on a link, button or image, and a click on a short message do not reveal. A double click on a collapsed message reveals it with the first click and selects the word.
- `refresh`: a revealed message stays revealed, in the same DOM node, when a new turn re-renders the feed or the same chat is selected again.
- `visit`: selecting another chat (the `select` event) clears the revealed set, so A → B → A starts collapsed; so does a page reload. Tool rows and groups open or close as before; only messages are one-way. A worker transcript (`w:<id>|` scope) and the Host agent drawer (`host|`) have their own reveal scope: opening one starts it collapsed.

## How to get to it (user POV)

- Send a long message (several paragraphs, or a ten-item list) in a chat, click it, then open another chat and come back.

## Driving it with browser CDP

Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> message-collapse`. It sends a short message, a five-paragraph message with a link and a ten-item list through the composer, then asserts every sub-feature with real pointer clicks, a real drag and double click, real key presses, a New chat round trip (A → B → A) and a reload. Screenshots `01-long-collapsed`, `02-long-revealed`, `03-list-collapsed`, `04-list-revealed`, `05-transcript-top` at 1440 px and `06` to `09` at 390 px. Not scripted: Brief messages in worker transcripts and the Host agent (same renderer, scoped keys, reset on open), a message with images.

## Gotchas

- The fake provider answers `VERIFY-LONG` with a long reply; do not put that word in these messages.
- Revealing is done in place (`aria-expanded`, the CSS reads it with `:has`), not by re-rendering, so selection, focus and scroll stay put. The open state stays out of the turn signature.
- A message without an `entryId` (not yet stored) renders plain and never clamps.
- Focusing a link the clamp hides (Tab, Shift+Tab) reveals the message.
- Reselecting the open chat is not a navigation (`select()` in `web/app.js` returns early), so it keeps revealed messages open.
