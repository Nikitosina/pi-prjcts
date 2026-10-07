# Coordinator live streaming and knowledge visibility failure cases

Record before implementation. Verify through an isolated real host, browser UI and a local fake model that streams slowly. Never touch existing projects or use a real model.

Observed on Mari (2026-10-06): the composer showed nothing while the coordinator worked, sometimes for minutes. The coordinator wrote three knowledge docs, but the "Project memory" card said "No shared notes yet." and the Knowledge tab showed only tiles.

## Streaming (SSE)
- No visible activity while the coordinator waits for the first token.
- Partial answer text is not shown until the whole turn commits.
- Running tool calls are not shown while they run.
- A model retry with backoff is not shown, so the coordinator looks hung.
- The live bubble stays after the turn finishes, or duplicates the final message.
- The final message doesn't appear until the next 2 s poll after the stream ends.
- `/live` accepts a request without the bearer token, or for an unknown project.
- The stream for one project leaks into another after switching projects.
- A dropped stream (runtime closed, network) never reconnects.
- Live frames include unbounded text (megabytes per frame).
- A closed browser tab leaves a subscription in the host.

## Knowledge visibility
- "Project memory" shows only the latest shared note, not the knowledge docs.
- Knowledge docs appear only inside a dialog, not inline on the Knowledge tab.
- Docs written by the coordinator don't appear until a page reload.
- Clicking a listed doc doesn't open it.
