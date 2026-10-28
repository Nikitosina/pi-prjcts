# PROTOTYPE — independent verification recipe for variant E (round 3)

Throwaway, see `web/PROTOTYPE-SIDEBAR-NOTES.md` for the source spec and acceptance checklist. The default scripted verify journey only covers the plain app and does **not** prove E. Run this recipe against **your own** scratch host. Everything here is readable in the repository snapshot; nothing depends on files outside it.

Source spec: the owner chose E (Arc-like tinted sidebar, rounded inset canvas, compact top tabs across projects) and asked for the current app's functionality in a richer Arc-inspired prototype. The original requirement stays: expandable project groups with only non-archived real coordinators, and normal opened-coordinator top tabs across projects.

## 1. Launch your own isolated scratch (one command)

```
node scripts/prototype-sidebar-preview.mjs <your-evidence-dir>
```

Prints JSON with `url` (E link with token), `scratch`, `ids` (seeded project/chat ids) and `stop`. Equivalent manual form: `PI_PROTOTYPE_SIDEBAR_E=1 node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch --evidence <dir>` then `node scripts/prototype-sidebar-seed.mjs <scratch>/run.json > ids.json`. Run `verify.mjs doctor --run <scratch>` (must be ok, revision = HEAD). Seed: 3 projects (Verify seed, Billing service, Docs site), several chats each, two archived (`Q2 dependency sweep`, `Old ledger spike`). Fake provider replies `VERIFY-FAKE-REPLY: <last message>`.

## 2. Gating negatives

- Default host (no env) and `NODE_ENV=production` host: with the bearer token, `GET /prototype-sidebar.js` and `/prototype-sidebar.css` must be 404, and `/?variant=E` must show the plain app (no `#proto-tabs`, `#proto-nav`).
- Plain app on the E host (`/` without `?variant=`): no prototype nodes or scripts, real `#project-list` and `#chat-list` visible.

## 3. Unscripted E drive (do it with your own CDP session, real pointer/keyboard events)

Open the E URL at 1440x900. Look for these real elements and do these real actions. Judge by screenshots plus DOM; do not trust text I wrote.

1. Overview: sidebar `#proto-nav .pp-node` x3 (projects), tab bar `#proto-tabs` with one tab (`Verify seed / Main`), no `#chat-list`. Expand every project by clicking `.pp-proj`. Archived chats must be absent. Collapse and re-expand a project: tabs unchanged.
2. Open `Release 0.9 checklist` (Verify seed), `Stripe webhook retries` and `Tax table import` (Billing service) by clicking `.pp-child`. Each time `#title` is the project name and `#messages` shows that chat's real transcript (`List what is left before tagging v0.9.0.`, `Are retries idempotent?`, `Diff the EU tax table against last quarter.`). Click an already-open coordinator: still one tab for it, now active.
3. Close fallback: close the active last tab, then the active middle tab, then an inactive tab, then the last one (`.pp-x`). Expect left neighbour, right neighbour, unchanged active, then empty state (`body.proto-empty`, `#proto-empty` visible, `.phead` hidden).
4. Quick switcher: press Ctrl/Cmd+J (real key event), expect `#proto-quick` listing non-archived coordinators of all projects, type `api ref`, Enter: that coordinator opens in a tab with its transcript.
5. Composer: click `#compose textarea`, type text with real input, click send. Expect `VERIFY-FAKE-REPLY: <text>`. Host-side proof: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> show '{"id":"<project>","chatId":"<chat>"}'` contains the text in that chat and not in another.
6. Chat create/rename/archive/restore: click `＋` in the tab bar (real `chat-new`), rename via the real toolbar dialog, archive, restore from `#chat-archived`. After each step verify with `rpc show` that the host state changed, and that tabs/sidebar follow (archived chat loses its tab and sidebar row; app falls back to Main).
7. Sections: click Knowledge, Observability, Settings in `.phead .tabs`; each panel renders. Open search (`#search-button`). Back in Coordinator, no stale panel.
8. Sidebar: Ctrl/Cmd+B collapses to a rail (`.app.side-collapsed`), again expands; drag `#proto-grip` to the right and `#side` width grows (clamped 200-460). Check dark and light theme screenshots.
9. Reload: `?variant=E` and the open coordinator stay; other tabs reset. No console errors during the whole drive. Page API writes are only the actions you performed (message, chat-create, chat-update); the prototype itself calls only the read-only `show`.

Not testable here (document, do not simulate): decisions/approvals and real worker output need a provider that calls tools.

## 4. Reference driver (optional, same checks)

`node scripts/prototype-sidebar-drive.mjs <scratch>/run.json <outdir> <ids.json>` runs all of the above (35 checks, exit 1 on failure). It is a helper, not independent proof; do your own drive first. Set `VERIFY_CHROME` for a non-macOS Chrome path.

## 5. Evidence the author produced (not independent)

Author's own run and screenshots from the pinned candidate are in the artifact folder named in the handoff; use them only to compare.

## 6. Cleanup

`node .agents/skills/verify-pi-prjcts/scripts/verify.mjs cleanup --run <scratch>`; then `pgrep -fl pp-chrome` must be empty.
