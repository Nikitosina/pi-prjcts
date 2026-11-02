# Clean coordinator chat regressions

Written before the renderer change.

- C9: Coordinator tool calls/results and thinking are shown inline, even after the answer settles.
- C10: Reset handoffs render as assistant messages instead of staying internal.
- C11: Host-injected user-role inputs without an existing report/event format are labeled You.
- C12: Filtering diagnostics also removes owner prose, attached images, useful events, compaction dividers, or Ready/Approve messages.
- C13: Shared worker/archive rendering loses its diagnostic tools, thinking, or handoff text.
- C16: Legacy coordinator inputs without origin metadata are falsely labeled You. They must retain text, links and attachments under Earlier input; explicit owner input and worker/archive labels must stay You.

Browser checks extend worker-chat-ui-e2e.mjs. Verification skill message-coordinator and jobs journeys cover persisted owner bubbles and Ready/Approve independently.
