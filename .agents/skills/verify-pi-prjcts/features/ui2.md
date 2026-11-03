# UI 2.0 client at /ui2/

The owner opens the UI 2.0 client at `/ui2/`: a project tree with chats and Memory, a coordinator chat with compact tool rows, a Workers context panel, a settings overlay with letter hotkeys and themes, and the Host agent drawer. `/` stays the current client.

## Sub-features

- `serve`: `/ui2/` has the same token, CSP and headers as `/`; `/ui2` redirects; nested and unknown paths return 404.
- `empty`: a chat with no messages offers three starter prompts. One click fills the composer and focuses it; nothing is sent.
- `chat`: a sent message shows one owner bubble, a mono `agents` tool row with a `worker ↗` link, a worker report row and the reply. Clicking the row head shows params and the result.
- `worker`: the Workers card shows plan progress and Approve. A spawn row opens the worker transcript in the center, and Esc returns to the chat.
- `memory`: knowledge tool calls render as "Used memory" and "Remembered · Undo · Edit" rows. An entry opens in the center. The tree's Memory node groups `memory-index` entries as Preferences, Decisions and Procedures (status badge when not current, superseded link, broken links, archive behind a toggle), with search. Undo calls `memory-undo`; `memory-recent` keeps the row "Undone" after reload and does not offer Undo for a superseded write.
- `settings`: ⌘, opens the overlay. Section letters jump (H for Theme). Theme and font go through `ui-set`, apply at once, and after a reload come from `ui-get` even when the browser's cached copy says otherwise. JetBrains Mono is bundled locally and is the default; System sans and System mono are alternatives.
- `automations`: schedule cards Run now, Edit with the record revision, Delete after confirmation, and Undo through `schedule-restore`; the journey checks history and the exact restored record.
- `stop-and-diagnostics`: Stop calls `chat-stop` with `projectId` and keeps history. A codemode row shows nested running/done/failed calls. A failed compaction warns in the status line and opens bounded details in Context, not in the chat.
- `feedback`: a change in Settings or the drawer settings is confirmed by one status line next to the section header, which fades. Toasts are only for background events and errors: an identical message shows once, at most two show, each leaves on its own, and they sit under the top bar, clear of both composers.
- `usage`: the status line shows the coordinator cost of this chat ("$0.000 chat") and each subscription with its period ("Eliza · $1.42 this month"), with a tooltip saying where it comes from. The left bar has no usage footer.
- `context`: Settings → Context shows current use over the window, the auto-compaction mark (drag, or ←/→; saves on release), the force mark where the runtime blocks for compaction (window − reserve, derived from the auto mark), the hatched reserve, and Compact now.
- `profiles`: Model, Prompt and Tools read `profiles-get`, `prompt-render` and `profile-tools` for the selected profile (Coordinator, Worker, Scout, Reviewer; no verifier). Model lists every tier as a row (badge, name, models in order, context and price of the model that would run, a check on the selected one) plus "Project model (no tier)", which saves the profile without a tier through `settings-update` because `profiles-set` merges. Tier and thinking save through `profiles-set` with the settings revision; Prompt → Edit saves the project instructions; a Tools checkbox saves `tools.disabled`; the status line shows the coordinator's thinking and effective model.
- `tiers`: Model tiers edits `tiers-get`/`tiers-set`: rename, letter, add a model by search (only models with credentials), reorder by drag or arrows, remove, new tier; Save and Revert appear only with unsaved edits. Worker chips show tier letters.
- `host-agent`: `\` opens the drawer. A message runs the Host agent: its tool calls show as mono rows (unfolded), and `ui_focus` frames from the host change feed move the page (here, Memory in the center). A dangerous `host_call` becomes an approval card above the transcript and counts in the status pill. Deny removes the card and leaves the request unrun; the outcome renders as one row, not a bubble. The model chip opens tier, pinned model, thinking and tools, saved with the settings revision. Approve runs the request and renders "Approved · ran". When the host could not open its Host agent, the drawer shows the host's reason and Try again.
- `coordinator-approval`: a coordinator's `owner_approval_request` row carries "Review approval ↗", which opens the drawer at its card ("Coordinator · <project>"). The pill counts it. The outcome comes back to that chat as one row.
- `narrow`: at 390 px there is no horizontal overflow, and the list and context become sheets. The drawer fills the width with its composer visible, and Esc closes it.

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
- `VERIFY-HOST-STATUS`: `ui_set` puts Connection first and hides Chat cost, then `ui_focus { view: settings, section: statusline }`. The drive checks the bar follows without a reload, Settings stays closed and a toast offers Open settings; clicking it opens Settings → Status line. There it moves Connection down with Enter (focus stays on ↓), shows cost and hides model by keyboard and click (the row says "hidden"), turns the whole bar off and on, and restores the default order, checking `ui-get` each time.
- `VERIFY-COORD-APPROVAL <id>` (coordinator): `owner_approval_request archive` of that project. The drive creates "Verify spare two", follows Review approval to the card, denies it, and checks the Denied row in the chat and that the project is kept.

After the drawer, the drive sets coordinator thinking to high in Settings → Model (checks `profiles-get` and the status line), adds `fake/fallback-model` to the seed tier, moves it first, saves (checks `tiers-get` order), then restores the tier and thinking. Then it checks the inline status, moves the auto-compaction mark one step by keyboard (checks `settings-snapshot`), saves new project instructions in the Prompt editor (checks `prompt-render`), switches the first unlocked coordinator tool off and on (checks `profile-tools`), renames the tier and adds a tier with `fake/fallback-model` (checks `tiers-get`), picks that tier on the Model page and then "Project model (no tier)" (checks `profiles-get`). At 390 px it fires one toast three times (one shows, clear of the composer) and opens the drawer. Then it opens Settings → Status line (every row's checkbox and ↑/↓ in view), moves Connection up by pointer (focus kept), hides and shows Thinking (`ui-get` each time), and checks every enabled item is drawn in the bar and reachable by scrolling it sideways, before restoring the default order.

The drive uses these ids: `#tree`, `#composer textarea`, `#feed .tool-row[data-tool]`, `#feed .memory-row`, `#workers .worker`, `#center[data-focus]`, `#focus-view`, `#memory-search`, `#settings`, `[data-theme-option]`, `#host-agent[data-open][data-available]`, `#ha-composer textarea`, `#ha-approvals [data-decide]`, `.approval-row`, `#ha-model`, `#ha-settings [data-thinking]`, `#settings nav [data-section]`, `#settings .profiles [data-profile]`, `.tier-edit [data-add-search]`, `[data-add]`, `[data-move]`, `#tiers-save`, `[data-memory-undo]`, `#feed .starters [data-starter]`, `#settings .settings-status`, `.ctx-bar .mark.auto`, `.ctx-bar .mark.force`, `#compact-now`, `#settings [data-mode="edit"]`, `[data-sec="project"] textarea`, `#prompt-save`, `[data-tool-name]`, `.tier-name-input`, `#tier-new`, `.tier-row[data-tier]`, `[data-review-approval]` and `#toasts .toast`. Key presses go through `Input.dispatchKeyEvent`. It saves screenshots `01` to `10` (plus `08b` approval, `08c` denied, `08d` drawer settings, `08e` approved, `11` model settings, `12` reordered tiers, `13` context, `14` a tool off, `15` model tier rows, `16`/`16b` coordinator approval row and card, `10a` narrow toast, `10b` narrow drawer) (claude, midnight, light and 390 px narrow) and `feed-dom.txt`.

## Gotchas

- The drive needs the merged round-2 backend plus PR36: Stop, `memory-recent`, schedule edit/delete/restore, Host agent model clearing, `font`, nested codemode and compaction failures must all answer.
- Worker data, PR 12, memory text and diagnostics are scripted at the existing fake-provider seam; all host state and browser behavior are real.
