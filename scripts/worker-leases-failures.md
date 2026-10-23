# Failure modes: shared-resource leases, background commands, runbooks

Written before the code. E2E: scripts/worker-leases-e2e.mjs (fake model, git project, two workers). Leases are advisory coordination.

## Leases (host-wide, in memory)
1. Two workers take the same resource (simulator): the second MUST get a clear "held by thread X (project P) until T" answer, not a silent share; with wait it queues FIFO for a bounded time and is granted when the first releases; a wait that times out returns the holder answer, never hangs the tool.
2. Holder settles, is stopped, paused or crashes without releasing: the lease MUST be freed (and a queued waiter granted) without the model's help.
3. Holder forgets forever: TTL expiry frees it (and grants the next waiter); a renewed acquire by the holder extends, never duplicates.
4. Waiter's work is stopped while queued: it MUST leave the queue (no grant to a dead worker, which would block everyone until TTL).
5. Release of something not held, or held by another thread: must not free the other thread's lease.
6. Resource name abuse (empty, long, path-like, control chars) and absurd TTL/wait: rejected by schema.
7. Host restart: no lease survives (in-memory); closing a project runtime frees its leases and waiters.
8. Coordinator cannot see who holds what: worker snapshot (projects_workers) and plan snapshot (UI card) MUST list held leases per thread; settled threads show none.
9. Workers not offered the lease tools in the scopes that have no worktree is acceptable; coordinator must NOT be offered them.

## Background commands (per thread, in the worktree)
10. Command that policy denies (git push to main, publishing commands...) MUST be rejected at start, nothing spawned, no id.
11. Over the per-thread cap (3 running): rejected with a clear message; finished ones do not count.
12. Output unbounded: goes to a log file under the thread artifacts (not host memory); status returns only a capped tail (lines and chars); log growth is capped (process killed past the limit).
13. status/stop for an unknown id or another thread's id: error, never touches the other thread's process.
14. Stop kills the whole process group (children), escalates to SIGKILL; stop of an already exited command is harmless.
15. A worker turn ending (work settles) MUST NOT kill the command; a follow-up turn can poll it. Thread stop, work archive and runtime close MUST kill it.
16. Host crash leaves orphans: on next runtime open, records still "running" whose pid still matches the recorded start time are killed; a reused pid with a different start time MUST NOT be killed.
17. Exit code and signal reported accurately (0, nonzero, killed).
18. Command text/label abuse (empty, huge): rejected by schema.

## Runbooks
19. Instruction text only: coordinator and worker instructions tell them to read `runbooks/` before builds/simulators and to record the working method after resolving an environment problem; existing asserted phrases remain.

## Waiting for a background command (found in a 103M-token chat: 36 sleep+tail polling turns, each replaying the full context)
20. A worker that needs a build result polls with `sleep N; tail` or repeated `projects_bg_status`; each poll is a model turn. `projects_bg_status` with `waitSeconds` returns when the command ends, with its state, exit code and capped tail.
21. A wait (at most 120 s, under the tool timeout) that outlives the command's end keeps waiting until the timeout: the wait MUST resolve on exit, on `waitSeconds`, and on abort (thread stop), and release its timer and abort listener in all three cases.
22. A wait on a command that already ended, or whose record is `lost`, returns at once.
23. Each poll resends the same output: `after` (a log byte offset, the previous `logBytes`) returns only newer output, still capped by tailLines, bytes and chars; an offset past the end of the log returns the normal tail.
22b. A wait returns only after the command's output pipes drained, never at the process exit alone (the tail would miss its last lines).
24. A wait on another thread's id, or an unknown id, fails with the same error as a plain status before any waiting, and the other thread's command keeps running.
25. `waitSeconds` outside 1..120 and a negative `after` are rejected by the schema; calls without them behave as before (F17).
26. Worker instructions still say to sleep and tail; they point at `waitSeconds`.
27. `tailLines: 0` returns an empty tail (it returned the whole capped tail through `slice(-0)`).
28. A wait called between the process exit and the close of its pipes still waits for the drain (the wait is on the close, not on `state`).
29. SDK boundary, not enforced here: the tool-argument validator truncates a fractional integer (`after: 1.5` becomes 1) instead of rejecting it; negative and out-of-range values are rejected.
