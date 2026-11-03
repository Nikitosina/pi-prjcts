# pi-prjcts domain

pi-prjcts runs long-lived coding agents for the owner's projects on Pi Durable. The owner gives work, then approves results; agents do the rest.

## Terms

- **Owner**: the single human who owns the host and its projects.
- **Project**: a repository checkout (Git or Arc) with its settings, models, knowledge and automations.
- **Host**: the one process that owns every project's durable storage and serves the web UI, CLI and Telegram.
- **Host agent**: the owner's agent over the whole host. It does through tools what the owner does in the browser: projects, chats, settings, automations, UI. It is not a Coordinator, owns no delivery and has no project or workspace.
- **Owner approval**: a dangerous host action (delete or archive a project, Approve, Deploy, revoking grants and devices, deleting files) requested by the Host agent or a Coordinator. It runs only after the owner approves it, exactly as stored, and the outcome goes back to whoever asked.
- **Chat**: a coordinator conversation in a project. A project has a main chat and may have more.
- **Coordinator**: the trusted agent in a chat that owns delivery. It investigates and makes changes directly in its own persistent workspace, or delegates work and judges the results.
- **Job**: one delegated request with its worker, plan and result. An independent Job delivers a PR for owner approval; a task helper returns its work to the Coordinator. A Job is not a pi-durable task.
- **Task helper**: a worker doing a subtask for its Coordinator, either in the chat's shared workspace or in an isolated workspace from a chosen commit. It returns changes and findings without needing its own PR.
- **Completed**: a task helper has returned control and an answer. This does not mean acceptance criteria passed, the result was independently verified or delivery was approved.
- **Agent roles**: coordinator, worker, scout, reviewer. The verifier role was retired on 2026-11-03; recorded verifier conversations still read.
  - **Worker**: implements one Job. An independent worker verifies the candidate itself with the project's verify skill and `projects_verify_run`, gets reviewed and reports Ready; a task helper returns its answer for the Coordinator to inspect and integrate.
  - **Scout**: read-only investigation.
  - **Reviewer**: read-only review of a pinned candidate.
- **Spawn**: starting an agent as a conversation owned by the spawning tool call. The Coordinator spawns workers, scouts and reviewers in the background; an independent worker spawns reviewers and scouts in the foreground. Task helpers leave further delegation to the Coordinator. Children of a worker cannot spawn.
- **Steer**: a message queued into a running agent's conversation, placed after its current tool round.
- **Dismiss**: clearing an ended Job or agent from the lists. Nothing is deleted.
- **Stop**: an explicit abort of an agent with a stated reason. Aborting drains everything the agent owns.
- **Candidate**: the exact commit the worker's verification runs and the reviewer judge.
- **Proof**: `projects_verify_run` runs, logs, screenshots and videos tied to a candidate, kept in the Job's artifacts.
- **Checkpoint**: an independent worker's intermediate handback while work is unfinished or needs a decision. It preserves the workspace and evidence for continuation, without offering Approve.
- **Ready report**: an independent worker's delivery report, distinct from an unfinished Checkpoint. It includes the PR, summary, proof, review findings, gaps and cumulative Job time and cost.
- **Approve**: the owner's one consequential action on a Job: merge the PR when mergeable, then pull the project's main checkout if it is clean.
- **Deploy**: restart the pi-prjcts host from its main checkout, with a smoke test and rollback. Separate from Approve.
- **Stall**: an agent with no transcript progress for a set time or an identical tool call with an identical result five times. A quiet background service alone is not evidence of stalled work. An agent waiting on an active subagent is not stalled.
- **Plan**: an agent's own list of steps with status and estimates, shown as progress and ETA.
- **Knowledge** (shown as **Memory**): durable project memory in `knowledge/`, read as three kinds, Preferences, Decisions and Procedures, plus a read-only Archive of legacy files. Not reviews, statuses or proof. Current preferences and a generated index go into every role prompt; the rest is read on demand.
- **Tier**: an ordered list of models stored host-wide; index 0 is preferred, the rest are the fallback order.
- **Profile**: a role's per-project settings: tier, thinking level and switched-off tools.
- **Archive**: read-only view of chats and transcripts from the pre-Job host.

## Pi Durable terms used as-is

Harness, conversation, entry, document, task, submission, extension, registry, agent. See `node_modules/@earendil-works/pi-durable/README.md`.
