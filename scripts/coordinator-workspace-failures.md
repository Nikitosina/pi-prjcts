# Coordinator workspace ownership failures

Recorded before the branch-switch fix. Run with a private host and fake model only.

- Switching the Coordinator's branch blocks its next read, bash or branch-restoration call.
- Detached HEAD or a changed branch becomes unusable after reopening the host.
- Shared helpers cannot borrow the same allocation after a Coordinator branch change.
- Relaxing Coordinator branch checks also relaxes isolated worker branch checks.
- Receipt, path, repository or ownership-lock changes stop being rejected when branch changes are allowed.

`coordinator-workspace-e2e.mjs` covers tool execution, reopen and shared helpers. `workspace-frozen-scope-e2e.mjs` covers strict branch checks and ownership tampering.
