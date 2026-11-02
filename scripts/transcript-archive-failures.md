# Archived report visibility

- A full `projects.agent-report` entry is retained but invisible in worker history.
- Reading a report by its text reference loses the omitted part of a bounded preview.
- A report appears as owner speech or has no usable recorded timestamp.
- A malformed report entry is treated as valid text, or a text reference reads another message slot.

Covered at the transcript reader's page/text interfaces in `transcript-archive-unit.mjs`; the live writer/reader path is checked in `durable-runtime-e2e.mjs`. Fixtures are private and contain no real host data.
