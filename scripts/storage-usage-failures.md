# Storage usage: what a project keeps on disk, and Clean up (Settings → Storage)

Written before implementation. `storage-usage` answers one row per kind: worktrees, workspace caches, disposable paths, Job videos,
and one row per plugin that keeps files for the project (simulator clones). Each row has a count, its size and what the cleanup
routine would free with its current settings. Clean up runs the cleanup routine now. Proof: `scripts/storage-usage-unit.mjs` (U1-U3),
`scripts/worktree-lifecycle-e2e.mjs` (U4-U6), `scripts/vcs-plugins-e2e.mjs` and `scripts/workspace-cleanup-unit.mjs` (U8, U10, U11) and the verify skill's ui2 drive (U7, U9, U12).

## Measuring
- U1 A size counts files outside the project (the owner checkout, another project's caches) or follows a symlink out of the folder.
- U2 One slow or failing measurement (unreadable folder, `du` timeout, a plugin that throws) fails the whole answer instead of marking that row unknown with a reason.
- U3 A worktree on a virtual mount is walked (fetching a remote tree) instead of shown as not measured.

## Rows
- U4 One of the five kinds is missing, or a row's count and size disagree with the worktree inventory and the cache folders.
- U5 "Cleanup would free" differs from what the cleanup routine removes with the same settings (cache cap and window, disposable globs, video days).
- U6 The disposable row reports paths while no disposable globs are set, or paths git does not ignore.
- U7 Clean up runs something other than the cleanup routine, so the run is missing from its history, or starts a second run while one is in flight.

## Plugins
- U8 A plugin's row is missing, or a plugin's usage that throws hides the other rows.

- U10 A slow measurement holds the project lock, so messages, settings and worktree actions of that project wait for `du` (up to two minutes).

## Host breakdown
- U11 `storage-summary` (the disk readout's breakdown) disagrees with the project's own rows, measures every project again on each open (minutes on a big machine), includes deleted or archived projects, or fails as a whole when one project fails. A total is the sum of the known rows; unknown rows are counted, not guessed; the last totals are kept 10 minutes unless `fresh` asks again.

## UI
- U9 Settings shows no Storage section, sizes without units, no unknown state, or a Clean up button that gives no outcome.
- U12 The disk readout in the status line opens no breakdown, or the breakdown gives no way to reach a project's Storage section.
