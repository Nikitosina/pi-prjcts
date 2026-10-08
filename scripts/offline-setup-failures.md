# Offline schedule E2Es and one-command setup: failure cases

Written before the change. Covers `scripts/durable-local-schedule-*-positive-e2e.mjs` (now on `scripts/fake-model.mjs`) and `npm run setup` (`scripts/link-durable.mjs` + unpdf).

Schedule positive E2Es
1. A script still resolves `openai-codex/*` (or any owner provider) and spends real usage; or the owner's `~/.pi/agent` auth/settings are read or written.
2. The host child inherits the owner's HOME/agent dir instead of the private one, so the fake model is not configured there.
3. The fake reply is not byte-exact (`Reply exactly X` → `X`), so native-record checks fail for the wrong reason.
4. The fake server or host is left running after a failure.
5. Checks that asserted OAuth availability now silently pass without any model at all (must assert the fake model is the one requested).

Setup (`npm run setup`)
6. Installed Pi is not 1.0.0 and the version-pinned integrity check refuses (current breakage), or the check is dropped entirely.
7. pi-durable's own pinned dependency on pi-coding-agent/pi-agent-core differs from the installed Pi and is linked anyway without saying so.
8. The tarball integrity (sha512 from the registry lockfile/`npm view`) is not verified before linking.
9. unpdf is a separate manual step; a fresh checkout fails on PDF upload until someone remembers `link:unpdf`.
10. Re-running setup is not idempotent (fails on an existing link, or re-downloads every time).
11. A wrong existing symlink/dir is silently kept.
