# Legacy quota-failed records without fallback metadata: failure modes

Covered by `scripts/worker-quota-legacy-save-e2e.mjs`.

## Failures the assertions catch
- A persisted quota failure with no `quotaFallback` and no `quotaRecovery` is not recovered by a later save.
- Recovery creates a new thread or loses the original cwd, instructions or tool names.

## Notes
The legacy record is produced by editing persisted state in a disposable project, not by an old release.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
