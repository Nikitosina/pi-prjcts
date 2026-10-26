# Search a project

The user opens the search dialog and finds words from chats, worker threads, knowledge and uploads, then jumps to the hit.

## Sub-features

- `chat-hit` — a word said in a chat is listed with its chat and role.
- `empty` — an unknown word shows an empty result list.
- `jump` — Enter on a hit opens its location.

## How to get to it (user POV)

- Toolbar button `#search-button`.
- Cmd+K (macOS) or Ctrl+K.

## Driving it with browser CDP

Preconditions: launch, doctor `ok: true`, and one earlier message in Main containing a unique word. Run `drive message-coordinator` first and search for `VERIFY-PING`. Without that message, report failure `no chat history to search`.

- Recipe only, not scripted: click `#search-button`; in `#search-input` insert `VERIFY-PING`; rows appear in `#search-results .search-row` (`data-source="chat"`); press Enter on the first row. Empty case: insert `nonexistentwordzz`, expect no rows.

## Gotchas

- Search is indexed per project; results from other projects never appear.
- A query made only of stop words is refused with an explanation, not an empty list.
