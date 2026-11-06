# Script routines: ways they can fail

Written before the code. Owner decision (2026-11-06, /tmp/storage-plan.md): a routine's action may be one shell command, stored
exactly and run with `/bin/zsh -lc` in the project folder, with the owner checkout and the workspace cache root in its env, a
10-minute default timeout, no overlapping runs, and no runs while the project is paused. The last 50 runs keep their exit code,
duration and the last 64 KB of output; a failed run sends the output tail to the routine's chat. Creating a script routine or
changing its command needs the owner's approval when an agent asks; timing and on/off do not. Proof:
`scripts/routine-script-unit.mjs` (S1-S5) and `scripts/routine-script-e2e.mjs` (S6-S12).

## Running
- S1 The command is changed on the way (trimmed, re-quoted, split), or runs in another folder or another shell.
- S2 A script that prints megabytes fills memory or the disk; the kept output is not the end of it.
- S3 A timed-out or aborted script leaves its children running (a `sleep` started in the background keeps the run alive).
- S4 A failed start (missing shell) or a kill by signal is recorded as success.
- S5 Run logs grow without bound, or pruning removes a newer log instead of the oldest.

## Routine
- S6 The script does not get `PI_OWNER_CHECKOUT` and `PI_WORKSPACE_CACHE_ROOT`, or the owner's login shell environment replaces them.
- S7 History shows no exit code or duration, or the output of a run cannot be read back.
- S8 A failing run is silent: no message with the output tail reaches the routine's chat; or a successful run posts one.
- S9 A second run starts while the first is still running.
- S10 A paused project still runs scripts.
- S11 A script command can be changed through the prompt edit (`schedule-update` text), bypassing approval.
- S12 The Host agent creates a script routine or changes its command without the owner's approval.
