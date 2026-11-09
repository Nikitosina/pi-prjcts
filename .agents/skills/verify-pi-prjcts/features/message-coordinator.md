# Message the coordinator

The owner types in the composer of a project's Main chat, sends, and sees their message and the coordinator's reply in the feed. The host stores the turn.

## Sub-features

- `send`: Enter posts the draft and clears the composer.
- `reply`: the coordinator's streamed reply lands in `#feed` as an agent message.
- `persist`: both turns survive a reload and appear in the host's `show` view.
- `long`: a reply longer than the agent preview (4000 characters) is shown whole, with no "shortened" note.
- `shortcut`: Shift+Enter inserts a newline; `/` outside a text field focuses the composer.

## How to get to it (user POV)

- Open the inbox, select the project's Main chat in the tree, type in "Message the coordinator…" (❯) and press Enter, or click the send button.

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, project `Verify seed` exists (seeded).

- `send` + `reply` + `persist` + `long`, scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> message-coordinator`. It opens `webUrl` (the inbox at `/`), waits for `body[data-ready="1"]` with `Verify seed` and Main in `#tree`, pointer-clicks `#composer textarea`, inserts `VERIFY-PING <run id>` with `Input.insertText` and presses Enter. Asserts: exactly one `#feed .msg.owner` with the prompt, the composer is empty, exactly one `#feed .msg.agent` with `VERIFY-FAKE-REPLY: VERIFY-PING <run id>`, both again after `Page.reload`, the host's `show` lists both turns, `model-requests.jsonl` has the prompt. Then it sends `VERIFY-LONG` and asserts the agent bubble holds both `VERIFY-LONG-START` and `VERIFY-LONG-END`, live and after a reload, and the feed never says "shortened". Screenshots `01-before-send`, `02-typed`, `03-reply`, `04-after-reload`, `05-long-reply-end`.
- `shortcut`, manual recipe: Shift+Enter in `#composer-input` adds a line and sends nothing. Not scripted.

## Gotchas

- The reply is the fake provider's echo. It proves the host-to-model seam and the UI wiring, not real model behavior, prompts or tool use.
- The turn needs `PI_OFFLINE=1` and the pinned `fake/fake-model`; a project created without pinning tries a real provider and hangs or errors.
- Opened without the `#token=` fragment (and nothing stored), the page shows the sign-in dialog (`#signin`).
