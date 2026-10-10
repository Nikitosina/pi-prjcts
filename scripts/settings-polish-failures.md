# Settings polish: failure cases

Owner feedback (handoff 7, Track U). `scripts/settings-polish-e2e.mjs` checks these in headless Chrome with a fake model, ~90 skills, 5 MCP servers, a GitHub project.

1. Checking or unchecking a skill/MCP row re-renders the picker: list scroll resets, focus is lost, rows reorder, the page jumps.
2. Typing in a search box re-renders the input (focus/caret lost) or resets the other state.
3. No select all / clear; or select all ignores the search filter, selects rows of other groups, touches inherited (locked) rows or disabled MCP servers.
4. Select all / clear moves the list scroll, or marks the draft clean (Save stays disabled), or the tab counts stay stale.
5. Group-level select all also changes other groups.
6. A section is unreachable (nav link missing/dead) or the section nav hides content; every Settings card must be reachable from the nav.
7. Horizontal overflow at 420 px (nav, pickers, kv rows, webhook URL, long paths).
8. Light theme muted text below 4.5:1 (also on chips, panels, sidebar); dark must stay >= 4.5.
9. Existing element ids, data-action values and checkbox/radio selectors used by other E2Es disappear.
10. Long lists grow the page instead of scrolling inside their card.
11. Dirty state invisible: Save enabled without a visible "Unsaved changes" hint or the hint stays after save.
