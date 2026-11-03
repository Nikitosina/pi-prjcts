# UI 2.0 client at /ui2/

The owner opens the UI 2.0 client at `/ui2/`: a project tree with chats and Memory, a coordinator chat with compact tool rows, a Workers context panel, a settings overlay with letter hotkeys and themes, and the Host agent drawer. `/` stays the current client.

## Sub-features

- `serve`: `/ui2/` has the same token, CSP and headers as `/`; `/ui2` redirects; nested and unknown paths return 404.
- `chat`: a sent message shows one owner bubble, a mono `agents` tool row with a `worker ↗` link, a worker report row and the reply. Clicking the row head shows params and the result.
- `worker`: the Workers card shows plan progress and Approve. A spawn row opens the worker transcript in the center, and Esc returns to the chat.
- `memory`: knowledge tool calls render as "Used memory" and "Remembered · Undo · Edit" rows. An entry opens in the center. The tree's Memory node groups entries as Preferences, Decisions and Procedures, with search.
- `settings`: ⌘, opens the overlay. Section letters jump (H for Theme). The theme applies at once and survives a reload.
- `host-agent`: `\` opens the drawer. A message runs the Host agent: its tool calls show as mono rows (unfolded), and `ui_focus` frames from the host change feed move the page (here, Memory in the center). A dangerous `host_call` becomes an approval card above the transcript and counts in the status pill. Deny removes the card and leaves the request unrun; the outcome renders as one row, not a bubble. The model chip opens model, thinking and tools, saved with the settings revision. On a host without the Host agent the drawer shows "Available after backend merge".
- `narrow`: at 390 px there is no horizontal overflow, and the list and context become sheets.

## How to get to it (user POV)

- Open the launch link with `/ui2/` before the `#token` fragment.
- Type in the composer (❯) and press Enter. Click a tool row, a `worker ↗` link or a memory row link.
- Click Memory under the project in the tree.
- Press ⌘, then a section letter. Press `\` for the Host agent. Esc leaves any focus view.

## Driving it with browser CDP

Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> ui2`. The fake provider handles two prompts:
- `VERIFY-JOB`: the spawn and Ready worker.
- `VERIFY-MEMORY`: a `projects_knowledge_read` of `preferences.md`, then a `projects_knowledge_write` of `decisions/greeting-style.md`.
- `VERIFY-HOST` (Host agent): `host_call list`, `ui_focus { view: memory }`, then `host_call archive` of the first listed project, which files an approval. The drive denies it and checks with `approvals-list` and `list` that nothing was archived, then switches thinking to low and back through the drawer settings.

The drive uses these ids: `#tree`, `#composer textarea`, `#feed .tool-row[data-tool]`, `#feed .memory-row`, `#workers .worker`, `#center[data-focus]`, `#focus-view`, `#memory-search`, `#settings`, `[data-theme-option]`, `#host-agent[data-open][data-available]`, `#ha-composer textarea`, `#ha-approvals [data-decide]`, `.approval-row`, `#ha-model` and `#ha-settings [data-thinking]`. Key presses go through `Input.dispatchKeyEvent`. It saves screenshots `01` to `10` (plus `08b` approval, `08c` denied, `08d` drawer settings) (claude, midnight, light and 390 px narrow) and `feed-dom.txt`.

## Gotchas

- Until the backend workstream merges, the host refuses `ui-*`, `tiers-*`, `profiles-*`, `profile-tools`, `prompt-render` and `memory-*` as unknown actions (and `host-agent-*`/`approvals-*` on a host older than c8c8ecf; the drive then records the Host agent part as blocked). The client shows them as unavailable and keeps theme and hotkeys in localStorage. The drive drops those `/api` 400s from the error sinks only when `ui-get` is missing, and records how many it dropped.
- The theme check after the reload proves local persistence only. Host persistence through `ui-set` needs the merged backend.
- Worker data, PR 12 and the memory text are scripted by the fake provider.
