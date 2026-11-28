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
- R9 A browser reload with a message in flight loses the bubble: the owner types it again (a duplicate) or sees nothing about it. A recovery handle must survive the reload, belong to one project and chat, and never leak into another. A delivered send whose handle goes before its draft is deleted leaves that draft behind for good when the page reloads in between.
- R10 A restored draft that the owner edited stays tied to the old bubble: the old bubble hides Retry, or sending the edit reuses the old request id.
- R11 A JSON error that did not come from the host's own refusal (a gateway) is taken as proof that nothing was sent, so the draft is restored and a second copy can be sent.
- R12 A Telegram replay of a record saved before origins were stored is refused as a different message, or a conflicting replay (other text, other chat, a web record) is accepted.
- R13 A denied recovery or admission grants the invoked skill's access.
- R14 Undo is offered from a stale answer after a reconnect or while a read is in flight, or the worker feed never learns the Undo state.
- R15 A long pending message is not clamped like the saved one.
- R16 A job id embedded in the page (a report link in a message) is trusted without being one of the project's jobs.
- R17 A record whose embedded id differs from its file name is taken as the message of that file, and its admitted flag shows a false Sent.
- R18 Recovery admits text that names an image without the image (deleted meanwhile), or with an image the saved content never had.
- R19 The 120000 limit is checked before the attachment block is added, so a skill is granted for a message the runtime then refuses.
- R20 Two tabs share one storage entry for recovery handles, so one erases the other's.
- R21 Retrying the original bubble while an edited draft is in the composer leaves that draft unowned, and it follows the owner into another chat.
- R22 A snapshot returns the saved effective content of an unadmitted record.
- R23 The Undo answer of a read that began before a reconnect is shown as current; the first connection of a stream withdraws Undo it just loaded.
- R24 A Telegram replay supplies the origin and re-expands the content of a legacy record that proves neither; only a receipt or the owner's own retry may settle it.
- R25 A saved message that does not say which images went with it is admitted as text only, or one over the runtime limit is recovered after granting its skill.
- R26 The first version's single handle list is lost on upgrade; more handles than the display cap are deleted as settled.
- R27 A turn-card Retry in a second tab, or after a reload, gets a new request id; an edited draft in one chat is replaced by another chat's draft.
- R28 Turn-card Retry reads the recipient after an await, so a chat switch sends it to the new chat; two projects with one failed job id share a retry id and handle.
- R29 A Telegram replay rebuilds a record that has an origin but no saved content; skill access is granted before the request is saved or admitted.

## Review round 4 (PR 63, six findings)

Written before the code. Each case runs through the page and the private browser endpoint (`src/web.ts`), never through a field the test invents.

- R30 The browser endpoint answers a host refusal without the host's refusal marker, so the page shows an unconfirmed bubble and no restored draft for a message the host never touched. An error that is not a proven pre-admission refusal must still read as unknown.
- R31 A repeat of a record without saved content (legacy, queued or running, no runtime receipt) is rebuilt from the text under its original id when the repeat comes from the owner; only the saved content or a runtime receipt is evidence.
- R32 A crash between the runtime taking the message and the skill grant loses the grant (the restart finds the receipt and only marks the record admitted), or a restart grants the skill again by resubmitting; a refused send grants a skill.
- R33 The page cannot store the recovery handle (storage full, denied) and sends anyway, so a reload loses the message with no trace; or the draft is cleared and the message is dropped.
- R34 Dismissing the failed bubble of a restored draft the owner already edited clears the edited, unsent draft.
- R35 A memory write older than the 50 most recent is offered Undo because it is absent from the recent list; an undone or changed write shows an Undo that fails. A legitimate old Undo must still work, checked only for the writes on screen and never with a send.
- R36 A repeat of a message the host already admitted, sent after its project went inactive, is answered with the host's refusal marker, so the page may treat a held message as not sent. Only a first send may be called a proven refusal.
- R37 A recovery handle another tab removed is trusted from the page's cache, so Retry sends without a handle on disk; and when Retry cannot store the handle the bubble drops from "Delivery not confirmed" to "Not sent" although the first attempt may have been admitted.
- R38 More than 20 unproven writes on screen: the ones past the first question are marked asked and never asked, so their legitimate Undo stays hidden; a failed question hides its writes until the next refresh.
- R39 The same text written again after an undo has the same revision (revisions are content hashes): an older, undone row is offered Undo and reverts the later write, or the later write shows Undone. Neither row may be offered Undo.
- R40 A revision written twice whose other write lies beyond the recent window is reported current: the window cannot see it, so the path's own history decides. When Retry cannot store the handle after a lost acknowledgement, the toast must say the retry was not sent again, not that the message was never sent.
