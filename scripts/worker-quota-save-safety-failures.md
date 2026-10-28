# Saves must leave unrelated work alone: failure modes

Covered by `scripts/worker-quota-save-safety-e2e.mjs`.

## Failures the assertions catch
- A save restarts stopped work, including stopped quota-waiting work.
- A save revives quota-failed work whose idle thread was stopped.
- A save touches unrelated failures or healthy completed work.
- A save interrupts or redirects healthy running work.
- A save runs work while the project is paused.
- Eligible quota-failed work is not recovered on its same thread.

## Notes
Each case checks status, task and model before and after the save.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
