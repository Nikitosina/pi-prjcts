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
