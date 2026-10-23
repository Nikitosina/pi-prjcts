# Activity prototype (throwaway)

**Question.** What should Activity look like so a worker's status, context use, and what it is doing are graspable at a glance, and should it stay a separate tab or fold into the Coordinator?

**Plan (one line).** Three structural variants of Activity, plus today's layout as the default, switchable from a floating bar via `?variant=`, hosted on the existing Activity tab.

## Run

```
npm run inbox
```

Open the app with `?tab=activity` and `?variant=A`, `?variant=B` or `?variant=C`. No `variant` param is today's Activity (`#work-list`, `#inline-thread`, `#artifact-pane`). The yellow pill at the bottom cycles Current → A → B → C → Current (buttons, or ← / → when no input, textarea, select, contenteditable or dialog has focus). The strip above it shows variant, chat id and title, and the focused worker's status, role, model, threadId, context tokens, window, compacting and blocker. `?variant=` survives reload.

Every variant lists only the selected coordinator's workers (same scoping as the Coordinator Workers card) and shows the chat title.

## What each variant decides

- **A — Board:** whether grouping workers by state (Running / Waiting / Blocked / Finished) as cards, with one card expanding in place, beats a mail-style list.
- **B — Inspector:** whether one worker deserves the whole screen, with a context ring first and a tool-call timeline (messages as notes on the spine) instead of a chat transcript.
- **C — No Activity tab:** whether the Coordinator's Workers card, expanding in place to the latest events and follow-up / steer / stop, can replace the Activity tab entirely.

## Context figures

Rings use a read-only `context` field on `thread-history` (`{ tokens, window, compacting, model }`), requested with `context: true` so the 2-second change watcher and the project snapshot do not pay for it. Tokens come from `contextTokens()` on the worker conversation; the window is the worker model's catalog `contextWindow` (the project override is coordinator-only and is not applied). When the window is null the UI shows the token count and "window unknown", never a percent. The prototype caches the figure in memory (8 s for live workers, 2 min for finished ones).

## Known gaps

- The strip's focused worker in "Current" is the thread open in the existing thread pane.
- Artifact chips open the file in a new browser tab; the existing artifact browser is not reused.
- Mermaid / CSP / production fixes are separate from this prototype.

## Verdict

_Owner fills in._ Stay a tab or fold into the Coordinator? Which of A / B / C, and what to keep:

&nbsp;

&nbsp;

Once a verdict exists, delete this prototype: `web/activity-prototype.js`, `web/activity-prototype.css`, this file, the `<script>` in `web/index.html` and the two asset-map lines in `src/web.ts`. (The `context` option on `thread-history` may stay if the verdict wants rings.)
