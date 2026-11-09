# Workspace allocation: continuing a branch another worktree holds, and retrying a blocked start

Written before the fix of 2026-11-09 (live: Mari PR #236, a fresh worker could not continue the branch its idle predecessor still had checked out, and every resume replayed the same block). E2E: `scripts/workspace-allocation-e2e.mjs`.

## Branch held by a worker worktree of this host
- B1 a fresh worker continuing a branch that an ended worker's worktree in this project's worktrees folder still has checked out fails to start, even though that worktree is clean, idle and fully pushed.
- B2 the branch is freed by deleting the holder's worktree, so the previous worker's files, history and artifacts are gone and it cannot be brought back; it must only be moved off the branch (detached HEAD at the same commit).
- B3 the branch is taken from a holder whose worker is running (its Job is running or its conversation has a turn in progress), or that has a process in it, uncommitted or untracked files, or commits not on `origin/<branch>`.
- B4 a Coordinator's persistent workspace, or a worktree of this folder that belongs to no recorded worker, is moved off its branch.
- B5 the refusal does not say which worker holds the branch and why it was not freed.

## Refusal texts
- T1 a missing previous-host home is reported as "that folder or the old host's home is missing": the holder folder and the old home must be named separately.
- T2 a holder outside both this host's worktrees folder and the previous host's home is touched, or its refusal stops saying it is outside.

## Retry after a blocked start
- R1 a start blocked before any provider effect (no workspace path) is replayed from the stored receipt on every resume, after the cause is gone.
- R2 the retry adopts a receipt for a differing intent or scope, or re-runs an allocated, preserved, uncertain or released receipt.
- R3 the owner checkout moved between the blocked start and the resume: the retry keeps the old frozen scope (owner HEAD of the first attempt) and is blocked as "Git owner head drifted" forever. A blocked receipt with no workspace path froze nothing, so the resume computes a fresh scope and replaces it; any other state with a differing scope is still refused.
