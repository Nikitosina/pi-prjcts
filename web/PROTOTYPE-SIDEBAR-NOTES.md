# PROTOTYPE — project sidebar + cross-project coordinator tabs

Question: should the inbox get an expandable project sidebar (non-archived coordinators as children) plus a top tab bar of opened coordinators across projects, and which shape fits best?

Three variants on the existing inbox route, opt-in with `?variant=A|B|C` (sub-shape A; the real header, composer and data stay):

- **A — Arc project tree + compact tabs.** Indented tree with hairline guides in the normal sidebar width; 28px pill tabs with a project tag.
- **B — Hermes workspace navigator + document tabs.** Wide 330px sidebar of project cards, coordinator rows with blurb, state pill and worker count; tall document tabs with a project breadcrumb, plus a document header under the tabs.
- **C — Split rail + grouped tabs.** 44px rail of project avatars (count badge) toggles stacked, sticky-headed coordinator groups; tabs are grouped under a colored project label; one-line status strip.

Run (existing runner): `npm run inbox`, then open the launch link (`npm run projects -- ui-url`) with `&variant=A` (or `B`, `C`) added before the `#token=` fragment, e.g. `http://127.0.0.1:<port>/?variant=B#token=…`. Switch with the bottom pill, or ←/→ (ignored while typing). Other search params are kept.

The top tab bar replaces the legacy coordinator bar (Main / + New chat / Rename): `#chat-bar` is hidden only while a variant is mounted.

Prototype behaviour: all state (expansion, open tabs, active tab) is in memory in `prototype-sidebar.js`; reload resets it, the variant stays in the URL. Coordinators are sample data (archived ones are in the data and filtered out). Real projects come from the host list; the list is padded with sample projects so cross-project tabs work on a one-project host. Activating a coordinator of a real project (open, tab click, or fallback after closing the active tab) switches the page to that project with the app's own project switch (navigation only); tabs survive it. No host mutations. The pill also prints expanded/open/active state.

Production: `src/web.ts` serves `prototype-sidebar.js`/`.css` only when `NODE_ENV !== "production"`, so the switcher never loads there.

## Verdict

Pending. Owner picks (or mixes) A/B/C.

## Cleanup after the verdict

Delete `web/prototype-sidebar.js`, `web/prototype-sidebar.css`, this file, the `?variant=` loader at the end of `web/app.js` and the `prototype-sidebar` assets block in `src/web.ts`. Fold the winner into `renderProjects()`/`index.html` with real chat data (`view.chats`, non-archived) and real tab state.
