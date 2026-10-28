# Saving a fallback while a worker waits on quota: failure modes

Covered by `scripts/worker-quota-live-save-e2e.mjs`.

## Failures the assertions catch
- A save does not resume the waiting worker, or resumes it more than once.
- The resumed attempt is on a different thread, or the model transition is not recorded.
- The fallback attempt loses the frozen instructions or tool list.

## Notes
Covers the browser-independent save path through the settings RPC.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
