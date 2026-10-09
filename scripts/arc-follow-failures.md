# Arc projects, slice S4 (follow PRs, auto-fix, auto-merge): failure cases (written before code)

Scope: `src/durable-follow.ts` polls the Arcadia PRs this project opened (verified `projects.arc-writes` receipts) through `ya tool arcanum` (seam `PI_PROJECTS_ARCANUM_CLI`), batches events to the chosen chat, auto-fixes CI failures, auto-merges (opt-in) with `arc pr merge --now`. E2E: `scripts/arc-follow-e2e.mjs` (fake arc/arcanum/model).

1. Real Arcanum/CI touched, or the owner's other PRs followed: only receipts' PRs are read; a PR in Arcanum that this project did not open produces no events, fixes or merges (asserted).
2. First poll announces everything (must baseline silently); later polls repeat events (every change exactly once, also across polls with no change and after a failed poll).
3. CI: failed/passed detected on the active diff-set of the current head only; a re-run that passes on the same head is news; failing non-required checks count; pending checks are neither.
4. Auto-fix: dispatched once per failing head to the thread that opened the PR (follow-up), capped (`fixCap`), not for PRs without a verified receipt, not when off, text tells the worker to update the PR through open_draft_pr, never a new PR; check output marked untrusted.
5. Comments: new non-draft comments (human or bot) once each, capped per poll, text marked untrusted; drafts ignored.
6. Auto-merge off by default: no reviewer, no merge. On: needs CI green at the head, a reviewer verdict `approve` for exactly that head (a new push needs a new review; changes requested blocks), a current Arcadia authorization, `merge_allowed` true from Arcanum (its own requirements hold: otherwise a note, no merge call), a re-read of the head and checks immediately before `arc pr merge --now`; at most 3 tries per head; one merge receipt per PR; an outcome still pending is inspected, never repeated blindly; a refusal is reported as needs-you.
7. Head moved after approval (new diff-set): no merge of the new head; a new reviewer is asked for it.
8. Rate limit (exit 75) and outages: the poll fails as a whole, state is not committed, `lastError` is shown, the backoff grows, and the next successful poll delivers each pending change exactly once (no duplicates, no lost events).
9. Reviewer for Arc PRs gets the diff in the task (`arc diff base head`), the verdict tool accepts the Arc repository id, GitHub reviewers/verdicts unaffected.
10. UI: the event card says "Arcadia activity" for `arc.follow`; GitHub events unchanged.
11. GitHub projects regress (follow-prs, auto-merge E2Es).
