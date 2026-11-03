# Pi Projects

Long-lived coding agents for your projects, on a pinned Pi SDK and official Pi Durable. You give a coordinator a task. It can investigate and make small changes in its own chat worktree, or delegate substantial work to workers. For task subtasks it chooses a worker in the same prepared workspace or an isolated branch from a chosen commit, then inspects and integrates the returned work. These helpers need no individual PR. Independent workers can still deliver Ready with a PR and proof for your Approve action. Terms are in `CONTEXT.md`; how it is built is in `ARCHITECTURE.md`.

A detached Node host owns every project's durable storage while your Mac is awake. The browser inbox, the CLI and Telegram all talk to that one host. Requires Node 22.19 or newer. `npm ci` (or `npm run setup`) installs the pinned SDK into this checkout; no global Pi is needed.

## Browser inbox

```bash
npm run inbox
```

This opens the selected project, or lets you choose or create one. The inbox lists saved questions with choice buttons, the project's Jobs with their plan, progress and Approve button, coordinator chats, knowledge, artifacts and settings. Answering a question records it under `decisions/` and wakes the asking chat's coordinator; it grants no execution authority.

The listener binds to `127.0.0.1` on a random port. A private launch link authenticates the tab and then leaves the address bar. Do not share launch links or `web.json`. The host rejects foreign origins and Host headers. Closing the tab does not stop work. After a host restart, run `npm run inbox` again because the port and token change; `npm run projects -- ui-url <project-id>` prints the link.

## UI 2.0 trial

`npm run ui2` starts a host from this checkout on its own home `~/.pi/agent/projects-ui2` (created empty; nothing is copied from other homes) with your real providers, and prints the `/ui2/` link; it refuses while that home's host is running.
`npm run ui2 -- stop` stops it.

## Remote access

Remote mode is opt-in: `npm run projects -- remote enable https://relay.example.com --name "Home Mac"` installs the per-user macOS host service and prints its relay allowlist command. `remote status` inspects it; `remote disable` removes the service and keeps paired identities. A private relay behind your own nginx joins outbound WSS connections, and devices pair from the inbox's Remote access settings. Protocol and limits: `REMOTE_SPEC.md`. Operator setup: `relay/deploy/README.md`.

## CLI

```bash
npm run projects -- list
npm run projects -- create "My project" /absolute/workspace "Build the approved feature"
npm run projects -- send <project-id> "Implement this feature"
npm run projects -- show <project-id>
npm run projects -- jobs <project-id>
npm run projects -- deploy
npm run projects -- host-stop
```

Without `--no-start` before the command, an API command starts the local host. Browser commands (`ui`, `ui-url`) do not take `--no-start`.

- Lifecycle: `pause`, `resume`, `archive`, `restore`, `delete`. Archive interrupts work and keeps state. Delete hides the project and keeps its state and workspace; it needs `--confirm <same-project-id>`. Restore leaves the project paused. Plain `resume` refuses when work was interrupted: inspect `jobs` and `show`, then `resume <id> --leave-interrupted --confirm <same-project-id>` allows new work without replaying interrupted requests.
- `create-once <request-uuid> <name> <workspace> [objective]` uses a stable creation identity. Repeating the exact arguments reuses the project.
- Threads: `thread-send`, `thread-steer`, `thread-stop` (needs `--confirm`) and `thread-history` take project, thread and request UUIDs.
- Routines: `schedules`, `schedule-history`, `schedule-once|interval|daily|weekly`, `schedule-enable`, `event-opt-in`.
- Owner setup: `owner-setup <project-id>` shows workspace and GitHub bindings; the other `owner-*` commands authorize, inspect and revoke them. Writes need same-project confirmation.
- `deploy` restarts the host from its main checkout with a smoke test and rollback. See "Deploy" in `ARCHITECTURE.md`.

## Knowledge

Each project has `knowledge/` under its state directory: `MEMORY.md`, an index of at most 3,000 characters, plus `preferences.md`, `runbooks/` and `decisions/`, loaded when needed. Coordinators and workers get the index and use `projects_knowledge_list`, `_read`, `_write` and `_history`. Writes need the current revision; `expectedRevision: null` only creates a file. You can edit the Markdown in your editor, and the host detects manual changes by content hash. An oversized index blocks new requests until you repair it; it is never truncated.

## State

The default home is `~/.pi/agent/projects/`; `PI_PROJECTS_HOME` selects another. Each project directory holds `project.json`, `durable.sqlite`, `knowledge/`, `decisions/` and more. The host uses a private Unix socket and owner-only files; `host.log` records startup failures. Project records from the removed legacy runtime are refused and never touched; create a new project for the same workspace instead. The host starts on demand and installs no LaunchAgent except through `remote enable`. Mac sleep pauses all local work.

Credentials, model overrides and configured extensions come from the Pi agent directory, `~/.pi/agent` by default. Pi libraries stay on the 1.0.2 release used with Durable 1.0.0; update the pins and the lockfile together.

## Access and security

The coordinator has ordinary Pi `read`, `edit`, `write` and unrestricted `bash` tools. Each chat uses its own persistent worktree, allocated from an existing unambiguous whole-repository grant when execution is first needed. Missing grants or unsupported provider adapters block workspace execution instead of falling back to your checkout. The chat's Tools/access panel shows its actual offered tools, workspace and restrictions. Browser automation runs through installed shell commands or configured MCPs; no browser service is installed automatically.

Commands run as your account, not in a sandbox. Worktrees prevent accidental collisions, not access outside their directories. Shared helpers use a single-writer handoff; the Coordinator drains its own writes before delegation and resumes after the worker settles. Isolated helpers do not implicitly inherit uncommitted files or dependencies. Task-branch integration is ordinary Coordinator work. Final merge to main, deployment and destructive actions require explicit owner approval as an agent rule, not a shell filter. MCP/skill selections and `githubCli: "none"` limit their provided gateways, not what unrestricted shell commands could do. `projects_gh` retains argv-only execution and `gh-calls.jsonl` logging. Independent workers keep their scoped workspace policies. Task helpers use trusted execution in their selected workspace; reviewers keep their static read-only tools. Run only trusted repositories and extensions, and keep production credentials away from unattended agents.

## Model providers from Pi packages and extensions

The host loads model providers from the owner's Pi packages (settings `packages`) and agent-dir `extensions/`, never from project-local `.pi/extensions` or this repo (`src/provider-extensions.ts`). They load once at host start, each isolated with its own timeout (`PI_PROJECTS_EXTENSION_TIMEOUT_MS`, default 15000); restart the host to pick up changes. Only provider and virtual-model registrations are kept; tools, commands and event handlers an extension registers are discarded. A failing extension is recorded in `extensionErrors` of `model-picker-snapshot` and does not stop the host. The picker reads Pi's `models.json` and `models-store.json` on each open (`docs/model-picker-discovery.md`).

Settings, Quota recovery selects an optional fallback model for worker, scout and reviewer. Only that exact installed, credentialed model is used. Without a fallback, a quota failure waits for the provider reset and retries.

## Plugins

Non-GitHub checkouts and PR services are plugins: `PLUGINS.md`. The iOS simulator plugin is `plugins/simulator`; it loads only when listed in `$PI_PROJECTS_HOME/plugins.json` (`plugins/simulator/README.md`).

## Development

Agents and contributors read `AGENTS.md`. `npm run check` type-checks, `npm run verify` is the CI gate, and `node scripts/run-e2e.mjs <name>` runs one script against a private home and a fake model.
