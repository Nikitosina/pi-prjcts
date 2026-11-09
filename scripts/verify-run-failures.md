# projects_verify_run: HEAD on every checkout kind, and refusals that name the next step

Written before the code (retro 2026-11-09). Script: `scripts/verify-run-unit.mjs` (the tool without a host: a fake Jobs document, git worktrees and a fake plugin checkout kind).

1. HEAD is always read with git, so in an Arc worktree the read fails and every run is refused as "the worktree is on an unknown commit", although it is on the candidate. HEAD comes from the checkout kind's provider (Arc: `arc info --json`), as `headCommit` does elsewhere.
2. A failure to read HEAD (not a checkout, a provider that answers no commit or throws, git failing) is reported as a mismatch with an "unknown commit". It must say "cannot read HEAD" with the error, and must not tell the worker to record or check out a candidate.
3. Without a candidate, an independent worker is told only that the worker records one. It must name the steps: commit, push, `job {action:"candidate", sha, branch, pr}`, then retry.
4. A task helper gets the same push advice, but helpers never publish: it must be told to record a local candidate with `job {action:"candidate", sha}` (no push, no branch or PR), then retry.
5. On a mismatch the worker is told to "verify the candidate or ask the worker" (it is the worker). It must get both ways out: record the current HEAD (full SHA, with the kind's candidate call) if that is the work to verify, otherwise check out the candidate.
6. A run on the candidate is refused, or a fix reads HEAD twice and runs on a commit other than the one recorded.
