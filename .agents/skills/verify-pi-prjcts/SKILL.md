---
name: verify-pi-prjcts
description: Verify pi-prjcts by driving its real browser inbox (Decision inbox web UI on a private host) with headless Chrome, and capture screenshot and host-state proof. Use after changing web/, src/host.ts, src/web.ts or coordinator chat behavior, or when asked to prove a UI feature works end to end.
---

# Verify pi-prjcts

Surface: the browser inbox (`web/`, served by `src/host.ts` on a random loopback port). The CLI (`npm run projects -- ...`) shares the same host and is secondary. Isolation: every run gets its own `HOME`, project home, agent dir, port and socket, so it never touches the owner's host. Run from the checkout root. Needs `node_modules` (`npm ci`) and Google Chrome at `/Applications/Google Chrome.app` (override with `VERIFY_CHROME`).

This skill lives in `.agents/skills/verify-pi-prjcts/`, the repo-local root that both the SDK catalog and worker repository-skill discovery scan. `.cursor/skills/verify-pi-prjcts` is a symlink pointer to it for tools that read `.cursor`; keep it a symlink (worker discovery refuses symlinks *inside* `.agents/skills`, so the canonical copy must stay real files).

All commands below are `node .agents/skills/verify-pi-prjcts/scripts/verify.mjs <command>` (`V` for short). Pick the feature file in [features/README.md](features/README.md) first; it lists preconditions and which journeys are scripted.

## Launch

`V launch --evidence <dir>` creates scratch data in `$TMPDIR/pi-verify-<id>/`, starts a fake model provider and a host from empty data, seeds project `Verify seed`, and prints JSON with `ready: true`, `scratch`, `evidence`, `origin`. Ready means the host answered `/health` with our pid, the web page is served, and the seeded project is listed. Without `--evidence`, proof goes to `artifacts/verify-pi-prjcts/<id>/` (gitignored). A failed launch cleans up after itself. Keep the printed `scratch` path; every later command takes `--run <scratch>`.

## Doctor

`V doctor --run <scratch>` is read-only. It checks the host and provider pids are alive, the private socket answers with our pid, the home is the scratch home (never the owner's), HEAD equals the launch revision, the web page serves from our origin, and the seed project is listed. Exit 1 lists the failed checks. Run it before every drive and whenever something looks off. After a failure, run `cleanup` and `launch` again instead of repairing.

## Drive

`V drive --run <scratch> <feature>` runs one scripted journey through headless Chrome (raw CDP over a pipe, real `Input.insertText` and clicks). Scripted today: `message-coordinator`. Other features in `features/` are manual recipes; use the same CDP approach with the ids they list, and say in your report that they are unscripted. Add a journey by extending the `journeys` map in `scripts/verify.mjs` and updating the feature file.

## Evidence

Each drive writes into the evidence dir: `01-before-send.png`, `02-typed.png`, `03-reply.png`, `messages-dom.txt`, `host-show-messages.json` (host's stored transcript), `model-requests.jsonl` (what the provider received), `report.json` (steps, console errors, HTTP errors). Proof standards: use the real user path (typing, clicking), capture action and result, confirm a side effect through a read-only second view, and report anything unscripted or blocked as such. A precondition the seed lacks is a failure reported with its reason, never a weaker journey.

The only mock is the fake provider at the existing model seam. A pass shows the UI, host routing and transcript storage work; it says nothing about real model output, tool calls or credentials.

## Cleanup

`V cleanup --run <scratch>` asks the host to shut down, kills only the pids recorded in `run.json` if they linger, and deletes the scratch dir. The evidence dir stays. Run it after every attempt, including failed ones. It never matches processes by name; if you started extra processes yourself, stop those by pid.
