# UI 2.0 Settings → Prompt editor: ways it can fail

Written before the code. The scripted proof is the `ui2-prompts` journey in `.agents/skills/verify-pi-prjcts/scripts/verify.mjs` (private host, fake provider, headless Chrome); each item names its check id there. Items marked *manual* are checked from screenshots and named as such in the handback. The block model and its RPCs belong to the backend (`docs/ui2-contract.md`, prompt blocks); this list covers only what the browser can get wrong.

## Target and layout

- E1 The target picker does not offer the Host agent next to the project roles, or picking it keeps showing the previous project's blocks.
- E2 A block row is missing its switch (a lock for a locked built-in), name, source badge (Built-in, Edited, Custom, Legacy) or token estimate, or the list grows into stacked full-height forms instead of one selected editor.
- E3 Generated sections (host contract, instance and repository instructions, tools, skills, preferences, Memory) can be edited, toggled or moved, or are missing from the preview.
- E4 At 390 px the list and the editor share the screen, overflow sideways, or the editor has no way back to the list.

## Editing

- E5 A switch flips the row but nothing is saved, saves the wrong block, or the preview does not follow.
- E6 Editing a built-in block saves it as a new custom block, or Restore default leaves the override in place (the badge still says Edited).
- E7 A new custom block is not saved with its name and text, or shows up for another target than the one it was made in.
- E8 ↑/↓ by keyboard reorders the row on screen but not in the saved order, or focus leaves the moved row.
- E9 Delete removes a built-in block; deleting a custom block does not ask once more.

- E19 Project instructions lose their own editable row, are saved as a prompt block instead of the project's objective, or save the rendered text back (a doubled "Project instructions:" prefix). The Host agent has no such row.

## Drafts and conflicts

- E10 An unsaved draft is lost on reload or on switching target, or a saved draft is restored again after it was saved.
- E11 A draft whose block changed elsewhere (another tab, the Host agent), or a write with a stale revision, overwrites the other change without asking, or discards the local draft instead of keeping it and offering Load latest; after Load latest, the other writer's other changes are lost.
- E12 A change made elsewhere (the other tab, the Host agent) is not picked up by an open editor without a draft, or opens Settings or any modal on its own.

## Preview

- E13 The preview does not show the assembled prompt in order with each section's source and tokens, or generated sections are expanded by default and bury the blocks.
- E14 The Worker tab does not switch between an independent Job worker and a task helper (blocks of target `taskHelper`, preview with `workerMode: task`), or shows the same text for both.
- E15 The preview does not say it shows the configuration for the next use, presents configured text as what a running conversation has, or hides that an edit applies only on the next safe turn.
- E16 Rendered prompt text is inserted as HTML (block text with `<b>` renders bold or runs a script).
- E23 In a chat other than Main, a Prompt tab other than the coordinator fails ("chatId applies to the coordinator profile only"): the preview asks for chat-specific text a worker, scout, reviewer or the Host agent does not have.

## Running agents (worker details, `jobs-snapshot` `agents[].prompt`; scripts/ui2-worker-prompt-e2e.mjs)

- E20 A worker started before prompt blocks whose stored prompt could not be rebuilt exactly (`frozen`) looks like any other worker: its details do not say its prompt is frozen, or hide the backend's reason. The owner approved keeping such workers on their original prompt, visibly, with the reason; there is no rebuild or restart control.
- E21 A worker that still has to be checked (`legacy-unchecked`) or that adopts saved behavior on its next turn (`pending`) is not told apart from one that already runs it, or a `current` worker (or one with `prompt: null`) gets a prompt line it does not need.
- E22 The prompt line goes stale: after the worker's next turn changes the state (checked and adopted, or frozen), the open details keep the old state.

## Fit (manual)

- E17 Claude, midnight and light themes keep contrast for badges, the selected row and the disabled (off) state; off is not shown by color alone.
- E18 Every control is reachable by keyboard with a visible focus ring; Esc leaves the editor before it closes Settings.
