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

## Coordinator input provenance

- P1 Machine-generated user-role entries lack source metadata and appear as owner messages.
- P2 Owner messages that quote a report/event prefix are classified by prose instead of admission provenance.
- P3 Looking up legacy input origins scans an entire chat's submissions on every page or fails to respect page/conversation bounds.
- P4 An owner message rendered before its admission ledger update is mistaken for internal input.
- P5 Unknown legacy entries are hidden or assigned internal origin without a matching submission; archives and worker transcripts lose diagnostics.

Legacy origin lookup reads at most the newest 200 submissions of this conversation. Older or unmatched legacy entries retain unknown origin and stay visible. New owner/internal input kinds carry their source in the entry and need no submission lookup. Cursors are backend-owned and are never synthesized from entry IDs.

## Compaction failure

- T12 A failed compaction leaves no trace: the context meter looks normal, so the owner does not learn that the context was not reduced and that a later turn may stop at the limit. The chat snapshot must carry the failure, and the meter must say "Last compaction failed" with the error in its label and popup, marked by text and not by color alone. It stays after a host restart and clears once a compaction produces a summary.
