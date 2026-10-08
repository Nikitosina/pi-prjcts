# Worker watchdog (C12): failure cases, written before implementation

Verified by `scripts/watchdog-e2e.mjs` unless marked (inspection).

## Timer
- D1 Ticks while no worker runs (idle project wakes the coordinator every N minutes, burning tokens).
- D2 Ticks while the project is paused, or while a settings/lifecycle transition closes the runtime.
- D3 Duplicate ticks: two timers (reopen, restart, settings change) or a re-sent submission produce two watchdog turns for one interval.
- D4 Not durable: a restart resets the interval (never fires on a host that restarts more often than N), or a tick claimed before a crash is lost/resent twice.
- D5 Interval or off switch not configurable in Settings; changing it needs a restart.
- D6 Default not 15 min / not on.

## Digest
- D7 The digest omits runtime, last tool calls, errors, repeated identical calls, tokens since last check or files changed.
- D8 The digest is unbounded (whole transcripts) and inflates the coordinator context.
- D9 Repeated identical calls are not detected (same tool + same arguments), so a looping worker looks busy.
- D10 Tokens since last check are cumulative (never reset per check) or crash on messages without usage.
- D11 Files changed reads the owner's checkout instead of the worker's worktree, or a missing/cleaned worktree throws and kills the tick.
- D12 Children and parents are mixed up (child digest attributed to parent), or queued (not running) work is included.
- D13 The digest does not say whether the worker was already steered since the previous check, so the coordinator cannot escalate to stop.

## Coordinator behaviour
- D14 Watchdog turns write to the owner (essay per tick) or notify ("Finished" in the feed / Telegram).
- D15 Watchdog turns count as worker reports or trigger the quiet-coordinator "final summary".
- D16 The coordinator is not told the escalation policy: steer first with a concrete nudge, stop + redispatch/rescope if still unproductive at the next check, leave healthy workers alone, tell the owner only in the final report or via needs-you.
- D17 Watchdog turns go to a random chat instead of Main / the events chat; an archived events chat breaks delivery.
- D18 A tick while the coordinator is busy interrupts (steers) the owner's turn instead of queueing behind it.

## End-to-end
- D19 A scripted looping worker is never steered, or is stopped without a steer first.
- D20 After the steer the still-looping worker is not stopped and redispatched.
- D21 A healthy worker running in parallel is steered or stopped.

## Resume + restart race (D22; found as a flake: "Project plan is paused; admission is denied" right after resume + restart)
- D22 Root cause: resume requeues the work the pause interrupted (`requeuePauseInterrupted`); work is then `queued`/`running` again. Restarting the host in that window makes open-time recovery (`src/durable-runtime.ts` ~:486: queued/running work or pending inputs) pause the project again, so the next send is denied. This is the designed crash recovery, but the E2E raced it: after D2 it waited for "no running" work, which is also true while work is merely `queued`, then restarted.
- D22a The E2E waits only for `running` to clear, so queued work survives into the restart (fixed: wait for no queued/running).
- D22b Settled work + resume + restart must always admit a send (looped 3x, deterministic).
- D22c Work still active at the restart must come back paused with a denied send (by design), and an explicit resume must admit again.
