# PROTOTYPE — static review handoff (variant E, round 3)

Read-only review input for the Standards, Spec and Bugs/performance reviewers. Throwaway prototype: judge it as a prototype, not as production code. The exact head SHA under review is pinned by the coordinator metadata (this file lives inside that head, so it cannot print its own SHA).

## Pinned range

- Base: `959d84a7df4d3a4db9ae70bb8b2fad48150e19fb` (PR #21 base, also the merge-base with `origin/main` at hand-off). `origin/main` has since moved (`bd453622...`); no merge was done, so the diff is `base..head`.
- Commits (oldest first): `4c0ad1f` first prototype A/B/C; `a725205` tabs follow real projects; `af37e0f` round 2 D/E/F; `664fcc7` notes; `2d33502` composer fix; `1076449` round 3 (E on the real app); then the repair commit that adds this file (gating seam, safe launch, notes, verify recipe).
- Changed files: `src/web.ts` (asset gate), `web/app.js` (opt-in loader at the end), `web/prototype-sidebar.js`, `web/prototype-sidebar.css`, `web/PROTOTYPE-SIDEBAR-*.md`, `scripts/prototype-sidebar-{preview,seed,drive}.mjs`.
- Use `git diff 959d84a...HEAD` and `git log --oneline 959d84a..HEAD` for the full diff and list.

## Source spec (verbatim in substance)

Original owner request: "I want to tune UI of sidebar so that projects are expandable and contain non-archived coordinators. The bar on the top where in current UI there are all coordinators in selected project should become a regular tab bar with opened coordinators from different projects. Take inspiration from Arc browser and Hermes Desktop." Round 1 (A/B/C) was rejected ("I like non of these"). Round 2 owner: likes E. Round 3 owner: "I think I like E but can we tune it to have the functionality of current app? I want to take a look at richer prototype. Since I am a big fan of Arc browser, you may inherit some layout/UX ideas from it."

## Acceptance checklist (round 3)

1. E keeps the tinted sidebar/inset canvas, compact top tabs across projects. Tabs stay on top.
2. Sidebar: expandable project groups with only non-archived real coordinators. Expansion independent of tabs.
3. Opening or selecting a tab shows that coordinator's actual content (real components, no fake overlay). Opening twice focuses one tab. Closing active falls back right, then left, then empty.
4. Current functionality reachable with existing semantics and gates: composer/messaging, chat create/rename/archive/restore, decisions, workers/results, knowledge, observability, settings. Unavailable items are documented, not simulated (decisions/approvals and real worker output need a tool-calling provider; see NOTES inventory).
5. No backend rewrites, no new production abstractions. Default app unchanged. Real data vs sample fixtures: there are no fixtures; all data is real scratch data.
6. E assets and mounting are opt-in: served only with `PI_PROTOTYPE_SIDEBAR_E=1` on a `pi-verify-*` scratch home and never in production; otherwise 404. Layout and open tabs are in memory.
7. Safe preview: `node scripts/prototype-sidebar-preview.mjs`. No instruction anywhere tells the reader to run E against a real host.
8. Docs: NOTES records the owner's E preference, the functionality inventory, the exhausted round-2 verification history (3/3, NOT VERIFIED, not a pass) and this round's own status.

## Standards sources

`README.md`, `VERIFY.md`, `.agents/skills/verify-pi-prjcts/SKILL.md`, `web/` conventions (plain JS, no framework, `setHtml`-style render, classic-script globals), TypeScript best practices for `src/web.ts` (the only TS edit: one `if` condition). There is no AGENTS.md or CLAUDE.md in the repository.

## Known limitations and review hints

- E reads app.js classic-script globals (`projects`, `projectId`, `chatId`, `view`, `chatState`, `changeProject`, `changeChat`, `setTab`, `api`). That coupling is deliberate for a throwaway; flag only real breakage.
- Other projects' chat lists come from the read-only `show` action every ~10 s; status dots there can lag.
- Decisions/approvals not exercised (fake provider). Round-2 D/E/F verification stays NOT VERIFIED and is not re-opened here.
- Verification recipe: `web/PROTOTYPE-SIDEBAR-VERIFY.md`.
