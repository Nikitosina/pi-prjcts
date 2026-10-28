# Mixed settings save with a fallback: failure modes

Covered by `scripts/worker-quota-mixed-save-e2e.mjs`.

## Failures the assertions catch
- A save that changes the fallback together with a non-live setting (the name) closes the idle runtime and saves without recovering quota-failed work.
- Such a save in a paused project resumes work, or fails to save the settings.
- Such a save revives work twice, or touches an unrelated failed (authentication) or healthy completed record.

## Notes
Quota-failed state is produced by editing persisted state in a disposable project. The sweep timer is set to one hour, so only the save can cause recovery.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
