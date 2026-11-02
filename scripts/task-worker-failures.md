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
- Task helpers drop owner-configured worker instructions or immutable authority rules.
- Existing independent Job/PR/Approve behavior or static pinned readers regress.
