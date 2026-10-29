# Lean runtime design

Implementation contract for the `lean-runtime` branch. Owner decisions live in `docs/lean-runtime-plan.md`; terms in `CONTEXT.md`. Where this file and the plan disagree, the plan wins.

## Core: Jobs on Pi Durable

Model the coordinator → worker relation on Pi Durable example 23 (persistent background subagents) and worker → subagent on example 22 (foreground subagent). Copies: `/tmp/retro-in/pidurable/23-subagent-background.ts`, `/tmp/retro-in/pidurable/22-subagent-foreground.ts` (pi-durable v1.0.0, matching our dependency).

- **Jobs document** on the project's root conversation (`projects.jobs`): one small record per Job: id, chat conversation id, title, owner request verbatim, acceptance criteria, status, worker conversation id, branch, PR, candidate sha, ready report fields (summary, proof refs, review result, not fixed, gaps), timestamps, stop reason. Never transcripts, instructions or tool output.
- **Coordinator `agents` tool** (replay unsafe, like example 23): `spawn` (role worker|scout|reviewer, brief, and for workers: title, acceptance, optional existing branch to continue), `send` (steer, or follow-up), `stop` (reason required), `status`, `wait` (ids). A worker spawn creates the Job record. Each child is owned by a background anchor task; a background reporter task delivers each answer, in full, to the chat as a follow-up input with a request id. No cap on the number of workers.
- **Worker `subagent` tool** (replay safe, like example 22): role verifier|reviewer|scout, brief; foreground; returns the child's final answer in full. Children get no spawn tools.
- **Worker `job` tool**: `plan` (steps with title, status, estimate minutes) and `ready` (summary, PR, candidate sha, proof refs, review result, not fixed with reasons, gaps). `ready` sets the Job to ready or ready-with-gaps; its report reaches the coordinator through the reporter.
- **Stop** aborts the anchor (with `{ background: true }` semantics); the ownership tree drains the worker and its subagents. Abort handlers of our tasks kill background process groups and release resource leases. A stop records its reason on the Job.
- **Steer** is `submit({ whenBusy: "steer" })` into the agent's conversation.
- **Restart**: pi-durable resumes everything; request ids keep spawn, delivery and reports exactly-once.
- Delete: `durable-planning.ts`, `durable-plan-types.ts`, `durable-workers.ts`, `durable-worker-tools.ts` admission/dependency/priority/retry machinery, the host verification cycle (freeze, criteria parsing, settlement, repair admission, exhaustion), synthetic work items for child results, result capping and paging.

## Verification and review (worker-owned)

- After implementing, the worker commits and pushes the draft PR, then spawns a fresh verifier on that candidate with the project's verify skill. Repair and repeat up to N rounds (project setting, default 3). No verify skill: the worker self-verifies and says so in the Ready report.
- Proof module: run a command with its log saved under the Job's artifacts, tied to the candidate sha; reject verdict evidence that references missing runs or files. The commit sha pins the candidate; no worktree content hashing or drift tracking.
- Automatic review after verification, before Ready: one fresh reviewer on the reviewer model with the owner's request verbatim, acceptance criteria, repository standards (AGENTS.md, CODING_STANDARDS.md), the pinned diff with full changed files, and the verifier's proof. At most ~8 findings with P0–P3, path:line and consequence. Fix P0 and P1 always; P2 only when it pays off long-term or is very cheap, else list under Not fixed with a reason; list P3. One re-check on the fix diff and open findings. Diffs over ~800 lines: Ready report suggests a manual three-axis `/pr-review`. The `pr-review` skill stays for manual use.
- After N rounds with gaps the coordinator judges: a genuine blocker goes to the owner; otherwise it spawns a worker on the same branch with only the gaps.

## Stall detector

Replaces the watchdog's verdict and prescribed actions. Follow the active leaf of each Job's ownership tree. Signals: no new committed entries or live tool output for N minutes (setting, default 20), the same tool call with the same result five times in a row, a background process with no output for N minutes. A worker in a foreground subagent call whose child is active is not stalled. Emit one notice per stall to the Job's chat with the last few steps; the coordinator decides. Never stops or steers by itself.

## Role profiles

Five short role prompts written positively, describing outcomes, following `/Users/nikitarat/.agents/skills/writing-for-agents/SKILL.md`. The workflow (spawn, verify loop, review policy, Ready report) lives in tool descriptions and these profiles once, not repeated. Owner prompt overrides keep working per project.

## Reads and live updates

- Transcript reader: page entries from the newest backwards with a fixed page size; previews built from bounded text, never `JSON.stringify` of whole results; images by reference.
- Binary results: MCP, simulator, uploads and image reads store bytes as Job or chat artifacts and put a reference plus a bounded model copy in the transcript.
- Change feed: subscribe to pi-durable `viewState`/`documentState`/watch and push typed topics (chat, jobs, knowledge, settings) to the browser; reads have no side effects. Remove 2-second rebuild polling.
- Archive: open an old host's sqlite read-only and page its chats and worker transcripts through the transcript reader; images load lazily.

## Approve, Deploy, Telegram

- Approve (result acceptance module): approved head → merge when mergeable (or enable auto-merge and finish when it merges) → pull the main checkout if clean and on its default branch → report outcome (merge uncertain / merged, pull skipped with reason / accepted). Same flow for Git (gh) and Arc (plugin capability). Coordinator's raw merge path goes away.
- Deploy (host lifecycle module): record sha; `npm ci` if the lockfile changed; `npm run check`; graceful stop; start; smoke (health, every project opens, Telegram polling, web UI loads); on failure check out the recorded sha, restart, message the owner. Triggers: button, and "deploy when idle" (no running Job in any project) within a window (default 02:00–07:00).
- Telegram keeps its core. Add the Approve inline button on the Ready message, a per-Job plan-progress message edited in place, and stall notices only when the coordinator forwards them.

## UI

Sidebar: projects → chats → Jobs. A Job expands into its worker and subagents (conversation tree, owner decision 2026-10-28), each with plan progress and ETA; a node opens its transcript. Approve button on the Ready message once mergeable. Deploy button and idle-deploy settings in host settings. `web/app.js` is split into feature modules (chat, settings, jobs and decisions, knowledge and uploads, notifications, shell with plugin hosting).
