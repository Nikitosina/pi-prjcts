# Pi Projects verification map

Maintained source for verifying what a user does in the Pi Projects browser inbox. Read this index, then open the feature file that matches the change.

## Baseline preconditions

- Launch with `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch`. It starts a private host (own `HOME`, project home, agent dir, loopback port, socket) from empty data, plus a fake model provider.
- The seeded state is one project named `Verify seed` (folder: a one-commit git repo), all roles pinned to `fake/fake-model`, a second configured `fake/fallback-model`, no chats, no knowledge beyond the starter `MEMORY.md` and `preferences.md`.
- Run `doctor --run <scratch>` and require `ok: true` before driving.
- Drive only the instance this run launched. Never open the owner's inbox URL or use its token.

## Driving conventions

- Browser entry is the launch link in `run.json` (`webUrl`, token in the `#fragment`), opened in headless Chrome over CDP.
- Prefer ARIA labels and ids: `textarea[aria-label="Message coordinator"]`, `#compose button[type=submit]`, `#messages`, `#title`, `#search-button`, `#create`.
- Type with `Input.insertText` and click real buttons. Never use host writes for the journey itself. Read-only second views: `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> show` (allowlisted: list, show, plan-snapshot, knowledge-list, knowledge-read, knowledge-history, search) and `model-requests.jsonl`.
- The fake provider answers `VERIFY-FAKE-REPLY: <your last message>` and never calls tools. A journey that needs a model-chosen tool call reports failure with that reason.

## Proof and skip reporting

- Capture a screenshot before the action, after typing, and after the result, plus a read-only second view of the stored state.
- Record the feature ID and the entry point used. Report an unscripted or blocked journey with the attempted step and unmet precondition; never count a different path as verified.
- Evidence goes to `--evidence <dir>` (default `artifacts/verify-pi-prjcts/<run id>/`) and survives `cleanup`.

## Feature entry contract

Each file: H1, one paragraph, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with browser CDP`, `Gotchas`. Each file's driving section states whether `verify.mjs drive <feature>` scripts it or it is still a manual recipe.

## Features

- [Message the coordinator](./message-coordinator.md) — compose box, send, reply, persisted transcript. Scripted.
- [Create a project](./create-project.md) — New project dialog with folder trust. Recipe only.
- [Search a project](./search.md) — search dialog over chats. Recipe only.
- [Knowledge topics](./knowledge.md) — create and read a knowledge document. Recipe only.
- [Verification settings](./verification-settings.md) — opt in to the automatic verifier loop in Project settings. Scripted.
- [Quota fallback settings](./quota-settings.md) — worker fallback selection, review, save and reload. Scripted.

- [Quota save recovery](./quota-save-recovery.md) — existing quota work and browser save. Scripted.
