# Arc projects, slice S3 (draft PRs through the host): failure cases (written before code)

Scope: worker tools `projects_arc_<key>_open_draft_pr` / `_pr_status` (`src/arc-worker.ts`), receipts `projects.arc-writes`, Arcanum client `src/arcanum.ts`, fakes `fake-arc` (`arc pr ...`) and `fake-arcanum` (shapes from the real `--json-schema`). E2E: `scripts/arc-pr-e2e.mjs`.

1. Real Arcanum/CI/Tracker touched: only `PI_PROJECTS_ARCANUM_CLI`/`PI_PROJECTS_ARC_CLI` fakes run; the call log shows every arcanum call and none leaves the temp root.
2. The PR is not a draft (`--publish` without an explicit request), or `publish: true` is ignored when asked.
3. Multi-line body arrives with a literal `\n` (must use `-F` with real line breaks; the fake rejects `-m` with textual `\n`); title with a line break is refused; a title over 200 characters is refused.
4. A separate `arc push` is made before `arc pr create` (arc pr create pushes itself); `--no-commits` missing (commit messages would be appended to the curated body).
5. The PR is not verified: author is not the Arc login, source branch is not `users/<login>/<branch>` (double prefix), the active diff-set head differs from the worktree HEAD, the marker is missing, or a draft was requested but the diff-set is published. A failed verification must not count as a verified receipt (so it is not followed/fixed/merged by the project) and must say why.
6. Uncommitted changes or a wrong checked-out branch at call time: refused with a clear message, nothing created.
7. Duplicate PRs: a second call after a verified receipt updates (pushes new commits, re-verifies, same number) and never creates another; a retry after an uncertain create never repeats.
8. Uncertain effect: `arc pr create` failing or its PR not findable leaves the receipt uncertain, blocks repeats and automatic admission (`uncertain-provider-write` blocker), and is visible in `arc-write-snapshot`.
9. Ticket: the key in the branch is linked with `pr link-tickets` (idempotent); a failed link does not fail the PR and is recorded; no key means no link; never any ticket status change.
10. Authority: tools exist only with a current Arc authorization (workspace revision), only for the active scoped worker of the right conversation, not while paused/closing, and not for GitHub projects.
11. `pr_status`: read-only, bounded (checks capped), reports merge readiness, checks and comment count; refuses before any PR exists.
12. Restart: after a host restart the tools are re-offered to a follow-up and still update the same PR.
13. Rate limits (exit 75) surface as a retryable error, never a tight loop (the client never retries by itself).
