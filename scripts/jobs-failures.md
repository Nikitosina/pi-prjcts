# Jobs report delivery failures

- A Ready wakeup repeats the closing answer and all evidence instead of a concise handback; full details must remain available through `agents report` without waking the worker.
- A long helper, scout, failure, Ready or checkpoint answer becomes an unbounded notification; notification previews must be explicitly marked, retain actionable status and point to the exact unabridged report.
- Reading an older notification after another Ready or helper answer returns the latest evidence instead of the original full report; report references must be immutable and conversation-scoped, including failures before preparation.
- A checkpoint is mistaken for Ready or failure, becomes approvable, or resumes without a new instruction after restart or project resume.
- Ordinary steers rearm an unchanged stall; a quiet background service wakes the coordinator despite visible execution progress.
- A recovered worker cannot raise a genuinely new stall, or an actionable helper answer is suppressed while the coordinator awaits the owner.
- A queued stall survives the worker's completion and consumes the next coordinator request; retract only still-queued obsolete stall submissions, never placed inputs or real results.

- Two steers answered by the same turn must not post duplicate failure reports to the coordinator.
- The newest steer must settle the agent and Job and post the full Ready payload, whether the oldest or newest reporter sees their shared answer first.
- A shared quota failure must start one recovery path, not one per reporter.
- Repeating `agents send` with the same request id must deliver one message.
- Distinct follow-up answers, Ready reports, restart continuation and stop must retain their existing behavior.
