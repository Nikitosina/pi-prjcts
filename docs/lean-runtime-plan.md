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

## Deployment

Run this branch as a separate host with `PI_PROJECTS_HOME=~/.pi/agent/projects-next` for 1–2 days of owner refinement. Rollback: stop it, start the old host on `projects-dev`. Promote: merge `lean-runtime` into main.

## Near-loop shape (target)

Work item lifecycle: Ask → Running → Ready (PR, proof, 3-line summary) or Ready with gaps → owner Approve (merge + pull) or Reject with comment. The coordinator contacts the owner only for consequential architecture or product decisions. Triggers (PR follow, webhook, schedule, Telegram) create work items.
