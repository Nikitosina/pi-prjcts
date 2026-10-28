# PROTOTYPE — project sidebar + cross-project coordinator tabs

## Source spec

Owner: "I want to tune UI of sidebar so that projects are expandable and contain non-archived coordinators. The bar on the top where in current UI there are all coordinators in selected project should become a regular tab bar with opened coordinators from different projects. Take inspiration from Arc browser and Hermes Desktop."

Question: which sidebar-plus-tabs shell should the inbox get?

## Round 1: rejected

Variants A (compact beige tree with pill tabs), B (large project cards with document tabs) and C (avatar rail with grouped tabs) were built and shown. Owner verdict: "I like non of these." They are removed from the switcher and the code. `?variant=A|B|C` now mounts nothing. Reasons to avoid next time (from the follow-up brief): bulky coordinator cards, redundant header rows, excess metadata, a shell that did not feel like one desktop window.

## Round 2: D/E/F shells (owner chose E; verification NOT VERIFIED, budget 3/3 used)

D (titlebar tabs + dark tree), E (tinted inset canvas, Arc-like) and F (IDE explorer) were mock shells over sample data. Owner verdict: "I like E". D and F are removed; `?variant=D|F` (and A|B|C) mount nothing.

Verification history of that round, kept as it happened: the host-owned verification cycle for D/E/F used all 3 attempts and ended **NOT VERIFIED**. Attempts 1 and 2 failed (attempt 2 failed only because the preview was launched at a stale revision); attempt 3 did not produce a pass. That cycle is exhausted and stays NOT VERIFIED. Nothing in this branch changes that result, and round 2 must never be cited as verified.

## Round 3: current (`?variant=E`, runs on the real app). Status: pending independent verification (new scope, attempt 1 of 3 used, findings repaired in this revision)

Owner: "I think I like E but can we tune it to have the functionality of current app? I want to take a look at richer prototype. Since I am a big fan of Arc browser, you may inherit some layout/UX ideas from it."

E is now a reskin of the real DOM, not an overlay and not fixtures. `app.js` still renders everything; `prototype-sidebar.js` only adds a tree, a tab bar and a switcher, and the CSS retints the real window.

What E keeps from round 2: tinted sidebar/window per project hue, rounded inset canvas, compact top tab bar (tabs stay on top, across projects).

What is real (all through existing code and handlers):

- Sidebar: one expandable group per real project, listing its real non-archived chats (open project from `view.chats`, others via the read-only `show` action, refreshed about every 10 s). Status dots use `chatState()` for the open project and the chat summary (`attention`/`busy`) for others. New project, project search, theme/refresh footer, ⌘B collapse (56 px glyph rail) are the app's own.
- Tabs: `(project, chat)` pairs in memory. Opening calls `changeProject`/`changeChat`; opening an open one focuses it; closing the active one falls back right, then left, then the empty state. App-driven navigation (new chat, search hit, restore, archive falling back to Main) is mirrored into the tabs; archived chats lose their tab.
- Page: the real header (section tabs Coordinator / Knowledge / Observability / Settings, search, status, pause, ⋯), transcript, composer (model, attach, send), workers, knowledge card and results card, the real Rename / Archive / Archived-list toolbar. The old all-coordinator strip is hidden because the tabs replace it. `＋` in the tab bar clicks the real "New chat".
- Arc borrowings: resizable sidebar (drag the right edge, 200-460 px), collapse to a glyph rail, per-project colour identity (glyph + tab chip + window tint), quick coordinator switcher (⌘J / Ctrl+J, filters all projects' non-archived coordinators).

Not demonstrated, with reason: decisions/approval cards and worker/result detail need a provider that calls tools; the fake provider only echoes, so they render through the unchanged code but were not exercised here. The scratch host's chats are seeded through the web API and are real scratch data, not sample fixtures. Tabs, expansion and sidebar width reset on reload (in memory); `?variant=E` and the open coordinator stay in the URL.

### Current-app functionality inventory (E keeps all of it, through the real render paths)

| Area | Where in E | Exercised on the fake-provider scratch host |
| --- | --- | --- |
| Coordinator transcript + composer (model, attach, send, retry) | canvas, Coordinator section | yes: real typed message, echo reply, stored in that chat only |
| Chat create / rename / archive / restore / archived list | `＋` in tab bar and the slim real toolbar under the header | yes, all four, host-side read-only proof |
| Questions / decisions / approvals (answer card, permission gates) | transcript and inbox, unchanged code | no: fake provider never calls tools; unavailable, not simulated |
| Workers card, worker detail (`?worker=`), results card | right column and worker pages, unchanged | card renders; real workers not produced by the fake provider |
| Knowledge | section tab | yes, reachable and rendered |
| Observability | section tab | yes |
| Settings (dialogs, permission gates) | section tab | yes, reachable and rendered |
| Search, New project, Open by ID, pause/resume, status pill, theme, usage footer | real controls | search opens; rest present, not mutated |
| Sidebar collapse (⌘B) | real control | yes |

Run (safe, one command): `node scripts/prototype-sidebar-preview.mjs`. It starts an isolated scratch host with the fake provider on loopback, seeds 3 projects and chats, enables the E assets for that host only and prints the E URL and the stop command. Do **not** use `npm run inbox` or `ui-url` for this prototype: E drives the real chat create/rename/archive/message handlers and would write to your real data. The E assets are served only when `PI_PROTOTYPE_SIDEBAR_E=1` is set and `PI_PROJECTS_HOME` is a `pi-verify-*` scratch home (and never when `NODE_ENV=production`); everywhere else `/prototype-sidebar.js|css` answer 404 and `?variant=E` does nothing. Without `?variant=` the app is unchanged. Independent verification recipe: `web/PROTOTYPE-SIDEBAR-VERIFY.md`.

## Acceptance checklist (for independent review)

1. Only E exists. Plain app (no `?variant=`) has no prototype nodes or scripts; other keys mount nothing; production does not serve the assets.
2. Sidebar groups are real projects with only real non-archived chats; expansion is independent of tabs.
3. Opening a coordinator in two projects shows its real transcript; opening twice focuses one tab; closing active falls back right, then left, then empty.
4. Real composer sends to the selected coordinator only; real New chat, Rename, Archive, Restore work and tabs/sidebar follow; Knowledge, Observability, Settings, search are reachable.
5. Tab bar stays on top; sidebar collapses (⌘B) and resizes; ⌘J switcher lists non-archived coordinators only.
6. E assets are 404 on a default host, on a production host and on any non-scratch home; only the preview script (or `PI_PROTOTYPE_SIDEBAR_E=1 verify.mjs launch`) enables them.
7. The prototype itself performs no writes (only the read-only `show` action); no backend changes; default app unchanged.

## Verdict

Pending: independent verification of round 3 (new scope, separate from the exhausted round-2 cycle) and owner review.

## Cleanup after the verdict

Delete `web/prototype-sidebar.js`, `web/prototype-sidebar.css`, this file, `web/PROTOTYPE-SIDEBAR-VERIFY.md`, `web/PROTOTYPE-SIDEBAR-REVIEW.md`, `scripts/prototype-sidebar-*.mjs`, the `?variant=` loader at the end of `web/app.js` and the `prototype-sidebar` assets block in `src/web.ts` (the `PI_PROTOTYPE_SIDEBAR_E` gate). Fold the winner into `renderProjects()`/`index.html` with real chat data (`view.chats`, non-archived) and real tab state.
