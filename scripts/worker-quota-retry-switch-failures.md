# Manual retry and fallback changes while capacity is occupied: failure modes

Covered by `scripts/worker-quota-retry-switch-e2e.mjs`.

## Failures the assertions catch
- A manual retry discards a fallback saved earlier, and the primary model runs again when capacity returns.
- A fallback removed after the retry is used anyway.
- A quota-failed record revived by a save behind an occupied slot keeps its failed-origin restoration after an accepted manual retry, so removing the fallback and freeing the slot restores the failure instead of running the retry.
- Replaying the same retry request id runs another attempt or restores the failure.
- A later save does not recover the work on the current fallback.

## Notes
The sweep timer is set to one hour so recovery depends on dispatch, not on a timer.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
