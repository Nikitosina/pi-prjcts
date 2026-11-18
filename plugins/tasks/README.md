# tasks

Optional plugin: a durable task list per project and chat for the Coordinator, shown in the Tasks section of the chat's right panel. Not loaded unless configured (`plugins.json` or `PI_PROJECTS_PLUGINS`, see `docs/plugins/development.md`).

- Coordinator tools: `tasks_list`, `tasks_add`, `tasks_update`, `tasks_attach_pr`, `tasks_finish`. The list is the calling chat's own: the host supplies the chat through `chatIdOf`, and no argument names a chat. Workers and helpers cannot call them.
- A task needs no Job and no PR. Stages: `planned`, `in-progress`, `in-review`, `blocked`, and `done` through `tasks_finish`.
- A PR is attached with an explicit provider, repository and number (and an optional http(s) link). Nothing is inferred; one PR belongs to one task of a chat. The Pull requests section and the merge controls are not touched.
- RPC: `list` only (read). The browser and the Host agent cannot write a list.
- Storage: `$PI_PROJECTS_HOME/plugins/tasks/<projectId>.json`, written atomically; an unreadable file refuses reads and writes and is never overwritten. Caps: 50 open tasks and the 50 latest finished tasks per chat.
- The section polls `list` every 3 seconds while the page is visible and refreshes when the page becomes visible again.

Failure cases: `FAILURES.md`. Tests: `scripts/tasks-plugin-unit.mjs`, `scripts/tasks-plugin-e2e.mjs`.
