# Quota save recovery

Check whether saving a worker fallback recovers work that already hit a provider quota error.

## Sub-features

- Existing quota-failed or quota-waiting work, browser settings save, and attempt/model evidence.

## How to get to it (user POV)

- Open project settings and save a worker quota fallback after work hits quota.

## Driving it with browser CDP

`verify.mjs drive --run <scratch> quota-save-recovery` submits disposable work through the private host setup API. The fake provider returns a 429 for the marked primary-model work. The journey waits for quota-failed or quota-waiting state, saves the fallback through the browser, and checks the same thread and fallback model in the read-only plan. It records provider requests and screenshots. Inspect screenshots before claiming visual proof.

## Gotchas

- Run doctor first and clean up after every attempt. Never use an owner host.
- This requires production support for applying a saved fallback to existing work. A timeout is a failure, not proof of recovery. Settings persistence alone is not this proof.
- The fake provider is not evidence of a real provider's quota behavior.
