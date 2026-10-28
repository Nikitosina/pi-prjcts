# Saves and verification cycles: failure modes

Covered by `scripts/worker-quota-verification-save-e2e.mjs`.

## Failures the assertions catch
- Exhausted verification budget, a pending verifier or a paused worker is changed by a recovery.
- A cycle is mutated by recovery.
- A quota-waiting repair turn in an open cycle with budget left is not recovered on the fallback.
- A quota-waiting worker with a verifier still pending is recovered anyway.

## Notes
Builds persisted fixtures and calls the planning recovery directly. It does not run a real verifier.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
