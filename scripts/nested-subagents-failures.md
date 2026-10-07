# Nested subagents (one level): failure cases, written before implementation

Covered by `scripts/nested-subagents-e2e.mjs` unless marked (inspection).

## Who may delegate
- N1 A child thread can delegate (depth 2+), by being offered the tool or by calling it anyway.
- N2 The coordinator, scouts or reviewers get the child-delegation tool, or a worker loses `projects_delegate`-free isolation (a worker can admit top-level work that reports to the coordinator).
- N3 A scoped (workspace) worker does not get the tool because scoped threads are configured later than unscoped ones.
- N4 A worker floods the pool: no bound on a parent's active children.
- N5 A child worker gets a different or broader workspace scope than its parent, or a scout/reviewer child gets a scope.

## Reports
- N6 A child's report goes to the coordinator chat instead of the parent worker.
- N7 The child report reaches the parent conversation but its answer is lost (submitted as a plain message that no work item owns), so the coordinator never hears the parent's conclusion.
- N8 The parent's follow-up answer reports to the wrong chat (not the chat that delegated the parent).
- N9 A child report for a stopped parent wakes the parent again, or is dropped silently.
- N10 Report delivery repeats after a restart, or a child report admits the parent twice (no stable request ID).

## Control
- N11 Stopping a parent leaves its children running.
- N12 The worker cap is exceeded by children, or a parent waiting for children deadlocks the pool at cap 1.
- N13 Pause/resume or a host restart loses the parent link (children show as top-level work, reports go to the coordinator).

## UI
- N14 Activity shows children as unrelated top-level rows; no tree.
- N15 The Observability trace puts child threads directly under a chat rather than under their parent thread.
- N16 Opening a child row does not open the child's thread; the tree breaks the 390 px layout.
- N17 `projects_workers` / plan snapshots do not expose the parent link, so the coordinator cannot tell children apart.  (plan-snapshot covered; projects_workers by inspection)
