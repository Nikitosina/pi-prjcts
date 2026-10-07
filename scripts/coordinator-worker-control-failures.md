# Coordinator worker control failure cases

Record before implementation. Verify through an isolated real host, Durable dispatcher, HTTP API and local fake model. Do not touch existing projects or use a real model.

- Existing coordinator conversations retain only old tools after reopening.
- Model-visible tools are absent, registered but not offered, or accidentally offered to workers.
- List hides queued/blocked workers, leaks another project's identities, or returns unbounded prompts/history.
- Read accepts unknown or foreign thread UUIDs; read fails to show worker messages and tool calls.
- Valid per-field read limits fail a hidden combined response budget: 100 × 16000, 50 × 7000, limit=100 with default text, or textLimit=16000 with default count.
- Clamped pages hide their effective limits, exceed the text allowance, or skip/duplicate messages when following nextOffset.
- Harness default 32 KiB tool-output truncation cuts valid large JSON and drops continuation metadata even when the page fits its character allowance.
- Text continuation skips Unicode characters; near-end/beyond-end pages return invalid cursors; genuinely invalid limits stop being rejected.
- Follow-up duplicates work on retry or ignores frozen role/scope/model.
- Pause aborts the coordinator, pauses unrelated workers, loses queued follow-ups, or starts paused work.
- Paused worker restart forgets its pause; project resume silently resumes individually paused workers.
- Resume starts before abort drain completes, reuses an aborted submission ID, or lets same-priority follow-ups overtake earlier work.
- Steering replaces queued/running work but later resurrects superseded paused work.
- Stopping a queued worker still lets it execute; stopping a paused worker leaves work resumable.
- A stopped attempt's late settlement overwrites replacement work or reports a stale completion.
- Retry mutates original terminal work, duplicates its request ID, or expands frozen permissions.
- Priority changes start running/terminal work again, or fail to order queued work.
- Parallelism changes do not persist across reopen, or lowering cap aborts active work.
- Batch plan ignores dependencies, admits cycles, or invents unavailable workspace/tools.
- Inspection is mistaken for independently verified evidence; worker content changes coordinator policy.
- Project pause still allows admission or coordinator controls to dispatch models.

Run `env -u PI_PACKAGE_DIR node scripts/coordinator-worker-control-e2e.mjs` from projects-mvp. Retained `artifacts/coordinator-worker-control-*/result.json` contains checks, tool responses and model-call trace; `host.log` contains the owned host log.
