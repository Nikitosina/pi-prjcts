# Jobs, Approve and Deploy

The user asks the coordinator for work, watches the Job in the Workers card (right column, current chat only), opens its details to approve Ready work, and finds the Deploy controls in Settings.

## Sub-features

- `tree` — the Job shows under Jobs with status and plan progress; expanding it lists its worker; opening the worker shows its transcript.
- `ready` — the worker's Ready report appears in its details with an Approve button (only when the Job has a PR and candidate).
- `approve` — Approve calls the host; a refusal or failure is shown to the user.
- `checkpoint` — an independent worker returns an intermediate result with retained proof and gaps, without readiness or approval.
- `deploy` — Settings has a Deploy button and deploy-when-idle settings (default window 02:00–07:00).

## How to get to it (user POV)

- Send a message; the Job appears in the Workers card. Click its arrow, then the worker row.
- Open the worker from the Workers card. Its delivery report, proof and Approve stay in the task details, outside the coordinator conversation. Intermediate checkpoints never offer Approve.
- Settings tab, Deploy section.

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, project `Verify seed` exists (seeded).

- Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> jobs`. The fake provider reads `VERIFY-JOB`: the coordinator spawns a worker, the worker plans (2 steps) and reports Ready with PR 12 and a candidate. The drive pointer-clicks Send, waits for the Job in `#job-tree` and ready Job, opens its details with proof and `[data-action=job-approve]`, confirms the coordinator conversation has no internal report, checks `jobs-snapshot` (one ready Job, PR 12), clicks Approve, expands the Job, opens the worker, sends `VERIFY-CHECKPOINT`, verifies a real checkpoint through task details and `jobs-snapshot` with no Approve, then opens Settings and checks the Deploy section (`#deploy`, hours 02:00 and 07:00). Screenshots `00` to `05` and `approve-outcome.txt` land in the drive folder.

## Gotchas

- The private host has no GitHub login, so Approve ends in the `gh pr view` failure shown in the error banner; the merged outcome line is not proven here. The drive tolerates that one HTTP 400.
- The first click needs a painted page; the drive takes a screenshot before it clicks the composer.
- The fake worker never touches the repository; PR 12, the candidate SHA and checkpoint proof text are made up. The checkpoint tool, stored state, coordinator delivery and UI are real.
