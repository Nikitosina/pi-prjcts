# Failure modes: the tasks plugin

Written before the code. Tests: `scripts/tasks-plugin-unit.mjs` (store and tools without a host), `scripts/tasks-plugin-e2e.mjs` (private host, fake model, headless Chrome on the inbox, two chats, desktop and mobile). Numbers appear in check labels.

Authority and identity
1. A tool call writes another chat's list: the tool takes a `chatId` argument, or trusts a name from the model. The chat is derived only from the calling conversation (`chatIdOf`), and an argument naming a chat is refused by the schema.
2. A worker, helper or any non-Coordinator conversation calls a tasks tool and reads or writes a list.
3. The browser or the Host agent writes a list through an RPC method. The plugin offers only `list` (read).
4. A malformed project or chat id reaches a file path.

Durable lists
5. Two chats of one project share a list, or the lists of two projects mix.
6. A restart, a corrupt file or a half written file loses or silently resets the list. Writes are atomic; an unreadable file refuses every write and read with the reason and is never overwritten.
7. Unbounded growth: open tasks, finished tasks, title and note sizes are capped, and the oldest finished tasks go first.

Tasks and stages
8. A task needs a Job: a task without a PR, a Job or a link is rejected or hidden.
9. A stage outside the enum is accepted, or `done` is set by update instead of finish, or a finished task is edited again.
10. Finishing or updating an unknown or another chat's task id changes something else.
11. Parallel tasks overwrite each other: an update changes every task, or a repeated add with the same title replaces one.

Pull requests
12. A PR is attached with a guessed provider or repository (the project's GitHub repository, the default branch host). Provider and repository are required and validated; nothing is inferred.
13. PR number 5 of repository A is treated as number 5 of repository B, or a GitHub PR as an Arc PR. The identity is provider, repository and number together.
14. One PR sits on two tasks of a chat, or a different PR replaces the attached one silently. Replacing needs `replace: true`; a repeated identical attach is a no-op.
15. A PR link that is not http(s) becomes an href (javascript: URLs).
16. The tasks plugin changes, hides or merges non-task PRs: the Pull requests section and merge controls must stay exactly as they are.

Sidebar
17. The section shows nothing for a task without a PR, a stage or a link, or shows `undefined`.
18. The section stays stale after a tool call, or an old answer overwrites a newer one, or a slow answer for the previous chat renders into the next chat.
19. Switching chats, reloading the page or restarting the host shows the wrong chat's tasks or none.
20. Task text is inserted as HTML.
21. The section overflows on a phone.
