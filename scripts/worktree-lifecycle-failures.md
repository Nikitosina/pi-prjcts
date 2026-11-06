# Worktree lifecycle: git merge/rebase, shared PR branches, pinned-commit reads, setup, cleanup (C2, C3, C4, C9, C11)

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
- G12 a shell redirection on a push (`git push origin HEAD:pi/x 2>&1`, seen live on 2026-11-06) is split at `&` and `2>` is read as a push target, so a legitimate push or `--force-with-lease` to a project branch is refused. Redirections are not arguments; a redirected push to `main` is still blocked.

## C3 Scouts/reviewers read a pinned commit
Since 2026-11-06 there are no shared read-head snapshots. `readRef` is an agent id or a full commit SHA. A SHA gets the reader its own
isolated worktree through the task-helper mechanism (no setup command), removed by cleanup once the reader ended.
- R1 a top-level reviewer given a full commit SHA still reads the owner's checkout instead of a worktree at that commit.
- R2 model-controlled ref text reaches git or a shell; anything but an agent id or a full lowercase SHA (`--upload-pack=…`, `../x`, branch names, `pull/1`) must be refused at spawn.
- R3 a reader's worktree outlives the reader: once it ended and the worktree is clean at its commit, cleanup removes it, even though that commit is on no remote.
- R4 a child reviewer/scout of a worker reads the owner's checkout instead of its parent's worktree.
- R5 path escape from the reader's worktree via `..`/absolute/symlink.
- R6 a branch or PR name is accepted without a pinned commit, or refused without saying to resolve it to a full SHA first.
- R7 reviewers without a ref lose their previous behaviour (project checkout).
- R8 a reader of another worker's worktree starts while that worktree has uncommitted changes, which may change under it.
- R9 the worker commits, moves HEAD or leaves uncommitted changes while a reader of its worktree reads; the reader's report then describes code that is no longer there. The commit is recorded when each reader message starts; when the report is filed, a moved HEAD or a dirty tree puts a first line on the report saying it is not valid for the current code, with both commits, so the Coordinator respawns the reader on the new SHA. A report of a reader whose target stayed put has no such line.

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
- K6 cleaned thread receives a follow-up and fails (obscure allocation error, or an instruction to re-delegate) although its kept branch holds everything: the host must revive the worktree at the same path on that branch with the same frozen binding.
- K11 a cleaned thread whose kept branch was deleted is revived onto a fresh branch (silently losing work) or fails with an obscure allocation error: it must fail with a blocker that says the branch no longer exists and to start a new worker, creating nothing.
- K7 reclaimable size missing/wrong; Settings has no manual action; kept reasons not shown.
- K8 automatic cleanup never runs, or runs while the project is paused/closing.
- K9 local branch deleted (commits lost) by cleanup.
- K10 a `read-heads/` snapshot left from before 2026-11-06 is never removed.

## Misc
- M1 `attempt.toolNames` still `[]` for workers.

## Classic inbox retired (2026-11-04)
The classic Settings worktree card (setup command field, worktree list, Clean up button, toast) is gone. The test now drives the same
calls over the host API: the revision-checked `settings-update` of `worktreeSetup` (W5), the `worktrees-snapshot` inventory
(K7: reclaimable space, removable and kept worktrees) and `worktrees-cleanup` (C9). The script no longer starts a browser.
Gap: the new client has no worktree view or cleanup control (Host agent or CLI).
