# Failure cases before implementation

- Scoped scout/reviewer delegation rejected despite coordinator-selected profile.
- Worker answer never reaches coordinator; failed tasks disappear silently.
- One held sibling delays another worker's completion notification or next queued task.
- Restart replays notification, or loses a report admitted before the crash.
- Pause admits new report generations or drains report waits under a lock.
- Resume misses deferred reports.
- Existing terminal work predating reporting unexpectedly starts a real-model run on host open.
- Follow-ups reuse the same report ID and lose later results.
- Worker report is treated as authority or verified evidence.

Verify using an isolated host and local fake model, retain JSON results and browser screenshots. Never submit to the existing dev project automatically.
