# UI polish (round 1): failure cases

Found by driving the web UI against a real coordinator (`openai-codex/gpt-6-luna`) on the `pi-prjcts` project itself. Each line is a way the polished UI could still be wrong. `scripts/ui-polish-e2e.mjs` checks them with a fake model.

## Conversation
1. A worker report (`[Durable work <id>, <role>, <status>; thread <id>]…`) renders as a "You" bubble with raw UUIDs and the coordinator instructions.
2. A report card loses the result text, or does not link to its worker thread.
3. A report with an unexpected shape (the regex misses) disappears instead of falling back to a plain message.
4. A tool call renders as a raw function name in a heavy coloured card. A `projects_delegate` call does not say who got what task.
5. An errored tool call looks the same as a successful one.
6. Message headers repeat the full date on every message from today.

## Layout
7. The page itself scrolls at 1440×900, clipping the project header.
8. The transcript cannot be scrolled independently, or the composer leaves the viewport.
9. The mobile layout (390 px) overflows horizontally.

## Header and composer
10. Pause and Resume are both shown, one disabled.
11. The eyebrow says "Nothing needs your call" while the subtitle repeats the same status.
12. The composer placeholder repeats the hint line. The model name is far from the composer.
13. The textarea does not grow with content, or grows past the viewport.

## Side rail
14. "Needs you" shows an empty card when nothing is pending.
15. Completed durable work vanishes from the rail. "Recent outcomes" only knows legacy reviews.
16. "All 1 work items" grammar. The link opens a dialog that duplicates the Activity tab.
17. Clicking a recent result does not open its thread.

## Regressions to keep
18. Retry button on failed turns, live streaming bubble, archive flow, context meter, and `/` focus all keep working (existing E2Es).

# Round 2 (from continued real-model use)

19. Numbered lists separated by blank lines render every item as "1.".
20. Activity stacks the thread below the work list with nested scrolling. Work list and thread must sit side by side and scroll independently.
21. The Knowledge tab repeats the docs list as tiles and shows raw timestamps and byte counts.
22. Editing a knowledge document asks you to type the 36-character project UUID. No owner action may require typing it.
23. At 1100 px the project header wraps: avatar above the title, ⋯ on its own line. The composer footer wraps too.
24. On mobile (390 px) the full project sidebar fills the first screen.
25. The context ring looks like a loading spinner and shows no number.
26. Rail lines wrap their time detail onto a ragged second line.
27. The Needs-you card repeats the question title three times.
