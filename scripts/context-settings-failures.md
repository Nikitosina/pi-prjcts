# Context and compaction settings per project (C8): failure cases, written before implementation

Verified by `scripts/context-settings-e2e.mjs` unless marked (inspection).

## Settings
- X1 No place to set the context window, auto-compact, threshold or keep-recent tokens; `~/.pi/agent/settings.json` `compaction` is ignored and the owner cannot change anything per project.
- X2 Out-of-range values (window 0 or negative, threshold 0%/100%, keep-recent larger than the window) are accepted and break generation (reserve ≥ window, negative background threshold).
- X3 Saving context settings requires an idle coordinator and worker queue (the generic settings-update closes the runtime), so the owner cannot react while a long session runs.
- X4 Saved values do not survive a host restart, or a reset (`null`) leaves stale values.
- X5 The settings revision does not cover the new field, so a concurrent edit silently overwrites it.

## Context window
- X6 The override does not reach the compaction threshold (pi-durable reads `models.getModel().contextWindow`), so compaction still waits for the catalog window.
- X7 The UI context meter still shows the catalog window instead of the override.
- X8 The override leaks to other projects (shared ModelRuntime) or to other models of the same project.
- X9 Removing the override does not restore the catalog/models.json window.

## Auto-compaction
- X10 Threshold % is ignored: compaction starts at the default point (window − 16384 − 32768) instead of the configured share of the window.
- X11 Auto-compact off still compacts on the threshold (manual and overflow are separate: manual must still work).
- X12 Keep-recent tokens is ignored (the whole transcript is summarized, or nothing is).
- X13 Workers keep the old policy while chats use the new one, or vice versa (inspection: one Harness per project, settings read on every resolution; documented: computed from the coordinator window).

## Compact now
- X14 No manual compaction: "Compact now" is missing, or only works for Main and not the selected chat.
- X15 Compact now on an archived/unknown chat or a paused project mutates anything, or on a short transcript errors instead of reporting "nothing to compact".
- X16 Compact now shows no progress/result; the context meter does not drop afterwards.
- X17 Double-click starts two compactions.
