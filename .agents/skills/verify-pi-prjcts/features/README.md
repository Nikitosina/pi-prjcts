# Pi Projects verification map

Maintained source for verifying what a user does in the Pi Projects browser inbox. Read this index, then open the feature file that matches the change.

## Baseline preconditions

- Launch with `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch`. It starts a private host (own `HOME`, project home, agent dir, loopback port, socket) from empty data, plus a fake model provider.
- The seeded state is one project named `Verify seed` (folder: a one-commit git repo), all roles pinned to `fake/fake-model`, a second configured `fake/fallback-model`, no chats, no knowledge beyond the starter `MEMORY.md` and `preferences.md`.
- Run `doctor --run <scratch>` and require `ok: true` before driving.
- Drive only the instance this run launched. Never open the owner's inbox URL or use its token.

## Driving conventions

- Browser entry is the launch link in `run.json` (`webUrl`, token in the `#fragment`), opened in headless Chrome over CDP.
- Prefer ARIA labels and ids: `#composer-input` (`aria-label="Message coordinator"`), `#feed`, `#tree`, `#workers`, `#focus-view`, `[data-cmd="settings"]`, `[data-cmd="palette"]`.
- Type with `Input.insertText` and click real buttons. Never use host writes for the journey itself. Read-only second views: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> show` (allowlisted: list, show, jobs-snapshot, knowledge-list, knowledge-read, knowledge-history, search, settings-snapshot, plugins) and `model-requests.jsonl`.
- The fake provider answers `VERIFY-FAKE-REPLY: <your last message>` and calls tools only for a message containing `VERIFY-JOB` (see the Jobs feature) or `VERIFY-MEMORY` (a knowledge read and write) or `VERIFY-HOST` (Host agent with a gated archive; see the UI 2.0 feature). Any other journey that needs a model-chosen tool call reports failure with that reason.

## Proof and skip reporting

- Capture a screenshot before the action, after typing, and after the result, plus a read-only second view of the stored state.
- Record the feature ID and the entry point used. Report an unscripted or blocked journey with the attempted step and unmet precondition; never count a different path as verified.
- Evidence goes to `--evidence <dir>` (default `artifacts/verify-pi-prjcts/<run id>/`) and survives `cleanup`.

## Feature entry contract

Each file: H1, one paragraph, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with browser CDP`, `Gotchas`. Each file's driving section states whether `verify.mjs drive <feature>` scripts it or it is still a manual recipe.

## Features

- [Message the coordinator](./message-coordinator.md) — composer, send, reply, persisted transcript. Scripted.
- [Long owner messages](./message-collapse.md) — clamp, one-way reveal per chat visit (click, keyboard, hidden link focus), no reveal on selection, links or short text; A → B → A and reload collapse again. Scripted.
- [Create a project](./create-project.md) — New project hint and the Host agent. Recipe only.
- [Search](./search.md) — ⌘K palette over chats, projects, commands and full-text hits. Recipe only.
- [Memory](./knowledge.md) — read and edit Memory entries; agent writes. Partly scripted (`ui2`).
- [Jobs, Approve and Deploy](./jobs.md) — Job tree, Ready proof and Approve in worker details, intermediate checkpoint without Approve, Deploy settings. Scripted.
- [The inbox](./ui2.md) — serving at `/`, tree, tool rows, worker focus, Memory, settings overlay with host themes, profiles, tiers, Context bar, prompt and tools, Host agent drawer with Approve/Deny, coordinator approvals and focus, toasts, narrow layout. Scripted.
- [Plugins](./plugins.md) — a plugin under development on the private host (`launch --plugin`), its row in the Plugins section and the `plugins` RPC. Scripted.
- [UI 2.0 Prompt blocks](./ui2-prompts.md) — Settings → Prompt: block list with switches, badges and tokens, one editor, custom blocks, reorder, restore default, drafts, stale-write conflicts, preview, Host agent, 390 px. Scripted.
- [Storage and Clean up](./storage.md) — Settings → Storage rows and the Clean up button ending with its run summary. Scripted.

`pr-review`: launch with `--review-fixture`, doctor, then drive `pr-review`. A local contributor checkout and stub gh supply two heads, four files across directories, a large multi-hunk patch, and open and resolved threads. Drive the PR row and chat #7, file navigation, Viewed and gap expansion; capture unified, split, resolved, expanded, context, since-you-looked, light and 390 px.

`review-drafts`: launch with `--review-fixture`. Measure the layout toggle at a file boundary, inspect a colleague PR, then link the fixture PR to a real fake-provider Job and exercise the draft and batch flow.
Add `--review-stress` at launch to measure the toggle after loading 16 files. The draft journey reads from Main and checks delivery in the Job's separate Calendar maintenance chat.

`review-publish`: launch with `--review-fixture`, doctor, then drive `review-publish`. The owner submits one selected draft and keeps a worker draft pending. The stub applies the reply but drops its receipt; the room shows the uncertain state.
