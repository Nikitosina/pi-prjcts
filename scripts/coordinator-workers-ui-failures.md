# Inline streaming, read-only scout/reviewer, worker archive: failure cases

Record before implementation. Verify through an isolated real host, Durable dispatcher, browser UI and a local fake model. Never touch existing projects or use a real model.

Observed on Mari (2026-10-06):
- The live bubble streamed below the chat scroll, separated from the transcript.
- Scouts failed with "Workspace scope binding is permitted only for worker role", and unscoped scouts or reviewers had no way to read code.
- The coordinator had no tool to archive finished workers, so the Workers panel filled with completed and failed work.

## Inline streaming
- The live bubble renders outside the transcript scroll container.
- A transcript refresh (innerHTML replace) wipes the live bubble mid-stream.
- New chunks don't scroll to the bottom while the user is at the bottom.
- New chunks yank the view down after the user scrolled up to read history.
- Auto-scroll never resumes after the user scrolls back to the bottom.

## Scout/reviewer code access
- An unscoped scout or reviewer has no tool to read, grep, find or list project files.
- A scout or reviewer gets write, edit, bash or push tools.
- Read-only tools escape the project checkout (absolute or `..` paths outside cwd).
- Worker role gains the read-only code tools or loses its existing tools.
- A scoped scout or reviewer still allocates a writable worktree instead of being rejected with guidance.

## Worker archive
- Completed work stays in the Workers panel.
- Failed or stopped work disappears before anyone archives it.
- The coordinator has no tool to archive terminal work.
- Archiving accepts running, queued or interrupted work, or unknown IDs.
- Archiving deletes history: the thread conversation, report or work record is gone.
- Archived work still shows in Activity without the "Show archived" toggle, or never shows with it on.
- The owner has no UI action to archive a failed item.
