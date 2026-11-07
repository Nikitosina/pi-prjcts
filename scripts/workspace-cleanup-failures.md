# Workspace cleanup routine: ways it can fail

Written before the code. Owner decision (2026-11-06, /tmp/storage-plan.md): the hardcoded 30-minute worktree cleanup timer becomes a
routine (a schedule whose action is cleanup), on by default in every project, daily, also run once right after Approve. Besides the
safe worktree rule it trims workspace caches, removes ignored disposable paths in live worktrees and deletes videos of old Jobs.
Proof: `scripts/workspace-cleanup-unit.mjs` (R1-R9), `scripts/worktree-lifecycle-e2e.mjs` (R10-R13), `scripts/jobs-e2e.mjs` (R14).

## Settings
- R1 A disposable path that is absolute, starts with `~`, or climbs out with `..` is accepted, so cleanup can delete outside the
  worktree. Bounds that make no sense (cache cap 0, unused days 0, thousands of globs) are accepted.

## What it removes
- R2 A disposable glob matches through a symlink and deletes a folder outside the worktree.
- R3 A disposable match that git does not ignore (tracked or untracked work) is deleted.
- R4 A disposable match written in the last day (a verification run in progress) is deleted.
- R5 A workspace cache used within the unused window is removed, or one unused for longer stays.
- R6 A cache over the size cap is removed while its workspace is using it (a build in progress); one over the cap and idle stays.
- R7 Videos of a running, ready or recently ended Job are deleted, or screenshots, logs and reports of an old Job go with its videos.
- R8 A dismissed Job's videos stay forever because only approved Jobs count.
- R9 Using a cache does not mark it used, so a cache in daily use looks stale.

## Routine
- R10 A project has no cleanup routine by default, or gets a second one on every open, or the timer still runs beside the routine.
- R11 The cleanup routine can be deleted, so it silently stops for good; or its settings cannot be changed without the owner.
- R12 Running the routine does not run the safe worktree cleanup (pushed W3 stays, or dirty W2 goes).
- R13 A run that dies with the host stays in flight forever and blocks every later run; or a host restart reports a cleanup as an
  uncertain prompt submission.
- R14 Approve does not start a cleanup, so a merged Job's worktree and cache wait a whole day.

## Plugin steps
- R15 A plugin cannot add a cleanup step (simulator clones keep their data forever), or a step that throws stops the core steps or
  is reported as a successful run; or the step does not learn the project and the unused window
  (`scripts/vcs-plugins-e2e.mjs`).
- R16 The simulator step erases a clone that is booted, leased, used within the unused window, or not owned by the project
  (`plugins/simulator/idle.ts` checks in `scripts/workspace-cleanup-unit.mjs`; the real erase is unscripted).
