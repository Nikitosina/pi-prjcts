# Workspace allocation failure modes

- A continued branch held by an ended same-host worker is blocked when the archive home is absent.
- Recovery deletes ignored evidence or dependencies instead of detaching the old worktree, or deletes the branch ref.
- Recovery touches a live or suspended owner, an undismissed checkpoint, an unknown owner, a foreign lock or a mismatched receipt.
- Recovery touches tracked or untracked changes, or a worktree with a process whose cwd is inside it.
- A refusal fails to name the holder path and specific reason.
- A missing archive home masks a current-root holder; previous-host clean/pushed checks regress.
