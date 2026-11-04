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

## UI 2.0: which providers the status line shows

Owner request: show or hide each provider's limits in the status line. The choice is the host's saved `limits-visibility` (the classic
inbox and Telegram `/status` read the same file), not page or `ui` state. Proof: `scripts/ui2-limits-e2e.mjs`.

- M14 Hiding a provider in Settings → Providers leaves it in the status line, or the choice is kept only in the page, so a reload, another
  browser or Telegram `/status` disagree.
- M15 Toggling a provider, or reading the toggles, sends `limits-refresh` or reaches a provider endpoint.
- M16 A refresh brings a hidden provider back into the status line, or stops refreshing it so re-showing it shows old numbers.
- M17 With every provider hidden the status line loses its refresh control, or Providers drops the rows of hidden providers so they
  cannot be shown again.
- M18 A failed save shows the new choice anyway, or rapid toggles of several providers leave the page and the host disagreeing.
- M19 A change from another tab or the Host agent leaves an open page on the old choice until a reload.
- M20 A toggle has no accessible name, cannot be switched from the keyboard, or loses focus when the list redraws.

## UI 2.0: details of one provider

Owner request: bring back the classic bar's per-provider details on hover. The details come from the readings the page already holds.

- M21 Hovering, focusing or tapping a provider asks the host for limits or reaches a provider, or a timer refreshes or closes the details.
- M22 The details miss what the classic popup said: each window's use, its reset (in how long and when), how old the reading is and
  where it came from, the period cost and account for Eliza, or the reason of a failed refresh next to the numbers it kept.
- M23 A hidden provider can still be opened from the status line.
- M24 The details open only for a mouse: no keyboard focus or tap opens them, Escape or a press outside does not close them, or
  Escape loses the keyboard's place.
- M25 On a narrow screen the details run off the screen or are cut by the status line's sideways scroll.
