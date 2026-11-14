# Storage and Clean up

Settings → Storage lists what the project keeps on disk and what the Workspace cleanup routine would free; Clean up runs that routine now and shows its summary when the run ends.

## Sub-features

- Rows per kind (worktrees, workspace caches, disposable paths, Job videos, plugin rows) with Count, Size and Cleanup frees.
- Clean up: runs the `workspace-cleanup` routine, waits for that run by its request id with a progress bar and the current step (Step N of 4, done/total, bytes freed), shows its summary, then measures again. A failed poll shows "waiting for the host…" and keeps waiting.

## How to get to it (user POV)

Open Settings (`[data-cmd="settings"]`), pick Storage under Project, press Clean up.

## Driving it with browser CDP

Scripted: `verify.mjs drive storage-clean` on a host launched with `--cleanup-delay-ms 2500` (the host's test seam that holds each run at its first step). It first records 31 cleanup runs through `schedule-run` (setup, so the project has more history than one oldest-first page), then clicks Clean up, requires the bar and `Step 1 of 4: Checking worktrees` while the run is held, and then the `.storage-outcome` line with the run's `Removed … worktree(s)` summary.

## Gotchas

- The seed project has no worktrees or caches, so the summary removes nothing; the journey proves the button ends, not what cleanup frees (`scripts/worktree-lifecycle-e2e.mjs` covers that).
