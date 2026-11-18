# Reviewer re-check failures (PR #60 repair)

These cases come from the independent review of PR #60 and precede the repair. `reviewer-recheck-e2e.mjs` drives them in a private host with a fake model: the reviewer is a real child whose own `code_read` tool reads the worker's real worktree.

- X1 A reviewer started by a worker (full or re-check) reads a checkout the host never confirmed: the host confirms the worker's `cwd`, but the child may read another directory (a missing `cwd` or a missing worktree falls back to the project checkout).
- X2 A missing or unreadable worktree is reviewed anyway, or the reviewer's code tools read the owner checkout instead.
- X3 A plugin checkout is confirmed by the VCS provider's guess instead of the worker's own task attachment; an attachment without `confirmRevision`, or one that throws, still lets the review start.
- X4 A thrown confirmation (provider crash) fails the call open or leaves the Job with a spent review.
- X5 The confirmed commit is recomputed on a replayed call, so a restart after admission refuses a call the host already admitted, or sends the reviewer a different commit than the one recorded.
- X6 A re-check that fails leaves its reviewer stranded: the failed turn counts as the last read and no later re-check can continue, although its budget was given back.
- X7 A failed re-check gives back the full review too, or a refused one spends budget.
- X8 The re-check turn does not show the content of the new commit: the reviewer answers from the earlier files, or its answer is accepted without any fact read from the disk.
- X9 Owner-visible start confirmation becomes a lock on the worker's checkout for the whole review.
- X10 A standalone full review (coordinator-started reader on a commit) or a Job's ownership and permissions change.
- X11 A given-back failed re-check reopens the full round (a second full reviewer is admitted after the only re-check failed).
- X12 A shared helper of a plugin checkout, which borrows the chat's attachment and has no task attachment, is confirmed by a generic provider status instead of being refused; a task checkout is confirmed without the ownership check its own tools pass.
- X13 A call admitted before a restart sends its first turn to a checkout that has moved off the pinned commit.
- X14 A job subagent with an empty `cwd` reads the project checkout through its code tools.
