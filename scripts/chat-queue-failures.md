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
