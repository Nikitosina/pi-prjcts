# Coordinator knowledge write failure cases

Record before implementation. Verify through an isolated real host, Durable dispatcher, HTTP API and local fake model. Do not touch existing projects or use a real model.

- Read-only (unset or explicit) project still offers the coordinator only list/read/history/notes; `projects_knowledge_write` and `projects_note` are missing.
- Write/note tools are offered to the coordinator but the read-only `beforeTool` hook still blocks them.
- Coordinator write skips revision checks: a stale `expectedRevision` overwrites the document.
- Coordinator write lands outside the project's knowledge tree, or not under the requested path.
- Coordinator instructions keep saying it may only inspect knowledge, so the model asks the owner for a grant.
- Read-only project leaks write/note tools to workers, or the worker hook stops blocking them.
- Retained pre-change coordinator (stored agent lists only read tools) does not gain write/note on reopen.
- Maintain project regresses: workers lose write/note.
- Switching settings maintain → read-only also removes coordinator write.
