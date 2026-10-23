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
13. The coordinator repeats implementation exploration before delegating, or coordinator/worker roles miss project preferences. The coordinator must delegate code exploration with the task; both roles must read preferences.md before implementation or review.
14. Quoted search operators are mistaken for shell pipelines and cause needless retries. A quoted grep alternation must remain readable while actual publication commands and file redirects stay blocked.
15. Coordinator Projects-specific instructions (everything except the objective, repository instructions, skill index and the MEMORY.md index) exceed 4000 characters. Measured before the change: 11123 characters, of which projects_vcs_shell and projects_vcs_operation notes were 2.4 KB.
16. Worker instructions exceed 2000 characters: a read-only scout measured 3643 and a whole-repository worker 6439 (task brief, repository instructions and skill index excluded). The budget is met by deleting facts the worker needs: its worktree path, branch and the owner-checkout warning must stay at the front; the push rule must stay; the artifacts folder and citation form must stay.
17. A budget is met by truncating repository instructions, the objective or the skill index. They are exempt from the count and must arrive whole.
18. The whole completion message (header, task echo, result, pointer, artifact summary, next-step text) exceeds 2000 characters for a coordinator report or a child report to its parent worker, or a cap leaves no room for the result.
19. Tool mechanics moved out of the standing text vanish: a coordinator can no longer learn from the tool description how to continue a branch (`fromThread`/`branch`), preview a VCS operation, or call an MCP tool.
