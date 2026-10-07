# Generic webhook: failure cases

Owner decision: a local HTTP endpoint per project with a per-project secret (HMAC or bearer). A delivery becomes an event for the coordinator through the existing event-ingest path. Settings show the URL and secret, with Rotate. `scripts/webhook-e2e.mjs` checks these with a fake model.

## Authentication
1. A delivery with no secret, a wrong bearer token, a wrong HMAC signature, or another project's secret is accepted.
2. The secret is compared with a timing-unsafe comparison, or the signature is computed over a re-serialized body instead of the raw bytes.
3. After Rotate the old secret still works, or the new one does not.
4. A disabled webhook accepts deliveries (it must answer 404 without revealing whether the project exists).
5. The webhook endpoint is reachable with the browser bearer token alone, or the browser API becomes reachable with the webhook secret.

## Delivery
6. The same delivery ID sent twice starts two coordinator turns (it must answer `duplicate: true`).
7. A reused delivery ID with a different body silently replaces the first event (it must be refused with 409).
8. Without a delivery ID header, retries of the same body are not deduplicated.
9. An oversized body is buffered whole or crashes the host (it must get 413 early).
10. A burst of deliveries floods the coordinator (rate limit, 429).
11. A non-JSON or binary body is refused or mangled; the coordinator must see it as untrusted text.
12. Events go to Main when another chat is chosen in Settings.
13. The webhook URL changes on every host restart, so configured senders break.

## UI
14. Settings do not show the URL and secret, the secret is shown without a reveal step, or Rotate needs no confirmation.
15. The transcript shows the delivery as a raw owner message instead of an event card.
