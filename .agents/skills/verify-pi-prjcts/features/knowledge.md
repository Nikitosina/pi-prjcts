# Memory

The owner reads and edits what agents remember about a project in Memory: Preferences, Decisions and Procedures from `memory-index`, stored under the project's `knowledge/` directory with revision history.

## Sub-features

- `starter`: a fresh project lists the starter preferences only.
- `read`: an entry opens rendered in the center with its path, revision and author.
- `edit`: Edit saves a new revision (`knowledge-write` with the current revision); history is kept.
- `agent-write`: a coordinator write shows as a "Remembered · Undo · Edit" row and reaches an open Memory view on the `knowledge` topic.

## How to get to it (user POV)

- Click Memory under the project in the tree (`#tree [data-memory-node]`), then an entry (`.mem-entry[data-memory]`).
- In the chat, a "Remembered" row's Edit link.

## Driving it with browser CDP

Preconditions: launch, doctor `ok: true`.

- Partly scripted: the `ui2` journey's `memory` step (see `ui2.md`) drives `VERIFY-MEMORY`, the rows, Undo and the Memory node. Editing an entry is a recipe: open an entry, click `[data-edit-memory]`, change `.mem-edit textarea` with `Input.insertText`, click Save; prove it with `rpc --run <scratch> knowledge-history`.

## Gotchas

- Updates need the current revision; a stale edit conflicts instead of overwriting.
- There is no "New document" form; new entries come from agents (or the Host agent).
- Retired with the classic inbox (2026-11-04): the Knowledge tab and its New document dialog.
