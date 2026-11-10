# Tool summaries and thinking visibility

A summary is one or two sentences about the tools one assistant message called, written by a light model the owner picks after all of that message's results arrived. It is derived display data: it lives in `<home>/tool-summaries.sqlite`, never in a conversation, and the original calls stay one click away. Thinking visibility is a display switch in the host `ui` document. Both are host-wide and apply to Coordinator chats, worker transcripts and the Host agent.

Covered by `tool-summaries-unit.mjs` (store, queue and model call with a fake runtime) and `tool-summaries-e2e.mjs` (a private host with the fake provider, RPCs, restart and the browser).

## Grouping and triggering

- G1 A summary covers the calls of a whole turn, or of several assistant messages, instead of the calls of one assistant message.
- G2 A summary starts before every call of the message has its result, so it describes outcomes that do not exist yet.
- G3 A commit seen twice (or a result committed again after a restart) queues the same message twice or calls the model twice.
- G4 Memory calls (`projects_knowledge_*`) disappear into the summary and lose their Remembered / Used memory rows; a message with only memory calls gets a summary at all.
- G5 Turning summaries on summarizes calls that finished before, or calls whose results arrived while summaries were off (backfill).
- G6 Opening a chat, a worker transcript or the Host agent, or paging history, starts or changes a summary (reads must have no side effects).

## Queue, restart and bounds

- Q1 A host restart while a summary is queued or its request is running loses it, or leaves it running forever.
- Q2 A request cut off by a restart is counted as free; its cost is unknown and must be said so.
- Q3 A failing or hanging model is retried without end; after the attempt limit the summary must fail and the original calls show.
- Q4 More summaries run at once than the concurrency limit, or the queue grows without bound.
- Q5 The model gets a whole large argument or result, an inline image, or every call of a huge message; input and output are bounded and binary data is never sent.
- Q6 The summary model gets tools, or tool text is presented as instructions rather than data; a returned paragraph longer than two sentences is shown as is.
- Q7 Summary work blocks, slows or fails the agent's own turn, or writes anything into the agent's conversation or context.
- Q8 A stored summary row keeps its bounded copy of the calls after it finished (state grows with history).
- Q9 Summaries are turned off while a summary waits for the model catalog, and its request is still sent afterwards.
- Q10 Restarts during the last attempt start more requests than the attempt limit.
- Q11 A message whose results never arrive (a turn cut off mid-call) keeps its row and its copy of the calls forever.

## Settings and models

- S1 Enabling summaries without a model, with a model outside the installed catalog, or with a model whose provider has no credentials is accepted, or a refused change alters the saved settings.
- S2 The configured model disappears or loses credentials later, and the host silently uses another model instead of failing the summary with the reason.
- S3 Disabling needs a restart, or queued work keeps running after it; re-enabling summarizes what happened while it was off.
- S4 Changing the model needs a restart; the next summary must use the new model.
- S5 A brevity setting exists, or summaries are not limited to one or two sentences.

## Usage

- U1 Summary tokens and cost are lost, mixed into the agent's own model usage, or missing from the totals the owner sees.
- U2 A cut-off request reports a cost of zero instead of unknown.
- U3 A request stopped by turning summaries off is counted neither as spent nor as an unknown cost.

## Display

- D1 With summaries on, a finished message's calls still show as separate rows, or the summary hides that a call failed.
- D2 The original calls of a summarized message cannot be opened, or their parameters, results and images are gone.
- D3 A running call and a summary still being written look the same.
- D4 A failed summary hides the calls or shows a loud error; it must fall back to the original calls with a quiet note.
- D5 Turning summaries off keeps showing summaries.
- D6 A summary arriving replaces or flashes the whole transcript, or animates again on later updates.
- D7 Hidden thinking still shows in history, in the streaming turn or in the held step after a commit, or hiding it changes the model's thinking level or the agent's context.
- D8 Worker transcripts or the Host agent ignore either setting.
- D9 The summary line is not reachable with the keyboard, overflows a narrow (390 px) screen, or animates with reduced motion.
