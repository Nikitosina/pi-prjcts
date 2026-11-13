# Workspace cleanup routine: ways it can fail

Written before the code. Owner decision (2026-11-06, /tmp/storage-plan.md): the hardcoded 30-minute worktree cleanup timer becomes a
routine (a schedule whose action is cleanup), on by default in every project, daily, also run once right after Approve. Besides the
safe worktree rule it trims workspace caches, removes ignored disposable paths in live worktrees and deletes videos of old Jobs.
Proof: `scripts/workspace-cleanup-unit.mjs` (R1-R9, R18, R19, R21), `scripts/worktree-lifecycle-e2e.mjs` (R10-R13, R17, R20, R22),
`scripts/jobs-e2e.mjs` (R14).

## Settings
- R1 A disposable path that is absolute, starts with `~`, or climbs out with `..` is accepted, so cleanup can delete outside the
  worktree. Bounds that make no sense (cache cap 0, unused days 0, thousands of globs) are accepted.

## What it removes
- R2 A disposable glob matches through a symlink and deletes a folder outside the worktree.
- R3 A disposable match that git does not ignore (tracked or untracked work) is deleted.
- R4 A disposable match written in the last day (a verification run in progress) is deleted.
- R5 A workspace cache written within the unused window is removed, or one not written for longer stays.
- R6 A cache over the size cap is removed while its workspace is using it (a build in progress); one over the cap and idle stays.
- R7 Videos of a running, ready or recently ended Job are deleted, or screenshots, logs and reports of an old Job go with its videos.
- R8 A dismissed Job's videos stay forever because only approved Jobs count.
- R9 A cache's last use is read from its folder's own mtime, so a build writing deep inside looks stale, and any tool call in the
  workspace (a `ls`, an MCP read) keeps a cache nobody builds in alive forever. Its last use is the newest write anywhere inside.

## Settled workspaces and the project budget
Owner decision (2026-11-13): clean caches more boldly. A cache is rebuildable, so it goes as soon as its work is over, and a project
keeps at most 50 GB of caches by default.
- R17 A worker's cache stays while its worktree is kept (dirty, unpushed, `arc status` failing), although its Job is approved or
  dismissed, or its PRs are all merged or closed. Or a running thread's cache, or a Coordinator chat's cache, is taken as settled.
- R18 A project's caches together exceed the budget and nothing goes because each is under the per-cache cap; or the budget removes
  the most recently written cache first, or one written in the last hour (a build in progress).
- R19 Stored cleanup settings from before the budget have no `budgetGb`, so a run or a settings change fails validation.
- R20 Settings → Storage counts as reclaimable only the caches the old rules free, so the caches of settled or over-budget workspaces
  show 0.

## Removal and the Clean up button
Seen live (2026-11-13): Finder wrote a `.DS_Store` into a cache while it was being removed, `rmSync` threw `ENOTEMPTY`, and the run
failed before trimming any cache; the Storage button kept spinning because it looked for its run among the 30 oldest.
- R21 One path that cannot be removed (a file written into it meanwhile, no permission) ends the run, so nothing after it is removed;
  or the failure is swallowed and the run reports success.
- R22 Clean up never ends once the project has more than 30 routine runs: history pages oldest first, so the button never sees its
  own run.

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
