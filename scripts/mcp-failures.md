# MCP servers for coordinator and workers: failure cases (written before code)

Scope: host-owned MCP pool (`src/mcp-servers.ts`), two stable gateway tools `projects_mcp_tools` / `projects_mcp_call` (`src/mcp-tools.ts`), per-profile picker (Settings), per-server "allow writes". Fakes only: `scripts/fake-mcp-server.mjs`, temp mcp.json via `PI_PROJECTS_MCP_CONFIG`, fake model. E2E: `scripts/mcp-e2e.mjs`.

1. Real `~/.pi/agent/mcp.json` is read or a real server (ci, tracker, npx) is spawned in a test. Guard: config path comes only from `PI_PROJECTS_MCP_CONFIG`; E2E asserts the catalog path, private HOME, and that every logged server cwd is under the temp root.
2. A server not selected for the caller's role is callable (coordinator calls a worker-only server; scout calls worker server).
3. Default (nothing saved) exposes a server.
4. Settings change needs a reopen or idle queue to take effect (must apply live; MCP-only changes skip the idle requirement).
5. Disabled (`enabled:false`) server is selectable/callable. OAuth-only HTTP server (`oauth`/`auth` in config) is offered as usable instead of "needs sign-in".
6. Stale name (server removed from mcp.json) breaks the prompt or a call crash instead of "unknown/unavailable".
7. Mutating tool runs without "allow writes": name heuristic misses (`ChangeIssueStatus`), annotation ignored (`readOnlyHint:false`, `destructiveHint:true`), `readOnlyHint:true` read blocked by name, read tool with a write-looking noun (`get_settings`) wrongly blocked.
8. "Allow writes" off server still shows blocked-call error without "ask the owner" guidance, or the blocked call still reaches the server (check server log).
9. Toggling writes needs a restart; toggle for server A unlocks B.
10. Worker cwd wrong: server started in project cwd instead of the worker's worktree (per-cwd pool key). Scout/reviewer use readRoot or project cwd.
11. Slow tool hangs the agent (per-call timeout from config `timeout` seconds); the next call after a timeout fails because the pool kept a dead connection.
12. Server crashes mid-call: error not surfaced, or the next call does not reconnect.
13. Oversized output floods the context (cap ~64 KiB, truncation marker); image blocks dropped or unbounded.
14. Secrets: server env values (`FAKE_MCP_SECRET`), headers or args leak into prompts, catalog output, tool listings, errors or the UI.
15. Recovery: after a host restart the gateway tools are missing from the coordinator (not re-added), or existing chats do not get them; recorded calls cannot resolve.
16. GitHub projects/old projects without `mcp` setting fail to load or change behavior (schema back-compat, settings revision hash).
17. Settings validation: unknown role key, non-string names, duplicate names, writes entry not in a catalog are accepted unsafely (unknown role/non-string rejected).
18. Gateway call argument validation: missing `server`/`tool`, non-object `arguments`, unknown tool name -> clear error, never a crash.
19. Concurrent calls to the same cold server spawn two processes (connect must be de-duplicated).
20. Host shutdown leaves orphan server processes (pool closes all; idle servers close after 10 minutes).
21. Picker UI: servers not listed, disabled/OAuth not locked, 390px overflow, save/reset not persisting, "All profiles" inheritance not shown.
22. Prompts: role instruction note present; no schemas of every tool pushed into prompts (tool listing is on demand and paged).
