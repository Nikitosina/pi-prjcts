# Workspace cache folder: ways it can fail

Written before the code. Owner decision (2026-11-06, /tmp/storage-plan.md): every workspace (Coordinator chat, worker, task helper)
gets one cache folder outside the worktree for build caches, test results, browser profiles and logs. The host owns it, names it in
`$PI_WORKSPACE_CACHE`, offers it to MCP servers as `${PI_WORKSPACE_CACHE}` and removes it once its workspace is gone. A host setting
moves the cache root. Proof: `scripts/workspace-cache-unit.mjs`, `scripts/artifacts-e2e.mjs` (C1, C2),
`scripts/codemode-native-tools-e2e.mjs` (C3), `scripts/mcp-e2e.mjs` (C4) and `scripts/worktree-lifecycle-e2e.mjs` (C6-C8).

## Location and env
- C1 A worker's bash has no `$PI_WORKSPACE_CACHE`, or it points inside the worktree (Arc would grow its overlay, git would see it as
  untracked), or the folder does not exist when the command starts.
- C2 The worker instructions do not name the folder, so agents keep inventing their own DerivedData paths.
- C3 A Coordinator's bash, or a task helper sharing the chat's workspace, gets no cache or a different one than the workspace it
  works in.
- C9 An Arc agent whose working folder is a project subfolder of the worktree is not matched to its workspace.
- C10 A reader in the owner's checkout, or any folder outside a workspace, gets a cache (it would never be removed).
- C11 The owner's login shell overrides `PI_WORKSPACE_CACHE` through the imported shell environment.

## MCP
- C4 `${PI_WORKSPACE_CACHE}` in an MCP server's env is resolved once from the host environment (empty), so every workspace shares one
  value, or one connection serves two workspaces with different caches.
- C5 Without a cache, `${PI_WORKSPACE_CACHE}/DerivedData` becomes `/DerivedData` instead of leaving the variable out.

## Cache root setting
- C12 A relative, empty or non-normalized cache root is accepted, or the setting is saved without a revision check.
- C13 With a cache root set, caches of different projects collide, or the default root keeps growing.

## Removal
- C6 Cleanup removes a worktree but leaves its cache.
- C7 A cache whose workspace is gone for another reason (task helper finished, receipt retired, crash before cleanup) stays forever.
- C8 Cleanup removes the cache of a live workspace (a Coordinator chat, a running worker, a kept worktree), or a folder that is not a
  cache (anything outside the cache roots, or a name that is not a workspace intent id).

## Prompts
- C14 The cache line enters a worker's frozen prompt only once its receipt is committed, so the first prompt and a rebuild differ and the
  worker freezes; or an agent prepared before frames and before caches no longer proves its stored prompt after the upgrade
  (prompt-blocks-legacy-e2e P8, ui2-worker-prompt-e2e).
