# Failure cases: composer drafts per chat (`chat-drafts-e2e`, `chat-drafts-remote-e2e`)

Written before the tests. Each case names how the composer can lose or misplace the owner's unsent text; the scripts prove it. Rules: a draft belongs to one
host, project and chat (the Host agent has one per host); a tab writes a draft only on an `input` event in that tab; a draft is deleted only by an
exact-text successful send, the owner emptying the field, Dismiss of a refused message, a confirmed archive of the chat, Forget host or a revoked device;
nothing is evicted for size.

## Switching and reload

- D1 The composer text follows the owner into another chat or project instead of staying with its chat.
- D2 Switching back to a chat shows an empty composer, or the text without the caret the owner left.
- D3 A reload loses the draft, or shows the draft of another chat.
- D4 A draft of project A / chat X appears in project B / chat X (same chat id, other project).

## Two tabs

- D5 An idle tab B that closes, reloads or switches chats writes its stale composer text over the draft tab A is typing, or deletes it.
- D6 A switch, reload or `pagehide` writes to storage at all (any write not caused by an `input` event).
- D7 A sends "base" while tab B has typed the newer draft "base more": A's cleanup deletes B's draft.
- D8 A sends "hello" while B stored "hello " (one trailing space): a trimmed comparison deletes B's draft.
- D9 A sends and the host admits the message: the sent text stays stored and comes back as a draft after a reload.
- D10 Between the send and its ack the sent text shows again as a draft (chat switch or reload while sending).

- D25 Another tab writes a newer draft between A's check ("the stored text equals what I sent") and A's delete, and the delete removes the newer text: the check and the delete are not one step across tabs. Likewise an earlier input write that waited its turn must never overwrite a later one, even when another tab queued a write between them.
- D27 A second tab's copy of the same pending message settles the same send a second time and deletes a fresh draft that happens to read the same as the sent text; or the settle mark cannot be stored and the draft is deleted anyway, so the next copy has nothing to stop it.

## Refusal

- D11 A refused message restored in A overwrites the newer draft B stored for that chat.
- D12 A refused message whose text went back to the composer is lost on reload (no stored copy), or the bubble's Retry is gone while the text is only in memory.
- D30 The bubble's Retry follows a flag set when the refusal came back, not the composer: after a switch, another tab's newer draft fills the composer and the refused text has no Retry left.
- D13 With a newer draft in the chat, the refused text has no durable copy (no bubble with Retry) after a reload.
- D14 Dismiss of a refused message leaves its text stored as a draft, or deletes an edited draft the owner made from it.

## Deleting

- D15 Emptying the field leaves the old text stored, so it returns after a reload.
- D16 Archiving a chat (after the owner confirms) leaves its draft in storage.
- D17 A draft is removed to make room for another (an eviction), or a cancelled archive removes it.

## Size

- D18 The browser refuses to store a draft and the owner is not told; or the older stored text is deleted when the new one cannot be written; or a refused Host agent text is not put back in the composer because it could not be stored; or a switch away and back replaces the unsaved text with the older stored one.

## Host agent

- D19 The Host agent composer keeps no draft over a reload, or shares its draft with a chat.
- D20 A successful Host agent send leaves its text stored, or deletes a newer draft typed meanwhile; a refused send loses the text.

- D26 A Host agent send is refused after the owner typed something new in its composer: the refused text is lost when the new text is sent, or it replaces the new text. The Host agent has no bubble, so the refused text goes back into the composer and the stored draft, below whatever they hold, after a blank line. A text the owner retyped while it was being sent is kept twice, not folded into one.
- D29 A Host agent send is refused while another tab stored a newer Host agent draft: the refusal overwrites the newer draft, or the refused text is not stored and a reload loses it. The stored draft is read and merged inside the key's lock, so both texts stay. An edit the owner makes while the restore waits for the lock is written after it, and the refused text is not added a second time.

## Remote hosts

- D21 A remote host's draft is stored under the local key, so a local chat with the same ids shows it.
- D22 Forget host leaves the remote host's drafts or pending-send handles in this browser, or removes local ones or another host's.
- D22b An input of the forgotten host still waiting for its lock writes the draft back after Forget host.
- D23 A revoked device leaves the host's drafts or pending-send handles in this browser.
- D28 The failed-turn Retry of a remote chat creates a send without the owning host, so the host is whichever one is selected when the send is made or retried, and its draft key follows the selection. A send whose host was forgotten, or a handle stored before sends named their host, goes to another host instead of failing closed. Two hosts with copied homes share project, chat and failed-turn ids, and their failed-turn Retries share one pending send and request id.
