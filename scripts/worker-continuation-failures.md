# Failure modes: continue a branch/worktree from a new worker thread; coordinator reads worker diffs

Written before the code. E2E: scripts/worker-continuation-e2e.mjs (fake model, git project with a bare local origin). Provider plugins repeat the provider-specific cases in their own repository.

## fromThread (take over another thread's worktree)
1. New thread starts from trunk and silently loses the source's committed + uncommitted state: it MUST run in the source's worktree (same path, same branch, dirty file visible).
2. Source thread still queued/running/interrupted: two writers on one worktree. Reject with a clear error, admit no work, change no ownership.
3. Unknown source, non-worker source (scout/reviewer), source that never configured a worktree: reject (no fallback to trunk).
4. Source worktree already cleaned up: reject, point at `branch`.
5. Old thread keeps writing into the transferred worktree (follow-up, retry, resume): the old thread MUST be refused at admission and at environment preparation; no tool of the old thread may run.
6. Transfer applied but the new work then fails to admit (half state): marker and new thread are written in one transaction.
7. Cleanup/maintenance treats the worktree as the old (settled) thread's and removes it under the running new thread: busy-ness MUST follow the new owner; the same worktree is never listed twice.
8. Chain B -> C -> D: ownership resolves to the original allocation; B and C are both refused afterwards. Taking over an already transferred thread is rejected (names the current owner).
9. Follow PRs auto-fix routes to the old thread (receipt conversation) and fails: it must follow the transfer to the current owner.
10. workspaceScopeId passed that differs from the source's scope: reject. fromThread + branch, or with threadId/ref: reject. fromThread on scout/reviewer: reject.
11. Replay of the same delegation must not transfer twice (the transfer is inside the admit transaction).

## branch (continue an existing branch / PR)
12. New worker starts a fresh `pi/...` / task-named branch and opens a second PR: the worktree MUST be on the existing branch at its tip, branch name unchanged, so pushes update the PR.
13. Branch the owner does not own: git branch outside the project prefix or a protected branch (main/master/base); a branch another user owns, or a PR authored by someone else (provider plugins define their ownership rules). Reject at delegate time, create no worktree, run no fetch/worktree command.
14. Unresolvable branch / PR number: reject (never fall back to trunk).
15. Option-like or traversal refs (`--upload-pack=x`, `a..b`, `refs/heads/../x`): rejected before any command; shell metacharacters rejected.
16. Local branch already exists (git, kept after cleanup) at the tip: reuse it without `-b`; existing at a different commit: blocked with the git message, never reset.
17. Non-whole-repository scope: reject (fixed file ownership cannot move onto an existing branch).
18. A thread that already allocated its worktree is not re-pointed: the branch is frozen with the receipt (later dispatches reuse it).
19. Defaults: delegation without fromThread/branch behaves exactly as before (covered by durable-workspace regressions).
20. Provider plugins: a second publication on the continued branch must update the existing PR receipt (record the new conversation), not create another PR (plugin repository suites).

## coordinator diff tool (projects_worker_diff)
21. Coordinator cannot read a worker's change without artifact copy: tool returns branch, head, status list (staged/unstaged/untracked) and a capped diff.
22. Not coordinator-only / unknown thread / thread without worktree / cleaned-up worktree: clear error.
23. Diff floods context: capped at the code_diff cap (46 KB; harness clips at 50 KB) with truncation note.
24. Tool must stay read-only: no writes, no mutating VCS calls; thread id is a UUID (schema), never a path.
