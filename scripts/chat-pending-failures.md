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
