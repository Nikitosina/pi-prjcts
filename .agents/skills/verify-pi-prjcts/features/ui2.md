# UI 2.0 client at /ui2/

The owner opens the UI 2.0 client at `/ui2/`: a project tree with chats and Memory, a coordinator chat with compact tool rows, a Workers context panel, a settings overlay with letter hotkeys and themes, and the Host agent drawer. `/` stays the current client.

## Sub-features

- `serve`: `/ui2/` has the same token, CSP and headers as `/`; `/ui2` redirects; nested and unknown paths return 404.
- `chat`: a sent message shows one owner bubble, a mono `agents` tool row with a `worker ↗` link, a worker report row and the reply. Clicking the row head shows params and the result.
- `worker`: the Workers card shows plan progress and Approve. A spawn row opens the worker transcript in the center, and Esc returns to the chat.
- `memory`: knowledge tool calls render as "Used memory" and "Remembered · Undo · Edit" rows. An entry opens in the center. The tree's Memory node groups `memory-index` entries as Preferences, Decisions and Procedures (status badge when not current, superseded link, broken links, archive behind a toggle), with search. Undo on a Remembered row calls `memory-undo` and the row then says "Undone".
- `settings`: ⌘, opens the overlay. Section letters jump (H for Theme). The theme goes through `ui-set`, applies at once, and after a reload comes from `ui-get` even when the browser's cached copy says otherwise.
- `profiles`: Model, Prompt and Tools read `profiles-get`, `prompt-render` and `profile-tools` for the selected profile (Coordinator, Worker, Scout, Reviewer; no verifier). Tier and thinking save through `profiles-set` with the settings revision; the status line shows the coordinator's thinking and effective model.
- `tiers`: Model tiers edits `tiers-get`/`tiers-set`: rename, letter, add a model by search (only models with credentials), reorder by drag or arrows, remove, new tier; Save and Revert appear only with unsaved edits. Worker chips show tier letters.
- `host-agent`: `\` opens the drawer. A message runs the Host agent: its tool calls show as mono rows (unfolded), and `ui_focus` frames from the host change feed move the page (here, Memory in the center). A dangerous `host_call` becomes an approval card above the transcript and counts in the status pill. Deny removes the card and leaves the request unrun; the outcome renders as one row, not a bubble. The model chip opens tier, pinned model, thinking and tools, saved with the settings revision. Approve runs the request and renders "Approved · ran". When the host could not open its Host agent, the drawer shows the host's reason and Try again.
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
- `VERIFY-HOST-APPROVE <id>`: `host_call archive` of that project. The drive creates "Verify spare", approves the card, and checks the approval is `done` and the project archived.

After the drawer, the drive sets coordinator thinking to high in Settings → Model (checks `profiles-get` and the status line), adds `fake/fallback-model` to the seed tier, moves it first, saves (checks `tiers-get` order), then restores the tier and thinking.

The drive uses these ids: `#tree`, `#composer textarea`, `#feed .tool-row[data-tool]`, `#feed .memory-row`, `#workers .worker`, `#center[data-focus]`, `#focus-view`, `#memory-search`, `#settings`, `[data-theme-option]`, `#host-agent[data-open][data-available]`, `#ha-composer textarea`, `#ha-approvals [data-decide]`, `.approval-row`, `#ha-model`, `#ha-settings [data-thinking]`, `#settings nav [data-section]`, `#settings .profiles [data-profile]`, `.tier-edit [data-add-search]`, `[data-add]`, `[data-move]`, `#tiers-save` and `[data-memory-undo]`. Key presses go through `Input.dispatchKeyEvent`. It saves screenshots `01` to `10` (plus `08b` approval, `08c` denied, `08d` drawer settings, `08e` approved, `11` model settings, `12` reordered tiers) (claude, midnight, light and 390 px narrow) and `feed-dom.txt`.

## Gotchas

- The drive needs the merged backend (e8b6554 or later): every contract request must answer. Only `chat-stop` is still missing on the host; Stop then says the host cannot stop a coordinator turn yet. The drive does not press Stop.
- The Host agent cannot unpin a model: `host-agent-settings` takes no `model: null`, and a pinned model wins over the tier.
- Worker data, PR 12 and the memory text are scripted by the fake provider.
