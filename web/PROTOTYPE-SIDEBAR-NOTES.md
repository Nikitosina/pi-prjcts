# PROTOTYPE — project sidebar + cross-project coordinator tabs

## Source spec

Owner: "I want to tune UI of sidebar so that projects are expandable and contain non-archived coordinators. The bar on the top where in current UI there are all coordinators in selected project should become a regular tab bar with opened coordinators from different projects. Take inspiration from Arc browser and Hermes Desktop."

Question: which sidebar-plus-tabs shell should the inbox get?

## Round 1: rejected

Variants A (compact beige tree with pill tabs), B (large project cards with document tabs) and C (avatar rail with grouped tabs) were built and shown. Owner verdict: "I like non of these." They are removed from the switcher and the code. `?variant=A|B|C` now mounts nothing. Reasons to avoid next time (from the follow-up brief): bulky coordinator cards, redundant header rows, excess metadata, a shell that did not feel like one desktop window.

## Round 2: current (`?variant=D|E|F`)

Each variant is a full-window shell over the real page with a project tree, a regular tab bar of opened coordinators from any project, and a mock conversation so the shell is judged in context. Three structurally different shells:

- **D — titlebar tabs + dark tree.** One dark window chrome. Tabs sit in the titlebar and the active tab joins the light content area. Flat dense tree, no header row, status at the right of the titlebar.
- **E — inset canvas (Arc-like).** Window tinted by the active project's hue. The sidebar floats on the tint with round project glyphs; the content is a rounded card that holds the tabs at its top, with a serif conversation heading.
- **F — IDE explorer + status bar.** Full dark. Indent-guided tree with uppercase project rows, flat rectangular tabs showing project name, log-style monospace transcript, blue status bar at the bottom.

Behaviour shared by all: projects expand and collapse independently of tabs; clicking a coordinator opens it or focuses the existing tab (no duplicates); closing the active tab activates the right neighbour, else the left, else the empty state; archived coordinators are in the sample data and never shown; the legacy all-coordinator strip is not rendered (the shell covers the real page). The sidebar can be hidden. The composer and the question card work in memory only.

Data: coordinators are sample data. Real projects from the host supply names; the list is padded with sample projects up to four. The prototype never calls the host API. State resets on reload and seeds three open tabs across three projects; the variant stays in the URL.

Switcher: bottom-centre pill, ←/→ buttons and keys (ignored while an input, textarea, select or contenteditable has focus, or a dialog is open), wraps, rewrites `?variant=` with `history.replaceState` and keeps other params. It prints expanded projects, open tab count and active coordinator.

Run: `npm run inbox`, then open the link from `npm run projects -- ui-url` with `?variant=D` (or `E`, `F`) before the `#token=` part. Without `?variant=` the app is unchanged. `src/web.ts` serves the prototype files only when `NODE_ENV !== "production"`.

## Acceptance checklist (for independent review)

1. D, E and F exist; A, B and C are gone from the switcher and code.
2. Each has an expandable project tree with only non-archived coordinators, and a top tab bar across projects.
3. Expand/collapse does not change tabs or the active tab. Opening an open coordinator focuses it. Closing the active tab falls back right, then left, then empty.
4. The legacy strip (Main / New chat / Rename) is not visible under the prototype and is unchanged without `?variant=`.
5. Switcher wraps, keeps other URL params, survives reload, ignores arrows in editable focus.
6. No host mutation by the prototype; plain app and production builds do not load the prototype files.

## Verdict

Pending. Owner picks, mixes or rejects D/E/F.

## Cleanup after the verdict

Delete `web/prototype-sidebar.js`, `web/prototype-sidebar.css`, this file, the `?variant=` loader at the end of `web/app.js` and the `prototype-sidebar` assets block in `src/web.ts`. Fold the winner into `renderProjects()`/`index.html` with real chat data (`view.chats`, non-archived) and real tab state.
