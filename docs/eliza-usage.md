# Eliza USD usage

The status bar shows Eliza after Cursor as `Eliza $X.XX`. The amount is the sum of `usage.*.stats.monthly.cost` returned by Eliza's actual usage endpoint. It does not use token counts or model prices.

## Documented API

Sources read through the owner's read-only Docs MCP:

- [Quotas](https://docs.yandex-team.ru/eliza/quotas/quotas) documents `GET https://api.eliza.yandex.net/v2/usage` with `Authorization: OAuth <token>`.
- [Authentication](https://docs.yandex-team.ru/eliza/auth) documents the OAuth scheme. The [API quick start](https://docs.yandex-team.ru/eliza/api) uses the `ELIZA_TOKEN` environment variable.
- [External quotas](https://docs.yandex-team.ru/eliza/quotas/external_quotas) defines cost in USD. Monthly periods reset on the first day of the month at 00:00 UTC.
- [LiteLLM proxy](https://docs.yandex-team.ru/eliza/integrations/litellm_proxy#kvoty-i-puly) confirms that `cost` in Eliza's usage API is actual spend. Its `/v2/usage/daily` example groups and sums that field rather than estimating it.

The host reads only the existing `ELIZA_TOKEN`. It does not request a token, add a login flow, read another credential store, or send the token to the browser. If the variable is missing, the item says it is not connected and explains what the host needs.

## Response and scope

A read-only request against the real endpoint on 2026-10-26 returned HTTP 200 for the owner's existing authorization. The response had this shape, with costs verified as numbers:

```json
{
  "usage": {
    "all": {
      "stats": {
        "daily": { "requests": 10, "cost": 0.02758798 },
        "monthly": { "requests": 58, "cost": 5.02741525 }
      }
    },
    "chain:top_opensource": {
      "stats": {
        "daily": { "requests": 0, "cost": 0 },
        "monthly": { "requests": 10, "cost": 0.02758798 }
      }
    }
  },
  "pool": "",
  "account": "<owner account>"
}
```

The integration sums `monthly.cost` across the returned usage buckets. In this response the actual month-to-date total was $5.05500323, displayed as $5.06. It uses no daily history to reconstruct that total. `account` identifies the account scope. A non-empty `pool`, when present, is shown in the tooltip. The browser receives only the normalized total, scope, UTC period bounds and fetch time.

The tooltip calls the value month to date, names USD and the account, and shows the next 00:00 UTC monthly reset. `observedAt` is the successful fetch time. The endpoint has no documented per-value as-of timestamp, so the UI does not claim that the accounting is real-time.

## Polling and failures

Eliza shares the existing limits cache: one automatic poll per provider per five minutes, a 15-second manual-refresh cooldown, exponential failure backoff, visibility-triggered recovery, and `Retry-After` support. Eliza documents no lower request limit for this endpoint. Only the read-only usage route is called; no model request is needed or made.

A network failure, 429 or 5xx keeps the last actual value and reports the failed refresh. Missing auth, 401 or 403 shows an unavailable state when there is no earlier value. Empty or malformed usage data never becomes $0.
