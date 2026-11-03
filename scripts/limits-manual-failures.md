# Manual-only subscription limits: ways it can fail

Written before the code. Owner decision: usage limits refresh only when the owner presses a refresh button; opening, reloading or showing a page, and time passing, never contact a provider. Proof: `scripts/usage-limits-unit.mjs`, `scripts/usage-limits-recovery-unit.mjs` (fake endpoints, no network) and `scripts/ui2-limits-e2e.mjs` (private host, fake model, `PI_PROJECTS_LIMITS_FIXTURE`, headless Chrome).

## Host

- M1 A plain `limits-snapshot` read (page load, Settings → Providers, a reload) still polls a provider endpoint because the 5-minute schedule has passed.
- M2 A `limits-snapshot` with `visit: true` (older pages, a tab coming back) retries a provider that shows an error.
- M3 After a failure the host retries on its own once a backoff ends, without a click.
- M4 `limits-refresh` does not call the provider, or calls it twice for one click (no in-flight dedup), or twice inside the 15 s per-provider cooldown.
- M5 `limits-refresh` overrides a provider's `Retry-After` (delta seconds or HTTP date), or the hold starts at request time instead of response time.
- M6 A failed refresh drops the last numbers instead of keeping them with the reason.
- M7 A read reports values that were never fetched (fabricated 0 %, $0) instead of the empty state.

## UI 2.0

- M8 The page requests `limits-refresh` on load, or calls `limits-snapshot`/`limits-refresh` on a timer.
- M9 The status line offers no refresh control when there is no reading yet, so the owner cannot get a first value.
- M10 The refresh button has no accessible name, stays enabled while a refresh runs (double click sends two), or keeps spinning after it ends.
- M11 A failed refresh is silent, removes the values already shown, or opens a dialog or popup instead of saying so in place.
- M12 Settings → Providers refresh uses a different path and leaves the status line on old numbers.
- M13 Hiding the Subscription limits status item still shows the refresh button.
