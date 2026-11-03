# Native Durable tools and code mode: failure cases

Recorded before the change. Covered by `codemode-native-tools-e2e.mjs`, which uses a private host, real Git worktrees and the fake model; N11 also by `transcript-archive-unit.mjs` (worker and archive reads) and N12 by `mcp-e2e.mjs` with `fake-mcp-server.mjs`. `coordinator-workspace-e2e.mjs`, `artifacts-e2e.mjs` and `worktree-lifecycle-e2e.mjs` keep covering the direct `read`/`bash` paths.

- N1 The coordinator, a worker or a scout is not offered `codemode`, or `codemode` is offered without the tools its scripts need.
- N2 A script's `tools.bash` resolves with text, so the script cannot read `exitCode`. The same happens when a command exits nonzero.
- N3 A nested `bash` runs outside the authorized worktree (the host cwd, the control root or the owner checkout), or loses `$PI_ARTIFACTS_DIR`.
- N4 A nested worker `bash` skips the worker Git policy, so `git push origin HEAD:main` runs.
- N5 A nested worker `write` lands in the owner's checkout.
- N6 A scout script reaches `bash` or `write`, which the scout is not offered directly.
- N7 Scripts get `models.*` (classifier and image calls are not approved).
- N8 Stopping a worker while its script waits on a nested `bash` leaves the command running.
- N9 Script output past its budget cannot be saved ("no execution environment"), so the full text is lost.
- N10 A direct `read` of an image stops returning a stored artifact reference.

## Typed results for scripts

- N11 A script calling `projects_artifacts_list`, `projects_knowledge_write`, `projects_note`, `projects_worker_read` or `projects_archive_read` gets a JSON string, so it must parse text that a byte bound may have cut. Each must declare a `structuredOutputSchema` and resolve with the same value the model reads, within the same bounds.
- N12 `projects_mcp_call` drops a server's `structuredContent`, so a script cannot filter it, and a server that returns only `structuredContent` shows the model "(no output)". A script must get `{ text, structuredContent?, isError? }` with the same 64 KiB bound as the model text; a blocked write or a failed call still rejects with its message.

## Live status of a script

- N13 While a code mode script runs, the chat's live status reads only "codemode…", never which nested tool runs or how many finished or failed, so a long script looks stuck. The live frame must carry the running nested tool names and the done and failed counts, and the live status must name them in text.
