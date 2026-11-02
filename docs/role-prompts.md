# Role prompts

`src/role-prompts.ts` owns the five editable defaults (coordinator, worker, scout, reviewer, verifier) and `SHARED_ROLE_RULES` (authority, evidence, decisions), which stay outside overrides. `durable-runtime.ts` assembles the effective text with project identity, repository standing instructions, skill indexes, plugin rules and workspace bindings. Overrides are per project and merged by key; changing role prose grants no tools or authority. Existing agents keep their frozen prompts.

Each prompt states the outcome the role owns, not a procedure:

- Coordinator: owns delivery, investigates and makes small changes directly in its persistent chat worktree, and delegates substantial or parallel work with `agents`. Investigations need no Job or PR. It chooses shared or isolated workspaces for task helpers, prepares the environment and integrates their results into its task branch. Its unrestricted shell is trusted local execution; final merge to main, deployment and destructive actions still require explicit owner approval.
- Independent worker: owns one Job from request to Ready. It plans with the `job` tool, builds, records the candidate commit, proves it with a fresh verifier up to the project's round limit, has an independent reviewer look at the diff, and reports with `job ready`; unproven criteria are reported as gaps. Unfinished stages or work held for a decision use `job checkpoint`, not Ready. After either recorded report it ends with a short acknowledgment, without copying the report into its answer.
- Task helper: works in its explicitly selected shared or isolated workspace and returns its answer normally. It reports changed files, checks, artifacts, gaps and integration instructions without publishing a worker PR. The Coordinator judges the return and delegates any pinned independent review. Shared helpers preserve the prepared environment and task branch. Explicit owner worker instructions still apply, but the fixed helper contract replaces independent PR/Ready requirements and retains the shared authority rules.
- Scout: read-only investigation with sources.
- Reviewer: reads pinned code and reports findings with evidence; never edits.
- Verifier: runs the project's verify skill against the candidate with `projects_verify_run` and reports per criterion what is proven, with run ids.

After asking the owner for a decision, the Coordinator ends its turn without acknowledgment-only messages to workers. It still processes new results and failures, but reports to the owner only when the result, blocker or decision changes. Compact handbacks point to `agents report` for the full evidence; a short notification is not proof of acceptance.

Independent Job verification and review are worker-owned. The host checks that a Ready report's proof ids are passing runs on the candidate commit. A task helper's `completed` status only means it returned control and an answer. It is not a verification verdict or approval.

Coverage: `durable-runtime-e2e` (quiet-wait and checkpoint instructions in actual model requests), `jobs-e2e` (engine), `repo-skill-overrides-unit` (skill discovery). Instruction checks do not prove that a real model will follow them.
