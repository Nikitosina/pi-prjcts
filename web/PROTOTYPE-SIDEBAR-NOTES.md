# PROTOTYPE — project sidebar + cross-project coordinator tabs

## Source spec

Owner: "I want to tune UI of sidebar so that projects are expandable and contain non-archived coordinators. The bar on the top where in current UI there are all coordinators in selected project should become a regular tab bar with opened coordinators from different projects. Take inspiration from Arc browser and Hermes Desktop."

Question: which sidebar-plus-tabs shell should the inbox get?

## Round 1: rejected

Variants A (compact beige tree with pill tabs), B (large project cards with document tabs) and C (avatar rail with grouped tabs) were built and shown. Owner verdict: "I like non of these." They are removed from the switcher and the code. `?variant=A|B|C` now mounts nothing. Reasons to avoid next time (from the follow-up brief): bulky coordinator cards, redundant header rows, excess metadata, a shell that did not feel like one desktop window.

## Round 2: D/E/F shells (done; D and F dropped)

D (titlebar tabs + dark tree), E (tinted inset canvas, Arc-like) and F (IDE explorer) were mock shells over sample data. Owner verdict: "I like E". D and F are removed; `?variant=D|F` (and A|B|C) mount nothing.

## Round 3: current (`?variant=E`, runs on the real app)

Owner: "I think I like E but can we tune it to have the functionality of current app? I want to take a look at richer prototype. Since I am a big fan of Arc browser, you may inherit some layout/UX ideas from it."

E is now a reskin of the real DOM, not an overlay and not fixtures. `app.js` still renders everything; `prototype-sidebar.js` only adds a tree, a tab bar and a switcher, and the CSS retints the real window.

What E keeps from round 2: tinted sidebar/window per project hue, rounded inset canvas, compact top tab bar (tabs stay on top, across projects).

What is real (all through existing code and handlers):

- Sidebar: one expandable group per real project, listing its real non-archived chats (open project from `view.chats`, others via the read-only `show` action, refreshed about every 10 s). Status dots use `chatState()` for the open project and the chat summary (`attention`/`busy`) for others. New project, project search, theme/refresh footer, ⌘B collapse (56 px glyph rail) are the app's own.
- Tabs: `(project, chat)` pairs in memory. Opening calls `changeProject`/`changeChat`; opening an open one focuses it; closing the active one falls back right, then left, then the empty state. App-driven navigation (new chat, search hit, restore, archive falling back to Main) is mirrored into the tabs; archived chats lose their tab.
- Page: the real header (section tabs Coordinator / Knowledge / Observability / Settings, search, status, pause, ⋯), transcript, composer (model, attach, send), workers, knowledge card and results card, the real Rename / Archive / Archived-list toolbar. The old all-coordinator strip is hidden because the tabs replace it. `＋` in the tab bar clicks the real "New chat".
- Arc borrowings: resizable sidebar (drag the right edge, 200-460 px), collapse to a glyph rail, per-project colour identity (glyph + tab chip + window tint), quick coordinator switcher (⌘J / Ctrl+J, filters all projects' non-archived coordinators).

Not demonstrated, with reason: decisions/approval cards and worker/result detail need a provider that calls tools; the fake provider only echoes, so they render through the unchanged code but were not exercised here. The scratch host's chats are seeded through the web API and are real scratch data, not sample fixtures. Tabs, expansion and sidebar width reset on reload (in memory); `?variant=E` and the open coordinator stay in the URL.

Run: `npm run inbox`, open the link from `npm run projects -- ui-url` with `?variant=E` before the `#token=` part. Without `?variant=` the app is unchanged. `src/web.ts` serves the prototype files only when `NODE_ENV !== "production"`.

## Acceptance checklist (for independent review)

1. Only E exists. Plain app (no `?variant=`) has no prototype nodes or scripts; other keys mount nothing; production does not serve the assets.
2. Sidebar groups are real projects with only real non-archived chats; expansion is independent of tabs.
3. Opening a coordinator in two projects shows its real transcript; opening twice focuses one tab; closing active falls back right, then left, then empty.
4. Real composer sends to the selected coordinator only; real New chat, Rename, Archive, Restore work and tabs/sidebar follow; Knowledge, Observability, Settings, search are reachable.
5. Tab bar stays on top; sidebar collapses (⌘B) and resizes; ⌘J switcher lists non-archived coordinators only.
6. The prototype itself performs no writes (only the read-only `show` action); no backend changes; default app unchanged.

## Verdict

Pending owner review of round 3.

## Cleanup after the verdict

Delete `web/prototype-sidebar.js`, `web/prototype-sidebar.css`, this file, the `?variant=` loader at the end of `web/app.js` and the `prototype-sidebar` assets block in `src/web.ts`. Fold the winner into `renderProjects()`/`index.html` with real chat data (`view.chats`, non-archived) and real tab state.
