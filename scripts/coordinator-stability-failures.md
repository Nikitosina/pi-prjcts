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
