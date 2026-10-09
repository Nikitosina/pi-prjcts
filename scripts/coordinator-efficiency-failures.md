# Coordinator efficiency (run-to-done briefs, capped reports): failure modes

Written before code. Covered by `scripts/coordinator-efficiency-e2e.mjs`.

1. Long (20 KB) worker result still injected in full into the coordinator turn -> context bloat. Must be capped (~3 KB) with "… N chars omitted" and a pointer to `projects_work_result`.
2. Cap silently drops the tail with no pointer, or the pointer names a tool the coordinator does not have.
3. Cap also truncates the stored report/result, so the full text is lost. Stored result must stay complete (up to the existing 16000-char attempt cap) and be exactly retrievable.
4. Short reports (under the cap) are altered, get a pointer, or lose text.
5. `projects_work_result` pages wrongly: overlap/gap between pages, offset past end errors, last page lacks nextOffset=null, concatenated pages differ from the original.
6. Unknown / foreign / non-UUID workId reads something (other project, other thread) or leaks internals; work without a result (queued/running) returns garbage instead of a clear "no result yet".
7. Result tool callable by a worker/scout/reviewer to read arbitrary work. Coordinator tool only on the coordinator; the parent-worker variant only reads that parent's own children.
8. Child reports to a parent worker are not capped (same rule) or the parent has no way to read the full child result.
9. Cap breaks the failed/blocker path (failed work reports blocker text, not result) or the multi-byte/surrogate boundary (cut inside an emoji -> lone surrogate).
10. Coordinator instructions lack the brief guidance (Goal / Acceptance criteria / Constraints / Stop conditions, no micro-milestones, follow-ups only for owner corrections/new info/failed acceptance), or worker instructions lack run-to-done / blocker-report guidance. Existing worktree-lifecycle assertions on coordinator text must stay in sync.
11. `acceptance` (optional string[]) on projects_delegate: not appended to the brief, appended when empty/absent, or rejects valid input; oversized lists blow the task cap.
12. Restart/replay: report text is persisted at settle time, so a restart must not re-cap or duplicate a report (R7 in durable-worker-report regression).
