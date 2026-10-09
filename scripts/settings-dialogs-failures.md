# Settings dialogs + model picker: failure cases

Owner request: refine UX of every popup reachable from Settings; make the model picker easy (scoped models first, search over all configured Pi models). `scripts/settings-dialogs-e2e.mjs` checks these in headless Chrome, fake model, fake Pi settings (never the owner's `settings.json`), light and dark.

Shell
1. A dialog has no visible title, one-line plain subtitle, or X close; X or Esc leaves host state stale (confirmation proposal, dialogVersion) so a later Enter/submit reuses a dead proposal.
2. Esc closes only the visual dialog but not our bookkeeping (settingsConfirmation, routineConfirmation, providerInspection stay set).
3. Primary action scrolls out of view in a tall dialog (footer not sticky); footer overlaps content or has no theme background in dark.
4. Body does not scroll inside the dialog at 420 px / short viewports; dialog taller than the viewport; horizontal overflow.
5. Raw JSON `<pre>` shown by default for current values, records, routines, history, usage, operations, receipts (must be inside a collapsed Details).
6. Jargon copy returns: "offline catalog", "Review this single change", "Explicit grants and hard concurrency", "Retained Durable routines", "Exact operation binding" as visible title, field names like `knowledgeAccess`.
7. Raw paging buttons ("Previous records"/"Next records") without a range label, or paging controls shown when there is one page.
8. Contrast below 4.5 (3 for large) in any Settings dialog, light or dark; bright light surfaces in dark.
9. Existing hooks lost: `[data-action=close-dialog]`, `workspace-quick-confirm`, `github-quick-confirm`, `arc-quick-confirm`, `details.advanced`, `form[data-owner-write][data-kind]`, no typed-project-id input.

Project settings
10. One button per field: name/objective/models/grants/concurrency cannot be edited together; user must run N review flows.
11. Form does not show current values inline; Save enabled while nothing changed; "no changes" confirmed anyway.
12. Confirm step does not show before -> after for every changed field (or shows JSON); wrong field shown for coordinator vs role models.
13. Confirmation sends more than the changed fields (unchanged fields rewritten), loses expectedRevision, or confirms without the project id (hidden confirm).
14. Edited name/objective draft lost on close or reread; Discard draft has no explicit confirmation; discard deletes without showing the draft text.
15. Stale revision: server conflict is swallowed or silently rebased; draft is dropped on a conflict.
16. Saving while project is not idle succeeds or the error is not shown inside the dialog.
17. Invalid name (blank, control characters) or worker cap outside 1-32 is submitted.

Model picker
18. Scoped models (Pi `enabledModels`, including globs, `:thinking` suffixes, and bare ids) are not listed first; entries that resolve to nothing show up as bogus rows; duplicates across scope patterns.
19. Host reads the owner's real `~/.pi/agent/settings.json` instead of `PI_CODING_AGENT_DIR` (test leak), or fails the whole picker when `settings.json` is missing/corrupt (must fall back to no scoped group).
20. Search misses provider, id or display name; is case-sensitive; does not combine several terms ("claude opus"); shows unconfigured models as selectable.
21. Unconfigured models are hidden with no hint, or selectable (host still rejects; UI must not offer).
22. Keyboard: Arrow keys do not move the active row or scroll it into view; Enter does not select; Esc inside the open list closes the whole dialog instead of the list; Tab traps focus.
23. Current model not visible/marked in the list; selection of the current model counts as a change.
24. Context window not shown or not compact (e.g. 1000000 -> 1M, 128000 -> 128k).
25. Thousands of models render slowly or the list is unbounded (must cap rendered rows and say how many more match).
26. Picker leaks tokens / requires network: `networkChecked` must stay false; no model request.
27. Picked model for a role the user then changes back still counts as a change; picks for four roles are not sent in one `settings-update`.

Other dialogs
28. Owner setup: revoke/authorize actions without confirmation; advanced forms visible by default; JSON-only editing of grants (must remain reachable under Advanced but described in plain words).
29. Connect GitHub/Arcadia/workspace dialogs lose their Confirm; a stale snapshot confirm succeeds.
30. Routines: enable/disable confirm lacks a before -> after state; the toggle applies without confirmation; lens tabs lack a selected state.
31. Lifecycle: archive/delete/restore button label ambiguous; state not shown; confirmation missing.
32. Approvals: decision buttons lose the fingerprint binding; exact operation dialog hides identity (project, id, fingerprint) completely.
33. Provider receipts / known PR inspection: lens switch lacks selected state; known-PR form accepts a short head SHA.
34. Usage: tokens shown as raw long sentences, page-only total not labeled as page-only.
