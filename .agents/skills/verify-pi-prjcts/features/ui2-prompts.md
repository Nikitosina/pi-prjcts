# UI 2.0 Settings → Prompt blocks

The owner shapes what each agent is told in Settings → Prompt of the UI 2.0 client: for the coordinator, the Job worker, the task helper, the scout, the reviewer and the Host agent, a compact list of behavior blocks (built-in and custom, each with a switch, a source badge and a token estimate) beside one editor, plus the assembled prompt as a preview. Project instructions keep their own editable row, which saves the project's objective. The other generated sections (host contract, instance and repository instructions, preferences, Memory, skills) are listed read-only. Failure list: `scripts/ui2-prompt-editor-failures.md` (E1–E18).

## Sub-features

- `targets`: the profile tabs on the Prompt page are Coordinator, Worker, Scout, Reviewer and Host agent. On Worker, "Independent Job | Task helper" picks target `worker` or `taskHelper` for both the blocks and the preview. The Host agent target has no project and its scope label says Host.
- `project`: on project targets the first row is Project instructions (badge Project, no switch). It edits the objective through `settings-snapshot`/`settings-update`, shared by every role; its draft is per project. The Host agent has no such row.
- `list`: one row per block in saved order: switch, name, `off` and `draft` markers in text, badge Built-in / Edited / Custom / Legacy, tokens. Generated sections sit in a folded "Generated · read-only" group with no controls. Keys on a focused row: ↑/↓ pick, Space on/off, ⌥↑/⌥↓ move (focus stays on the moved row), Enter edits.
- `editor`: one selected block. Built-in: Save stores an override (badge Edited); Restore default removes it. Custom: name and text, Delete asks once more. ⌘↵ saves. "+ New block" adds a custom block with id `custom:<slug of the name>`; custom blocks belong to the target they were made in.
- `drafts`: typing keeps a draft per target and block in localStorage, so a reload or a target switch keeps it; Revert drops it; a successful save clears it.
- `conflicts`: every write is the whole ordered list with the revision it was read at. When the block under a draft changed elsewhere (change feed) or the host refuses a stale revision, a banner keeps the draft and offers Load latest; the next Save stores the draft on the newest revision, keeping the other writer's other changes.
- `quiet-updates`: project `settings` and host `host-agent` topics re-read an open Prompt page (caret kept); nothing opens Settings or a dialog.
- `apply`: the editor note follows `application.adopts`: the coordinator's next message, each agent's next turn, or the Host agent's next turn (with "pending next turn" while `application.pending`).
- `preview`: `prompt-render` sections in order, the role section replaced by the enabled blocks with their badges, Project instructions open, generated sections folded. The label is the host's ("Configured for next use"); a running conversation is described only from `active` (uses this prompt, or runs an older one and switches on its next safe turn), never with configured text.
- `narrow`: at 390 px the list and the editor are separate views; the editor has ← Back, and Esc steps back before it closes Settings.

## How to get to it (user POV)

- Open `/ui2/`, press ⌘, then P (Prompt). Pick a tab, then a row.
- Type in the editor and press ⌘↵, or click Save. "+ New block" under the list.
- Blocks | Preview switches the view.

## Driving it with browser CDP

Scripted: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive --run <scratch> ui2-prompts`. The journey checks the Project instructions row, switches a coordinator built-in off and on by Space (`prompt-blocks-get` each time), edits it with ⌘↵ and restores the default, adds the custom block "Verify aliases" with markup in its text (stored as `custom:verify-aliases`, inert, coordinator only), moves it up with ⌥↑, keeps a draft across a reload, lets a second writer (`prompt-blocks-set` with a fresh revision) edit the same block and switch the custom block off, resolves the conflict with Load latest and checks both changes, watches a host write update the open page and leave a closed Settings closed, previews the Job worker and the task helper, switches a Host agent block off and on, and checks the 390 px list and editor views. Screenshots `01-blocks` to `13-narrow-editor`, with `11-light` and `11-midnight`.

The `ui2` journey's Prompt step saves the project instructions (checks the project section of `prompt-render`, without a doubled prefix), then one coordinator block with ⌘↵ (checks the role section) and restores its default.

Worker details (agents prepared before prompt blocks): `node scripts/ui2-worker-prompt-e2e.mjs` runs two workers on a 9f4ee13 host, upgrades the same home to this branch and checks the `.w-prompt[data-prompt-state]` line under the worker header: "Prompt check pending" with the backend's reason, then "Prompt frozen" with its reason after a turn that cannot rebuild the stored prompt (no reload, no rebuild or restart control), and no line for a worker that rebuilt exactly and is current. Screenshots `01-legacy-unchecked`, `02-frozen`, `03-frozen-390` in its artifact directory.

Ids used: `#settings .profiles [data-profile]`, `[data-kind]`, `[data-pane]`, `.pb[data-target]`, `.pb-row[data-block]` with `.pb-toggle`, `.pb-name`, `.pb-src`, `.pb-tok`, `[data-generated]`, `[data-block="objective"]`, `.pb-editor[data-block]`, `.pb-text`, `input.pb-title`, `#pb-new`, `#pb-save`, `#pb-revert`, `#pb-restore`, `#pb-delete`, `.pb-conflict [data-conflict="reload"]`, `.pb-back`, `.pv-sec`, `.pv-state`, `.pv-body`, `#center .w-prompt[data-prompt-state]`.

## Gotchas

- Needs the prompt blocks backend (`prompt-blocks-get`, `prompt-blocks-set`, `prompt-render` with `workerMode`, `label` and `active`).
- The fake provider never runs a turn here, so `active` and pending application are not exercised; the preview's active line is checked only by reading the code.
- Open the 390 px worker details by loading the page at that width: resizing a live desktop page keeps its side panels open (an existing UI2 layout behavior, not the prompt line).
- Theme screenshots set `data-theme` directly; the theme setting itself is covered by the `ui2` journey.
