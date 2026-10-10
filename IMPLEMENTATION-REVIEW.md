# Implementation review — source-only guide

**Implemented, unverified; not accepted or verified.** Five foundations remain historically accepted and the goal remains 5/10. Verification is suspended. No checks, builds, UI/runtime sessions, provider calls, grants or provisioning/effects were performed for this review. No production host was restarted or migrated. Historical failed/UNKNOWN/BLOCK records remain intact; see `PARITY.md`.

## Review entry points

- **Native:** `/projects`, then press `O` for Owner setup; `/projects-inbox`, `/projects-desk`, `/projects-board` select layouts. Read-only source review: `src/project-owner-setup-screen.ts`, `src/project-screen.ts`.
- **Browser:** `/projects-ui` from Pi, then **Owner setup**. Shell inbox entry (starts a detached local host): `npm run inbox --prefix /Users/nikitarat/.pi/agent/projects-mvp`. Keep launch links and `web.json` private.
- **CLI:** lifecycle, owner setup and copy-only commands are documented in `README.md` and `CLI-WIRING.md`. Commands are suggestions only and were not run; without `--no-start`, a command may start a host.

Any later hands-on review requires a fresh owner-approved disposable project home and host—not `/Users/nikitarat/.pi/agent/projects` or the current Pi session. Do not reload/restart production, duplicate global extension registration, copy credentials/settings, clear `NODE_OPTIONS`/`PI_PACKAGE_DIR`, or grant real provider effects. Use a private browser launch link.

## Bounded checklist

- [ ] Review native layouts and controls: inbox, drafts, evidence, threads, knowledge, settings, usage, lifecycle, routines.
- [ ] Review browser inbox, drafts, owner-backed controls and confirmation flows.
- [ ] Review CLI lifecycle/thread/routine forwarding and no-start/confirmation boundaries.
- [ ] Review owner setup: workspace/GitHub authorization and revocation, exact profile operations, repository skill selection; compare revision and consent boundaries.
- [ ] Review standalone copy-only maintenance on a fresh marked disposable root only. It never starts a copied project and is not production migration.
- [ ] Distinguish configured-skill availability, provider operation approval, and effect execution; one does not imply another.

Current implementation is unverified. Focused historical GREENs elsewhere in `PARITY.md` do not verify these new paths.

## Correct authorization distinctions and blockers

Owner setup UI/CLI and revision-checked workspace/GitHub authorization and revocation, fixed-profile operations, and repository-skill grants are implemented but unverified. Workspace/GitHub revocation retains identity history; it does not delete repository data or remote objects. Repository skill selection and worker document reads are implemented but unverified. Configured Pi skills remain unavailable without a trusted already-loaded public catalog snapshot. No provider plugin adapter/setup/commands exist.

Provider write workflows are implemented, not categorically excluded; they require their own scoped authority and approvals. Exact-head GitHub merge execution is implemented but unverified, guarded by a separately executable approval and explicit execution confirmation. This review authorized/performed no merge or other external effect. Auto-merge is unavailable. Deployment/destructive execution is not authorized here. Owner grants configure authority; they are not themselves approval or execution of an effect.

Copy-only maintenance handles acknowledged owned disposable copies; it is not migration, does not import/start/open a copy, and preserves archive/marker/rollback evidence. Configured skills and provider plugin remain blockers/exclusions. Five verification contracts remain pending; this document does not advance the 5/10 accepted status.

## Safe sequence

1. Read this guide, `README.md`, `PARITY.md`, then inspect source/reports without launching anything.
2. For interactive review, obtain separate authorization and use a fresh disposable home/host. Avoid production defaults/current session and real effect grants.
3. Run no verification or provider operation until separately authorized; preserve all historical evidence and report failures as failures.
