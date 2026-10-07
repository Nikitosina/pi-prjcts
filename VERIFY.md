# MVP verification contract

Run `npm run e2e`. The script uses real Pi sessions, the installed pi-subagents runner, and configured model credentials. It writes a dated evidence directory containing assertions, worker artifacts, and project records. No mocks or unit tests.

Failure cases to exercise:

- Pi 1.0 removes an unused core export that the background runner still requires,
  preventing worker launches. Skip only that obsolete alias on Pi 1.x; other
  missing host dependencies must still fail.
- Two clients start two hosts or two sessions for the same project.
- Closing a client kills delegated work or loses its result.
- A saved coordinator session cannot reopen after host restart.
- A worker completion never wakes the coordinator.
- Worker notes disappear or concurrent appends overwrite notes.
- A scout mutates the workspace.
- A worker writes outside the workspace through file tools or follows a symlink outside it.
- Publishing or an obvious destructive shell command runs without approval.
- A malformed request, invalid project ID, or oversized body crashes the host.
- A second writer enters the same workspace before the first finishes.
- A crash silently replays an interrupted prompt and duplicates its changes.
- Worker inspection or steering targets a run owned by another project.

## Live decision inbox

Browser E2E must exercise these failures before release:

- A missing or wrong bearer token can read project data or mutate it.
- Cross-origin requests or a forged Host header can reach the local API.
- A question disappears after a host restart or a new unrelated chat message.
- Two submissions answer the same question twice or enqueue duplicate prompts.
- Accepting a result commits, merges, publishes, or launches another writer.
- A review appears before its worker is terminal, or reappears after acceptance.
- Evidence uses an arbitrary file path, follows a symlink outside the workspace,
  executes HTML/SVG, or changes after the worker rewrites the original file.
- A worker transcript, steering action, or artifact crosses project ownership.
- Polling loses a draft, interrupts typing, or applies an old project's response.
- Closing the browser stops work or loses the stored decision and review state.
- Failed or stopped workers look like successful verification.
- An arbitrary request is treated as goal-mode activation instead of normal chat.
- A follow-up spawns another worker instead of steering the existing worker.
- The coordinator edits files or executes shell commands itself.
- A coordinator reply is inaccessible when the decision inbox is empty.
- A delayed dialog-close event cancels a newly opened evidence preview.
- A message submitted while typing loses edits made before the host acknowledges it.

Use a disposable project and real configured models. Exercise the live browser,
not a mocked host. Save screenshots, assertions, run receipts, captured evidence,
and the repeatable command under `artifacts/`.

MVP limits: trusted local agents, not an OS sandbox. Shell scripts and arbitrary code can bypass command-pattern checks. Mac sleep pauses execution. Host restarts restore sessions and worker controls; interrupted coordinator requests require an explicit new instruction and are never replayed automatically.
