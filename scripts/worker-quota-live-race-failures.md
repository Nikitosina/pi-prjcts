# Saves racing with a busy worker slot: failure modes

Covered by `scripts/worker-quota-live-race-e2e.mjs`.

## Failures the assertions catch
- Concurrent saves with the same revision both win, or neither does.
- Queued recovery switches the model before capacity is available.
- A changed fallback is not the one used at dispatch, or is used twice.
- A removed fallback is still used when capacity returns.
- A restart runs pending recovery by itself, or a later explicit project resume applies the fallback more than once.

## Notes
Uses a one-slot worker cap held by a blocking request. Timing is controlled by that request, not by sleeps, except one short wait to show that nothing runs.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
