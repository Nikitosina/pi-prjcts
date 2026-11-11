# Multiple chats per project: failure cases

Owner decision: each chat is its own durable coordinator conversation. All chats share knowledge, standing instructions, one worker pool and the Activity tab. A worker report goes back to the chat that delegated it. The Coordinator tab has a chat list (new, rename, archive). The existing coordinator becomes the first chat, "Main". `scripts/multi-chat-e2e.mjs` checks these with a fake model.

## Identity and compatibility
1. An existing project (no chat list stored) fails to open, shows no chat, or loses its transcript. It must open with exactly one chat, Main, which is the existing root conversation.
2. A new chat reuses the Main conversation (shared transcript) or creates a conversation with no coordinator configuration (no tools, wrong model or instructions).
3. After a host restart, chats disappear, lose their titles or transcripts, or lose tools because only the root is reconfigured on recovery.
4. A chat ID from another project, or an unknown ID, is accepted.

## Shared tools and authority
5. Coordinator-only tools (worker management, decisions, GitHub, library, skill files, knowledge writes without a worker maintain grant) refuse calls from a non-Main chat because they compare against the root conversation only.
6. `projects_delegate` from a non-Main chat writes a separate planning document on that chat, creating a second worker pool that the Activity tab and cap never see.
7. Worker conversations become able to call coordinator-only tools because the coordinator check is widened too far.

## Routing
8. A worker report goes to Main instead of the delegating chat, or goes to both.
9. A follow-up, retry or steer by the coordinator in another chat reports to the wrong chat.
10. An owner answer to a `projects_question` asked in chat B wakes Main instead of chat B.
11. Owner messages land in the wrong chat, or the job ledger shows another chat's messages.

## UI
12. The chat list is missing or does not mark the selected chat; switching keeps the previous chat's transcript, draft or live bubble. The Workers list shows Main's workers (or none) when the jobs read lands before the chat's view: it must follow the selected chat whichever read arrives first.
13. The live stream shows another chat's in-flight generation.
14. Rename does not persist or is not shown; archive leaves the chat selectable for new messages; Main can be archived.
15. The selected chat is lost on reload (it must survive in the URL).
16. Activity shows only the selected chat's work instead of the shared pool.

## Lifecycle
17. Project pause stops only Main; another chat keeps generating.
18. Messages to an archived chat, or while paused, are admitted.

## Archive from the sidebar and keyboard
The runtime refuses to archive Main and aborts a busy chat's turn when it is archived; workers it delegated keep running and report to Main.
20. A chat row has no archive control, the control is a button nested in the row button, or it shows only on hover (not on keyboard focus or touch screens). Its name and tooltip lack the chat or the current shortcut.
21. Main offers archive, or the shortcut archives Main or the project instead of the chat.
22. Archiving a chat whose turn is running silently aborts that turn. The page must refuse and say to stop it first.
23. Archiving the selected chat leaves it selected or selects nothing; it must select the next chat (else the previous). Archiving another chat moves the selection.
24. There is no Undo, or Undo does not bring the chat back to the tree with its transcript.
25. A failed archive drops the row or the selection, or shows no error.
26. A double click sends two archive requests.
27. Mod+Shift+E does nothing, matches Mod+E, fires while typing, in the worker view or with Settings open, or is missing from the Hotkeys page.
28. The archive does not survive a reload.
29. Arrow keys in the tree stop on archive buttons.
30. The button or the shortcut archives without a confirmation dialog naming the chat; Cancel or Escape archives or moves the selection; a repeated shortcut stacks dialogs or archives; focus is lost when the dialog closes.
31. Hovering the tree shows 1–9 badges on chat rows (noise the owner removed), or removing them also breaks the digit shortcuts that switch chats.

## Regressions to keep
19. live-chain, ui-polish, coordinator-live, github-quick-ui, coordinator-workers-ui, projects-chat-md, workers-card-ui, worker-chat-ui and coordinator-github-skills keep passing.

## The inbox at `/` (classic inbox retired 2026-11-04)
Chats are the selected project's `[data-chat]` rows in `#tree`; New chat is `[data-new-chat]`; the transcript is `#feed` and the live
turn `#live-turn`. F8 opens the scout from `#workers` into the worker view. F12 checks that switching chats swaps the transcript and
the Workers list. F14 renames with `/name`. F20-F30 archive with the row's `[data-archive-chat]` button and Mod+Shift+E, confirmed in `#archive-chat`; F25 stubs
`fetch` in the page to fail one `chat-update`.
Retired with the classic layout: per-chat composer drafts and the chat tab strip.
Known gap: the tree's dot for a background chat does not turn "working" while it streams: running turns publish no topic, so the
project list only refreshes on the next commit or the 15 s list read. F13 checks busy flags over RPC, as before.
