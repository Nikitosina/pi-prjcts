# Task worker workspace failures

These failure cases precede the task workspace implementation. Fix-specific red/green evidence stays outside the repository.

- Shared preparation attaches the wrong chat or falls back to an owner checkout.
- Borrowing allocates, resets, sets up, detaches or removes the chat's workspace.
- Shared workers lose prepared dirty files, dependencies or services.
- Concurrent shared writers or Coordinator mutations bypass the handoff before actual worker settlement.
- Isolated work starts at owner HEAD/trunk rather than the chosen commit, or copies uncommitted files implicitly.
- Retry or restart changes frozen selection, base, branch, grant or allocation identity.
- Stop, cancellation or cleanup releases another thread's processes, artifacts or provider lease.
- Revocation, archived chats, missing roots or unsupported providers silently fall back to another workspace.
- Ordinary helper return requires a PR/Ready report, publishes automatically, or becomes owner approval.
- Queued messages, empty output, provider failure or interrupted delivery become false completion.
- A dirty helper tree is presented as independently verified or a reviewer gains execution tools.
- A task helper cannot start its own reviewer or scout with `subagent`, or that child can spawn agents.
- Task helpers drop owner-configured worker instructions or immutable authority rules.
- Existing independent Job/PR/Approve behavior or static pinned readers regress.

## Task helpers never publish (2026-11-06)

A Coordinator told a task helper to push to the owner's PR branch, then to rebase it. The helper had no shell guard, so the push went through, and it ran `arc rebase --virtual` on its checked-out branch as a "dry run". These cases come first; the red/green evidence stays outside the repository.

- H1. A shared or isolated task helper runs `git push` (any form) or a `gh pr` write and it reaches the remote.
- H2. A helper's blocked command fails silently or without saying who publishes instead (the Coordinator).
- H3. Read-only git and gh commands, commits and local branches stop working for a helper.
- H4. A workspace plugin's own helper policy is ignored and the git default runs instead, or a plugin without one leaves helpers unguarded.
- H5. The independent worker guard or the Coordinator's own shell changes.
- H6. The Coordinator prompt lets it hand a push, rebase or PR update to a task helper, or routes a PR event to a helper instead of handling it itself or through an independent Job continuing the branch.
- H7. The Coordinator prompt gives no safe rebase path: no backup branch, no abort, or a "dry run" that does not exist.
