# Archived report visibility

- A full `projects.agent-report` entry is retained but invisible in worker history.
- Reading a report by its text reference loses the omitted part of a bounded preview.
- A report appears as owner speech or has no usable recorded timestamp.
- A malformed report entry is treated as valid text, or a text reference reads another message slot.
- `projects_worker_read` or `projects_archive_read` with an explicit `limit` returns the whole page unbounded (100 entries of previews passed 120 KiB). It must stay within 16 KiB, and following `before` must still visit every entry exactly once (verified by `transcript-archive-unit.mjs`).
- An owner view (chat or worker history in the web app) shows a long message cut to its preview, or an agent read loses the bounded preview and returns whole messages.

Covered at the transcript reader's page/text interfaces in `transcript-archive-unit.mjs`; the live writer/reader path is checked in `durable-runtime-e2e.mjs`. Fixtures are private and contain no real host data.

# Retiring the old home

Projects carried over from the previous host still name a worktree folder inside the old home (the Archive folder) as their approved root. The stored value stays, because it is part of the authorization fingerprint; the host maps it to its own project folder. Removing the old home must not break those projects. Proof: `workspace-allocation-e2e.mjs` (H1, H2).

- H1 Adding a scope to a carried project's grant reads the old folder (`realpath` of the stored root) and fails once it is gone, or the re-grant rewrites the stored root and so changes the fingerprint.
- H2 A command profile checks its executable against the stored root on disk and fails once the old folder is gone, instead of against the folder the host uses.

