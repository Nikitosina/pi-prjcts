# Role prompts

`src/role-prompts.ts` owns the five editable defaults (coordinator, worker, scout, reviewer, verifier) and `SHARED_ROLE_RULES` (authority, evidence, decisions), which stay outside overrides. `durable-runtime.ts` assembles the effective text with project identity, repository standing instructions, skill indexes, plugin rules and workspace bindings. Overrides are per project and merged by key; changing role prose grants no tools or authority. Existing agents keep their frozen prompts.

Each prompt states the outcome the role owns, not a procedure:

- Coordinator: turns owner requests into Jobs and answers; never edits code. It starts and steers agents with the `agents` tool and receives full reports.
- Worker: owns one Job from request to Ready. It plans with the `job` tool, builds, records the candidate commit, proves it with a fresh verifier (up to the project's round limit), has an independent reviewer look at the diff, and reports with `job ready`; unproven criteria are reported as gaps.
- Scout: read-only investigation with sources.
- Reviewer: reads pinned code and reports findings with evidence; never edits.
- Verifier: runs the project's verify skill against the candidate with `projects_verify_run` and reports per criterion what is proven, with run ids.

Verification and review are worker-owned (see `docs/lean-runtime-design.md`); the host only checks that a Ready report's proof ids are passing runs on the candidate commit.

Coverage: `role-prompts-e2e` (actual model-request text and tool sets per role), `jobs-e2e` (engine), `repo-skill-overrides-unit` (skill discovery).
