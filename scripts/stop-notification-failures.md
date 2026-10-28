# Stop notification: failure cases

Owner report: after "Verification did not pass: Stopped explicitly" and "Stopped with its parent worker" the coordinator got no message and treated the workers as still running. `scripts/stop-notification-e2e.mjs` checks these with a fake model on an owned host.

1. Stopping a running worker sends the coordinator chat nothing, so it waits for a result that never comes.
2. Stopping a worker while its verifier runs sends nothing, or sends one notice per thread (worker and verifier) instead of one coherent notice.
3. Stopping the verifier directly sends nothing, sends a verifier success, or wakes the waiting worker as if a verdict had arrived.
4. Stopping a thread whose work is only queued (cancellation) sends nothing.
5. The notice lacks the work id, thread id or reason, or reads like a finished result, an ordinary failure or an exhausted cycle.
6. The notice arrives before the drain ends (thread still stopping, verifier settlement still open), so the coordinator acts on a tree that is not released.
7. A paused project delivers the notice while paused, or never delivers it after resume.
8. A busy coordinator loses the notice instead of getting it after its current turn.
9. A restart delivers the notice twice, or loses one that was admitted but not delivered.
10. Stopping an idle thread (nothing queued or running) sends a notice about work that had already reported.
11. A child stopped with its parent sends its own notice besides the parent's.
12. A parent worker whose turn already returned while its children run (its answer is held, no verification started) is stopped: the children are cancelled, but nothing reports, because the parent has no running work of its own. Its held answer stays "completed" as if final, or the notice claims a verification was stopped. Verification off must report too.
