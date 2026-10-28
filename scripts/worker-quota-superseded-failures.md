# A superseded failed record next to a quota-waiting follow-up: failure modes

Covered by `scripts/worker-quota-superseded-e2e.mjs`.

## Failures the assertions catch
- Both the failed record and the follow-up are revived, and the dispatcher then refuses to run either because another record on the thread holds quota recovery.
- The failed record gets a model transition or a quota wait.
- Repeated saves or a restart create extra records or extra fallback requests.
- An idle sweep over 20000 completed records takes more than 1.5 s.

## Notes
The timing bound is generous on purpose. It catches quadratic rescans, not small regressions.

Limits: an isolated host with a local fake provider that returns scripted 429 responses. It says nothing about a real provider's quota or reset behavior.
