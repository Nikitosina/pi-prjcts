# Role-specific fallbacks applied to existing work: failure modes

Covered by `scripts/worker-quota-live-roles-e2e.mjs`.

## Failures the assertions catch
- A worker, scout or reviewer waiting on quota takes another role's fallback, or none.
- Recovery changes the role, thread, instructions or tool permissions.
- The recovered attempt does not receive the original request.

## Notes
All three roles run in one project with its own fallback each.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
