# Failure cases: fast send and chat switch (`chat-pending-e2e`)

Written before the code. Each case names how the page can go wrong; `scripts/chat-pending-e2e.mjs` proves it.

## Memory (Undo state)

- M1 An ordinary chat reload (send, live frame, switch to another chat of the same project) asks the host for `memory-recent`, so every send pays the knowledge scan.
- M2 Selecting another project does not load that project's Undo state, or shows the previous project's.
- M3 A slow `memory-recent` holds back the first transcript paint of a selected project.
- M4 A `memory-recent` answer for project A lands after the owner selected project B and replaces B's state.
- M5 A knowledge change (a coordinator write) does not refresh Undo state, so the new row has no correct Undo.
- M6 A burst of knowledge changes sends one request each instead of coalescing.
- M7 Undo stops working or shows "Undone" wrongly after the refresh moved out of `loadChat`.

## Pending owner message

- P1 The owner's text is not on screen until the ack and a transcript read return.
- P2 After the ack the pending bubble and the canonical message are both shown, or neither.
- P3 A late ack, or a refresh that lands before the ack, shows the message twice or removes it.
- P4 Two identical consecutive texts collapse into one bubble, or one canonical message claims both pending bubbles.
- P5 Switching chat or project while a send is pending shows the bubble in the other chat, or loses it when switching back.
- P6 A rejected send is shown as sent, loses the text, or its bubble appears in another chat.
- P7 A lost response (the host may have admitted the message) is shown as success or as a plain failure, or is sent again on its own.
- P8 A slash command, a draft typed after the send, or the existing draft restore on failure changes behavior.
- P9 A failed bubble never goes away, or its Retry sends under a new request id after an ambiguous delivery.
- P4b A refused short text is matched to a longer message that contains it, so the refusal disappears.
- P6b A refusal that arrives after the owner left the chat and came back leaves the bubble on Sending, or restores the draft into another chat.
- P7b The host recorded the job and then reported an error: the bubble says Not sent and the restored draft invites a second send.
- P4c A recorded short text takes a longer message that contains it as its own canonical message.
- P6c A restored draft that the owner edited keeps the bubble's claim that it is in the composer, hiding Retry.
- P10 A job the host recorded but never admitted is shown as Sent, or Retry returns it without admitting, so the message never arrives.
- P10b A pending message is matched by its text (equal, or followed by a blank line and appended blocks) to a different transcript message, so one message swallows another.
- P10c Without a transcript entry linked to the pending message's own request, a bubble guesses; it must stay unconfirmed instead.

## Delivery recovery (decisions/message-delivery-recovery.md)

Written before the code. The saved request is the intent: a restart continues it under its own id, or leaves it visibly unknown.

- R1 A message the host recorded but never admitted (any client, including one that supplied no id, or Telegram) is lost on restart, or admitted from a rebuilt prompt instead of the content that was saved (skill expansion, references, attachment block).
- R2 The runtime holds the submission but the ledger was not marked admitted (crash between the two): a restart admits it again, so the chat gets a second turn.
- R3 An admitted message is admitted again after a restart.
- R4 A legacy record without saved content is delivered from a guess, or hidden; it must stay unconfirmed, and only the owner's explicit Send again delivers it (once).
- R5 A saved message whose chat was archived meanwhile is delivered into the main chat, or the check is skipped; it must stay undelivered and unconfirmed.
- R6 The saved effective content stays in the record after admission.
- R7 The attachment block delivered after a restart differs from the one saved (a renamed or deleted upload changes the text).
- R8 A turn-card Retry whose ack was lost sends under a new request id on the next click, so the chat gets two turns.
- R9 A browser reload with a message in flight loses the bubble: the owner types it again (a duplicate) or sees nothing about it. A recovery handle must survive the reload, belong to one project and chat, and never leak into another.
- R10 A restored draft that the owner edited stays tied to the old bubble: the old bubble hides Retry, or sending the edit reuses the old request id.
- R11 A JSON error that did not come from the host's own refusal (a gateway) is taken as proof that nothing was sent, so the draft is restored and a second copy can be sent.
- R12 A Telegram replay of a record saved before origins were stored is refused as a different message, or a conflicting replay (other text, other chat, a web record) is accepted.
- R13 A denied recovery or admission grants the invoked skill's access.
- R14 Undo is offered from a stale answer after a reconnect or while a read is in flight, or the worker feed never learns the Undo state.
- R15 A long pending message is not clamped like the saved one.
- R16 A job id embedded in the page (a report link in a message) is trusted without being one of the project's jobs.
