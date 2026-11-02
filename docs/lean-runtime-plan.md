# Lean runtime: owner decisions and plan

Branch `lean-runtime`, worktree `~/Projects/pi-prjcts-next`. Goal: move pi-prjcts from in-the-loop (owner prompts, polls, unblocks) to near-the-loop (owner gives a task, later approves a ready result).

## Problems this branch fixes (retro of projects-dev, Oct 22–28)

- Host-owned verifier cycle turns unfinished work into permanent `blocked` workers (41 of 41 blocked workers).
- Role prompts are long and prohibition-heavy; briefs, notes and verdicts copy that jargon.
- Review churn (PR29: 5 static rounds × 3 axes) and watchdog false positives (37 workers superseded by steering).
- 63 of 157 e2e scripts fail on main behind `knownFailing`; 85KB DURABLE.md; no AGENTS.md.
- Slow UI: 246MB durable.sqlite with inline base64 images; planning doc with 2,568 revisions and every work item.
- Owner round-trips for merge, pull and restart.

## Owner decisions (2026-10-29)

1. **State**: fresh start. Carry project config, models, settings, knowledge/, preferences, automations and plugins. Provide a read-only archive of old coordinator chats and worker transcripts, with images lazy-loaded.
2. **Telegram**: the new host owns the bot during the trial. Keep the Telegram core as is; improvements may be proposed.
3. **Builder**: built from an outside Pi session with subagents, not by the pi-prjcts coordinator.
4. **Tests and docs**: delete what covers removed code or is known-failing; fix the rest to green; remove `knownFailing`. Replace DURABLE.md with a short architecture doc and add AGENTS.md.
5. **Verification**: the worker spawns a fresh verifier (project verify skill) after finishing, repairs, and repeats up to N rounds (default 3, per project). After N it returns "Ready with gaps" with proof to the coordinator. No host-owned cycle, no `blocked` state.
6. **Approve**: merges the PR and pulls main automatically. Redeploying pi-prjcts is separate: a Deploy button plus a "deploy when idle" toggle with a time window; restart only when no project has running work; auto-rollback on failed smoke test.
7. **Roles**: keep coordinator, worker, scout, reviewer, verifier. One review per PR plus at most one re-check after fixes; three-axis review only on request.
8. **Watchdog**: code detects only hard stalls (no new transcript entries for N minutes, identical call with identical result 5+ times, hung process). The coordinator gets a notice with the last steps and decides freely; leaving the worker alone is the default. Never stops automatically.
9. **Jev / TypeSafe**: out of scope for now.
10. **Architecture**: run improve-codebase-architecture on this branch before the rewrite; its findings shape the module split.
11. **Architecture candidates accepted (2026-10-29)**: all 15 candidates of the architecture review (thread execution, execution lifetime, proof module, role profiles, stall detector, transcript reader, change feed, settings application, web/app.js split, result acceptance, deploy lifecycle, workspace lifecycle, binary result retention, skill-grant retirement, event and question delivery).
12. **Review**: the owner can still run `/pr-review` with three axes manually. The single automatic review needs a careful design for quality; it is settled in the design grilling below.

## Design grilling, round 1 (2026-10-29)

- **pi-durable vocabulary.** A pi-durable *task* is a harness step (model request, tool call, compaction, extension task) in one ownership tree with conversations. Our owner-facing unit gets another name (proposed: Job) so the two never collide. A spawned thread is a conversation owned by the spawning tool call; coordinator → worker spawns are background, worker → verifier/reviewer/scout spawns are foreground. Stop is an abort of the owning task; the ownership tree drains children; we add process and lease cleanup in abort handlers. Steering is `submit({ whenBusy: "steer" })`. Exactly-once spawn uses `requestId` and replay-safe spawn tools.
- **Spawning.** Async spawn with the child's final answer delivered in full as a message to the parent, plus a `wait(ids)` tool. The parent reads the child's transcript only on demand.
- **Nesting.** Two levels: coordinator spawns worker, scout, reviewer; worker spawns verifier, reviewer, scout; those children cannot spawn.
- **Concurrency.** No worker cap. Quota fallback stays.
- **Steering.** A steer is a message into the running conversation; stop is explicit, with a reason shown in the UI.
- **Automatic review.** The worker runs it after the verifier passes and before Ready, with one re-check. One fresh reviewer on the project reviewer model gets the owner's request verbatim, acceptance criteria, repository standards, the pinned diff with full changed files and the verifier's proof; at most ~8 findings, each with P0–P3, path:line and consequence. P0 and P1 are always fixed. P2 is fixed only when it pays off long-term or is very cheap; otherwise it is listed under "Not fixed" with a reason on the Ready card. P3 is listed only. The re-check covers the fix diff and open findings. For diffs over ~800 lines the Ready card suggests a manual three-axis `/pr-review`.
- **Watchdog.** Stall detection follows the active leaf of the ownership tree: a worker waiting on an active subagent is not stalled; a stalled subagent is named in the notice.
- **Plan indicator.** A `plan` tool writes steps (title, status, estimate in minutes) to a document on the Job; UI and Telegram subscribe. ETA = remaining estimates scaled by observed estimate accuracy.
- **Build.** Rewrite in place on this branch, deleting old modules as replacements land; no feature flag.
- **Gaps.** After N verifier rounds the coordinator judges: a genuine blocker goes to the owner; otherwise it spawns a worker on the same branch to fix the gaps.

## Design grilling, round 2 (2026-10-29)

- **Job** is the owner-facing unit (one owner request or trigger with its worker, subagents, PR and proof), in code, UI and Telegram.
- **PR.** The worker opens a draft PR at its first commit and marks it ready at Ready.
- **Approve** is identical for Git and Arc: merge (immediately when mergeable, otherwise as soon as it becomes mergeable), then pull the main checkout if it is clean and on the default branch; otherwise skip the pull and say why.
- **No Reject.** An Approve button appears (web and Telegram) once the PR is ready to merge. To request changes the owner just writes in the chat.
- **Knowledge** keeps preferences, runbooks and decisions only. Review reports, verdicts and proof go to the Job's artifacts. Carry over preferences.md, runbooks/ and decisions/; leave plans/, research/legacy and notes.
- **No verify skill:** the worker self-verifies and the report says "No independent verification — add a verify skill". With a skill, default 3 verifier rounds, per project.
- **Ready report** is a regular coordinator message (and Telegram message), not a card: PR link, 3-line summary, inline proof media, review result and Not fixed list, gaps, time and cost, with the Approve button attached once mergeable.

## Deployment

Run this branch as a separate host with `PI_PROJECTS_HOME=~/.pi/agent/projects-next` for 1–2 days of owner refinement. Rollback: stop it, start the old host on `projects-dev`. Promote: merge `lean-runtime` into main.

## Near-loop shape (target)

Work item lifecycle: Ask → Running → Ready (PR, proof, 3-line summary) or Ready with gaps → owner Approve (merge + pull) or Reject with comment. The coordinator contacts the owner only for consequential architecture or product decisions. Triggers (PR follow, webhook, schedule, Telegram) create work items.

## Decisions 2026-10-29 (final review)

- Delete operation approvals (exact VCS operation inbox). Worktree cleanup stays as the Settings button; branch deletion is the owner's shell action.
- Delete Follow PRs auto-merge and its reviewer. Approve is the only merge path. Follow PRs auto-fix stays.
- Delete per-PR monitors. Follow PRs and PR watch cover CI and merge state.
- Keep worker GitHub publication tools with receipts for the trial; revisit after it.

## Trial (started 2026-10-29)

- Host: launchd `dev.pi-projects.host.3c435db9`, checkout `~/Projects/pi-prjcts-next` (branch `lean-runtime`), home `~/.pi/agent/projects-next`, Arc plugin clone `~/Projects/projects-arc-plugin-next` (branch `lean-runtime`). It owns the Telegram bot and the relay identity.
- Old host: launchd `dev.pi-projects.host.11a08742` booted out and disabled; `~/.pi/agent/projects-dev` untouched and readable in Archive.
- Rollback: `launchctl bootout gui/$(id -u)/dev.pi-projects.host.3c435db9; launchctl enable gui/$(id -u)/dev.pi-projects.host.11a08742; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.pi-projects.host.11a08742.plist`.
- After the trial: PR `lean-runtime` → main; merge the plugin clone's `lean-runtime` into the live plugin repo after the owner commits or stashes their uncommitted work there.

## Trusted Coordinator decision (2026-11-02)

The owner approved replacing the coordinator-as-dispatcher rule with a normal trusted Pi-style agent that owns delivery and chooses whether to work directly or delegate. This supersedes the earlier coordinator prohibition on source edits.

- Give coordinators standard read/edit/write/bash execution, configured MCPs and skills, with browser automation through installed commands or configured MCPs.
- Keep a persistent worktree per chat, separate from the owner's checkout and workers. Preserve existing allocation grants and provider ownership; show missing/unsupported workspace prerequisites explicitly.
- Delegate substantial or independent work, not every change. Investigation may finish with findings and evidence without creating a Job or PR. Independent reviewers remain static readers.
- Remove the coordinator shell allowlist. Commands run as the host user, not in a sandbox. Merge, deployment and destructive operations still require explicit owner approval as behavioral rules.
- Show the selected chat's actual offered tools, worktree and practical restrictions in the UI. Do not mistake a prompt instruction for a tool grant.

## Coordinator-selected worker workspaces (2026-11-02)

After PR33 was opened, the owner clarified that one Coordinator chat owns a large task and completes smaller steps iteratively. The owner approved choosing shared or isolated worker workspaces per spawn, preparing the environment and integrating worker results in the task branch. This supersedes mandatory separation of every worker from its Coordinator and mandatory worker PRs for task helpers. Independent Job/PR delivery remains available.

- A shared helper borrows the spawning chat's actual persistent workspace, including prepared dependencies and dirty/untracked files. It does not own or release that allocation.
- An isolated helper gets a fresh workspace and branch from an explicit chosen commit. Uncommitted files and dependencies are not implicitly copied.
- The Coordinator drains its writes before a shared handoff and waits for the worker to settle before resuming mutations. Shared work is a single-writer handoff, not a sandbox or a general parallel-write scheduler.
- Helpers finish by returning their answer. Completed means control returned, not independently verified or accepted delivery. No worker PR or Ready report is required.
- The Coordinator inspects changes, integrates isolated branches and verifies the combined result. It can delegate static review of a committed candidate; dirty shared changes are not a pinned snapshot.
- Integrating worker branches into the task branch is ordinary task work. Final merge to main, deployment, destructive actions and new authority still require owner approval.
- Missing grants, invalid ownership and unsupported isolated provider capabilities fail visibly. There is no fallback to the owner's checkout or provider trunk.
- This decision does not authorize merging PR33, deploying it, restarting the live host or publishing the private Arc plugin.

## Quiet coordinator chat (2026-11-02)

The owner approved removing service chatter from the main conversation and reducing unnecessary Coordinator invocations.

- Show owner and Coordinator messages in the main chat. Keep worker reports, evidence and actual Ready approval in separate worker details.
- Send concise worker handbacks; retain full evidence for explicit reads. Do not append a repeated closing answer to a structured Ready report.
- Suppress repeated notices for the same stall; a quiet background service is not proof that an agent making progress is stalled.
- After asking for an owner decision, end the turn without sending acknowledgment-only wait messages. New actionable results and failures must still reach the Coordinator.
- The owner explicitly chose a separate `job checkpoint` action for an independent worker's unfinished stage. It retains the branch and evidence, notifies the Coordinator once, offers no Approve action, and continues through new instructions to the same worker. It is not a host-owned blocked workflow.
- Changes and verification run privately. This decision does not authorize deploying or restarting the running host.
