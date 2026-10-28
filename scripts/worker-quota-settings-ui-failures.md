# Quota settings UI: failure modes

Covered by `scripts/worker-quota-settings-ui-e2e.mjs`.

## Failures the assertions catch
- The settings dialog does not explain that fallback changes apply to existing threads, or omits the pause and stop guard.
- Per-role fallback choices are not offered or do not persist (the rest of the script's assertions).

## Notes
This is a browser check of the text and the controls. It does not recover any work. Recovery is covered by the `worker-quota-*` API scripts and the `quota-save-recovery` browser journey.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
