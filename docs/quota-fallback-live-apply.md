# Live quota fallback for existing workers

This document is the authoritative source spec and acceptance criteria for PR 28. Every static reviewer and runtime verifier should read it in full.

## Source request

The owner said: "I want fallback model to be applied instantly even for existing workers."

The owner then answered a clarifying question: "Yes. Automatically recover quota-failed and quota-waiting workers when a fallback is saved."

## Required behavior

- Healthy work must not be interrupted by a fallback save.
- Manually paused or stopped workers and paused projects must not resume automatically.
- Role, instructions, tools, permissions, workspace, transcript and worktree are preserved across recovery.
- The current role fallback replaces any stale admission setting on existing threads, for follow-ups and retries.
- Legacy quota-failed records that have no `quotaFallback` field are supported.
- Changed or removed fallbacks, repeated or concurrent saves, and restarts are durable and idempotent.
- Fallback exhaustion must not loop rapidly.
- Verifier budgets and frozen authority are respected.
- No change is made to the owner's live project, settings or workers. All runtime testing is isolated.
- No merge or deployment is authorized.

## Acceptance criteria

1. Saving a role fallback applies to existing threads immediately for future eligible recovery and automatically recovers existing quota-failed and quota-waiting work, including legacy records. Regression tests and isolated runtime state prove the actual model transition and retained work.
2. Healthy attempts are not interrupted. Paused or stopped workers and paused projects are not automatically resumed. Unrelated failures and verifier budget and authority constraints are preserved, demonstrated by tests.
3. Changing or removing a fallback does not reuse stale frozen configuration. Repeated saves, concurrency, restart and fallback exhaustion do not duplicate attempts or create tight retry loops, demonstrated by targeted regression tests.
4. Role, instructions, tools, permissions, workspace and transcript or worktree continuity are preserved across recovery, with regression evidence and source explanation.
5. `npm run check`, affected tests and documented full suite results are reported honestly. Isolated browser save-to-recovery evidence includes inspected screenshots and read-only state and attempt traces. Fake-provider limitations are explicit.
6. A draft PR and exact candidate commit are provided with sanitized artifacts, and without mutations of the owner's live project, settings or workers. No merge or deployment.

## Source map

- `src/host-server.ts`: after a project settings save that changes `fallbackModels`, calls `recoverQuota()` on the running project.
- `src/durable-runtime.ts`: reads the current role fallback live from the project and exposes `recoverQuota`.
- `src/durable-planning.ts`: re-evaluates the model at dispatch and recovers quota-failed or quota-waiting threads that are eligible (not paused, stopped or in a paused project), under the schedule mutex so repeated saves do not duplicate attempts. Thread identity, frozen instructions, tools, scope and worktree are reused.

## Tests

Targeted scripts live in `scripts/worker-quota-*-e2e.mjs` and are listed in `scripts/e2e-manifest.json`. The isolated browser journey is `verify.mjs drive --run <scratch> quota-save-recovery` (see `.agents/skills/verify-pi-prjcts/features/quota-save-recovery.md`). The fake provider is not evidence of a real provider's quota behavior.
