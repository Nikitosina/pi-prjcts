# Pi Projects MVP

Local persistent projects using a locally installed, pinned Pi SDK and official Pi Durable. Every project uses Durable; the legacy (pi-subagents era) runtime has been removed. A `project.json` without `runtime: "durable"` is refused: it is left out of the list, every action on its id fails with "uses the removed legacy runtime and cannot be opened", the host logs `legacy-project-refused` at start, the browser shows that message, and its files are never touched. A detached Node host owns Durable coordinators/workers while your Mac is awake.

Verification is currently suspended by the owner. New backend and native/browser changes are unverified. Five foundation milestones are accepted; full parity is not. See `PARITY.md` for evidence limits, `IMPLEMENTATION-REVIEW.md` for this source-only closeout and safe review path, and `BROWSER-WIRING.md` for browser controls. Do not run verification or restart/migrate a production host without renewed permission. Any future interactive review requires a fresh owner-approved disposable project home, not the production home or current running Pi session.

## Live decision inbox

The browser client uses Decision inbox. Run `npm run inbox`. It opens the selected project, or lets you choose or create one.
The CLI and browser share the same persistent coordinators.

From a shell:

```bash
npm run inbox --prefix /Users/nikitarat/.pi/agent/projects-mvp
```

The inbox has saved questions with choice buttons and custom answers, Durable
worker threads (history, follow-up, steer, stop) in Activity, immutable evidence
previews, shared notes, and coordinator messaging. The message box stays available
while reading the inbox; `/` focuses it. Drafts survive polling, in-flight sends
and project switches within the tab. Durable browser controls also cover scoped approval records and separate execution/inspection, managed knowledge, a hash-pinned library with confirmed pasted imports, role settings, usage, lifecycle actions, GitHub observations and routines. Tab/origin-local draft snapshots restore no actions or confirmation inputs.

Answering a question records it under `decisions/` and wakes the asking chat's
coordinator with the answer; it grants no execution authority. Old legacy `review`
decision files are ignored.

The browser listener binds only to `127.0.0.1` on a random port. A private launch
link authenticates the tab, then the token leaves the address bar. Do not share
launch links or `web.json`. The host rejects foreign origins and Host headers.
Closing the tab does not stop work. After a host restart, run `npm run inbox`
again because the port and token change. For an owner-authorized review in a fresh disposable home only, load host-side updates after active work finishes by stopping that disposable host and reopening a project. This is not advice to stop or restart the production host.

## Remote access

Remote mode is opt-in: `npm run projects -- remote enable https://relay.example.com --name "Home Mac"` installs the per-user macOS host service and prints its relay allowlist command. `remote status` inspects it; `remote disable` removes the service and retains paired identities. Enable keeps the Mac awake only on AC power. It does not restart an already-running host to load new code.

A private relay behind your own nginx joins outbound WSS connections; devices pair from the local inbox's Remote access settings. See [REMOTE_SPEC.md](REMOTE_SPEC.md) for the protocol, security limits and staged verification, and [relay deployment](relay/deploy/README.md) for operator setup. Deployment and cellular/VPN verification have not run.

## Use

The terminal UI (Pi extension, `/projects*` and `/project-*` slash commands) was removed. Use the browser client (`npm run inbox`) and the CLI (`npm run projects -- <command>`).

## Lifecycle CLI

The CLI supports `pause`, idle `resume`, `archive`, `restore`, `plan`, and confirmed
`delete`. Use `--no-start` before the command to contact only an existing host.
Without it, API commands can start the local host. Browser commands do not support
`--no-start`.

From this package directory:

```bash
node --experimental-strip-types src/cli.ts --no-start pause <project-id>
node --experimental-strip-types src/cli.ts --no-start plan <project-id>
node --experimental-strip-types src/cli.ts --no-start resume <project-id>
node --experimental-strip-types src/cli.ts --no-start resume <project-id> --leave-interrupted --confirm <same-project-id>
node --experimental-strip-types src/cli.ts --no-start archive <project-id>
node --experimental-strip-types src/cli.ts --no-start restore <project-id>
node --experimental-strip-types src/cli.ts --no-start delete <project-id> --confirm <same-project-id>
```

Archive interrupts work and retains state. Delete hides the project while keeping
its state and workspace; it requires the matching UUID after `--confirm`.
Restore leaves the project paused. Plain resume refuses prior work. Inspect `plan`
and `show` first, then use `--leave-interrupted --confirm <same-project-id>` to
permit new work without replaying interrupted requests. The CLI flag E2E covers
confirmation and forwarding on an empty plan; nonempty CLI recovery remains
unverified. The browser now offers confirmed project pause for Durable projects.
Closing its confirmation leaves the project running. After pause, the browser
shows the paused state and disables messaging without clearing the draft.
Browser resume reads the saved plan and offers idle resume or UUID-confirmed
`leave-interrupted` recovery. The browser E2E covers cancel, wrong confirmation
and explicit policy forwarding on an empty plan, not nonempty recovery.
Browser archive/delete/restore and native lifecycle controls are now implemented but unverified. They retain repository work, allocated resources and remote PRs. Restore stays paused; the browser can reopen a known retained UUID removed from ordinary listing. The historical pause/resume E2Es do not verify these additions.
Do not restart a production host with active work without approval. Interactive review instructions apply only to a fresh owner-approved disposable home.

## Structured knowledge

Each project has `knowledge/` under its state directory (by default
`~/.pi/agent/projects/<project-id>/knowledge/`):

- `MEMORY.md`: a maintained index, maximum **3,000 Unicode characters**.
- `preferences.md`, `architecture/`, `research/`, `decisions/`, `runbooks/`, `plans/`:
  documents loaded only when needed, not appended to every prompt.

Coordinators and workers receive the index. `projects_knowledge_list`,
`projects_knowledge_read`, `projects_knowledge_write`, and
`projects_knowledge_history` provide project-bound access. Read before writing:
updates require the current revision; `expectedRevision: null` only creates a
new file. Workers maintain topics; the coordinator curates the index and
preferences. Standing project instructions remain separate.

Owners can inspect/edit these Markdown files with their editor. Manual changes
are detected by their content hash. An oversized index blocks new coordinator
requests and worker launches until repaired; it is never silently truncated.
Managed document APIs support `knowledge-list`, `knowledge-read`,
`knowledge-write`, and `knowledge-history`, all with the project `id`; read,
write, and history also take `path`, and write takes `text` and
`expectedRevision`. Human read/write APIs remain available for index repair.
The terminal/browser Notes views still show the audit log. Native `K` and browser managed knowledge now provide editors, null-revision topic creation and read-only history. Conflicts keep the draft's original revision; rereading does not silently rebase. Topic creation does not automatically edit MEMORY.md. New UI behavior is unverified.

Old JSON notes remain unchanged. Repeatable migration imports them under
`research/legacy/` without replacing human corrections. Hidden `.knowledge/`
records hold revisions, import receipts, and a recovery journal. A small
`writer.sqlite` database supplies only the cross-process lock; the Markdown files
remain authoritative. The installed Node runtime must support `node:sqlite`.
No extra SDK or database service is installed. Recovery keeps
a conflicting human edit and retains the interrupted write under
`.knowledge/conflicts/`; do not delete those records as a repair shortcut.

## CLI

```bash
cd ~/.pi/agent/projects-mvp
npm run projects -- ui
npm run projects -- ui-url <project-id> # Private launch link; do not share it.
npm run projects -- list
npm run projects -- create "My project" /absolute/workspace "Build the approved feature"
npm run projects -- send <project-id> "Implement this feature and return E2E evidence"
npm run projects -- show <project-id>
npm run projects -- host-stop
```

`create-once <request-uuid> <name> <workspace> [objective]` uses a stable creation identity. Repeat the exact arguments to reuse that project, without restoring/resuming or resetting settings. It cannot reconstruct native/browser requests with additional explicit model/grant fields; use their stored request instead. Ordinary `create` still chooses a fresh project UUID. This new behavior is unverified.

Scoped worker submission is explicit: CLI `submit-scoped <project-id> <scope-id> <thread-id> <request-id> <task>` selects an existing owner-authorized scope. It grants no new tools or repository authority and uses the official Durable planner. This path is unverified.

Routine CLI controls include `schedules`/`monitors` snapshots, stable-ID one-shot/interval/daily/weekly creation, explicit event opt-in and confirmed enable/disable. They call the existing Durable backend without client timers, new grants or automatic resume. See `CLI-WIRING.md` for syntax and limits. This wiring is unverified.

Owner setup uses `projects -- owner-setup <project-id>` for current bindings and revision-checked workspace/GitHub authorization and revocation, fixed-profile operations, and skill grants. Native Pi opens it with `O`; browser clients have an Owner setup button. Writes require fresh same-project consent. Revocation retains identity history and does not remove repository data or remote objects. Repository skill selection is implemented but unverified; configured Pi skills remain unavailable without a trusted already-loaded catalog snapshot. These owner-grant controls configure authority; they do not themselves authorize a worker effect. See `CLI-WIRING.md`. This wiring is unverified.

Durable thread CLI controls: `thread-send`/`thread-steer` require project, thread and request UUIDs plus text; `thread-stop` requires matching `--confirm`; `thread-history` and `legacy-thread-history` (threads from older Durable stores) expose message/Unicode slices. See `CLI-WIRING.md`. These additions are unverified.

CLI creation trusts the named workspace's Pi resources and creates a Durable coordinator. It grants neither other workspaces nor worker/provider execution. Explicit workspace/tool/publication grants and executable-effect approvals remain separate.

## Durable controls

Durable uses the official owned Harness, persistent UUID threads, scoped workspaces and fixed command profiles. Missing workspace/tool access remains a blocker. Worker execution requires explicit grants; the coordinator does not receive a shell. `COMMANDS.md` and `GITHUB-LOCAL.md` describe command/publication limits.

Use confirmed `settings-update` or browser settings rather than editing state or stopping production. Coordinator models can be cycled from the composer through the project's scoped list, inherited from Pi's `enabledModels` unless overridden. Worker, scout and reviewer selections default to inheriting the coordinator model when a new thread is admitted; explicit role selections override inheritance. Existing worker threads retain their frozen model and instructions. Coordinator model changes require idle coordinator chats and do not interrupt running workers. Configured credentials do not prove connectivity.

New projects allow coordinator questions and access to their captured-evidence library by default; existing grants are not broadened. Concurrency defaults to five workers; explicit project limits remain unchanged. The owner controls this limit in settings, not through the coordinator's tools. Skills and MCP use a shared selection by default, with existing per-role selections retained under advanced controls. Compaction uses Durable defaults unless a legacy override is present; advanced controls retain access to those overrides.

Projects-specific instructions target 4,000 characters for coordinators and 2,000 for workers, excluding repository instructions, owner objectives and on-demand resource content. Project read/search/status responses default to 8 KiB with continuation or expansion; native Pi coding tools keep their own limits. Completion notifications are capped at 2,000 characters with a full-result pointer. These are context budgets, not model-window or billing limits.

`usage-snapshot` and browser usage expose owner-backed counters; page-only worker totals and SDK estimates are not billing.

## Persistence and recovery

Durable projects keep official runtime data under their owned project state, with one Harness/storage owner. Do not open extra historical stores, edit runtime databases or remove uncertainty records to enable replay. Interruptions and uncertain effects remain inspectable; recovery requires an explicit policy. Native draft snapshots are active-Pi-branch/session state; browser drafts are tab/origin-local `sessionStorage`, not proven across closed tabs, host-port changes or crashes. Restore of either UI state submits nothing.

Default state: `~/.pi/agent/projects/`. `PI_PROJECTS_HOME` selects a separate store. Each project directory holds `project.json` (identity, workspace, models, `runtime: "durable"`), the Durable runtime store, `knowledge/`, `notes/`, `inbox/`, `decisions/`, `evidence/` and `events.jsonl`. The host uses a private Unix socket and owner-only state files; `host.log` records startup failures and `legacy-project-refused` lines.

Legacy records (no `runtime: "durable"`) are refused rather than adopted: they may carry legacy `runs`, a pi `sessionFile`, review decisions and `writer-launch.json`, and opening them as Durable would silently drop that history. Copy-only migration/switch tooling was removed with the legacy runtime; move such a project by creating a new Durable project for the same workspace.

The host starts on demand and does not install a LaunchAgent. After reboot, reopen a project. Mac sleep pauses all local work. No cloud execution, scheduled work, external subscriptions, image chat, or OS sandbox is included. Workers currently have local coding tools, not your MCP tool catalog; Xcode and other MCP-backed workflows need a later tool-policy expansion.

## Repository authorization

A GitHub workspace grant binds its repository ID to its owner checkout, approved
root and ownership prefix. Later grants cannot retarget that ID. Use a new
repository ID for a different binding. The same binding can authorize another
file scope without changing its existing scopes. This does not grant publication,
merge, deployment or destructive-operation permission.

The host can record proposed merge/auto-merge decisions with `operation-request`,
`operation-decide` and `operation-snapshot`. Confirmation binds the project UUID
and the exact intent fingerprint. Plain records remain non-executable. New exact approvals with `execution: true` are consumed only by their bound executor; old records gain no execution authority. Merge execution/inspection and fixed worker deployment/destructive approvals are implemented but unverified. `operation-inspect` or native effect inspection does not grant replay permission. Auto-merge remains blocked. `provider-pr-inspect` can separately read an authorized GitHub PR, check
its numeric repository identity and require an expected live head SHA. This
read-only inspection does not link the local checkout to the remote repository
or turn decision records into executable grants. provider plugin inspection remains pending.

### Approved coordinator VCS operations

`projects_vcs_operation` previews or requests a named operation with `method`,
`scopeId`, `action` and `target`. Requests also need a stable `requestId` UUID.
Supported actions are `worktree-remove` for one host-owned Git or Arc worktree,
`worktree-remount` for one registered provider mount, and `branch-delete` for one
local Git branch. Arc removal and remount require the provider's matching hooks. Resets, cleaning, arbitrary shell commands and publication
remain unavailable through this tool.

Review the exact target, state and risks in the approval inbox. Choose **Allow
exact executor**, then confirm **Execute once**, or let the coordinator execute
using that approval's ID and fingerprint. Plain approval and Telegram's **Approve
record only** button grant no execution permission. State changes require a fresh
request and approval. All workers must be settled; dirty, local-only, active or
unknown work remains protected. Approved cleanup may remove a safely retained
worktree with an open PR. Git cleanup keeps its branch and commits. Arc cleanup
forgets that worktree's store and local refs: stashes block removal, and every
local branch tip must match the retained base/current head or its published
remote tip. Unknown inventories or more than 32 local branches also block it.

Execution records uncertainty before changing VCS state. Completed retries return
the original receipt; uncertain attempts never run again. Inspecting a receipt
neither retries nor clears uncertainty. An uncertain attempt blocks new workers
and automatic worktree cleanup pending manual investigation. There is no VCS
uncertainty recovery control yet; inspection cannot unblock that project.
For an unmounted Arc worktree, request `worktree-remount` first. Its approval
binds the registered mount, backing storage and host lease, not local cleanliness
or permission to delete. Remount uses the registered Arc mount configuration;
it does not transfer ownership or retire the allocation. Arc's named remount
checks the owner under its registry lock, but has no atomic renewal-timestamp
flag; the provider rechecks the exact snapshot before calling it. Afterward,
inspect actual local changes and unpublished commits, then request a separate
`worktree-remove` approval if safe. Fetching a PR head cannot establish that an
unmounted worktree has no local work. Dirty or unreadable state still blocks
removal.

## Security limits

Run only against trusted workspaces. Extensions execute with your account's permissions. File-tool and shell-pattern checks are operational guardrails, not confinement: shell scripts, generated programs, and ambient trusted extensions can access files or services outside the workspace. Keep production credentials away from unattended workers. SDK extension dialogs are recorded as questions and fail closed. Answer in the decision inbox or perform the approved action yourself. An answer cannot bypass publishing or destructive-command checks.

## UI choice

Decision inbox is the chosen default. The browser client lives in `web/`; the terminal UI was removed.
Trial screenshots under `artifacts/ui-prototype/` show the earlier simulated app,
not either live client.

## Optional project simulator

iOS simulator management is a plugin in this repository: `plugins/simulator`. Enable it by adding its absolute path to `$PI_PROJECTS_HOME/plugins.json` (see `PLUGINS.md`) and restarting the host. Details: `plugins/simulator/README.md`.

## Verify and maintain

General verification remains suspended. The pi-subagent-manager migration has owner approval for an isolated Durable-host E2E only. Commands below are otherwise reference, not permission to run unrelated checks/E2Es or restart production. Historical/frozen fixtures and evidence must remain unchanged.

```bash
cd ~/.pi/agent/projects-mvp
npm run setup
npm run check
npm run e2e:legacy-removal
```

Runtime requires Node 22.19 or newer and npm, not a global Pi installation. `npm ci` (also `npm run setup`) installs the SDK, Durable, unpdf and TypeScript into this checkout's `node_modules` using `package-lock.json`. Pi libraries stay on the 1.0.2 release used with Durable 1.0.0; update the pins and lockfile together. No dependency symlinks, pi-subagents dependency or runner patches are needed.

Credentials, model overrides, settings and configured extensions still come from the usual Pi agent directory, `~/.pi/agent` by default. The SDK's model catalog cache lives separately at `$PI_PROJECTS_HOME/models-store.json`, seeded once from Pi's existing cache; Projects does not write the shared catalog cache. Those extensions are user-managed and must support the pinned SDK. Project state still follows `PI_PROJECTS_HOME`. Global Pi upgrades do not update this runtime. The host still scrubs inherited `PI_SUBAGENT*` variables before loading shared extensions. `scripts/setup-e2e.mjs` is a historical fixture for the removed global-link setup, not a check for the npm install path.

E2E scripts (`scripts/*-e2e.mjs`, run with `env -u PI_PACKAGE_DIR node scripts/<name>-e2e.mjs`) use a private HOME, a local fake model and headless Chrome; no real providers. On non-Mac systems, set `CHROME_BIN` to a Chrome-compatible browser executable. No TUI pseudo-terminal E2E remains (the old one drove legacy runs).

Each run creates an isolated disposable workspace and project store under `artifacts/<timestamp>/`. `report.json`, `assertions.json`, worker inspection reports, and generated verification files are repeatable evidence. See `VERIFY.md` for the failure cases.

For an owner-authorized disposable review home only, uninstall by removing `./projects-mvp` from that review Pi package list and reloading its client; stop only that disposable host. Keep its state directory if you want to retain review history. Do not apply these instructions to production without explicit approval.

## Model providers from Pi packages/extensions

The host loads model providers contributed by the owner's Pi packages (settings `packages`) and agent-dir `extensions/` (never project-local `.pi/extensions`, never this repo). See `src/provider-extensions.ts`.

- Loaded once at host start, each extension entry isolated (own runtime, timeout `PI_PROJECTS_EXTENSION_TIMEOUT_MS`, default 15000). Nothing is installed or downloaded. Restart the host to pick up extension changes.
- Only provider, native-provider and virtual-model registrations are kept. Tools, commands, flags, shortcuts, event handlers and UI hooks an extension registers are discarded and never reach project agents. The extension's module and factory code does run in the host process (as in Pi); handlers such as `session_start` never fire, so providers that need lazy init from events or UI/OAuth login flows are not supported (stored credentials in `auth.json` are).
- A failing extension is recorded (`extensionErrors` in `model-picker-snapshot`, shown at the bottom of the picker list, logged as `provider-extensions` at start); the host and other extensions continue. Models of a failed extension are unavailable.
- One factory (`createModelRuntime`) builds every model runtime: the picker, settings validation and each project's running sessions. It registers extension providers and runs one offline availability pass, so `configured` means the same everywhere (api_key and oauth entries in `auth.json`, env keys, extension apiKey).
- The skill catalog loader (`project-resources.ts`) no longer executes extensions (`noExtensions`), so a broken extension cannot block opening a project.

E2E: `scripts/provider-extensions-e2e.mjs` (failure cases in `scripts/provider-extensions-failures.md`).

Provider plugins (non-GitHub checkouts and PR services): see PLUGINS.md.
