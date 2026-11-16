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
- W9 An acknowledgment deletes the withdrawal mark of an input the producer has not submitted yet (a worker's delivery task still preparing, the Host agent between its ledger write and its submit), so the producer then submits the original and the owner has it both in the editor and running. First repaired with a cancellation marker; that left the producer's check and its submission as two steps (the turn could finish before the abort), so it is superseded by W16.
- W10 A crash between the withdrawn mark and the runtime abort leaves the runtime queue holding the input while the page is offered its text: restored and executing at once. Recovery finishes the abort before it offers the text; an input a turn took meanwhile is kept, one the runtime refuses to abort goes back to queued.
- W11 The restore response arrives after the owner left the surface: the text goes into a detached editor and the acknowledgment deletes the host's copy, so the text is gone. A reload after a normal restore loses the text too (it was only in memory). The page keeps one draft per surface (Coordinator chat, worker, Host agent) in localStorage; the acknowledgment is sent only after that write succeeded; a refused write acknowledges nothing.
- W12 A page whose copy of a worker says "idle" sends Enter as a follow-up, or the host's default for `thread-send` makes Enter a follow-up. The page always sends the key's mode and the host resolves idle or busy.
- W13 A lost acknowledgment makes the next Alt+Up add the same text to the editor twice. Ids waiting for an acknowledgment stay in the draft; an offered input already there is not added again and its acknowledgment is retried.
- W14 Restored messages carry more uploads than one message can send (`maxItems` 10): the page truncated the list and acknowledged everything. Messages that do not fit stay withdrawn and unacknowledged, so the next Alt+Up offers them again; no upload association is dropped.
- W15 `message` admission records the ledger entry, then submits; an Alt+Up and its acknowledgment in between delete the entry and the submission goes through. After the admission the host takes it out again when the ledger no longer holds it as queued.
- W16 (supersedes the W9 marker) An input the runtime has not seen and whose producer may still submit it is given back, and a turn then takes it before the producer's abort. The queue never withdraws such an input: it stays queued ("kept") and the next Alt+Up takes it once the runtime holds it. A producer that is gone (a Host agent send that crashed, an ended worker) cannot submit, so its input is the page's at once. Unit: `owner-input-queue-unit` W16; e2e `worker-input-keys-e2e` W9 (each input is given back and never delivered, or kept and delivered once).
- W17 The page clears the editor and the draft before the host accepted a send; a reload or a rejected or lost request loses the restored, acknowledged text and uploads. A send keeps its own record (text, uploads, origin, request id, delivery) in the surface's draft until the host accepted it; a page that finds such a record sends it again under the same id (the host takes an id once) and gives the text back when the host refuses it. Unit: `queued-input-unit` R1.
- W18 Two sends overlap: the second inherits the first's uploads and origin, and finishing the first removes the second's. Each send owns its record; finishing or failing one touches only that record. Unit: R2.
- W19 Two Alt+Up overlap and the second response carries ids the first already restored and acknowledged, so the text is added twice (also after a reload). One composer restores one at a time, and acknowledged ids are remembered per surface. Unit: R3.

## Third pass (PR 53): one request protocol for all three surfaces

Written before the code, after the second pass kept finding the same family of bugs one patch at a time. This section is the contract; W20-W33 are the
failure modes it must close. Surfaces: a Coordinator chat (`message`, `chat-dequeue`), a worker (`thread-send`, `thread-dequeue`) and the Host agent
(`host-agent-send`, `host-agent-dequeue`). Units: `queued-input-unit` (R4-R10), `owner-input-queue-unit` (P1-P3). E2E: `chat-queue-e2e`, `worker-input-keys-e2e`,
`host-agent-e2e`, `chat-input-keys-e2e` (real browser loss, reload and concurrent typing).

### Contract

One request is `{ requestId, text, delivery, attachments, origin }`, immutable from the moment the owner presses Enter until the host forgets it.
It moves through these owners, and each step has exactly one owner at a time:

| step | owner | what the page may do |
|---|---|---|
| draft | the editor and the surface's draft in localStorage | edit freely |
| `sending` record | the surface's draft (`sending[]`, one record per send, never shared) | nothing; the editor no longer holds it |
| host ledger `queued` | the host (Job ledger, Jobs `inputs`, Host agent `owner-inputs.json`) | show it as pending; Alt+Up |
| runtime queue or turn | pi-durable (`queued` -> `placed`/`done`) | show it; Alt+Up while it is still `queued` |
| withdrawn | the host ledger, until the page acknowledges | the page copies it to its draft first, then acknowledges |

Host acceptance and Durable acceptance are different steps: the ledger entry is written first, the runtime submission second. An accepted request is
never "done" until the runtime holds it, so a retry of the same id re-submits (Durable takes an id once and returns the existing submission).

Page side (`web/queued-input.js`):
- Send: the `sending` record is written, and checked, before the editor is cleared or anything is sent. A refused write sends nothing and leaves the editor, uploads and origin untouched.
- Outcome of the request: **accepted** (the host answered ok) drops the record. **Refused** (the host answered with `refused: true`: it recorded nothing) hands the record back to the owner (below). **Unknown** (a network error, a timeout, a 5xx, a response that cannot be read) keeps the record and its id; the page sends the same id again, after a reload and on a timer, and never treats it as refused.
- A refused record goes back through the editor, never behind it: when the editor is shown, the text is put in front of what the editor holds now and the draft is written from the editor's own value. When it cannot be merged (more uploads than one message may carry, or another origin) it stays as a refused record that Alt+Up brings back, and the owner is told.
- Restore (Alt+Up): one restore at a time per surface, across tabs (a Web Lock); messages join the draft in Pi's order only while their uploads fit one message and their origin matches the draft's; the rest stays withdrawn at the host (or refused in the draft) and is offered again. Nothing is truncated and nothing inaccessible is acknowledged. An id that is also a `sending` record moves from one to the other in one write.

Host side:
- The same id with a different payload (text, delivery, attachments or origin) is refused (`refused: true`) on every surface. Durable does not compare payloads, so the host does.
- Admission, withdrawal and acknowledgment are serialized per surface. A request with a ledger entry and no runtime submission is re-submitted by a retry of its id, not returned as if it ran.
- An exception after the ledger write keeps the ledger entry (the outcome is unknown); only a refusal before it leaves no entry.
- Withdrawal returns text only when the runtime cannot deliver it and no producer can still submit it. "No submission seen" and "the agent ended" prove neither. A producer is: a message handler between its ledger write and its submission (chat, Host agent) and a live delivery task of the agent (worker); the second is read from the runtime's live task records, not from `endedAt`. An input with a producer stays queued ("kept") and is taken by the next Alt+Up.
- All three surfaces use `src/owner-input-queue.ts`; the chat adapter is a port over the Job ledger. Internal reports and approvals have no owner ledger entry and are never withdrawn.
- Uploads are not touched by any queue step (they are deleted only by the owner's explicit delete), so a restored or re-sent request keeps valid upload ids.

### Failure modes

- W20 `beginSend` ignores a failed storage write: the editor is cleared and the message is sent although nothing keeps it, so a reload or a refusal loses text and uploads. Nothing is cleared or sent unless the record was kept.
- W21 A refused send A is merged into the stored draft while the editor holds a newer text B; the editor keeps typing from B and the next keystroke overwrites the merged draft, so A is gone. The merge goes through the editor.
- W22 A response that never arrived (offline, timeout, 5xx) is treated as a refusal: the text is handed back and then also delivered when the host did get it, or the id is dropped and the same text is sent twice under two ids. An unknown outcome keeps the same id and payload and resends them.
- W23 The same request id is sent with other text or uploads and the host answers with the first request as if it were this one. The host refuses it on every surface.
- W24 The host wrote the ledger entry and then failed or crashed before the runtime submission; the retry with the same id finds the entry and returns it without submitting, so the message never runs. The retry submits (idempotent in Durable) unless the owner withdrew it.
- W25 Two overlapping Alt+Up on a Coordinator chat: the second finds the first's withdrawn mark on an input whose message handler has not submitted yet, offers its text as safe, and the turn then takes the input as well. Admission and withdrawal are serialized and an input with a producer is kept.
- W26 A worker is stopped (its `endedAt` set) after its delivery task passed its check and before it submitted: the withdrawal reads "ended" as "no producer", returns the text, and the delivery task then submits it. The producer is the live delivery task.
- W27 The Host agent removes its ledger entry when `submit` throws, although the submission may exist: the text is lost or runs twice. The entry stays, and a retry of its id submits again.
- W28 Restored messages with different origins (a Telegram message and a web message) are merged into one message that keeps one origin and drops the other. Only compatible origins join; the rest stays held.
- W29 A restore in two tabs of one surface: each tab's in-memory queue is separate, so both add the same text. One restore at a time per surface across tabs.
- W30 A refused record that cannot merge (too many uploads, another origin) is dropped or truncated. It stays as a refused record and Alt+Up brings it back whole.
- W31 A withdrawn input whose id is also an unknown `sending` record: the retry sends it again (the host answers withdrawn) while the text also sits in the editor. The record leaves `sending` in the write that restores it.
- W32 The editor is cleared and a record created for a slash command, so a reload resends `/command` as a message. Slash commands have no record and run only from the editor.
- W33 A host that cannot tell a refusal from a failure: validation errors carry `refused: true` only when no ledger entry or runtime submission was written; everything after the first write is unknown.
