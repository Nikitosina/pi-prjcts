# Legacy runtime removal: failure cases (written before code)

Scope: delete the non-Durable (pi-subagents era) runtime: legacy coordinator prompt/worker policy, copy-only migration/switch helpers, legacy RPC actions (`delegate`, `workers`, `control`, `review`), legacy CLI commands, legacy TUI/browser branches, their E2Es and docs. Projects without `runtime: "durable"` are refused on load.

Decision: refuse, do not adopt. A legacy record may carry `runs`, a pi `sessionFile`, review decisions and a `writer-launch.json` marker; opening it as Durable would start a fresh coordinator that silently ignores that history. Refusal is explicit and leaves the files byte-for-byte untouched.

## Refusal
1. A legacy `project.json` (no `runtime`) in the home makes `list` throw, so no project (Durable ones included) is listed.
2. Host start crashes or stops restoring Durable projects because one record is legacy.
3. `show`/`message`/`settings-*`/any id-scoped action on a legacy id succeeds, returns a schema error, or a generic ENOENT instead of a clear "removed legacy runtime" message.
4. The refusal writes to the legacy project dir (project.json rewritten, knowledge seeded, `inbox/`, `notes/`, `decisions/` created).
5. A legacy id passed in the browser URL silently opens another project with no explanation, or the browser shows a raw stack/JSON.
6. The refusal is not logged by the host, so the owner never learns why a project vanished from the list.
7. Telegram/notify/webhook scans crash on the legacy record.
8. A record with `runtime: "durable"` but other old optional fields (`sessionFile`, `runs`) stops loading (owner's live project has `sessionFile: null, runs: []`).

## Removed surface
9. Removed RPC actions (`delegate`, `workers`, `control`, `review`, `legacy-thread-history` stays only if Durable needs it) still dispatch, or are accepted by the schema.
10. Removed CLI commands (`delegate`, `workers`, `steer`, `stop`, `copy-*`) still run or crash with a stack instead of the usage line.
11. A durable project with an old `review` decision file breaks `show` (inbox parse fails) instead of ignoring it.
12. Snapshot loses fields the browser/TUI still read (`inbox`, `notes`, `evidence`, `jobs`), or the browser reads removed ones (`activeRuns`, `runStates`, `project.runs`) and throws.
13. Browser JS errors after removing the legacy branches (undefined `view.activeRuns`, removed `state()` helper, `inspectWorker`).
14. Type check gains new errors beyond the two known ones.
15. Durable code paths that only looked legacy are removed by mistake: `loadProjectResourceLoader` (skills/AGENTS.md), `workRules`, `projects_note`/`projects_notes`, notes-to-knowledge import (`research/legacy/`), Durable-era `projects.legacy-worker-recovery` task extension (old Durable stores), legacy-worker usage rows, legacy monitor guard.
16. `PI_SUBAGENT*` scrubbing removed although the owner's global pi-subagent-manager still reads `PI_SUBAGENT_EXTRA_AGENT_DIRS` and the host loads global extensions.
17. package.json still lists scripts for deleted E2Es; README/DURABLE.md still document deleted commands.
18. `skills-scale-chats` still checks out and runs the 95817c3 legacy host (F19).

## Durable still works
19. Create → message → coordinator reply in the browser breaks.
20. Coordinator delegation → worker runs → report wakes the coordinator → Activity shows the thread breaks.
21. Answering a coordinator question (`answer`) breaks after the review code is removed.
22. TUI `/project-steer` and `/project-stop` vanish without a Durable equivalent.
