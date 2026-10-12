# Inline references (/ # @), collapsible sidebar, chat font: failure modes (written before implementation)

Syntax: `/skill:<name>` anywhere (start, or after whitespace); `#12` / `PR #12` (PRs, unchanged); `@issue:<n>`, `@doc:<knowledge path>`, `@upload:<filename>`, `@file:<repo path>` (`@file:"a b.txt"` when the value has spaces).

## Composer and autocomplete
1. `/` typed mid-text after whitespace opens no skill menu (only position 0 works today).
2. `/` inside a word or path (`src/host.ts`, `a/b`) opens the skill menu.
3. Picking a skill mid-text rewrites the whole message (today `pickSkill` replaces everything before the caret) instead of replacing only the typed token.
4. `@` opens nothing, or opens on `user@example.com` (no whitespace before `@`).
5. `@` menu is not fuzzy: `hst` does not find `src/host.ts`; basename/prefix matches rank below deep accidental matches; results are not grouped by kind.
6. `@` with an empty query shows nothing useful (should show recent issues, docs, uploads, recently changed files).
7. A kind prefix (`@file:`, `@doc:`, `@issue:`, `@upload:`) does not narrow the menu to that kind.
8. ↑/↓/Enter/Tab/Esc do not work in the `@` menu, Enter sends the message while the menu is open with matches, or Enter with no matches is swallowed.
9. Picked token lacks a trailing space, or caret lands in the wrong place; the text after the caret is lost.
10. A failing data source (gh missing, not a git repo) makes the whole `@` menu fail instead of showing the other kinds plus a note.
11. Huge repositories: the candidates RPC returns unbounded file lists or blocks the host (needs a cap and a cache).
12. Files outside the project folder, `.git` internals or ignored build output appear in the list.

## Highlighting in the composer (textarea overlay)
13. Tokens are not highlighted, or the overlay drifts from the textarea text (different font/padding/wrap/scroll), making the caret look misplaced.
14. Overlay renders owner text as HTML (XSS via `<img onerror>` in the draft).
15. Backspace right after a token deletes one character and leaves a broken half-token (should remove the whole token); backspace elsewhere still deletes one character.
16. Overlay does not follow scroll when the draft exceeds max-height.

## Host: expansion and context for the coordinator
17. A skill referenced mid-text is sent as literal text with no skill body.
18. Two skills in one message: only the first expands; a duplicated skill expands twice.
19. Unknown `/skill:x` mid-text silently sent (must be an error like today), but `/skill:` inside a URL or word is wrongly treated as a command.
20. Leading `/skill:x args` (old form) changes behavior or the transcript shows the skill body instead of the compact text.
21. Old transcript rows (`<skill…>…</skill>\n\nargs`) stop rendering compactly.
22. `@` references are not visible to the coordinator: no `[Referenced items …]` block, or the block is not marked untrusted.
23. `@file:../../etc/passwd`, absolute paths, symlinks leaving the project folder, or `.git/config` are read.
24. Large or binary referenced files flood the prompt (needs per-file and total caps; binary is named, not dumped).
25. Unknown doc/upload/file/issue fails the whole message instead of a "could not be read" line.
26. Issue lookups call real GitHub in tests, or gh errors leak tokens.
27. Invoked skills mid-text are not recorded for projects_skill_file access.

## Transcript rendering
28. Tokens in sent messages are plain text, not highlighted.
29. Clicking a token does nothing: PR/issue must open the URL; doc → knowledge dialog; upload → upload dialog; file → read-only preview; skill → SKILL.md preview.
30. Tokens inside code spans/blocks get turned into links.
31. The appended `[Referenced items …]` block shows as raw text in the owner bubble.
32. Preview dialogs render file text as HTML.

## Sidebar and font
33. Sidebar cannot collapse; or collapses but the 250px background gradient still paints; state lost on reload; no keyboard shortcut; shortcut fires inside text inputs or overrides the browser's bold in editors.
34. Collapsed sidebar leaves no way to reopen it or switch projects.
35. Chat font change leaks into other tabs/cards or the composer overlay misaligns after the change.
