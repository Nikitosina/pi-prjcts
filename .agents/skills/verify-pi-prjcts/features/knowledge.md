# Knowledge topics

The user creates and reads a Markdown knowledge document from the Knowledge tab; the host stores it under the project's `knowledge/` directory.

## Sub-features

- `create-topic` — "Create a topic" saves a new document.
- `read` — the document opens rendered, with its revision.
- `starter` — a fresh project lists `MEMORY.md` and `preferences.md` only.

## How to get to it (user POV)

- Tab "Knowledge", then "Create a topic" or "Read/edit document".
- The Knowledge card on the Coordinator tab, "Open →".

## Driving it with browser CDP

Preconditions: launch, doctor `ok: true`.

- Recipe only, not scripted: click `[data-tab=knowledge]`, click `[data-action=knowledge-new]`, fill the path and text fields in the dialog, save. Proof: dialog shows the new path; `rpc knowledge-list` (read-only) lists it; the file exists (`find <scratch>/home -path "*knowledge*" -name "<topic>.md"`) before cleanup. Copy that file into the evidence dir before cleanup, because cleanup removes the scratch dir.

## Gotchas

- Updates need the current revision; a new topic uses `expectedRevision: null`, so creating an existing path conflicts.
- The new topic is not added to `MEMORY.md` automatically.
