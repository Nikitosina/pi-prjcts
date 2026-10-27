# Verification settings

The owner opts a project into the automatic verification loop in Project settings: a Verifier model and a verification skill. Off by default; a refused save stores nothing.

## Sub-features

- `refuse` — enabling without a Verifier model is refused by the host and stored nowhere.
- `enable` — Verifier model + skill saved through the review dialog; `settings-snapshot` shows both.
- `persist` — reload shows the saved state; turning it off stores `verification: null`.
- `loop` — the fail → fix → fresh pass loop itself. Not drivable by this settings-only journey. Covered by `scripts/verification-loop-e2e.mjs` (trusted commands and drift checks) and `scripts/verification-trusted-browser-e2e.mjs` (this canonical skill runs inside the verifier with real isolated Chrome/host proof). Both use a deterministic model at the provider seam.

## How to get to it (user POV)

- Project → Edit settings → Models (Verifier row) and Verification (checkbox + skill name) → Review changes → Save changes.

## Driving it with browser CDP

Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> verification-settings`. The seed copies this skill into the workspace so `verify-pi-prjcts` is an installed skill. Pointer clicks on `#settings-button`, `input[name=verifyEnabled]`, `.mp[data-role=verifier]` rows and the review/confirm buttons; text via `Input.insertText`. Screenshots 01–07, `host-settings-snapshot.json`.

## Gotchas

- `settings-snapshot` is on the read-only rpc allowlist for this journey.
- The fake provider proves UI and host wiring only, not a real judge model.
