# Archived report visibility

- A full `projects.agent-report` entry is retained but invisible in worker history.
- Reading a report by its text reference loses the omitted part of a bounded preview.
- A report appears as owner speech or has no usable recorded timestamp.
- A malformed report entry is treated as valid text, or a text reference reads another message slot.
- `projects_worker_read` or `projects_archive_read` with an explicit `limit` returns the whole page unbounded (100 entries of previews passed 120 KiB). It must stay within 16 KiB, and following `before` must still visit every entry exactly once (verified by `transcript-archive-unit.mjs`).

Covered at the transcript reader's page/text interfaces in `transcript-archive-unit.mjs`; the live writer/reader path is checked in `durable-runtime-e2e.mjs`. Fixtures are private and contain no real host data.
