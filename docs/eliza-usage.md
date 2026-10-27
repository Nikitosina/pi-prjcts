# Eliza USD usage

The status bar shows Eliza after Cursor as `Eliza $X.XX`. The amount is the sum of `usage.*.stats.monthly.cost` returned by Eliza's actual usage endpoint. It does not use token counts or model prices.

## Documented API

Sources read through the owner's read-only Docs MCP:

- [Quotas](https://docs.yandex-team.ru/eliza/quotas/quotas) documents `GET https://api.eliza.yandex.net/v2/usage` with `Authorization: OAuth <token>`.
- [Authentication](https://docs.yandex-team.ru/eliza/auth) documents the OAuth scheme. The [API quick start](https://docs.yandex-team.ru/eliza/api) uses the `ELIZA_TOKEN` environment variable.
- [External quotas](https://docs.yandex-team.ru/eliza/quotas/external_quotas) defines cost in USD. Monthly periods reset on the first day of the month at 00:00 UTC.
- [LiteLLM proxy](https://docs.yandex-team.ru/eliza/integrations/litellm_proxy#kvoty-i-puly) confirms that `cost` in Eliza's usage API is actual spend. Its `/v2/usage/daily` example groups and sums that field rather than estimating it.
- [Pools](https://docs.yandex-team.ru/eliza/quotas/eliza_pools) documents that `Ya-Pool` selects pool usage. This integration sends no such header, so it reads the token's personal account and reports any `pool` scope returned by the server.

The docs establish units and periods but do not establish whether usage buckets overlap. Aggregation is verified separately against Eliza's implementation at Arcadia revision `9a10456b7db6ed98db50325e4bc2300fd6e74d45`, not inferred from bucket names. [`GetV2Usage`](https://a.yandex-team.ru/arcadia/search/eliza/api/internal/server/handlers/general.go) returns `UsersStats.EffectiveUsage(account)`. [`EffectiveUsage`](https://a.yandex-team.ru/arcadia/search/eliza/api/internal/quotas/check_quota.go) removes chain families from `all`, caps a chain bucket at its quota, and moves only its overflow into `all`; its contract says the returned buckets' `Stats` sum to real spend without double-counting. The [chain-quota tests](https://a.yandex-team.ru/arcadia/search/eliza/api/internal/quotas/chain_quota_test.go) cover that partition and overflow, including dedicated model quotas. Eliza's own [`totalMonthlyPoolSpend`](https://a.yandex-team.ru/arcadia/search/eliza/frontend/lib/utils/poolUsage.ts) uses the same sum. Nested `by_family` entries are a breakdown, not additional spend: a capped chain's family breakdown can exceed its `stats`. The parser sums only top-level `stats.monthly.cost`, never `by_family`, quota limits, or nested totals.

The host reads only the existing `ELIZA_TOKEN`. It does not request a token, add a login flow, read another credential store, or send the token to the browser. If the variable is missing, the item says it is not connected and explains what the host needs.

## Response and scope

A read-only request against the real endpoint on 2026-10-27 at 04:22:40 UTC returned HTTP 200 for the owner's existing authorization. The response had this shape, with costs verified as numbers:

```json
{
  "usage": {
    "all": {
      "stats": {
        "daily": { "requests": 0, "cost": 0 },
        "monthly": { "requests": 58, "cost": 5.027415250000001 }
      }
    },
    "chain:top_opensource": {
      "stats": {
        "daily": { "requests": 0, "cost": 0 },
        "monthly": { "requests": 430, "cost": 16.79726398000001 }
      }
    }
  },
  "pool": "",
  "account": "<owner account>"
}
```

The integration sums `monthly.cost` across the returned usage buckets. For this response the source-backed month-to-date sum was $21.82467923000001, displayed as $21.82. The earlier sanitized artifact's $7.91 is not independently verified: it retained only a computed total, not the bucket data. It must not be used as proof of aggregation correctness. It uses no daily history to reconstruct that total. `account` identifies the account scope. A non-empty `pool`, when present, is shown in the tooltip. The browser receives only the normalized total, scope, UTC period bounds and fetch time.

The tooltip calls the value month to date, names USD and the account, and shows the next 00:00 UTC monthly reset. `observedAt` is the successful fetch time. The endpoint has no documented per-value as-of timestamp, so the UI does not claim that the accounting is real-time.

## Polling and failures

Eliza shares the existing limits cache: one automatic poll per provider per five minutes, a 15-second manual-refresh cooldown, exponential failure backoff, and visibility-triggered recovery. Both delta-seconds and HTTP-date `Retry-After` values hold every polling mode, including manual refresh; the 15-minute backoff cap never shortens that hold. Eliza documents no lower request limit for this endpoint. Only the read-only usage route is called; no model request is needed or made.

The request-start time selects the UTC month. If the response arrives in a different UTC month, the host discards it and schedules a retry instead of labeling old-period usage with new-period bounds.

A network failure, 429 or 5xx keeps the last actual value and reports the failed refresh. Missing auth, 401 or 403 shows an unavailable state when there is no earlier value. Empty or malformed usage data never becomes $0.
