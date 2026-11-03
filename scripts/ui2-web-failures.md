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
- The worker's model chip shows the project's legacy role model instead of the model that agent runs on (its tier's model or the model a quota move left it on).
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

## Round 2: feedback, usage, Model and Context pages, polish

- Toasts: the same message stacks once per event; more than two show at once; one never goes away; on 390 px a toast covers the composer or the drawer's composer.
- A change made in Settings or the drawer is confirmed only by a toast far from the control, or not at all; the inline status stays forever or survives into another section.
- The left-bar "Eliza $1.42" (or any subscription line) has no label saying what it is, which period it covers, or where it comes from; the status line's session cost and the subscription cost read as the same number.
- Model page: a tier missing from the list, a tier without its models in order, context size or price; the selected row is not marked (check and aria-checked); no way back to "Project model (no tier)", or choosing it leaves the tier saved.
- Context page: no current-use marker; the auto-compaction mark does not drag or move with ←/→, or moves without saving; the force mark disagrees with where the runtime forces compaction (window − reserve); the window size is missing; Compact now is hidden.
- A new chat shows an empty page with no next step; a starter prompt sends without the owner seeing it, or fills a composer that is not focused.
- Tool rows and message headers start at different left edges; spacing between turns is uneven.
- Prompt editor: Save sends nothing, or the saved project instructions do not appear in `prompt-render`.
- Tools: switching a tool off does not reach `profile-tools` (enabled stays true), or a locked tool can be switched off.
- Tier editor: a rename or a new tier is lost on Save, or a new tier saves with no model.
- A coordinator's `owner_approval_request` shows only as a raw tool row: no card in the drawer, no needs-you in the pill, no way from the chat row to the decision; the outcome posted back to the chat renders as an owner bubble.
- At 390 px the Host agent drawer overflows the screen, hides its composer, or cannot be closed by keyboard.

## Final wiring, local font and PR36 transcript diagnostics

- Stop sends the removed `id` shape or only reports the contract as unavailable; the running chat does not actually become idle.
- Host agent settings cannot clear a pinned model, or choosing a tier leaves the old pin in force. Rapid tier/model/tool changes must not send a pre-change revision and lose the newer request.
- Automation cards lack working Run now, Edit or Delete; Delete has no owner confirmation; Undo does not restore the deleted schedule through its tombstone. Run now must not asynchronously replace the section and remove the controls the owner is about to use.
- Memory Undo is only page-local: after a reload the same write offers Undo again instead of reading `memory-recent` and saying Undone.
- JetBrains Mono is not bundled and actually loaded by default, its license is missing, or a font choice is only local and does not survive reload through the host `ui` document.
- A nested codemode call has no compact running/done/failed detail, or a failed compaction disappears instead of remaining inspectable in Context without adding noise to the primary chat.
- The status pill says All quiet from per-chat state but its click follows a stale project-level working flag; displayed state and click behavior must agree.
- Rendering a diagnostic expands or stringifies an unbounded result instead of using the transcript's bounded preview.

## Composable status line

- The status line ignores `statusItems`: a hidden item still renders, or items keep the built-in order after a reorder.
- Settings → Status line cannot reorder by keyboard (Up/Down buttons), loses focus after a move, or shows hidden items the same as shown ones (no "hidden" state in words, not only color).
- A change from another tab or from the Host agent's `ui_set` reaches the bar only after a reload.
- The Spacer stops pushing the items after it to the right, or with the Spacer hidden the bar overflows instead of packing left.
- At 390 px the bar overflows the viewport or cuts off items without a way to reach them.
- A Host agent `ui_focus` at Settings (or a settings section such as `theme` or `statusline`) opens the Settings overlay by itself after it changes a setting; the owner must get a quiet notice with a button, and owner-opened Settings (⌘,, palette, the button) must still work.
- At 390 px an enabled status line item (thinking, cost, limits, key hints) is hidden by the narrow layout, so its Settings switch does nothing there and the item cannot be reached; enabled items must stay in the bar, reachable by scrolling it sideways.

## Chat Markdown and slash completion

- A GFM table in a Coordinator or Host agent reply renders as pipe text instead of a table; a wide table pushes the chat sideways instead of scrolling inside its own box; column alignment (`:---:`, `---:`) is lost.
- A table cell, heading, list item or quote is inserted without escaping, so `<img onerror>` or `<script>` from a reply becomes live HTML.
- A link with a `javascript:`, `data:` or other non-web scheme becomes a clickable anchor; an image (`![x](https://…)`) is fetched instead of shown as a link; an autolink swallows the trailing period or bracket.
- Markdown inside a code span (`` `**x**` ``) or a fenced block is formatted instead of shown literally.
- A nested bullet list flattens into one level, or an ordered list that starts at 3 restarts at 1; a blank line between items splits one list into several.
- Blockquotes, strikethrough and horizontal rules show their raw markers.
- The Host agent drawer and the Coordinator chat render the same reply differently (two renderers drift).
- Typing `/` in the Coordinator composer shows nothing; the skill list is not the project's `coordinator-skills` catalog.
- Commands are offered mid-message (only skills are, after a space or bracket); a mid-message `/` that matches no skill still opens a menu.
- Up/Down do not move the selection, Enter or Tab sends the message instead of picking, or a click on an option loses the composer focus.
- Picking a skill does not insert `/skill:<name> ` at the trigger, or clobbers text after the caret.
- A command typed or picked at the start (`/reload`) is sent to the Coordinator as a message instead of running; a command with an argument (`/name <title>`) runs before the argument is typed.
- Esc with the menu open leaves the composer (blurs it) or closes another layer instead of only closing the menu.
- The menu has no listbox role, the textarea has no `aria-expanded`/`aria-controls`/`aria-activedescendant`, so a screen reader hears nothing.
- A catalog answer for the previous project, or for a query the owner has since changed, repaints the menu (stale selection); switching chat leaves the menu open.

## Images in transcripts

- A tool result that returned a screenshot (`read` of a png, a simulator or MCP image) shows only its text; the image reference in `images` is ignored, or appears only after the row is expanded.
- A message with images and no text (a captionless photo, an image-only tool result) disappears instead of showing its images.
- A reply citing `![caption](artifact:<thread>/<path>)` shows the raw Markdown or a link to nowhere instead of the image from the host's token-authenticated `/artifacts/` route.
- An image is fetched by URL without the token (401), embedded as `data:` (CSP blocks it), or every image of a long transcript is fetched at once instead of as it nears the viewport.
- A missing, refused or oversized image leaves a broken-image icon or a spinner forever instead of a short labelled note.
- A remote `![x](https://…)` image is fetched (a prompt-injected URL leaks that the chat was read); it must stay a plain link.
- Blob URLs accumulate without `revokeObjectURL`, or a re-render (new live frame) refetches every image.
- Alt text or the label from a reply is inserted unescaped.
- A worker transcript in the center shows the same placeholders but never loads them (wrong `threadId` source).
