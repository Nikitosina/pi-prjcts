# Auto-merge (per-project opt-in): failure cases, written before implementation

Covered by `scripts/auto-merge-e2e.mjs` unless marked (inspection).

## Opt-in
- A1 Auto-merge is on by default, or a project created before this feature (no `autoMerge` in automations.json) fails to load or starts merging.
- A2 Turning auto-merge on without Follow PRs silently does nothing and Settings does not say why.
- A3 Turning it off does not stop a merge on the next poll.

## What may merge
- A4 A PR the project did not publish (no verified create-pr receipt) is merged, e.g. a person's PR, or a PR whose branch merely starts with the grant's prefix.
- A5 A PR is merged while CI is pending, failed, or has no check runs at all.
- A6 A required status check (branch protection) that has no run, or only a legacy commit status, is ignored, so a PR merges with a required check missing or failing.
- A7 A PR merges without a reviewer approval, with an approval from a non-reviewer (coordinator, worker), or with "request changes".
- A8 A reviewer approval for an older head is reused after a new push (stale head).
- A9 The head changes between the checks and the merge call, and the new, unreviewed head is merged (the merge call does not pin `sha`).
- A10 A draft PR (project PRs are opened as drafts) can never merge, or is marked ready without every other gate passing.

## Reviewer
- A11 No reviewer is ever asked, so auto-merge waits forever; or a reviewer is dispatched again on every poll for the same head.
- A12 The reviewer verdict tool accepts a malformed SHA, an unauthorized repository, or a call from a worker thread / the coordinator.
- A13 A reviewer that requested changes is overridden by a later poll without a new verdict.

## Execution and receipts
- A14 A merge is attempted twice for one head (two polls, a restart, or a Check now during a poll).
- A15 A provider error (HTTP 4xx) is recorded as merged, or a transport failure (5xx/timeout) is recorded as failed and blindly retried without first checking whether the merge happened.
- A16 The receipt (PR, head SHA, merge commit, reviewer thread, time) is missing or lost on restart.
- A17 The event chat is not told: the merge, or why a PR did not merge (waiting for review, required check missing, stale approval), never reaches the coordinator.
- A18 A paused project merges.
- A19 Settings does not show the toggle, the receipts or the reason a PR is waiting; the card overflows at 390 px.
- A20 The owner-approval merge flow (operation approvals) changes behaviour.  (inspection: `src/github-operations.ts` untouched)
