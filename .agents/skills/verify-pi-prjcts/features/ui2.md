# UI 2.0 client at /ui2/

The owner opens the UI 2.0 client at `/ui2/`: a project tree with chats and Memory, a coordinator chat with compact tool rows, a Workers context panel, a settings overlay with letter hotkeys and themes, and the Host agent drawer. `/` stays the current client.

## Sub-features

- `serve`: `/ui2/` has the same token, CSP and headers as `/`; `/ui2` redirects; nested and unknown paths return 404.
- `chat`: a sent message shows one owner bubble, a mono `agents` tool row with a `worker ↗` link, a worker report row and the reply. Clicking the row head shows params and the result.
- `worker`: the Workers card shows plan progress and Approve. A spawn row opens the worker transcript in the center, and Esc returns to the chat.
- `memory`: knowledge tool calls render as "Used memory" and "Remembered · Undo · Edit" rows. An entry opens in the center. The tree's Memory node groups entries as Preferences, Decisions and Procedures, with search.
- `settings`: ⌘, opens the overlay. Section letters jump (H for Theme). The theme applies at once and survives a reload.
- `host-agent`: `\` opens the drawer. Before the backend merge it shows "Available after backend merge".
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

The drive uses these ids: `#tree`, `#composer textarea`, `#feed .tool-row[data-tool]`, `#feed .memory-row`, `#workers .worker`, `#center[data-focus]`, `#focus-view`, `#memory-search`, `#settings`, `[data-theme-option]` and `#host-agent[data-open]`. Key presses go through `Input.dispatchKeyEvent`. It saves screenshots `01` to `10` (claude, midnight, light and 390 px narrow) and `feed-dom.txt`.

## Gotchas

- Before the backend merge, the host refuses `ui-*`, `tiers-*`, `profiles-*`, `memory-*`, `host-agent-*` and `approvals-*` as unknown actions. The client shows them as unavailable and keeps theme and hotkeys in localStorage. The drive drops those `/api` 400s from the error sinks only when `ui-get` is missing, and records how many it dropped.
- The theme check after the reload proves local persistence only. Host persistence through `ui-set` needs the merged backend.
- Worker data, PR 12 and the memory text are scripted by the fake provider.
