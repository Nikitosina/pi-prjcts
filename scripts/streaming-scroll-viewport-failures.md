# Streaming and transcript scroll: failure cases

- Switching between projects with cached older transcript pages queues a scroll event while the transcript is empty. It must not fetch older history, disable following, or leave the newest message out of view.
- Switching in both directions through the top chat strip between named chats in separate projects with cached long histories and rich content must land at the newest message, without loading older pages. A cleared transcript can retain a positive viewport height; a pending older request must not change another chat's position.
- Deliberately scrolling to the top must still fetch older history and preserve the visible message's position. Refreshes must preserve a paused reader's position.
- With a visible worker warning, switching top tabs can leave an empty transcript with positive height. Its queued scroll must not load older history or stop following the destination chat.
