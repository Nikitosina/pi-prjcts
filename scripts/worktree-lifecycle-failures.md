# Worktree lifecycle: git merge/rebase, shared PR branches, PR-head reads, setup, cleanup (C2, C3, C4, C9, C11)

Written before implementation. E2E: `scripts/worktree-lifecycle-e2e.mjs`; guard matrix also in `scripts/worker-yolo-e2e.mjs`.

## C2 Git policy / shared project branches
- G1 `git merge-base`, `git merge-tree`, `git log … && git merge-base …` still blocked by a `merge\b` prefix match.
- G2 `git merge origin/main` (and conflict resolution + commit) still blocked.
- G3 `git rebase origin/main` works locally but the result cannot be published: `--force-with-lease` to the worker's own branch blocked.
- G4 `--force-with-lease` allowed to a non-project branch (main, the base branch, `feature/x`) or a bare `--force`/`-f`/`+ref` slips through once lease is allowed.
- G5 push to another thread's project branch (`HEAD:pi/durable-other`) still blocked, so a second thread must do a "transfer commit".
- G6 push to the default/base branch, `main`, `master`, branch delete (`:pi/x`, `--delete`), `--mirror`, `--all`, `--tags` becomes allowed.
- G7 an empty/short branch prefix ("" or no publication) widens pushes to every branch.
- G8 a blocked compound command gives no hint which segment was blocked; the message must name it (quoted safely, no shell injection through the echoed chunk).
- G9 `gh pr merge` / `gh api …/merge` becomes allowed.
- G10 YOLO text still says "After pushing, call open_draft_pr" unconditionally (C11g) or still forbids merge/rebase.
- G11 coordinator still told nothing about continuing an existing PR branch from another thread → transfer-commit threads.

## C3 Scouts/reviewers read the PR head
- R1 a top-level reviewer given a PR branch still reads the owner's checkout (stale content).
- R2 the ref is fetched with model-controlled text into a shell (injection) or outside the project home; refs like `--upload-pack=…`, `../x`, spaces must be refused.
- R3 two reviewers on the same head create two snapshots (no dedupe) or a second fetch races the first.
- R4 a child reviewer/scout of a worker reads the owner's checkout instead of its parent's worktree.
- R5 path escape from the snapshot root via `..`/absolute/symlink.
- R6 unknown ref fails silently (reviewer reads checkout) instead of refusing the delegation with a clear error.
- R7 reviewers without a ref lose their previous behaviour (project checkout).

## C11f Scout/reviewer with workspaceScopeId
- S1 a scout delegated with workspaceScopeId still fails; must run read-only (scope ignored, receipt says so).

## C4 Worktree setup command
- W1 setup command not run after a fresh worktree allocation, or run in the owner checkout.
- W2 rerun on every dispatch of the same thread (slow, side effects).
- W3 failure invisible: worker not told, owner cannot see it (Settings worktree list), exit code/output not recorded.
- W4 hangs forever (no timeout) or huge output kept unbounded.
- W5 setting not persisted / revision-checked, empty value not treated as "none", projects without it break.

## C9 Worktree cleanup
- K1 a worktree with uncommitted/untracked changes is removed.
- K2 a worktree with commits not on any remote (and no merged/closed PR) is removed.
- K3 a worktree whose thread is queued/running is removed.
- K4 a worktree with an open PR is removed (Follow-PRs fixes / follow-ups still need it).
- K5 gitignored dependencies (node_modules) make removal fail or count as dirty.
- K6 cleaned thread receives a follow-up and fails with an obscure allocation error instead of "start a worker on branch X".
- K7 reclaimable size missing/wrong; Settings has no manual action; kept reasons not shown.
- K8 automatic cleanup never runs, or runs while the project is paused/closing.
- K9 local branch deleted (commits lost) by cleanup.
- K10 read-head snapshots never removed.

## Misc
- M1 `attempt.toolNames` still `[]` for workers.
