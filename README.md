# Pi Projects MVP

Local persistent projects using installed Pi and official Pi Durable. New projects use Durable; unchanged existing projects retain their original runtime until explicit migration. A detached Node host owns coordinators/workers while your Mac is awake.

Verification is currently suspended by the owner. New backend and native/browser changes are unverified. Five foundation milestones are accepted; full parity is not. See `PARITY.md` for evidence limits, `IMPLEMENTATION-REVIEW.md` for this source-only closeout and safe review path, `TUI-VERIFY.md` for native controls and `BROWSER-WIRING.md` for browser controls. Do not run verification or restart/migrate a production host without renewed permission. Any future interactive review requires a fresh owner-approved disposable project home, not the production home or current running Pi session.

## Decision inbox inside Pi

Run `/reload`, then `/projects`. Decision inbox is the default for new sessions.
Use `/projects-inbox` to select it explicitly in a session with a saved layout.
Press `/` to write any request, and `m` to read the coordinator conversation.
The master plans, spawns workers, and steers existing workers when you change
requirements. It delegates execution instead of coding itself.

Other layouts remain available inside Pi:

```text
/projects-desk
/projects-board
/projects-inbox
```

If no project is selected, you can choose or create one first. `/projects` also
opens the native screen after choosing a project. `/projects-view desk|board|inbox`
is the single-command form. The last layout is saved in the Pi session.

- Command desk: a task list beside a scrollable inspector.
- Work board: host-derived Planned, Running, Needs you, and Complete lanes.
- Decision inbox: pending questions and results before background activity.

Press `1`, `2`, or `3` to switch layouts. `/` focuses the coordinator prompt;
Enter sends and Shift+Enter adds a line. Drafts survive layout changes,
polling, and project switches within the open screen. Tab moves between the list, inspector, and prompt. Escape first leaves
an editor or inspector, then closes the screen. Closing does not detach the
project, stop its host, or stop workers. Native draft snapshots now use public Pi session entries, including thread request IDs and knowledge/settings revisions. They checkpoint periodically and on close. Reload/restart retention is unverified, not a crash guarantee.

Use `w` for work, `i` for the inbox, `m` for coordinator conversation, `e` for
evidence, `n` for notes, and `l` for coordinator requests. Up/down or j/k select items. Left/right choose board lanes.
Enter inspects an item or opens a question. `a` answers, `v` accepts a review,
`c` requests changes, `t` reads a worker transcript, `s` steers, and `x` stops.
Review acceptance and worker stopping both require confirmation, defaulting to
cancel. `p` switches projects, `r` reconnects, and `?` shows all controls.

Durable controls also include `f` for an existing-thread follow-up; `o` for paged approvals; `K` for managed knowledge/topic creation; `L` for a hash-pinned library; `A` for confirmed pasted reference imports; `S` for revision-checked settings/model defaults; `U` for owner-backed usage; `P` for confirmed lifecycle actions; `G` for GitHub PR/CI/review/publication receipts; and `R` for retained routines with separately confirmed enable/disable and event opt-in. Plain approval and executable consent are separate. Exact-head GitHub merge execution is implemented but unverified and requires a separately executable approval plus explicit execution confirmation; no merge effect is authorized by this review. Auto-merge and Arc adapter/commands remain unavailable. These controls have no new walkthrough evidence.

These are live terminal clients, not browser simulations. All mutations use the
existing host APIs. Evidence comes from hash-checked captured files. Board lanes
are not editable statuses, and none of the layouts allocates worktrees. Worker
JSON and polling messages stay out of the underlying chat while the screen is
open. The layouts require interactive Pi; RPC and print callers keep the existing
commands. Terminal resize, active themes, and built-in Unicode editing are supported.

## Live decision inbox

The browser client uses Decision inbox. In Pi, run `/reload`, then
`/projects-ui`. It opens the selected project, or lets you choose or create one.
The terminal client and browser share the same persistent coordinators.

From a shell:

```bash
npm run inbox --prefix /Users/nikitarat/.pi/agent/projects-mvp
```

The inbox has saved questions with choice buttons and custom answers, terminal
worker results for review, immutable evidence previews, worker transcripts,
steering and stop controls, shared notes, and coordinator messaging. The main
conversation stays collapsed by default. A short latest-reply preview links to
it. The message box stays available while reading the inbox; `/` focuses it.
Drafts survive polling, in-flight sends and project switches within the tab. New Durable browser controls add owned thread history/follow-ups/steering, scoped approval records and separate execution/inspection, managed knowledge, a hash-pinned library with confirmed pasted imports, offline role settings, page-labelled usage, retained lifecycle actions, explicit pinned GitHub observations and retained routine views with separately confirmed toggles/event opt-in. All new controls remain unverified. Tab/origin-local draft snapshots restore no actions or confirmation inputs.

Accepting closes a review and saves an owner note. It does not commit, merge,
publish, or start another task. Legacy change requests queue one coordinator instruction. Durable answers/revisions are manual-delivery results, not automatic resume, execution approval or queued replacement work. A complete run means the process ended, not that its verification
passed. Failed and stopped runs keep their real status.

Workers attach reports and screenshots using `projects_evidence`. Copies are
limited to 10 MiB, must originate inside the assigned workspace, and have saved
SHA-256 hashes. Text, including HTML and SVG, displays as text. PNG, JPEG, and
WebP evidence can display as images. Files are associated with the worker session;
older runs without attachments still expose their report and transcript.

Questions and review decisions persist under `decisions/`. Legacy answer/change requests use fixed job IDs; Durable decision resolution retains its record without starting a legacy coordinator or inventing a delivery job.
Accepted reviews stay closed after restart. The recovery path never replays a
job that had already started.

The browser listener binds only to `127.0.0.1` on a random port. A private launch
link authenticates the tab, then the token leaves the address bar. Do not share
launch links or `web.json`. The host rejects foreign origins and Host headers.
Closing the tab does not stop work. After a host restart, run `/projects-ui`
again because the port and token change. For an owner-authorized review in a fresh disposable home only, load host-side updates after active work finishes by stopping that disposable host and reopening a project. This is not advice to stop or restart the production host.

## Use

Run `/reload` in Pi, then:

- `/projects-ui [project-id]` opens the live decision inbox.
- `/projects` browses projects or creates one, then opens the native screen.
- `/projects-desk`, `/projects-board`, `/projects-inbox` open the three native layouts.
- `/project-create <name>` creates and opens a Durable project after trusted-resource consent. Worker workspace/tools and provider execution still need separate grants.
- `/project-create-retry <UUID>` confirms an exact retained creation request from the current Pi session branch. Startup never retries it automatically.
- `/project-open <project-id>` reconnects to a coordinator.
- Plain chat goes to the selected project's coordinator instead of the local Pi agent.
- `/project-close` returns to ordinary local Pi without stopping project work.
- `/project-status` shows requests, coordinator messages, and worker IDs.
- `/project-delegate <worker|scout|reviewer> <task>` assigns a bounded task directly through the same delegate path the coordinator uses.
- `/project-workers [run-id]` lists workers or reads a transcript.
- `/project-steer <run-id> <message>` steers a worker.
- `/project-stop <run-id>` stops a worker.
- `/project-notes` reads immutable audit notes.
- `/project-host-stop` stops the local host. Durable shutdown cancels/drains its owned runtimes; uncertain cleanup remains a blocker. Legacy detached-worker behavior is separate. Use host stop/restart only in an owner-approved disposable review home; production host changes require explicit renewed permission.

Slash commands and `!` shell commands still belong to the local Pi client. Project chat currently accepts text only.

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

Historical verification entry point: `npm run e2e:knowledge`, not authorized while verification is suspended. The isolated-state E2E uses real configured
models, saves prompt evidence, kills/restarts its own host, and exercises recovery
from captured transaction fixtures. It does not restart the production host.

## CLI

```bash
cd ~/.pi/agent/projects-mvp
npm run projects -- ui
npm run projects -- ui-url <project-id> # Private launch link; do not share it.
npm run projects -- list
npm run projects -- create "My project" /absolute/workspace "Build the approved feature"
npm run projects -- send <project-id> "Implement this feature and return E2E evidence"
npm run projects -- show <project-id>
npm run projects -- delegate <project-id> scout "Inspect the authentication flow"
npm run projects -- workers <project-id> [run-id]
npm run projects -- steer <project-id> <run-id> "Additional requirement"
npm run projects -- stop <project-id> <run-id>
npm run projects -- host-stop
```

`create-once <request-uuid> <name> <workspace> [objective]` uses a stable creation identity. Repeat the exact arguments to reuse that project, without restoring/resuming or resetting settings. It cannot reconstruct native/browser requests with additional explicit model/grant fields; use their stored request instead. Ordinary `create` still chooses a fresh project UUID. This new behavior is unverified.

Scoped worker submission is explicit: CLI `submit-scoped <project-id> <scope-id> <thread-id> <request-id> <task>` or native `/project-submit-scoped <scope-id> <thread-id> <request-id> <task>` selects an existing owner-authorized scope. It grants no new tools or repository authority and uses the official Durable planner. This path is unverified.

Routine CLI controls include `schedules`/`monitors` snapshots, stable-ID one-shot/interval/daily/weekly creation, explicit event opt-in and confirmed enable/disable. They call the existing Durable backend without client timers, new grants or automatic resume. See `CLI-WIRING.md` for syntax and limits. This wiring is unverified.

Owner setup uses `projects -- owner-setup <project-id>` for current bindings and revision-checked workspace/GitHub authorization and revocation, fixed-profile operations, and skill grants. Native Pi opens it with `O`; browser clients have an Owner setup button. Writes require fresh same-project consent. Revocation retains identity history and does not remove repository data or remote objects. Repository skill selection is implemented but unverified; configured Pi skills remain unavailable without a trusted already-loaded catalog snapshot. These owner-grant controls configure authority; they do not themselves authorize a worker effect. See `CLI-WIRING.md`. This wiring is unverified.

Durable CLI controls are separate from legacy run controls: `thread-send`/`thread-steer` require project, thread and request UUIDs plus text; `thread-stop` requires matching `--confirm`; `thread-history` and `legacy-thread-history` expose message/Unicode slices. See `CLI-WIRING.md`. These additions are unverified.

CLI creation trusts the named workspace's Pi resources and creates a Durable coordinator. It grants neither other workspaces nor worker/provider execution. Explicit workspace/tool/publication grants and executable-effect approvals remain separate.

## Legacy behavior and current Durable controls

The following native-subagent behavior describes retained legacy projects, not current Durable acceptance. Durable uses the official owned Harness, persistent UUID threads, scoped workspaces and fixed command profiles. Missing workspace/tool access remains a blocker. Worker execution requires explicit grants; the coordinator does not receive a shell. `COMMANDS.md` and `GITHUB-LOCAL.md` describe unverified command/publication limits.

For Durable defaults, use confirmed `settings-update`, native `S` or browser settings rather than editing state or stopping production. Role model selection uses installed offline metadata; configured credentials do not prove connectivity or repair default transport. Existing threads retain frozen model/instruction text. `usage-snapshot`, native `U` and browser usage expose owner-backed counters; page-only worker totals and SDK estimates are not billing.

Legacy behavior follows:

The coordinator has a dedicated system prompt in `src/coordinator-prompt.ts`.
It handles ordinary requests, plans and delegates, and normally steers an
existing worker when a follow-up changes that worker's task. Its active-tool
allowlist and tool-call checks prevent direct coding, shell execution, and
alternate agent launchers. This is not an OS sandbox.

pi-goal-x integration is deferred. The project coordinator does not load the
goal lifecycle extension or expose its tools. Ordinary requests do not create
goals. `/goal` still belongs to the local Pi session, not the project host. Native asynchronous subagents deliver completion notifications to the persistent coordinator. The host supplies a notification UI, so the coordinator remains responsive rather than waiting for the headless runner's automatic drain.

Workers may edit and verify. Scouts and reviewers have read tools and shared-note tools, but no shell or file-mutation tools. Exactly one writer may enter a workspace at a time, including across projects using the same workspace. This MVP deliberately avoids Git or Arc worktree allocation; it works directly in the workspace you selected. Do not run unrelated writers there at the same time.

Default coordinator and reviewer model: `openai-codex/gpt-5.6-sol`. Worker: `openai-codex/gpt-5.6-terra`. Scout: `openai-codex/gpt-5.6-luna`. Creation through Pi uses the client's current model for the coordinator. To change stored models, stop the host, edit the project's `project.json`, then reopen it. Existing child sessions retain their resolved models.

Shared notes are immutable individual records, so concurrent agents cannot overwrite each other's notes. The latest notes enter coordinator and worker context. Verified decisions and artifact pointers should go into notes rather than relying only on conversation history.

File mutation tools reject paths outside the workspace and symlink escapes. Shell checks reject obvious publishing, VCS mutation, deployment, and destructive commands. The MVP has no approval bypass for these actions; the human performs them separately.

## Persistence and recovery

### Copy-only legacy maintenance (standalone; not production migration)

The native `/project-migration-help` command describes the supported maintenance boundary. These CLI commands never start a host and require `--no-start`; nonempty `NODE_OPTIONS` or `PI_PACKAGE_DIR` is refused:

```sh
npm run projects -- --no-start copy-root-init /absolute/new/disposable-root
# Copy only an already-authorized, inactive legacy project into the new root; never open/start it.
npm run projects -- --no-start copy-inspect /absolute/new/disposable-root <project-uuid> /absolute/workspace --confirm <project-uuid>
npm run projects -- --no-start copy-archive /absolute/new/disposable-root <project-uuid> /absolute/workspace /absolute/separate/archive --confirm <project-uuid>
npm run projects -- --no-start copy-switch /absolute/new/disposable-root <project-uuid> /absolute/workspace /absolute/separate/archive --confirm <project-uuid>
npm run projects -- --no-start copy-rollback /absolute/new/disposable-root <project-uuid> /absolute/workspace /absolute/separate/archive --confirm <project-uuid>
```

Root initialization requires a fresh absent path and creates an ownership marker. Use absolute canonical paths (no symlink aliases); the root cannot overlap the active or SDK-default production project home. Archive directory must already exist separately from the project. Exact project UUID confirmation is required. Inspection/archive reject active, interrupted or unknown work; switch/rollback refuse a live host and alter copied metadata only. These routes do not import history, start/open a copy, read original historical SQLite stores, replace original metadata, or reconcile unknown receipts. Preserve partial archives, marker temporaries and failed artifacts for inspection. Production migration is unsupported.

Durable projects keep official runtime data under their owned project state, with one Harness/storage owner. Do not open extra historical stores, edit runtime databases or remove uncertainty records to enable replay. Interruptions and uncertain effects remain inspectable; recovery requires an explicit policy. Native draft snapshots are active-Pi-branch/session state; browser drafts are tab/origin-local `sessionStorage`, not proven across closed tabs, host-port changes or crashes. Restore of either UI state submits nothing.

The legacy filesystem layout/recovery description below remains for existing legacy projects.

Default state: `~/.pi/agent/projects/`. `PI_PROJECTS_HOME` selects a separate store.

Each project has:

- `project.json`, identity, workspace, models, session pointer, and worker history.
- `sessions/`, persistent coordinator and child transcripts.
- `notes/`, shared knowledge.
- `inbox/`, accepted requests and their outcomes.
- `runs/`, archived terminal worker status and output.
- `decisions/`, durable questions, run reviews, and owner resolutions.
- `evidence/`, captured files and hash-checked metadata.
- `events.jsonl`, host lifecycle evidence.

The host uses a private Unix socket and owner-only state files. `host.log` records startup failures. Native subagent runs also use pi-subagents' retention-managed runtime storage; terminal output is copied into the project store before that runtime storage expires.

Reopening after a host restart restores the coordinator session and worker controls. Accepted requests that never started can run after recovery. Requests interrupted while running become `interrupted`; the host never automatically replays them. Inspect workers, then send a new instruction.

A writer dispatch interrupted before its receipt was saved leaves `writer-launch.json`. That blocks further writers in the workspace. Inspect `/project-workers` and native run records, stop or account for the uncertain run, then remove that marker manually. Missing native status also blocks new writers unless a terminal receipt was already archived.

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
or turn decision records into executable grants. Arc inspection remains pending.

## Security limits

Run only against trusted workspaces. Extensions execute with your account's permissions. File-tool and shell-pattern checks are operational guardrails, not confinement: shell scripts, generated programs, and ambient trusted extensions can access files or services outside the workspace. Keep production credentials away from unattended workers. SDK extension dialogs are recorded as questions and fail closed. Answer in the decision inbox or perform the approved action yourself. An answer cannot bypass publishing or destructive-command checks.

## UI choice

Decision inbox is the chosen default for the browser and new native Pi sessions.
Native Pi still offers all three layouts through `src/project-screen.ts`; they share one live project state and preserve
the coordinator draft when switching. The browser client remains in `web/`.
Trial screenshots under `artifacts/ui-prototype/` show the earlier simulated app,
not either live client.

## Verify and maintain

Verification remains suspended. Commands below are reference, not permission to run checks/E2Es, alter shared installs or restart production. Historical/frozen fixtures and evidence must remain unchanged.

```bash
cd ~/.pi/agent/projects-mvp
node scripts/link-host.mjs
npm run check
npm run e2e
npm run e2e:inbox
npm run e2e:tui
```

`link-host.mjs` links the existing global Pi installation and installed pi-subagents without installing a second SDK. With Pi 1.x it also patches the installed runner's obsolete core alias check. This does not downgrade Pi or supply a fake API. Run it after moving or reinstalling Pi, or updating pi-subagents; an upstream update can overwrite the patch. The type check requires the installed `tsc` command. Runtime requires Node 22.19 or newer with TypeScript stripping support.

All E2E commands use real configured models and incur provider usage.
`e2e:inbox` also runs isolated headless Chrome, creates a disposable live project,
exercises the browser controls, restarts the host, and saves screenshots plus
captured evidence. On non-Mac systems, set `CHROME_BIN` to a Chrome-compatible
browser executable. `e2e:tui` runs the actual Pi CLI in a pseudo-terminal and
records ANSI output, readable screen captures, durable decisions, and live worker
evidence. It installs pinned pyte dependencies only in its own artifact directory.
It defaults to Pi 1.0's fullscreen mode; set `PI_PROJECTS_E2E_TUI_MODE=regular`
to verify scrollback mode. See `TUI-VERIFY.md` for terminal failure cases.

Each run creates an isolated disposable workspace and project store under `artifacts/<timestamp>/`. `report.json`, `assertions.json`, worker inspection reports, and generated verification files are repeatable evidence. See `VERIFY.md` for the failure cases.

For an owner-authorized disposable review home only, uninstall by removing `./projects-mvp` from that review Pi package list and reloading its client; stop only that disposable host. Keep its state directory if you want to retain review history. Do not apply these instructions to production without explicit approval.
