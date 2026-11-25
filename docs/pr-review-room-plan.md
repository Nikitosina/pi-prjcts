# PR Review room: plan

Owner decisions: `decisions/pr-review-room.md` in project memory. Prototype: `ui-prototype-diff/` (variant `combo`). Base: `origin/main`.

## Goal

The owner reads and comments on any PR of the project (our Jobs' PRs and colleagues' PRs) inside pi-prjcts. The Review room is the default view. A guided tour, built by a scout, runs only on request. Comments go to a worker by default on our PRs; publishing to GitHub or Arcanum is an explicit owner action with a confirmation.

## Shape

- **Center focus `pr`.** A new focus kind next to `chat` and `memory` in `web/app.js`. Entry points: a Review button on the PR row in the context panel (`web/workers.js`), `#66` references in the chat, the palette. Esc returns to the chat.
- **One review source per PR provider.** An optional `review` capability on `PrProvider` (`src/plugin-types.ts`). Core implements it for GitHub; the Arc plugin implements it for Arcanum. The browser never sees which provider answers, only what the capability supports.
- **Diff text from the local VCS, metadata from the provider.** GitHub's `patch` is cut on large files and Arcanum returns no content, so file diffs and context come from `git` / `arc` at exact commits.
- **Host state per PR.** Viewed marks, the last seen head, drafts and the tour map live in one project document (`projects.pr-review`), keyed by `provider:id`. Commits are immutable, so diffs are cached by sha.

## The `review` capability

```ts
type PrReviewSource = {
  /** Header, iterations (GitHub pushes, Arcanum diff-sets) with head sha, checks per iteration, author. */
  snapshot(project, id): Promise<PrReviewSnapshot>;
  /** Changed files between base and an iteration, or between two iterations. */
  files(project, id, range: PrRange): Promise<PrFile[]>;
  /** One file's unified diff for a range; whole-file lines for expanding context. */
  fileDiff(project, id, path, range): Promise<string>;
  fileLines(project, id, path, sha, from, to): Promise<string[]>;
  /** Review threads anchored to path, line, side and commit; resolved and outdated flags. */
  threads(project, id): Promise<PrThread[]>;
  /** Phase 3. Outward-facing; called only from the owner's confirmed browser action. */
  publish?(project, id, review: PrPublish): Promise<PrPublishReceipt>;
  capabilities: { viewedSync: boolean; annotations: boolean; issues: boolean; suggestions: boolean };
};
```

- **GitHub (core, new `src/github-review.ts`).** GraphQL for the header, `reviewThreads` and the timeline (pushes, force pushes). File diffs: fetch `refs/pull/<n>/head` into a private ref (`refs/pi-prjcts/pr/<n>`) of the project's checkout, the same way `branch-continuation.ts` already fetches, then `git diff <merge-base>..<head> -- <path>`. Pushes are not stored by GitHub as iterations: the host records each new head it sees (Follow PRs already polls heads).
- **Arcanum (Arc plugin, `src/review.ts`).** `pr diffs --id` for diff-sets, `pr changelist --diff-id`, `arc diff <base> <merge> -- <path>` and `arc show <merge>:<path>` (already used in `coordinator-reads.ts`), `comment list-diff` for threads. Iterations and interdiff are native.
- **Interdiff ("since you looked").** Arcanum: diff of the two merge commits. GitHub: per file, the diff between the two heads limited to the PR's files; when the base moved between them (a merge from main), the UI says so and lists the files instead of a misleading diff.

## Phases (one PR each)

1. **Read-only Review room.** Host RPCs `pr-review-open`, `pr-review-files`, `pr-review-file`, `pr-review-lines` (validated before any runtime opens, bounded output, sha-keyed cache). `web/review.js` with the file tree, viewed progress, unified/split, wrap, expandable context, threads shown read-only, checks, iterations, "since you looked". `web/diff.js` renders rows (the prototype's tokenizer and word diff, hardened, everything escaped). Viewed marks and last seen head in `projects.pr-review`; a viewed mark resets when that file's blob changes. Big PRs: files load lazily as they scroll in; lock and generated files collapsed. Both providers, both "ours" and colleague PRs.
2. **Drafts and Ask worker to fix (our PRs).** Line and range comments as host-stored drafts, anchored to path, line and sha. Drafts are batched: adding a draft sends nothing. "Ask worker to fix" sends every pending worker draft of the PR at once, as one message to the Coordinator of the Job's chat (like the Merge dialog does today), after the owner sees the full text in a confirmation; the Coordinator starts one fresh worker on the branch for the whole batch. Sent drafts leave the pending list and stay readable as sent. No new authority. On colleague PRs drafts are provider drafts only.
3. **Publish to the provider.** `publish` for GitHub (`addPullRequestReview` with threads and a verdict) and Arcanum (`comment post-diff --is-draft`, then `publish-drafts`; issues optional). Owner-only browser action with a confirmation; excluded from Host agent and Coordinator tools. A write with an unknown outcome is recorded as uncertain and never retried blind, like `projects.github-writes`. Reply and resolve on existing threads come here too.
4. **Guided tour.** The Tour button sends the chat's Coordinator a structured request (a compact event line, not an owner message). The Coordinator spawns the scout with `agents`, adding what it knows from the chat and the Job to the brief. The scout reads the PR head (`readRef` with the full sha, available locally after phase 1's fetch) and returns a review map through a structured answer: steps with title, why, risk, files, checks and line notes. The host validates it (every changed file in exactly one step, notes resolve to lines) and stores it with the sha it was built on. For our PRs the scout also gets the Job's Ready report; for others, the PR description. Files / Tour switch, approved steps mark files viewed. After a new head, steps with changed files get a mark and a Rebuild map button; no automatic rebuild.

## Tests and verification

- Each phase writes `scripts/pr-review-failures.md` entries first, then one e2e script per contract against a fake GitHub (`gh` stub) and a fake Arc plugin; no real provider.
- UI phases follow the verify skill with headless Chrome screenshots of the room, the tour and the confirmations.

## Decided

The chat's Coordinator starts the tour's scout (owner, 2026-11-23): the scout should carry the project and chat context, and the Coordinator can answer later questions about the map. The scout returns the map through a validated structured answer that the host stores; the Coordinator does not retype it.
