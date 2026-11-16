# Chat input queue (Pi steer / follow-up): failure modes, written before the code

Contract: `message` takes `delivery: "steer" | "followUp"` (Enter while busy = steer, Alt+Enter = follow-up, as in the Pi coding agent). `chat-dequeue`
(Alt+Up) withdraws inputs that have not been delivered yet and returns them in Pi's order (steering first, then follow-up), each with its immutable
request id. Both queues deliver one message at a time (Pi's default). Script: `chat-queue-e2e`.

- Q1 A message sent while the chat is busy loses its delivery mode, or both modes look the same in the ledger, so the page cannot group "Steering" and "Follow-up".
- Q2 A repeated request id (a double Enter, a replayed Telegram update) queues the input twice instead of returning the one already admitted.
- Q3 `chat-dequeue` leaves a withdrawn message in the ledger, so a restart re-admits it or the page keeps showing it.
- Q4 `chat-dequeue` returns messages out of Pi's order, or drops a mode, or returns text that differs from what was typed.
- Q5 Race: an input already placed in a turn (delivered) is withdrawn anyway, restored to the editor and also answered (duplicate). `chat-dequeue` must report it as kept.
- Q6 Race: dequeue twice, or dequeue on an idle chat, errors or restores something twice instead of returning nothing.
- Q7 A withdrawn input is still delivered later (the model sees it).
- Q8 Several queued follow-ups run in one turn (queue mode "all") instead of one turn each; same for steering.
- Q9 Dequeue by request ids touches inputs it was not asked about, or another chat's queue.
- Q10 An archived or deleted project, or an unknown chat, can be dequeued.
- Q11 Alt+Up withdraws an internal input (a worker report or an approval result queued for the Coordinator) that the owner never typed. Only inputs in the owner's ledger are the owner's to withdraw; anything else stays queued and is answered.
- Q12 The response with the restored text is lost (page closed, network drop) after the host withdrew it: the owner's text is gone. A withdrawn input stays in the ledger as withdrawn until the page acknowledges it, and the next `chat-dequeue` returns it again.
- Q13 A restored message loses its attachments (or its Telegram origin), so resubmitting it sends a different message.
- Q14 The page sends `delivery` only while its own copy of the chat says "running"; a turn that started a moment ago gets the message queued as a plain follow-up instead of steering. The page always sends the intended mode and the host decides.

Browser keys (scripts/chat-input-keys-e2e.mjs)
11. While a turn runs, Enter sends a steering message and Alt+Enter a follow-up; either sends the wrong mode or the pending list mixes them. The pending list groups "Steering:" lines before "Follow-up:" lines.
12. Alt+Up replaces the draft with the queued text, or loses queued text when the draft is not empty. All queued messages (steering first) return to the editor, followed by the draft; the host ledger is empty afterwards.
13. Touch users have no keys: the follow-up and edit-queued buttons are visible while a turn runs and hidden when it is idle.
14. A turn that has not started (idle chat) sends Alt+Enter as a plain message (no delivery) and restores nothing.

Worker and Host agent queues (scripts/worker-input-keys-e2e.mjs, same protocol as the Coordinator: withdraw, then acknowledge)
- W1 The worker or the Host agent keeps no list of what the owner sent while it was working, so the owner cannot see what is waiting. Each shows "Steering:" lines before "Follow-up:" lines, one per queued input.
- W2 Alt+Up in the worker composer or the Host drawer does nothing, or the withdrawn text is still delivered to the agent afterwards (double send). The queued inputs return to the editor and the agent never sees them.
- W3 The response with the restored text is lost after the withdrawal: the owner's text is gone. The withdrawn input stays recoverable (`thread-dequeue` / `host-agent-dequeue` return it again) until the page acknowledges it.
- W4 An acknowledgment arrives twice, for an unknown id, or for an input that was never withdrawn: it removes a queued input or fails. Only withdrawn inputs are removed.
- W5 Alt+Up takes an input the agent already took (placed in its turn): it is restored and also answered. A taken input is reported as kept, answered once, and never restored.
- W6 A withdrawn follow-up leaves its worker stuck "running": the earlier turn's report defers to a newer message that no longer exists. After the withdrawal the worker's Job settles as it would have without the message.
- W7 The coordinator's own `agents send` to a worker (no owner ledger entry) can be withdrawn by the owner's Alt+Up. Only the owner's inputs are listed and withdrawn.
- W8 A message sent to an idle agent (it starts a turn at once) appears in the pending list and can be withdrawn, leaving the Job running with nothing to end it. Only inputs sent while the agent was working are queued.

Second repair pass (PR 53): durable restore, cancellation and mode (`scripts/owner-input-queue-unit.mjs`, `scripts/queued-input-unit.mjs`, `scripts/worker-input-keys-e2e.mjs`)
- W9 An acknowledgment deletes the withdrawal mark of an input the producer has not submitted yet (a worker's delivery task still preparing, the Host agent between its ledger write and its submit). The producer then submits the original, and the owner has it both in the editor and running. The acknowledgment of an unsent input leaves a cancellation marker; the producer's own check or `afterSubmit` consumes it.
- W10 A crash between the withdrawn mark and the runtime abort leaves the runtime queue holding the input while the page is offered its text: restored and executing at once. Recovery finishes the abort before it offers the text; an input a turn took meanwhile is kept, one the runtime refuses to abort goes back to queued.
- W11 The restore response arrives after the owner left the surface: the text goes into a detached editor and the acknowledgment deletes the host's copy, so the text is gone. A reload after a normal restore loses the text too (it was only in memory). The page keeps one draft per surface (Coordinator chat, worker, Host agent) in localStorage; the acknowledgment is sent only after that write succeeded; a refused write acknowledges nothing.
- W12 A page whose copy of a worker says "idle" sends Enter as a follow-up, or the host's default for `thread-send` makes Enter a follow-up. The page always sends the key's mode and the host resolves idle or busy.
- W13 A lost acknowledgment makes the next Alt+Up add the same text to the editor twice. Ids waiting for an acknowledgment stay in the draft; an offered input already there is not added again and its acknowledgment is retried.
- W14 Restored messages carry more uploads than one message can send (`maxItems` 10): the page truncated the list and acknowledged everything. Messages that do not fit stay withdrawn and unacknowledged, so the next Alt+Up offers them again; no upload association is dropped.
- W15 `message` admission records the ledger entry, then submits; an Alt+Up and its acknowledgment in between delete the entry and the submission goes through. After the admission the host takes it out again when the ledger no longer holds it as queued.
