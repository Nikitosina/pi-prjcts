# Coordinator stability and context indicator failure cases

Record before implementation. Verify through an isolated real host, Durable dispatcher, browser UI and local fake model. Do not touch existing projects or use a real model.

Observed on Mari (2026-10-06 16:54, 16:57): two coordinator turns failed with `WebSocket idle timeout after 60000ms`. Durable settings were `stream.timeoutMs: 60000` and `retry.maxRetries: 0`. The UI showed only `model_error`.

- A transient connection drop on a coordinator request ends the turn as failed instead of retrying.
- A retry after tools already ran repeats those tool calls (duplicate notes/writes/delegations).
- Retries never stop: a persistent provider error loops instead of failing after a bounded number of attempts.
- A failed turn shows only `model_error`; the provider's error text is lost.
- A failed turn offers no way to resend except retyping the message.
- Retry sends a different text, sends twice on a double click, or targets another project.
- `attention`/`model_error` remains after a later turn succeeds, so the project looks stuck.
- Stream idle timeout stays at 60 s, shorter than long reasoning pauses of the configured coordinator models.
- Context indicator is missing, sits away from Send, or has no hover popup with a percentage.
- Context percentage ignores the latest usage, exceeds 100 %, or divides by the wrong model's context window.
- Context indicator throws or shows NaN before the first model response.

## Dismissing notices (✕), recorded before implementation
- D1 No ✕ on a warning row or on the error box, or it is not keyboard reachable.
- D2 ✕ hides the row, but the next poll re-renders it (dismissal not remembered).
- D3 ✕ on one warning hides the others too; or the box stays visible empty after the last row.
- D4 ✕ is a data-action, so it is disabled while busy, or it fires the row's Retry.
- D5 A dismissed problem stays hidden after its text changes (a new failure must show again).
- D6 Reload loses the dismissal (kept per tab session), or it leaks across projects.
- D7 ✕ on #error hides it, but a different later error stays hidden.
- D8 The ✕ glyph is low-contrast or overlaps long text.

## The inbox at `/` (classic inbox retired 2026-11-04)
- S4 A failed coordinator turn shows nothing in the new client: no error text and no Retry (the classic warning bar was the only
  place). Expected: the transcript ends with a failure row for the newest failed or interrupted turn of this chat (after the last
  settled one), carrying the provider error and a Retry button. (Red: artifacts/only-inbox/red-coordinator-stability-failure-row.json.)
- S5 Retry resends the same text to the same chat exactly once (a double click must not send twice).
- S6 A later success removes the failure row. S10 a later failure replaces it.
- S7/S8 read the status line's context item (the classic composer meter and its popup are retired).
- S9/S11 (✕ on the classic warning rows and error box) are retired with them.
