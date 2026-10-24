# Chat transcript across compaction: failure cases

Verified by `scripts/transcript-compaction-e2e.mjs`. The transcript is display history; the model context is unchanged.

- T1 After a compaction the chat only shows the messages from the first kept entry on (Durable's active view), so earlier messages vanish; recovering the older stored entries duplicates, reorders, or revives entries from before a /new reset.
- T2 A compaction leaves no mark, the divider lands at the start of the kept messages instead of where the summary was written, or only the newest compaction is marked.
- T3 The summary shows up in the chat as an owner message.
- T4 Showing the history changes what the model sees (summaries re-run, context meter differs).
- T5 Transcript indexes (search jumps) repeat or run backwards.
- T6 The divider is large, loud or missing in the browser.
- T7 A reload or chat switch drops the older messages or dividers, or shows another chat's history.
- T8 A newer streamed message is lost, duplicated or placed before a divider after the history is read.
- T9 Past 30 messages the older ones cannot be reached, or Show earlier messages reorders, duplicates or jumps the reading position.
- T10 Reading the history triggers summaries or changes the context meter.
- T11 A host restart loses the history.
