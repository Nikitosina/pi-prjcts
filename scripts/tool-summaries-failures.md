# Tool summaries and thinking visibility

A summary is one or two sentences about the tools one assistant message called, written by a light model the owner picks after all of that message's results arrived. It is derived display data: it lives in `<home>/tool-summaries.sqlite`, never in a conversation, and the original calls stay one click away. Thinking visibility is a display switch in the host `ui` document. Both are host-wide. Summaries are made for Coordinator chats, the agents the Coordinator started (worker, scout, reviewer) and the Host agent, never for a worker's own subagents: those are not meant for the owner to read. Thinking visibility applies to every view.

Covered by `tool-summaries-unit.mjs` (store, queue and model call with a fake runtime) and `tool-summaries-e2e.mjs` (a private host with the fake provider, RPCs, restart and the browser).

## Which conversations

- N1 A worker's own scout or reviewer (a nested conversation, listed in the Jobs document's `subagents`) opens a summary row, queues one or sends a request. Ownership comes from that document, written in the commit that creates the conversation, never from its role: a scout or reviewer the Coordinator started is summarized.
- N2 After a restart, a summary of a nested conversation left queued, cut off while running or still collecting from before is sent. A store's recovered summaries are queued only when that store opens and has dropped its nested ones; a saved nested summary is kept, not purged.

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
- Q11 A message whose results never arrive (a turn cut off mid-call) keeps its row and its copy of the calls forever. Its row must be dropped with its copy when the conversation moves on, when the turn that made the calls ends (finished or stopped), and, for a turn that ended while the host was not observing, when its store opens after a restart: a group is dropped there only when its conversation has no running turn, so no timer or age ever drops a group whose turn still runs, however long. A group whose tools are still running is not dropped by a restart, by another task ending, by another store opening or by another conversation's turn ending; a stopped turn whose calls all got their aborted results is complete and is summarized.
- Q12 A large or deeply nested argument, nested-call argument or result is serialized or walked whole before it is cut: memory and time grow with the input, and deep nesting overflows the stack. Arguments are written by a bounded walk (depth, items, characters) with a marker where it cut; only the first result parts are read.
- Q13 A damaged row in the summary database (bad JSON, wrong shape) crashes the host, blocks other summaries, or its content reaches the model. A queued summary whose stored calls lack a result is damaged too, never summarized as incomplete. It must fail that summary quietly and drop its stored copy; usage ignores a damaged usage record; reads still write nothing.

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
- D6 A summary arriving replaces or flashes the whole transcript, or animates again on later updates. In the worker transcript too: unchanged turns keep their nodes, the focused line keeps focus, an open line stays open, and a reader who scrolled up keeps the turn they are reading in place, even when an earlier turn changes height.
- D7 Hidden thinking still shows in history, in the streaming turn or in the held step after a commit, or hiding it changes the model's thinking level or the agent's context.
- D8 Worker transcripts or the Host agent ignore either setting. Every summarized conversation type (Coordinator, worker, scout, reviewer, the Host agent) gets summaries with the error mark and its thinking, a worker's own scout and reviewer keep their thinking, and each view that shows it applies both settings without a reload; the Host agent's streaming turn shows its live thinking like the Coordinator's. Agents keep their own model and thinking; only summaries use the summary model.
- D9 The summary line is not reachable with the keyboard, overflows a narrow (390 px) screen, or animates with reduced motion.
