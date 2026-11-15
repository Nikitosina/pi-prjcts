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
