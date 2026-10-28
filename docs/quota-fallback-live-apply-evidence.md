# Evidence map for live quota fallback (PR 28)

Spec and the six acceptance criteria are in `docs/quota-fallback-live-apply.md`. This file maps each criterion to tests and recorded evidence. Evidence files are under `docs/evidence/quota-fallback-live-apply/` with a SHA-256 manifest in `MANIFEST.sha256`.

The candidate commit is the PR head at the time you read this. The evidence was produced on source commit `04385cccc41d07e3e6d3678989b010fbdb8d7d67`. Later commits only add this document and the evidence files, so the source is identical.

## Criteria to evidence

1. Live apply and recovery, including legacy records.
   - `worker-quota-live-save-e2e`: the same thread resumes once with an audited model transition.
   - `worker-quota-legacy-save-e2e`: a legacy quota-failed record without `quotaFallback` recovers on the same thread.
   - `worker-quota-recovery-e2e`: saving a fallback recovers a quota wait and a quota-failed thread without duplicate work.
   - Browser journey: `browser/attempt-before.json` (status queued, `quota_reset_wait`, model `fake/fake-model`) and `browser/attempt-after.json` (completed, model `fake/fallback-model`, one `modelTransitions` entry). `browser/model-requests` is not included. Provider requests are summarized in `browser/report.json`.
2. Healthy, paused, stopped, unrelated failures, verifier budget.
   - `worker-quota-save-safety-e2e`: stopped work, healthy running and completed work, project pause and unrelated failures are untouched.
   - `worker-quota-verification-save-e2e`: exhausted verification, a pending verifier, an open cycle with a pending verifier and paused work are preserved. A quota-waiting repair turn in an open cycle with budget left is recovered on the fallback, and the cycle itself is unchanged. This case fails without the fix.
   - `worker-quota-recovery-e2e`: manual pause, project pause and stop survive saves, timers and restart.
3. Changed or removed fallback, repeated saves, concurrency, restart and exhaustion.
   - `worker-quota-superseded-e2e`: a failed quota record A is followed by a quota-waiting follow-up B on the same thread. After restart and three saves (set, remove, set), only B recovers, once, on the fallback. A is not revived, there is no deadlock, and the plan has no extra records. The same script then adds 20000 completed records and shows an idle sweep stays bounded (about 40 ms, threshold 1500 ms). Without the source fix this script hangs: the due follow-up is rejected because another record on the thread holds quota recovery. I observed that as a timeout, not as a clean assertion failure.
   - `worker-quota-retry-switch-e2e`: with the only slot occupied, a fallback is saved and the waiting work is manually retried. When the slot frees, the retry runs once on the fallback and the primary model is not called again. A fallback removed after the retry is never used, and a later save recovers on the current fallback. The script fails deterministically without the fix because the retry used to discard the pending fallback wake.
   - `worker-quota-live-race-e2e`: concurrent saves, latest fallback used once, removed fallback not used, restart keeps pending recovery.
   - `worker-quota-settlement-race-e2e`, `worker-quota-retry-receipts-e2e`: races and idempotent retry receipts.
   - `worker-quota-recovery-e2e`: fallback exhaustion fails after a finite number of requests, and no further requests occur under repeated sweeps.
4. Continuity of role, instructions, tools, permissions, workspace, transcript and worktree.
   - `worker-quota-live-save-e2e`: frozen instructions and tools are unchanged.
   - `worker-quota-recovery-e2e`: conversation history, worktree file and prior tool result survive the fallback.
   - Browser traces: `instructions`, `toolNames` and `cwd` are identical before and after in the two attempt files.
   - Source: recovery edits only the conversation model and `attempt.model` (`src/durable-planning.ts`, quota recovery pass), never the instructions, tools, scope or worktree.
5. Checks and suites.
   - `npm run check` passes (tsc).
   - `logs/npm-run-verify.log`: 21 of 22 passed. The one non-pass is `coordinator-efficiency-e2e`, which is listed in `knownFailing` in `scripts/e2e-manifest.json`.
   - `logs/full-suite.log`: 110 of 173 passed, 62 reported as KNOWN-FAIL, and 1 unexpected failure: `telegram-media-e2e`, which the project already documents as flaky on readiness. It passes inside `npm run verify` and alone (`logs/telegram-media-serial.log`). I did not change or waive it. The earlier load flakes (`status-dots`, `follow-prs`, `verification-trusted-browser`) passed in this run. `scoped-models-e2e` is in the known list but passes, a manifest cleanup unrelated to this PR. The 62 known entries are the manifest's claim, and I did not re-run main.
   - Screenshots `browser/03-review.png` (confirmation dialog) and `browser/04-saved.png` (saved fallback in settings) were inspected.
6. Draft PR and no live mutations.
   - Draft PR 28, no merge or deployment.

## Test flake repair

The independent verifier saw `worker-quota-recovery-e2e` fail waiting for a quota wait. The cause was the test, not the product. The script used a 120 ms retry delay, so the observable wait window was shorter than the polling latency under load, and the work had already retried. The fix adds a test-only cap `PI_PROJECTS_QUOTA_RETRY_MAX_MS` (default unchanged at six hours) and runs this script with a 1500 ms base and cap. Assertions are unchanged, and the "no resume" waits are lengthened to 2000 ms so they still outlast the deadline. After the fix the script passed in 3 sequential runs and in 2 rounds of 7 scripts running concurrently.

## Isolation receipt

- The browser journey ran on a private host started by `verify.mjs launch`, with its own HOME, agent dir, port, socket and fake provider. `doctor` reported no failed checks before and after, and `cleanup` ran afterward.
- The e2e scripts each create their own temporary host and worktrees. None touched the owner checkout or live project.
- The artifact scan covered only the files in this evidence directory: patterns for common key formats, bearer tokens, `token=`, passwords and home paths. Absolute temp and worktree paths were replaced with placeholders. Nothing was flagged apart from a benign field name, `workspaceAuthorization`. This is not a claim about any other historical artifacts.

## Limits

- The fake provider returns scripted 429 responses. It says nothing about a real provider's quota behavior or reset metadata.
- The browser journey is one scenario. The other behaviors are covered by the API-level e2e scripts, not the browser.

## Failure-mode specs

Each regression script has a companion `scripts/<name>-failures.md` listing the failures its assertions catch and its limits. These were added alongside the scripts in the commit that created them, and make no claim about being written earlier.
