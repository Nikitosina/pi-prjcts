# Search

The owner presses ⌘K and finds chats, projects, commands and full-text hits from the selected project's chats, worker threads, knowledge and uploads in one list.

## Sub-features

- `chat-hit`: a word said in a chat is listed with its source (`.muted` hint on the row).
- `empty`: an unknown word shows "Nothing found".
- `jump`: not available yet. Choosing a full-text hit does nothing (`docs/classic-retirement.md`, gaps); report it as unverified.

## How to get to it (user POV)

- Top bar "Search" (`[data-cmd="palette"]`), or Cmd+K (macOS) / Ctrl+K.

## Driving it with browser CDP

Preconditions: launch, doctor `ok: true`, and one earlier message in Main containing a unique word. Run `drive message-coordinator` first and search for `VERIFY-PING`. Without that message, report failure `no chat history to search`.

- Recipe only, not scripted: open the palette, insert `VERIFY-PING` into `#palette[open] input`; rows appear as `#palette li[data-index]`. Empty case: insert `nonexistentwordzz`, expect "Nothing found". `scripts/search-ui-e2e.mjs` scripts the same checks.

## Gotchas

- Search is indexed per project; results from other projects never appear.
- A query made only of stop words is refused with an explanation, not an empty list.
