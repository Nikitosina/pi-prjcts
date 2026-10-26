# Create a project

The user opens the New project dialog, names a project, picks a folder, confirms trust, and gets a new selected project.

## Sub-features

- `create` — name, folder and trust checkbox create the project.
- `trust-required` — the dialog refuses to submit without the trust checkbox.
- `listed` — the project appears in the sidebar `#project-list` and in `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> list`.

## How to get to it (user POV)

- Sidebar button `#create` ("New project").

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, a second empty folder inside the scratch dir (the helper's `workspace` folder is already used by the seed project).

- Recipe only, not scripted: click `#create`; in `dialog form[data-create]` fill `input[name=name]`, `input[name=cwd]`, tick `input[name=trusted]`, click `button[type=submit]`. Proof: sidebar lists the new name, `#title` shows it, `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> list` shows two projects, screenshots before and after.

## Gotchas

- The folder must exist; use a new directory under the run's scratch dir, never a path from the owner's checkout.
- Creating through the host's `create` call skips the dialog and does not prove this feature (launch does that for seeding).
