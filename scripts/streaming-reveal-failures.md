# Streaming reply in the inbox at `/`: failure cases

`streaming-reveal-e2e.mjs`. The classic client paced streamed text in with a fade (old S1-S5 and S8: paint cadence, fade only on new
words, reduced motion, hidden-tab flush, abort/resume, unfinished inline Markdown). That reveal was retired with the classic inbox on
2026-11-04; the new client paints each live frame as it arrives.

- S6 Switching to another chat shows this chat's live text there, or coming back does not restore the running reply.
- S7 The finished message differs from what the host stored, loses the heading or code blocks, or appears twice (live + stored).
- S9 After Stop the live reply comes back when the provider sends more.
- S10 Stop throws away the part already received instead of keeping it in storage and in the transcript.
