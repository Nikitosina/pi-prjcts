# Working in pi-prjcts

Read `CONTEXT.md` (domain terms; use them exactly) and `ARCHITECTURE.md` (modules and the rules each must keep) before changing code. `docs/lean-runtime-plan.md` holds settled owner decisions: do not reopen them. Plugin authors also read `PLUGINS.md`.

## Commands

- `npm run check` runs `tsc --noEmit`. Run it before every commit.
- `npm run format` runs Prettier (printWidth 140) over the repo. It skips `*.md`, so write Markdown by hand.
- `npm run verify` is the CI gate: check, `format:check`, then a fixed set of scripts through the runner. Run it before reporting a change done.
- One script: `node scripts/run-e2e.mjs <name> --timeout 240`. A name matches `scripts/<name>.mjs`, `<name>-e2e`, `<name>-unit` or `<name>-tdd`; globs work (`'durable-*'`). `--jobs N` runs several in parallel, `--retry-failed-serially` reruns failures one at a time, `--list` lists the scripts. Artifacts go to `artifacts/` (gitignored).
- `npm run check:fast` runs check plus only the scripts affected by your diff, chosen by `scripts/e2e-manifest.json`.

## Tests

- Commit lean tests: one per contract. Extend an existing script before adding a new one.
- Write the ways a new module can fail into `scripts/<name>-failures.md` before the code. Show a fix with a red run before and a green run after.
- `knownFailing` in `scripts/e2e-manifest.json` stays empty. A script that fails is fixed, or deleted when it only tests removed behavior. Do not weaken an assertion about behavior that still exists.
- Every script uses its own temp home, socket, port and Chrome profile, and a fake model. No script reaches a real provider.

## Live data

Tests and verification must use a fresh `PI_PROJECTS_HOME` in a temp directory and the fake provider. Never point them at a live `PI_PROJECTS_HOME` (`~/.pi/agent/projects*`, including `projects-dev` and `projects-next`) or at `~/Projects/pi-prjcts`.

For owner-requested deployment, use the normal Deploy flow described in `ARCHITECTURE.md`. Do not deploy the host while any project is `working`; wait until all projects are `idle` and recheck before deployment. Do not bypass this check with a manual restart or migrate a running host.

## Verifying the UI

After changing `web/`, `src/host-server.ts`, `src/web.ts` or chat behavior, follow `.agents/skills/verify-pi-prjcts/SKILL.md`. It launches a private host with a fake provider, drives headless Chrome, and saves screenshots and host state as proof. Report any journey you did not script as unscripted.

## Style

- Match the surrounding code. Add a comment only to explain a reason, in one line.
- No coding standards file exists in this repo. The owner's rules are in `~/.pi/agent/AGENTS.md`, and TypeScript conventions are in the `typescript-best-practices` skill; apply both.
- `/pr-review` (three axes) is manual: run it only when asked.
