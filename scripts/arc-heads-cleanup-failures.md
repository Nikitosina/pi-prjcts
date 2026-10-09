# Arc projects, slice S5 (PR-head reads and worktree cleanup): failure cases (written before code)

Scope: `src/arc-worktrees.ts` and the Arc branches of `src/worktree-maintenance.ts`: scouts/reviewers read PR heads from leased read-only arc-wt worktrees; inventory and cleanup understand Arc worker worktrees. E2E: `scripts/arc-heads-cleanup-e2e.mjs` (fake arc / arc-wt / arcanum).

1. Real mounts touched, or a git command run in an Arc worktree: asserted from the call logs (fake only, paths under the temp root).
2. Ref resolution: `pull/<n>` and bare PR numbers resolve through Arcanum's active diff head; `users/<login>/<name>` and `<name>` resolve through `arc log`; a full SHA must exist; option-like refs (`--upload-pack=...`), empty or unknown refs are refused with a clear message and create no worktree.
3. Dedup: the same commit reached by PR number, branch and SHA mounts one worktree (`pi-read-<sha12>` at `<projectHome>/read-heads/<sha>`), leased `pi-projects:<id>`, based on that SHA; a reviewer reads exactly that head's files (not trunk, not the owner's branch).
4. Inventory keeps (with a reason): open PR, uncommitted changes, commits not on the server, running/queued thread, lease held by someone else or missing, PR state unknown (Arcanum failing), Arcadia not connected (pushed state unverifiable). It marks removable: clean and pushed (no PR), or any finished (merged/closed) PR.
5. Cleanup: removal is `arc-wt lease renew` then `remove --lease-owner --lease-renewed <exact>`; never `--force`; a refusal keeps the worktree and reports why; foreign or unleased entries are never touched; branches are kept; the receipt is retired (`cleanup-unforced`) so a later follow-up gets the "cleaned up, continue the branch" message; idle read-head worktrees are removed, busy ones kept.
6. GitHub projects and git read-heads/cleanup unchanged (worktree-lifecycle E2E).
