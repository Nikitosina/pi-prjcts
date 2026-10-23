# Quota, status and artifact compactness: failure cases
Written before code. Covered by `scripts/quota-status-e2e.mjs` (fake model, private HOME).
Source: three coordinator chats (retro in `artifacts/token-efficiency-fixes/`): five doomed reviewer launches after a 429 quota error, 150,858 characters of `projects_workers` output, completion reports listing nested xcresult files.

1. A provider 429 "Quota exceeded" / session limit settles as the bare enum `model_error`; the raw provider text (`answer.detail`) is lost, so the coordinator cannot tell quota from a transient throttle.
2. A transient 429 ("too many requests") is treated as exhausted and blocks later work, or a quota failure is not recognised.
3. After a quota failure the coordinator can admit more work for the same provider; each launch fails after a model call.
4. The cooldown is process memory: a host reopen resets it. It must derive from persisted failed work, expire after a bounded time, and end when a later attempt on that provider completes.
5. Admission silently switches to another provider or model. It must refuse and name the exact model.
6. `projects_workers` rows carry long briefs and rarely-used fields; the complete brief and blocker must stay reachable (`workId`), and the browser plan snapshot must not change.
7. A completion report lists every nested file of an xcresult bundle; it must list top-level evidence, summarize the rest as a count and size, and cap the list.
