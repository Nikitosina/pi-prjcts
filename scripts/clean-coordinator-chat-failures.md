# Clean coordinator chat regressions

Written before the renderer change.

- C9: Coordinator tool calls/results and thinking are shown inline, even after the answer settles.
- C10: Reset handoffs render as assistant messages instead of staying internal.
- C11: Host-injected user-role inputs without an existing report/event format are labeled You.
- C12: Filtering diagnostics also removes owner prose, attached images, compaction dividers, or access to Ready approval in worker details.
- C13: Shared worker/archive rendering loses its diagnostic tools, thinking, or handoff text.
- C16: Legacy coordinator inputs without origin metadata are falsely labeled You. They must retain text, links and attachments under Earlier input; explicit owner input and worker/archive labels must stay You.

Browser checks extend worker-chat-ui-e2e.mjs. Verification skill message-coordinator and jobs journeys cover persisted owner bubbles and Ready/Approve independently.

- C17: Internal Ready/checkpoint/completed/stalled reports and events appear as separate coordinator bubbles. Worker details must retain proof and Ready approval.
- C18: A checkpoint looks ready or offers Approve; completed helpers must remain distinct from independent delivery.
- C19: Removing scout/reviewer reports makes completed read-only agents unreachable. Keep recent returned agents in the Workers card, with older agents available through Show all.
