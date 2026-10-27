# Throwaway agent coordinator interaction models

## Question and owner correction

Can coordinator supervision work as a keyboard-first TUI, a desktop session workspace, or a decision desk? These should differ in how people work, not just in color or cards.

The owner asked for more native interaction and drastic changes. This revision takes over the previous worker's committed prototype and uncommitted app/CSS redesign. Each model now replaces the Projects header/sidebar entirely. All three remain on `/`, selected by `?variant=terminal|desktop|dispatch`. The production app does not load these files.

## Run and review server

```sh
npm run prototype:agent-desktop
```

- A: <http://127.0.0.1:4179/?variant=terminal>
- B: <http://127.0.0.1:4179/?variant=desktop>
- C: <http://127.0.0.1:4179/?variant=dispatch>

`PORT=4180 npm run prototype:agent-desktop` selects another port. Reload clears memory. The floating switcher retains the query parameter and displays variant/action state.

The existing review instance was verified, not restarted: wrapper PID **48542**, Node PID **48569**, prior background task `bg-d5d7f9db`. Node's cwd matches this worker worktree and its command is `node web/prototype-agent-desktop/serve.mjs`. It listens only on `127.0.0.1:4179`. This is not the owner's production host. Keep it running for review. Before eventual cleanup, recheck the PID command/cwd and listener identity, then stop that prototype process or its background task. Never kill an unrelated or reused PID.

## Safety boundary

Static files and memory-only actions. No persistence, production imports, API requests, socket, token, shell calls, model calls, or real mutations. Displayed bash commands and tool output are fixture text. CSP has `connect-src 'none'` and `form-action 'none'`. The static host reuses `web/index.html` as a mount point and swaps the production script for this isolated script. No production routing/default behavior changed. Do not promote this code.

## A: modal terminal

The primary action is to navigate the transcript or queue a steer, not to manage project cards.

Walkthrough:

1. Press `?` for help or click the help hint. `j/k` selects visible transcript blocks in order; `o` expands/collapses a selected tool. `d` toggles the inline diff and `w` toggles workers.
2. Press `f`, type `delegat`, and inspect the filtered transcript. Escape clears it. Press `s`, filter `mobile`, and Enter to open its mock session; repeat for `release`.
3. Press `i` to edit. Type `/` for slash completion, filter `/di`, then Tab or Enter to run `/diff`. Available commands include `/steer`, `/compact`, `/sessions`, and `/help`.
4. Type a steer and Enter to queue it locally. Send another, then use Up/Down in the empty prompt to traverse history. Shift+Enter inserts a newline. Escape leaves insert mode.
5. In normal mode `/` opens a filterable command palette. `y` records the displayed local retry choice; `n` opens the decision desk's consequence view.

Compact statuses show running/paused state, queue length, tokens, cost and context. The worker rail disappears on narrow screens. This is a modal browser mock, not a terminal emulator or exact Pi reproduction.

Tradeoff: compact and useful for active pairing, but mode switching and mixed narrative/tool output demand more learning.

## B: Hermes-inspired workspace

The primary action is to work within a session while inspecting its files and activity.

Walkthrough:

1. Select Mobile verification, return to Release coordination, or use `+` to create an empty local session. Filter sessions with the sidebar input. Typed messages belong to the selected session and reset on reload.
2. Use the inspector tabs Diff, Files, Activity and Context. Choose a fixture file, open host.ts from the diff, or compact mock context to change its meter.
3. Pause/resume mock tasks, attach/remove retry-policy.md, or switch the mock model in the composer. These change local state only.
4. Open the palette with Cmd+Shift+P or Ctrl+Shift+P. Filter `files` and Enter. `[` toggles sessions, `]` toggles the inspector; F6 cycles available workspace focus targets.
5. Drag the inspector separator to resize it, or focus it and use Left/Right. These keys resize rather than switching variants.

At tablet width sessions become a drawer. On mobile the inspector is a closeable overlay, initially closed, and sessions remain available as a drawer. The reference files/diffs are fixtures, not a real filesystem. Workspace identity and settings controls explicitly report their mock limitations.

Tradeoff: useful chat-plus-working-context layout, with more pane navigation and less operational detail visible at once than A.

## C: decision desk

There is no chat or project-navigation shell. A two-item owner queue leads to one question, its evidence/consequence tabs, choices and an undoable local ledger. Worker status remains secondary.

Click either queue entry, inspect evidence or consequence, then choose an option. Alternatively `j/k` switches question, `1/2` records a choice, and `u` undoes it. No worker is actually unblocked and no approval or handoff is sent. The copy deliberately separates local recording from real execution.

Tradeoff: useful for intermittent supervision, but omits detailed chronology and conversational steering.

## References and assumptions

The earlier research pass used these public sources. Reference images remain in artifacts `54784fc7-1bc3-4268-8617-d14a43eabe50/references/`.

- Pi coding-agent/TUI package identity in this repository: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 1.0.2. A interprets terminal conventions: dense turns/tools, prompt history, slash commands, compaction and token/context/cost status. The specific modal bindings are prototype choices, not claims about Pi's actual bindings.
- Official Hermes desktop: <https://github.com/NousResearch/hermes-agent/tree/main/apps/desktop>. Its README describes streaming chat, side-by-side previews, file browser and shared sessions. Its DESIGN.md says "Chat is the home surface" and "Flat, not boxed." The official `pr-assets/session-source-folders.png` informed the quiet session navigation and composer.
- Community Hermes One: <https://github.com/fathah/hermes-desktop>. `previews/chat.png` and `previews/sessions.png` informed session grouping, tool summaries and model/token treatment. This prototype borrows ideas; it does not claim exact Hermes features, branding, bindings or parity.

Assumptions: coordinator supervision matters more than general chat; owner decisions and worker/tool context must remain available. All names, projects, timestamps, models, costs, token counts, results, diffs, workers and statuses are invented fixtures, not runtime evidence.

## Inspection and evidence

Fresh headless Chrome, private temporary profile, real CDP key events, text insertion and hit-tested pointer clicks against the isolated static host. No test infrastructure was added to the repository. This is an unscripted prototype inspection recorded with an artifact-only driver, not a production host or real-model verification.

Evidence folder: `artifact:09fc0baf-f57e-4382-8b6e-f489c0955283/prototype-agent-desktop/`.

- `desktop-terminal.png`, `desktop-desktop.png`, `desktop-dispatch.png`: revised models at 1440×1000.
- `tablet-terminal.png`, `tablet-desktop.png`: 800×1100.
- `mobile-terminal.png`, `mobile-desktop.png`, `mobile-desktop-inspector.png`: 390×844.
- `terminal-shortcuts.png`, `terminal-slash-completion.png`, `terminal-command-palette.png`, `terminal-queued-steers.png`.
- `desktop-shortcuts.png`, `desktop-command-palette.png`, `desktop-files.png`, `desktop-activity.png`.
- `dispatch-recorded-decision.png`, `walkthrough.mp4`, `report.json`. `responsive.png` and `commands.png` combine the responsive and keyboard captures; `gallery.html` indexes all evidence.

Inspection covers tool expansion, transcript ordering/search, filtered session/palette selection, slash completion, queue/history, input/browser modifier exclusions, variant keys/clicks, files/activity/context, pause/attach, per-session messages, F6 and resize arrows, local decision recording/undo and reload reset. All 48 inspection checks passed. A separate source review found cross-variant retry-choice targeting, Tab/Enter focus selection, history editing, diff-tab and resized-pane edge cases; these were fixed and checked with real inputs, including widths 700, 821 and 1050. No runtime exceptions, horizontal overflow at captured sizes, production app.js loading, API or nonlocal requests were observed. Requests were limited to the loopback static assets and a harmless favicon request. `npm run check`, `node --check` and `git diff --check` passed.

## Verdict and cleanup

Pending owner selection. No variant has been promoted, merged or deployed. The review question is whether A's command flow, B's session-and-inspector workflow, or C's decision queue should guide a production redesign. Parts can be mixed after feedback.

After a decision, record the chosen interaction and its tradeoffs, implement it with real permissions/data/streaming/tests, then delete `web/prototype-agent-desktop/` and the `prototype:agent-desktop` package script. Stop only the verified private prototype server before deletion. Do not absorb these fixture components directly.
