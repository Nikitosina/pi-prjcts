# UI 2.0 web client: ways it can fail

Written before the code. The scripted proof is the `ui2` journey in `.agents/skills/verify-pi-prjcts/scripts/verify.mjs` (private host, fake provider, headless Chrome). Items marked *manual* are checked by screenshots or by hand and named as such in the handback.

## Serving and sign-in

- `/ui2/` is not served, or is served without the CSP, nosniff and no-store headers that `/` gets.
- `/ui2` (no slash) 404s instead of redirecting to `/ui2/`.
- A request path under `/ui2/` reads a file outside `web-ui2/` (`..`, encoded slashes, dotfiles); only files present at start are served.
- `/ui2/` changes what `/` serves (the existing client must be byte-identical).
- The token from the launch link (`/ui2/#token=…`) is not stored, or stays in the URL bar after load.
- No token: the page throws instead of showing the sign-in prompt.
- An inline script or inline event handler is blocked by the CSP and a feature silently does nothing (console error).

## Layout and navigation

- The left tree does not list the seeded project with its Main chat nested under it.
- Selecting a chat in the tree does not open it in the center, or opens it in another project's frame.
- A late response from the previous project renders into the newly selected one (generation not checked after an await).
- Panel toggles (`[` list, `]` context panel) do not hide/show the panel, or the layout jumps without a transition.
- At 390 px the three areas overflow horizontally; the list and context panel are not reachable.
- The status pill shows "idle" while the coordinator is running, or does not jump to the working chat on click.

## Coordinator chat

- Sending from the composer does not create exactly one owner bubble and one reply.
- Tool calls are hidden (old rule), or each renders as a big card instead of one compact row with status icon, mono name, argument summary and duration.
- A running tool shows no spinner; a finished one keeps spinning.
- A finished turn's tool rows do not fold into one group summary ("agents ×1 · 0.1s"), or the live turn folds while it runs.
- Expanding a tool row fails to show its parameters and a bounded result preview, or dumps unescaped HTML from a tool result.
- A spawn (`agents spawn`) or a worker handback does not render as a row linking to the worker.
- Internal worker reports render as owner bubbles ("You").
- Thinking renders as a block of text instead of a one-line marker that expands.
- Live frames from the selected chat do not stream text; frames from another chat render here.
- A question from the coordinator does not show as an answer form above the composer, or shows in more than one place.
- Memory: a `projects_knowledge_write` call does not render as "Remembered: … · Undo · Edit", a read not as "Used memory: …".

## Workers card

- A Job does not appear in the context panel, or appears as a one-line header without plan step, progress and model.
- A Ready Job has no single primary action (Approve) and badge; Approve is offered for a checkpoint.
- Opening a worker does not show its transcript in the center; Esc does not return to the chat.

## Settings overlay

- `⌘,` does not open the overlay; letter hotkeys inside it do not switch sections.
- An item has no Project/Host scope label, or a section shows more than one line of description outside ⓘ.
- A Project section writes to another project after the selection changed.
- Contract requests that are not merged yet (`ui-*`, `tiers-*`, `profiles-*`, `profile-tools`, `prompt-render`, `memory-*`) crash the overlay instead of showing a quiet "available after backend merge" state.
- Context bar marks cannot be dragged with the pointer or moved with the keyboard; a drag past the window size saves an invalid threshold.
- Automations: toggling asks for confirmation instead of applying with an Undo toast.

## Theme, hotkeys, motion

- Switching theme does not change the CSS variables on the root, or flashes the default theme on reload.
- The theme choice is kept only in this browser (it must go through `ui-set`), or after a reload the stale localStorage pre-paint copy wins over `ui-get`.
- A hotkey fires while typing in the composer or a text field (except Esc and ⌘ combos).
- A rebound hotkey still triggers on the old key; two commands share one binding without a visible conflict.
- `prefers-reduced-motion` or Animations "off" still animates rows and panels.

## Host agent

- `\` does not open the drawer from the chat or from settings.
- When the host could not open its Host agent, the drawer is blank or crashes instead of showing the host's reason with Try again.
- A pending approval is shown without the exact action and its input, or Approve/Deny fire without a visible result.
- A `ui_focus` frame for another project opens it without changing the selection consistently (tree, center, URL).
- A send renders twice (optimistic bubble plus history) or not at all until reopen.
- The Host agent's tool calls render as raw JSON instead of the same compact mono tool rows as the coordinator chat.
- `ui_focus` frames are read from `/live` instead of the host change feed (`/changes?project=host`, `topic: "host-agent", type: "focus"`), so the page never moves; or an unknown view crashes instead of showing a short note.
- The host change feed opens only when the drawer is open, so approvals filed by a coordinator never reach the status pill.
- A pending approval does not count in the status pill, or the pill click does not open the drawer at the approval.
- Deny or Approve leaves the card in place, or a second click sends a second decision; the outcome posted back (`[approval <id>] …`) renders as an owner bubble.
- Changing the Host agent model, thinking or tools ignores `revision`; a stale revision overwrites a newer change, or the error is swallowed.
- With no model available, send fails silently instead of naming the problem and opening the drawer settings.

## Accessibility (manual, plus checks in the journey)

- A control is a `div` with a click handler instead of a button; focus ring invisible on dark themes.
- Icon-only buttons have no accessible name.
- Contrast of muted text below 4.5:1 on any theme (manual, screenshots).

## Real data after the backend merge

- A placeholder ("Available after backend merge", disabled buttons with that tooltip) survives anywhere for a request the host now answers.
- A verifier profile shows up in the Profile tabs or anywhere else.
- `profiles-set` is sent without the `settings-snapshot` revision, or a refusal is swallowed and the section keeps showing the unsaved value.
- Thinking changes in Settings but the status line keeps the old level, or shows the project model instead of the coordinator's effective model.
- The tier editor offers all 1,600 catalog models in one select, lets a model without credentials be added, or saves on every keystroke; a refused `tiers-set` (stale revision, empty tier, tier in use) discards the owner's edits.
- After a tier edit, worker chips keep the old tier letter until reload.
- Memory Undo on a write that a later write superseded shows the raw revision error, or a second click undoes twice; after Undo the row still offers Undo.
- The Memory view still classifies by folder in the browser instead of using `memory-index` kinds, hides archived entries without a way to see them, or drops broken links.
- The drawer repaints its whole history on every turn end, so every row animates in again.
- A burst of toasts stacks until it covers the chat on a phone.
