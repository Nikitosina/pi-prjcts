# Role prompts and review delivery

`src/role-prompts.ts` owns five editable defaults and the shared authority, evidence and decision rules. `durable-runtime.ts` assembles the effective text with project identity, repository standing instructions, role skill indexes, grants, plugin rules and generated workspace bindings. The shared rules stay outside overrides. `verification-model.ts` owns the verifier's mandatory evidence, cleanup and structured-verdict protocol, which stays appended even with a customized verifier role prompt.

Settings exposes all five roles through `prompts-snapshot`. Prompt overrides remain per-project and are merged by key; adding or resetting the verifier does not replace an owner's other custom prompts. Existing worker threads keep their frozen prompts. Reload and reopen retain the existing lifecycle rules. Changing role prose grants no tools or execution authority.

## Delivery policy

The coordinator delegates implementation and drives pinned static review, fresh runtime verification and same-worker repairs. Explicit owner conversation requirements qualify as the source spec and survive repair iterations. Actionable gaps remain pending work. The coordinator asks the owner for consequential choices, missing authority, genuine blockers or exhausted host verifier budgets, not approval for routine reversible repairs.

This is prompt policy, not a new orchestration engine. Model compliance is not guaranteed by prose. The existing host verifier still owns its persisted three-attempt budget, selected model and skill, drift checks, background shutdown and worker freeze through settlement. Static review does not consume or replace runtime verification. Screenshots alone are not functional proof.

## Repository skills

The repository ships `pr-review`, `code-review` and `ask-user` under `.agents/skills`. No global skill is edited. Pi's actual resource loader selects repository-local names ahead of global names, including a same-named configured package skill, as tested by `repo-skill-overrides-unit`. These overrides apply when this repository is the project or an applicable ancestor; they do not silently replace skills in unrelated projects. Project `.pi` skills or explicit resource configuration may take precedence under the existing SDK rules.

The review skills keep Standards, Spec and Bugs/performance independent. All axes are admitted before awaiting results; normal worker-cap queueing is valid. Completed identical rounds can be reused, but new requirements, different coverage or incomplete results justify a fresh same-head round. Reviewers read pinned code and report evidence limitations without running or repairing the target. Complete results must be read through pagination. Posting requires separate approval.

Published PR reviews use coordinator-root admission with the full revision read target. Child reviewers normally read the parent's live worktree, so their handoff must supply complete pinned source contents or return the candidate to the coordinator for immutable-root review. Callers without write tools delegate snapshot and handoff preparation to an authorized worker. Skill readers address sibling skills by name because relative paths cannot escape the selected skill directory.

The host admits up to three active child reviewers when all active children are reviewers. Mixed and implementation child work retains its two-child bound. The normal project worker cap still controls execution; no extra execution slots or authority are added.

Arc collection preserves the existing Arc/Arcanum workflow and ships its collector and Bugs/performance reference locally. Snapshot directories must be fresh and are made read-only rather than overwritten. Arc commands were checked against the installed Arc skill but were not exercised against a live Arcadia checkout.

## Focused regression coverage

- `role-prompts-e2e`: actual model-request text for all five roles, host context and tool sets, live local skill reads and explicit invocation, three-axis admission at cap one, fourth-reviewer refusal, verifier customization and reset preserving other overrides.
- `repo-skill-overrides-unit`: real SDK discovery with global and configured-package collisions, automatic and explicit invocation, and local reference graph.
- `workspace-defaults-e2e`: five prompt editors, pointer/native input saving and reloading verifier text, server-state confirmation, reset and screenshots.
- `quiet-coordinator-e2e`, `nested-subagents-e2e`, `review-target-e2e` and `skill-reload-runtime-e2e`: existing result routing, queue bounds, pinned targets and reload/frozen-prompt behavior.
- Verification unit, loop, recovery and trusted-browser scripts cover the retained host verifier lifecycle.

Fake-provider tests prove prompt assembly, tool routing, storage and browser behavior, not live model judgment or guaranteed autonomous adherence to policy.
