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

- Recipe only, not scripted: pointer-click `button[data-tab=knowledge]`, then `button[data-action=knowledge-new]` ("＋ New document"). In the dialog fill `input[name=path]` with a folder path such as `research/verify-topic.md` and click "Continue". In the editor (`form[data-knowledge-write]`) insert text into `textarea[name=text]` and click "Save". Proof: the new path appears in `#knowledge-inline`; `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> knowledge-list` lists it; `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> knowledge-read '{"path":"research/verify-topic.md"}'` returns the text. Copy the file from `<scratch>/home` into the evidence dir before cleanup (found with `find <scratch>/home -path "*knowledge*" -name "verify-topic.md"`), because cleanup removes scratch.

## Gotchas

- Updates need the current revision; a new topic uses `expectedRevision: null`, so creating an existing path conflicts.
- The path must start with a folder (architecture/, research/, decisions/, runbooks/ or plans/); a bare file name is refused.
- The new topic is not added to `MEMORY.md` automatically.
