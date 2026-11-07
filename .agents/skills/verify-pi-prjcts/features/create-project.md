# Create a project

The owner creates a project from the Host agent or the CLI. The inbox has no New project form: its New project button only says where to go.

## Sub-features

- `hint`: the tree's "＋ New project" button shows a toast naming the Host agent (`\`) and `npm run projects -- create <name> <workspace>`; nothing is created.
- `host-agent`: asking the Host agent to create a project runs `create` as one of its host calls; the new project appears in the tree.
- `listed`: the project appears in `#tree` and in `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc --run <scratch> list`.

## How to get to it (user POV)

- Tree button "＋ New project" (`[data-cmd="new-project"]`), then `\` for the Host agent drawer.

## Driving it with browser CDP

Preconditions: launch succeeded, doctor `ok: true`, a second empty folder inside the scratch dir (the seed project already uses the helper's `workspace` folder).

- Recipe only, not scripted: click `[data-cmd="new-project"]` and expect the toast (`#toasts .toast`). The fake provider does not script a Host agent `create`, so creating through the drawer is not driveable here; report `host-agent` as not verified rather than creating the project over RPC.

## Gotchas

- `create` grants the whole-repository workspace and GitHub access in the same step (`docs/ui2-contract.md`).
- Retired with the classic inbox (2026-11-04): the New project dialog with its folder trust checkbox (`docs/classic-retirement.md`).
