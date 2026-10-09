# Failure modes: scout/reviewer review targets (threadId, ref) and code_diff

Written before the code. E2E: scripts/review-target-e2e.mjs (fake model, fake arc, git project).

1. Reviewer delegated without a target silently reads trunk/owner checkout when the coordinator meant a worker's edits: instructions must name `threadId`; with it the root MUST be that worker's worktree (content of the unpushed edit visible).
2. Unknown threadId falls back to the project checkout: the delegate call must fail with a clear error and admit no work.
3. threadId of a thread with no worktree (never started, no workspace) or whose worktree was cleaned up falls back to trunk: must fail instead.
4. threadId + ref both given: ambiguous; reject.
5. threadId on a worker delegation: meaningless; reject (like ref).
6. threadId pointing at a non-UUID / injection string: schema rejects.
7. Ref that does not resolve (git and arc) must fail, never trunk (already covered by worktree-lifecycle / arc-heads-cleanup; re-checked here for git).
8. code_diff must not be a write path: no shell, ref arguments cannot be options (`--output=/x`, `--ext-diff`), base must not smuggle flags; no files written, no arc mutation (only diff/log/status/merge-base).
9. code_diff on huge diffs floods the context: capped at 46 KB (the harness clips any tool result at 50 KB) with a truncation note.
10. code_diff misses a worker's brand-new uncommitted file: untracked files are listed and their content included.
11. code_diff on a root without VCS or with an unresolvable base: clear error text, not a crash or empty "no changes".
12. code_diff base default wrong for the worktree: diff against merge-base with the default branch, so unrelated trunk movement is not shown as changes.
13. Default (no target) reviewer must still read project cwd and still get code_diff over its checkout.
14. Reviewer must not be able to write via the new root: code_* path guard still limits to the chosen root; no write/edit/bash tool bound.
15. Worker children (projects_delegate_child) still inherit the parent worktree.
