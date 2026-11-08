# Jobs, Approve and Deploy

The owner asks the coordinator for work, watches the Job in the Workers panel (right column, current chat only), approves Ready work there, opens the worker's transcript, and reads the Deploy window in Settings.

## Sub-features

- `card`: the Job shows in `#workers` with its status and plan progress; its title opens the worker transcript in the center, and Esc returns to the chat.
- `ready`: a Ready worker card shows the PR and an Approve button (only when the Job has a PR and candidate); the coordinator chat shows no internal report.
- `approve`: Approve asks for a second press ("Confirm approve #12"), then calls the host; a refusal or failure shows as a toast.
- `checkpoint`: an independent worker returns an intermediate result with retained proof and gaps, without readiness or approval.
- `scope`: a new chat shows an empty Workers panel; Main shows its Jobs again.
- `deploy`: Settings → Deploy shows the deploy window (default 02:00–07:00) and idle state. It is read only here; the CLI deploys.

## How to get to it (user POV)

- Send a message; the Job appears in the Workers panel. Approve on its card; click its title for the transcript.
- ⌘, then D for Deploy.

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, project `Verify seed` exists (seeded).

- Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> jobs`. The fake provider reads `VERIFY-JOB`: the coordinator spawns a worker, the worker plans (2 steps) and reports Ready with PR 12 and a candidate. The drive types in `#composer textarea` and presses Enter, waits for `#workers .worker[data-status="ready"]`, presses `[data-approve]` twice, opens the transcript from `.w-title`, runs the checkpoint worker, checks a new chat's empty panel, and reads Settings → Deploy. Proof: `jobs-snapshot`, screenshots and the approve toast.

## Gotchas

- The private host has no GitHub login, so Approve ends in the `gh pr view` failure shown in a toast; the merged outcome line is not proven here. The drive tolerates that one HTTP 400.
- The first click needs a painted page; the drive takes a screenshot before it clicks the composer.
- The fake worker never touches the repository; PR 12, the candidate SHA and checkpoint proof text are made up. The checkpoint tool, stored state, coordinator delivery and UI are real.
