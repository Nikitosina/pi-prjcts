# Quota recovery: failure modes

Covered by `scripts/worker-quota-recovery-e2e.mjs`. The inventory lists the cases it asserts now, with the live-apply cases marked.

## Configured fallback and context
- The fallback completes the same work on the same thread, with an explicit recorded transition, and does not duplicate execution.
- Conversation history, the worktree file and an already completed primary tool result survive the fallback, and the side effect is not repeated.
- An already queued follow-up on the thread shares the audited fallback model.
- A fallback that is unavailable is rejected without changing other settings, and fallbacks stay independent per role.

## Waiting without a fallback
- Work waits on its frozen model with a visible retry status, and completes after reset without any fallback.
- A dependent work item stays queued until its quota-waiting predecessor recovers.
- A manual retry wakes the same waiting work without a duplicate.

## Added for live apply
- Saving a fallback recovers an existing quota wait on its original thread, without creating work.
- Saving a fallback does not resume a manually paused worker, and a worker pause, a stop and a project pause survive saves, timers, host restart and explicit project resume.
- An explicit resume of a healthy worker keeps its primary model.
- A saved fallback recovers a previously quota-failed thread without a duplicate record.
- Fallback exhaustion and unknown-reset waits both stop after eight retries and stay terminal under repeated sweeps.

## Notes
The script runs with a 1500 ms retry base and cap (`PI_PROJECTS_QUOTA_RETRY_MAX_MS`) so the wait window is longer than polling latency. The "must not resume" waits are 2000 ms.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
