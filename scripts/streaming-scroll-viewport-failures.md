# Streaming and transcript scroll: failure cases

- Switching between projects with cached older transcript pages queues a scroll event while the transcript is empty. It must not fetch older history, disable following, or leave the newest message out of view.
- Deliberately scrolling to the top must still fetch older history and preserve the visible message's position. Refreshes must preserve a paused reader's position.
