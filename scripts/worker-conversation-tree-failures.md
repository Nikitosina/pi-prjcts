# Worker conversation tree browser regression failure cases

Recorded before implementing the custom browser journey. The journey must use a private real host and a fake provider, not the prototype fixture or a generic coordinator compose test. Compare the rendered tree with a read-only persisted plan snapshot.

- A conversation is missing or duplicated, or work belonging to different threads is combined into one conversation.
- A node shows the wrong role, thread, current work, status, reason, or context usage, or presents context usage as a per-work history value.
- Queued follow-ups are missing, out of order, or associated with the wrong conversation; current work and history are confused.
- Delegated conversations or a host-created verifier appear under the wrong parent, or a fabricated verifier is accepted as proof of the real verifier relationship.
- History cannot be expanded or collapsed, contains the wrong work, or loses its state during routine refresh or interaction.
- Clicking a conversation, work detail, or supported control targets another thread or work item. Keyboard focus or activation fails, or focus is lost unexpectedly.
- Empty, archived, blocked, failed, stopped, completed, running, idle, or queued states are hidden or mislabeled when present in persisted state.
- Reloaded browser state disagrees with the persisted plan, including queue order, history and parent relationships.
- Light, dark, or narrow layouts obscure or clip content and controls, or make them unusable.
- Browser console or HTTP errors are unexplained; screenshots lack matching functional and persisted-state evidence.
- The private host, provider, browser or scratch data remain after cleanup, or cleanup touches resources not owned by the run.
