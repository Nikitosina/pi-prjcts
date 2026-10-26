# Message the coordinator

The user types in the Coordinator tab's composer, sends, and sees their message and the coordinator's reply in the Main chat. The turn is stored by the host.

## Sub-features

- `send` — Send button posts the draft and clears the composer.
- `reply` — the coordinator's streamed reply lands in `#messages`.
- `persist` — both turns survive reload and appear in the host's `show` view.
- `shortcut` — Enter in the composer sends; Shift+Enter inserts a newline.

## How to get to it (user POV)

- Open the project, Coordinator tab, type in "Message the coordinator…", click "Send ↵".
- Press Enter in the composer.
- Press `/` outside a text field to focus the composer (per README).

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, project `Verify seed` exists (seeded).

- `send` + `reply` + `persist`, scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> message-coordinator`. It opens `webUrl`, waits for `#title` to read `Verify seed`, pointer-clicks `textarea[aria-label="Message coordinator"]` (hit-tested, `Input.dispatchMouseEvent`), inserts `VERIFY-PING <run id>` with `Input.insertText`, pointer-clicks `#compose button[type=submit]`. Asserts: exactly one `#messages article.msg.you` bubble with the prompt, the composer is empty, exactly one `article.msg.them` bubble `VERIFY-FAKE-REPLY: VERIFY-PING <run id>`, both bubbles again after `Page.reload`, the host's `show` lists both turns, `model-requests.jsonl` has the prompt. Screenshots `01-before-send`, `02-typed`, `03-reply`, `04-after-reload` land in the drive's own folder.
- `shortcut` — Enter in the composer sends; Shift+Enter inserts a newline.

## How to get to it (user POV)

- Open the project, Coordinator tab, type in "Message the coordinator…", click "Send ↵".
- Press Enter in the composer.
- Press `/` outside a text field to focus the composer (per README).

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, project `Verify seed` exists (seeded).

- `send` + `reply` + `persist`, scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> message-coordinator`. It opens `webUrl`, waits for `#title` to read `Verify seed`, focuses `textarea[aria-label="Message coordinator"]`, inserts `VERIFY-PING <run id>` with `Input.insertText`, clicks `#compose button[type=submit]`. Proof: `#messages` contains `VERIFY-FAKE-REPLY: VERIFY-PING <run id>`, `host-show-messages.json` lists both turns, `model-requests.jsonl` has the prompt, screenshots `01-before-send`, `02-typed`, `03-reply`.
- `shortcut`, manual recipe: same setup, but dispatch `Input.dispatchKeyEvent` Enter instead of the click; expect the same reply. Not scripted.

## Gotchas

- The reply is the fake provider's echo. It proves the host-to-model seam and the UI wiring, not real model behavior, prompts, or tool use.
- The turn needs `PI_OFFLINE=1` and the pinned `fake/fake-model`; a project created without pinning tries a real provider and hangs or errors.
- The sign-in dialog (`#sign-in`) appears if the page is opened without the `#token=` fragment.
