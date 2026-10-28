# Evidence map for live quota fallback (PR 28)

Spec and the six acceptance criteria are in `docs/quota-fallback-live-apply.md`. This file maps each criterion to tests and recorded evidence. Evidence files are under `docs/evidence/quota-fallback-live-apply/` with a SHA-256 manifest in `MANIFEST.sha256`. The manifest does not list itself. Check it with `cd docs/evidence/quota-fallback-live-apply && shasum -a 256 -c MANIFEST.sha256`.

The candidate commit is the PR head at the time you read this. The evidence was produced on source commit `aae572a6f85f742242a0626bde0010b604590717`, recorded in `SOURCE_COMMIT.txt`. The browser run's host check `revision matches checkout HEAD` passed on that commit (`browser/doctor-before.json`). Commits after it only add this document and the evidence files, so the source is identical. Run output is stored as `.txt` under `run-output/` because the repository ignores `*.log` and `logs/`. Per-script output is in `run-output/quota/`.

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
   - `worker-quota-retry-switch-e2e`: with the only slot occupied, a fallback is saved and the waiting work is manually retried. When the slot frees, the retry runs once on the fallback and the primary model is not called again. A fallback removed after the retry is never used, and a later save recovers on the current fallback. The same script covers a quota-failed record revived by a save behind the occupied slot: after an accepted manual retry and removal of the fallback, releasing the slot runs the retry on the primary instead of restoring the failure, and replaying the retry request id adds no attempt. It fails without the fix. The script fails deterministically without the fix because the retry used to discard the pending fallback wake.
   - `worker-quota-mixed-save-e2e`: a save that changes the name together with the fallback closes the idle runtime. It now reopens it under the lifecycle locks and recovers quota-failed work once. In a paused project it saves the settings and resumes nothing. Unrelated authentication-failed and healthy records are untouched. It times out without the fix.
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
   - `run-output/npm-run-verify.txt`: 22 of 23 passed. The one non-pass is `coordinator-efficiency-e2e`, which is listed in `knownFailing` in `scripts/e2e-manifest.json`.
   - `run-output/earlier-source-04385cc/`: full-suite, verify and serial telegram output from the earlier source commit `04385cc`, kept for the `telegram-media-e2e` failure and its serial pass. It does not describe the current source.
   - `run-output/full-suite.txt`: 109 of 174 passed, 62 reported as KNOWN-FAIL per the manifest (I did not re-run main), and 3 unexpected failures: `observability-host-e2e`, `observability-usage-schedule-e2e` and `observability-toolcalls-e2e`. Their output is `Projects host did not start`. The host log shows `Shell environment import failed: timeout` from `src/host-environment.ts`, so the host's login-shell environment import timed out under three parallel jobs. That is outside the quota code. All three passed when run alone (`run-output/*-serial.txt`). I did not change, waive or relabel them. In the previous full run on the earlier source, `telegram-media-e2e` failed once instead: its assertion read `telegram.json` for the sent album's message routing before the notifier had recorded it, so a persistence-timing race, and it passed alone and in `npm run verify`. `scoped-models-e2e` is in the known list but passes, which is manifest cleanup unrelated to this PR.
   - Screenshots (bottom desktop status bar cropped out to remove unrelated account and system information; I re-read the committed `03-review.png` and `04-saved.png` from this run) `browser/03-review.png` (confirmation dialog) and `browser/04-saved.png` (saved fallback in settings) were inspected.
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

Each regression script has a companion `scripts/<name>-failures.md` listing the failures its assertions catch and its limits.
