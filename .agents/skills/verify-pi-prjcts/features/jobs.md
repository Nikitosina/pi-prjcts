# Jobs, Approve and Deploy

The user asks the coordinator for work, watches the Job in the sidebar tree, approves its Ready message, and finds the Deploy controls in Settings.

## Sub-features

- `tree` — the Job shows under Jobs with status and plan progress; expanding it lists its worker; opening the worker shows its transcript.
- `ready` — the worker's Ready report is a regular chat message with an Approve button (only when the Job has a PR and candidate).
- `approve` — Approve calls the host; a refusal or failure is shown to the user.
- `deploy` — Settings has a Deploy button and deploy-when-idle settings (default window 02:00–07:00).

## How to get to it (user POV)

- Send a message; the Job appears under Jobs in the left sidebar. Click its arrow, then the worker row.
- The Ready message is in the chat; Approve is under it.
- Settings tab, Deploy section.

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, project `Verify seed` exists (seeded).

- Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> jobs`. The fake provider reads `VERIFY-JOB`: the coordinator spawns a worker, the worker plans (2 steps) and reports Ready with PR 12 and a candidate. The drive pointer-clicks Send, waits for the Job in `#job-tree` and the `.job-msg[data-status=ready]` message with `[data-action=job-approve]`, checks `jobs-snapshot` (one ready Job, PR 12), clicks Approve, expands the Job, opens the worker, then opens Settings and checks the Deploy section (`#deploy`, hours 02:00 and 07:00). Screenshots `00` to `05` and `approve-outcome.txt` land in the drive folder.

## Gotchas

- The private host has no GitHub login, so Approve ends in the `gh pr view` failure shown in the error banner; the merged outcome line is not proven here. The drive tolerates that one HTTP 400.
- The first click needs a painted page; the drive takes a screenshot before it clicks the composer.
- The fake worker never touches the repository; PR 12 and the candidate SHA are made up.
