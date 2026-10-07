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
12. The chat list is missing or does not mark the selected chat; switching keeps the previous chat's transcript, draft or live bubble.
13. The live stream shows another chat's in-flight generation.
14. Rename does not persist or is not shown; archive leaves the chat selectable for new messages; Main can be archived.
15. The selected chat is lost on reload (it must survive in the URL).
16. Activity shows only the selected chat's work instead of the shared pool.

## Lifecycle
17. Project pause stops only Main; another chat keeps generating.
18. Messages to an archived chat, or while paused, are admitted.

## Regressions to keep
19. live-chain, ui-polish, coordinator-live, github-quick-ui, coordinator-workers-ui, projects-chat-md, workers-card-ui, worker-chat-ui and coordinator-github-skills keep passing.
