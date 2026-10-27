---
name: pr-review
description: Static Arcanum or GitHub PR review with independent Standards, Spec, and Bugs/performance reviewers. Use when reviewing a PR or assessing a PR candidate before completion, or when the user names pr-review.
---

# PR review

Review your own PRs or those assigned to you. Static assessment only: reviewers read code and evidence without builds, target execution, reproduction or edits. The caller may collect VCS metadata and immutable source snapshots for the handoff. If the caller cannot write files or collect VCS data, delegate preparation to an authorized worker and receive its complete handoff before review. Pin the PR into a read-only `<snapshot>` (`/tmp/pr-review/<id>/snap-<timestamp>/`); inputs, prompts, and reports go in `<round>` (`/tmp/pr-review/<id>/round-<key>-<attempt>/`, step 3). Posting requires separate approval.

Read the repo-local code-review skill in full, using the skill reader by name `code-review`, not a path escaping this skill directory. Its file is [`../code-review/SKILL.md`](../code-review/SKILL.md). Use its Standards and Spec process, briefs, and smell baseline inside this workflow, not as a separate nested run. Replace its fixed-point/HEAD comparison with the pinned PR base/head below. Keep its explicit-spec requirement, independent contexts, and separate reports.

## 1. Collect and pin

Detect the repository. In Arcadia, use `/skill:arc` and `/skill:arcanum-go`; elsewhere use GitHub's `gh`. Run this skill's scripts by absolute path, resolved relative to this file.

**Arcanum.** Run `scripts/collect-arcanum.sh <id> <snapshot>` from the checkout. It saves metadata, the active diff-set, the base-to-merge diff, and changed files at the merge revision, then makes the directory read-only. Record those revisions and the `arc diff <base> <merge>` command. Capture the corresponding commit list with `arc log -n <count> <base>..<merge> --oneline`, paging until the complete range is saved, following the arc skill. Compare `ya whoami` with `pr.json` `author.name`.

**GitHub.** Resolve the number and repository even when given a URL. Save `gh pr view <id> --json title,body,author,baseRefOid,headRefOid,files,url` as `pr.json`. A live `gh pr diff <id>` is only diagnostic until matched to the pinned objects. Fetch the PR head and base objects without checking out a branch. Save every non-deleted changed file with `git show <headRefOid>:<path>` under `files/`. Pin the merge-base and head, generate the authoritative `diff.patch` with `git diff <merge-base> <headRefOid>`, record that command, and save `git log <baseRefOid>..<headRefOid> --oneline`. Re-read PR metadata and confirm the head and base still match; if either moved, start a fresh snapshot. Compare `gh api user -q .login` with the author. Make `<snapshot>` read-only when done.

Finish only with a non-empty complete diff, pinned revisions, commit list, and all non-deleted changed files. An unreadable or truncated diff stops the review. Treat `files/` as authoritative; fetch relevant surrounding code at the pinned revision when the local checkout differs. Do not base findings on mismatched revisions.

## 2. Prepare review inputs

Use the source-spec and standards criteria from code-review steps 2 and 3. Keep this PR snapshot immutable: hold additional inputs for step 3 and save them in the writable round directory, not inside the read-only source snapshot.

- Reuse the explicit owner requirements already supplied in the conversation, or the user-designated requirements, file or URL. Ask for a spec or explicit permission to skip Spec only when none is supplied. A PR description or linked issue qualifies only when the user identifies it as the spec. Never infer requirements from the implementation or commit messages. Failed retrieval requires replacement contents, not a silent skip.
- Read applicable `AGENTS.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md`, and their relevant pointers. Use PR-revision standards where available. Record the sources and revisions.
- Hold the supplied spec in full with its source, the standards sources, diff command, and commit list for step 3, which saves them.

Proceed only when these inputs are readable and Spec is supplied or explicitly skipped.

## 3. Admit the round

The **round key** is the head revision (Arcanum: diff-set merge revision) plus base, a hash of the spec contents, a hash of the standards contents, and the axis set. Compute it after step 2; name `<round>` with it and a fresh attempt suffix, and create it. Keep earlier attempts unchanged. Save the spec, standards sources, diff command, and commit list there.

- Identical key with all reviewers complete: reuse that round's reports; launch nothing.
- Same head with a different key (new or changed spec, new standards, other axes) or any earlier reviewer incomplete, failed, or truncated: run a fresh round in a new `<round>` covering every axis again.
- Different head: fresh round.

## 4. Review in parallel

Use these reviewers in independent fresh contexts. Skip Spec only with explicit permission, leaving two reviewers.

| Reviewer | Role | Brief |
|---|---|---|
| Standards | reviewer | code-review's Standards brief and full smell baseline, plus design and slop criteria below |
| Spec | reviewer | code-review's Spec brief, with the user-supplied spec |
| Bugs/performance | reviewer | `references/bugs-performance.md` |

These are independent threads on the configured reviewer model, not a multi-model panel.

For Standards, also read the installed codebase-design, ponytail-review and simplify skills by name through the role's skill reader. If one is unavailable, report that coverage limitation rather than inventing its contents. Apply their review criteria only, without edits or extra reviewers. Cover leaking interfaces, wrong ownership, unnecessary abstractions, unused compatibility code, misleading names, and narrating comments. Repository standards override these heuristics. Separate documented violations from judgement calls; skip tooling-enforced rules.

Build and save `prompt-<reviewer>.md` in `<round>` for each reviewer. Each is a complete handoff, without assuming reviewers inherit skills, `AGENTS.md`, or conversation:

- the pinned revisions, diff command, commit list, and absolute `<snapshot>` paths, which stay unchanged for the round;
- the full contents or readable paths of its inputs: standards sources, the full smell baseline pasted in Standards, the full spec text in Spec, `references/bugs-performance.md` in Bugs/performance;
- the PR description from `pr.json` with any verification evidence it links (run IDs, manifests, proof directories) by path;
- the rules: read only, no edits, builds, or execution; evidence it cannot read is reported as `evidence unavailable`, separately from findings and never as a violation;
- the report format: each finding cites new-side `path:line`, evidence, and consequence. Standards and Spec reports stay under 400 words each; Bugs/performance follows its reference.

Use coordinator-root delegation with the pinned full revision as the read target for published PRs, so the host binds read-only code tools to its immutable snapshot. A child reviewer normally reads the parent's live worktree, not an immutable PR snapshot: use it only with complete pinned contents supplied in the handoff, or return the prepared candidate to the coordinator for root admission. Inline required inputs when snapshot paths are outside the reviewer's readable root; never assume an arbitrary caller filesystem path is readable.

Launch with the host's reviewer-role delegation tools (tool-neutral protocol from code-review step 4): admit all reviewers, each with a distinct task identity and its own handoff, before awaiting any. Queued admission under normal caps is fine. Then await each, page through each result until the host reports it complete, and save a separate complete report per reviewer in `<round>`. Infrastructure failure stops the review with error details and saved evidence; ask before changing model or execution protocol.

## 5. Report

Read the cited pinned code to check each finding. Discard unsupported claims with a short reason in the artifact. Static support is not runtime verification.

Save `verdict.md` and reply with these sections:

- `## Standards`: its report, verbatim or lightly cleaned.
- `## Spec`: its report, or `Skipped: no spec available`, never a pass.
- `## Bugs/performance`: supported bugs, security flaws, and performance risks with severity and evidence.

Keep the axes separate. Do not merge, rerank, or count repeated findings as consensus across axes. Link duplicates if useful. List any `evidence unavailable` items apart from findings. End with finding counts and the worst issue within each axis, plus the artifact path and a note that review was static. Keep discarded claims in the artifact rather than expanding the chat report.

## 6. Optional posting

Post nothing without separate approval. On your own PR, stop at the report. On someone else's PR, post only findings the user selects, as drafts. Prepare short comments in the PR description's language, preserving the axis and severity. Check that the PR head/diff-set still matches the reviewed revision before posting; if it changed, stop and offer a fresh review.

**Arcanum.** Follow `/skill:arcanum-go` for `changelist` entry IDs and `comment post-diff --is-draft`. Use general draft comments when no changed line fits. Publish drafts only on explicit approval.

**GitHub.** Create a pending review with the pinned `headRefOid` as `commit_id` and inline `path`, `line`, `side: RIGHT`, and `body`. Omit `event`; submit only on explicit approval.

Report created drafts with links.
