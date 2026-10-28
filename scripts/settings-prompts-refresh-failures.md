# Settings role prompts after a host restart: failure cases

Verified by `scripts/settings-prompts-refresh-e2e.mjs`.

## Original cases (retrospective)
This list was written after commit 1575f20, which shipped without it. It records the cases that commit's test already covered; it does not claim they were written first.
- F1 A tab left open across a host restart keeps showing the previous host's built-in prompts, labelled Default, after Settings is reopened.
- F2 Refreshing loses a genuine override (shows Default) or an unsaved edit in another editor.
- F3 Saving the shown default stores it as an override.
- F4 New coordinator, worker or reviewer requests use the old built-in text, or a new scout ignores its override.
- F5 A follow-up on a worker started before the restart loses its frozen prompt.
- F6 Reset leaves an override (or a snapshot of the default) in `project.json`.

## Review findings (written before their fix)
- F7 The refresh on reopening Settings fails (host restarting, network drop) and replaces the editors with an error, discarding unsaved drafts. A retry after the failure does not restore the editors.
- F8 A refresh that read an override before Reset arrives after Reset has completed and puts the old text back as Customized; saving then stores it again.
- F9 A refresh that read the prompts before a Save arrives late and shows the pre-save text.
- F10 A first load that fails leaves no understandable message, or a later opening of Settings does not retry.
