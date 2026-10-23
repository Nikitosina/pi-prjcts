# Subscription limits bar

The bottom bar shows one compact item per provider with the 5-hour and weekly (7-day) usage windows, a percent bar, a reset countdown on hover, and the time and source of the last reading. It is modelled on the status bar in [Orca](https://www.onorca.dev/).

## How Orca does it (research)

Orca is open source: [github.com/stablyai/orca](https://github.com/stablyai/orca), read at commit `52e413e` (2026-10-22). Its landing page ([onorca.dev](https://www.onorca.dev/)) shows the bar as `5h` and `7d` rows with a fill bar and a percent, and says it tracks the subscriptions you already have. No separate docs page covers the bar; the source is the reference.

**Presentation** (`src/renderer/src/components/status-bar/`)
- One segment per provider ([`StatusBarProviderSegment.tsx`](https://github.com/stablyai/orca/blob/52e413e/src/renderer/src/components/status-bar/StatusBarProviderSegment.tsx)): provider icon or name, then per window a 48×6 px muted `MiniBar` and a tabular percent label (`5h 42%`, `7d 24%`).
- Tone thresholds: 60 % warning, 80 % urgent ([`provider-extra-usage-section.tsx`](https://github.com/stablyai/orca/blob/52e413e/src/renderer/src/components/status-bar/provider-extra-usage-section.tsx)).
- Narrow bars collapse segments into an overflow chip, then into one-letter badges.
- Click or hover opens a panel above the bar ([`ProviderDetailsMenu.tsx`](https://github.com/stablyai/orca/blob/52e413e/src/renderer/src/components/status-bar/ProviderDetailsMenu.tsx)) with per-window percent, reset time and extra-usage credits.
- Providers: Claude, Codex, Cursor, Gemini, Grok, Kimi, MiniMax, OpenCode Go, Z Code, Antigravity.

**Where the numbers come from** (`src/main/rate-limits/`)

| Provider | Source | Orca file |
|---|---|---|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` with the Claude Code OAuth token (macOS keychain or `~/.claude/.credentials.json`), headers `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/2.1.0`. Returns `five_hour` / `seven_day` with `utilization` (percent) and `resets_at` (ISO string). Also a live feed from Claude Code's statusline `rate_limits`. | [`claude-oauth-usage-request.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/claude-oauth-usage-request.ts), [`claude-oauth-credentials.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/claude-oauth-credentials.ts), [`claude-usage-window.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/claude-usage-window.ts) |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` with the token from `~/.codex/auth.json` (`ChatGPT-Account-Id`, `originator`), or the Codex app-server RPC. `primary_window` / `secondary_window` are classified as session or weekly by `limit_window_seconds`. | [`codex-backend-usage-client.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/codex-backend-usage-client.ts), [`codex-backend-auth.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/codex-backend-auth.ts) |
| Cursor | cursor.com dashboard routes (`/api/usage-summary`, `/api/dashboard/get-current-period-usage`) with a session cookie `<subject>::<jwt>` from Cursor's `state.vscdb` or `cursor-agent`'s `auth.json`. A monthly quota, not 5 h / weekly. | [`cursor-fetcher.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/cursor-fetcher.ts), [`cursor-session-token.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/cursor-session-token.ts) |

Orca does not read response headers. It polls (default every 15 minutes, minimum 30 s, 5 min debounce on resume, 60 s debounce on open, stale after 30 minutes; [`service-types.ts`](https://github.com/stablyai/orca/blob/52e413e/src/main/rate-limits/service/service-types.ts)) and honours `Retry-After`.

## What Pi prjcts does

Everything is host-side (`src/usage-limits.ts`). The browser calls the authenticated `limits-snapshot` action and receives normalized samples `{ provider, window, usedPercent, resetsAt, observedAt }` (plus `source: "headers" | "endpoint"` and a status/reason per provider). Tokens and raw responses never leave the host. The CSP is unchanged (no new script origin, no CDN).

**1. Passive response headers (preferred).** `src/durable-runtime.ts` wraps the model stream and passes an `onResponse` observer to pi-ai, which fires it with the response headers of every request ([`anthropic-messages.js`](../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js), [`openai-codex-responses.js`](../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js)). Header names were checked against real responses:

- Anthropic (provider `anthropic`): `anthropic-ratelimit-unified-5h-utilization` and `-7d-utilization` are **0–1 fractions**; `-5h-reset` / `-7d-reset` are **epoch seconds**; also `-status`, `-representative-claim`, `-fallback-percentage`.
- Codex (provider `openai-codex`): `x-codex-primary-used-percent` / `-window-minutes` / `-reset-at` and the same for `secondary` (**percent**, minutes, epoch seconds). Windows are classified by length (≤ 7.5 h is 5 h, ≥ 3.5 d is 7 d), so a weekly-only plan shows only `7d`. An empty secondary (`window-minutes: 0`) is ignored.

`claude-bridge` (`src/provider-extensions.ts`) spawns Claude Code as a subprocess, so no HTTP response passes through Pi and **its headers are unreachable**. Turns made through the bridge produce no passive samples; the Claude item then relies on the endpoint below, using the Anthropic login Pi holds.

**2. Read-only usage endpoints with the login Pi or the CLI already has.** Used only when no passive sample is fresher than 60 s. At most one request per provider per 60 s, exponential backoff to 15 min after failures, `Retry-After` honoured, 10 s timeout, no token refresh and no writes.

| Endpoint | Credential | Documented? |
|---|---|---|
| `GET https://api.anthropic.com/api/oauth/usage` | `anthropic.access` from Pi's `auth.json` | **No, undocumented.** Same call Claude Code and Orca make. |
| `GET https://chatgpt.com/backend-api/wham/usage` | `openai-codex.access` + `accountId` from Pi's `auth.json`, else `~/.codex/auth.json` | **No, undocumented.** Same call the Codex app and Orca make. |

If a token is expired or missing the item says so ("Not connected" / sign-in expired) and keeps retrying only on the backoff schedule; it never refreshes the token itself, so Pi's own next use does.

**3. Cursor: unavailable.** Orca's source is a cursor.com dashboard session cookie that Pi does not hold (Pi's `cursor` credential is an SDK OAuth token, not the dashboard session), and Cursor's quota is monthly. The bar shows `Cursor —` with "Not connected" on hover and never polls.

**No invented numbers.** No sample means `—`; hover says "No data yet" with the reason and the time of the last attempt. A reading whose reset time has passed is dimmed and shown as `—` until a new reading arrives.

## Checks

- `node scripts/usage-limits-unit.mjs`: header parsing against recorded real shapes, window classification, poll cadence and passive-over-poll precedence.
- `node scripts/status-dots-e2e.mjs`: browser run with fixture data (`PI_PROJECTS_LIMITS_FIXTURE=<file>` replaces both endpoints; no provider is contacted).
