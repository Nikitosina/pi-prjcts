# Architecture

Terms are defined in `CONTEXT.md`; owner decisions are in `docs/lean-runtime-plan.md`. This file maps modules to responsibilities and lists the rules a change must keep. It describes `src/` as of the lean-runtime branch.

## Host and projects

One detached Node process, the host, owns every project's durable storage and serves the web UI, the CLI and Telegram. Nothing else opens a project's storage.

- `src/host.ts` imports the owner's shell environment, then loads `src/host-server.ts`. The server holds a private Unix socket (`host.lock` records the pid) and one `dispatch` function for every request. `src/state.ts` defines the closed request schema (a TypeBox union of actions), project records and `home()`, which is `$PI_PROJECTS_HOME` or `~/.pi/agent/projects`.
- `src/client.ts` and `src/cli.ts` reach the host through the socket and start it on demand. `src/web.ts` serves `web/` on a random loopback port with a bearer token, rejects foreign origins and Host headers, and streams server-sent events.
- Each project is a directory `<home>/<project-id>/` with `project.json`, `durable.sqlite` and `knowledge/`; artifacts live under the project's control root. `src/durable-runtime.ts` (`openDurableProject`) opens a project's pi-durable Harness and assembles its coordinator, agents, tools and automations. `src/durable-host.ts` adapts that runtime to snapshots.
- Project records without `runtime: "durable"` come from the removed pi-subagents runtime. The host refuses them and never writes their files.

Rules:
- Take a project's lock (`withProjectLock` in `host-server.ts`) only for short local state changes. Open or replace a runtime through `withDurableOwner`, outside the lock, and never wait on a model, a provider or an abort drain while holding it.
- A request that fails validation must fail before it opens a runtime.

## Instance instructions

`src/durable-standing.ts` reads the optional `$PI_PROJECTS_HOME/AGENTS.md` (using `state.home()`, default `~/.pi/agent/projects/AGENTS.md`). It applies across projects to coordinators, workers, scouts, reviewers and verifiers, in a distinct prompt section before repository standing instructions. Repository instructions can specialize shared guidance; neither changes immutable role, tool or security contracts. Projects does not read or copy personal `~/.pi/agent/AGENTS.md`.

The file must be regular, valid UTF-8, at most 64,000 bytes and 16,000 UTF-16 code units. Missing means no extra instructions. Unreadable, invalid, oversized, symlinked or changing files fail loading with a source-path error; content is never silently truncated. The reader keeps existing home/realpath semantics.

Each conversation persists its shared-instruction snapshot separately from its frozen repository/role prompt. New agents and explicit retries of ended agents load current instructions. A running agent keeps its snapshot, including after restart and between tool rounds. Coordinators refresh on owner admission, Reload and prompt-affecting settings application. An owner follow-up queued during a coordinator turn defers the new snapshot until that turn ends; background reports otherwise use the last snapshot. Editing/removing the file needs no host restart or watcher. Saved snapshots survive reopening; the additive document does not migrate SQLite or change repository revisions, workspace authorization fingerprints or grants.

## Coordinator execution

The coordinator owns delivery and can investigate, reproduce, test and make small changes directly; delegation is optional. `coordinator-execution.ts` adapts Pi's ordinary read/edit/write/bash tools to Durable, resolving the calling chat's workspace before each invocation. It preserves errors, aborts and progress, and retains image results through the binary artifact mechanism. Browser automation uses installed shell commands or configured MCPs, not an invented built-in browser tool.

`coordinator-workspace.ts` persists one chat owner and frozen workspace intent on the project root, then reuses the existing isolation allocator. Main and additional chats own distinct persistent worktrees. The first execution selects one existing whole-repository grant; missing, revoked, ambiguous or unsupported grants give a visible blocker, never a writable owner-checkout fallback. Reuse checks preserve the current branch, detached or advanced HEAD and dirty/untracked files while verifying workspace identity and ownership. A Git Coordinator allocation's branch is its starting branch, not an execution restriction; receipt, path, repository association and ownership-lock checks still apply. Shared helpers borrow that same checked allocation; isolated workers retain their allocated-branch check. Runtime attachments close without deleting the worktree; worker cleanup retains coordinator allocations. Provider-specific chat attachments use the optional workspace provider coordinator adapter rather than a fabricated Job.

Root creation, extra chats, reopen and Reload all bind the shared execution tools. Calls resolve their own target instead of copying Main's worktree. Coordinator MCP and GitHub CLI calls use that same target. `show` projects actual selected-chat tool names and workspace state through `coordinatorAccess`; the Tools/access panel does not allocate a workspace or contact MCP servers. The historical `projects_vcs_shell` registration resolves recorded calls but is not offered to new turns.

This is trusted local execution, not confinement. Unrestricted bash can act outside the worktree and bypass tool-gateway settings. Final PR merge to main, deployment and destructive actions require explicit owner approval as behavioral rules. Integrating worker branches into the Coordinator's task branch is ordinary task work. Static scouts/reviewers do not gain execution tools. An investigation can finish with findings and evidence without a Job or PR; direct changes report their branch, files, checks and gaps. Independent Jobs retain the worker verification/Ready/Approve workflow below. Explicit task helpers use the return-to-Coordinator workflow instead.

### Task helper workspaces

The Coordinator selects `workspace: {kind: "shared"}` or `workspace: {kind: "isolated", baseCommit: "<full commit>"}` on worker spawn. The model cannot supply a cwd, chat identity, lease or provider. Omission preserves independent Jobs and existing recorded workers. Explicit task selection cannot be combined with independent branch continuation or scope/read-ref overrides.

Shared helpers borrow the spawning chat's verified allocation and prepared filesystem. They never allocate, set up, reset, release or delete it. Their process, artifact and host-lease identities remain their own. Shared selection freezes the chat/conversation/allocation identity; retry cannot retarget another workspace. A durable live-agent handoff prevents a second shared writer and new Coordinator mutation calls until the helper actually settles. The Coordinator must drain its own writes before handing off; unrestricted host-user execution is not confinement.

Isolated helpers freeze a fresh owned allocation at the explicitly chosen commit. Git's selected base is distinct from the observed owner HEAD used by allocation preflight. Provider task support is explicit; unsupported providers refuse rather than substituting their independent-worker default base. Dirty files, untracked files and dependencies are not copied. Retry preserves the frozen intent, while runtime ownership checks allow the worker's HEAD and files to advance.

A helper returns an ordinary answer and becomes `completed`, `failed` or `stopped`. Completion is a worker-reported execution handback, not independently accepted delivery. Helpers do not publish PRs, report Ready or enter Approve. The Coordinator inspects and integrates their changes, then verifies the combined task. Helpers leave further delegation to the Coordinator. Independent reviewers read committed snapshots, never a helper's mutable shared tree.

## Jobs engine

`src/jobs.ts` replaces the old planning engine, the host verification cycle and the watchdog policy. It is built on pi-durable's ownership tree: a conversation owned by a task is aborted and drained with that task.

- **State.** One document, `projects.jobs`, on the project's root conversation (`JobsState`: `jobs`, `agents`, `subagents`, `requests`, `paused`). A Job record holds small facts only: request verbatim, acceptance, status, optional task workspace choice, branch, PR, candidate sha, plan, Ready report, stop reason. Transcripts, prompts and tool output stay in the conversations.
- **Coordinator `agents` tool** (replay unsafe): `spawn`, `send`, `stop`, `status`, `wait`, `report`. `report` retrieves the full handback on demand. Roles are worker, scout and reviewer. A worker spawn creates the Job. Explicit `workspace` selects a task helper; omitted selection keeps independent delivery. There is no global worker cap.
- **Anchor and reporter.** Each spawn creates a background anchor task that owns the child conversation, and a background reporter task that prepares the agent (`host.prepare`), submits the message, waits, and posts a concise handback to the chat as a follow-up. Full reports and answers are retained as immutable non-model `projects.agent-report` entries in the worker conversation. Each notification names its report entry; `agents report {id, ref}` retrieves that exact evidence after later sends, while omitting `ref` reads current facts. Worker transcripts expose the retained reports without adding them to model context. Quota failures switch once to the owner's fallback model, otherwise wait for the stored retry time and resend.
- **Worker `job` tool** (replay safe): `plan`, `candidate`, `checkpoint`, `ready`. Independent `checkpoint` ends an unfinished stage without approval and retains its workspace for a later send. Independent `ready` sets `ready` or `ready-with-gaps` after `host.checkProof` accepts the proof references. Helpers may record a plan and local candidate, but finish by returning their answer, not Ready. **Independent worker `subagent` tool**: a foreground verifier, reviewer or scout, owned by the tool call's task. Helpers leave subdelegation to the Coordinator. Subagents get neither tool.
- **Stop and steer.** `stop` requires a reason, marks the Job `stopped`, aborts the agent's conversation with `{ background: true }` (the tree drains its subagents) and then calls `host.killProcesses`. Steer is `send` into the running conversation; sending to a finished, failed or stopped Job reopens it (a worker that never got its brief gets it first, so a send is a retry). `dismiss` (coordinator `agents` action, owner Dismiss button, `thread-dismiss`) stamps `dismissedAt` on an ended Job or scout/reviewer; records, transcripts and files stay, the lists, dots and warnings skip it, and a new message clears the mark.
- **Hung providers.** pi-durable awaits a provider stream without racing the abort, so a provider that ignores its signal (claude-bridge) would keep a stopped conversation busy forever. `model-guard.ts` wraps every dispatch in `durable-runtime.ts`: the stream ends `aborted` on a real abort and ends with a retryable "timed out" error after 10 minutes without an event; the provider's late events are dropped.
- **Failed turns.** Durable's `afterFailedRun: "continue"` advances queued follow-ups after a terminal failure without replaying the failed input. Inputs already parked by an older host's `keep` policy remain protected work; a new owner message through normal admission advances that queue.
- **Restart.** pi-durable resumes anchors and reporters once `install(registry)` has run. `recover` rebuilds workspace tools for live agents. Request ids (`requests`, `agent:<reporter>:<attempt>`, `report:<reporter>`) keep spawn, delivery and report exactly-once.
- **Host seam.** Models, prompts, workspaces, processes, leases and merging live behind `JobsHost`; `durable-runtime.ts` supplies it. The host RPCs and the `JobsSnapshot` shape are in `docs/jobs-host-data.md`.

Rules:
- Every commit that creates a task, conversation or submission must be replay safe: derive ids from the seed or request id so a retry returns the same agent.
- Do not store transcripts or tool output in the Jobs document. Do not add a state that makes a Job wait on the host (there is no `blocked`).

## Independent Job verification and review (worker-owned)

The worker commits, pushes a draft PR, records the candidate with `job candidate`, then spawns a fresh verifier on that sha. It repairs and repeats up to `verification.rounds` (project setting, default 3). It runs one review before `ready`, and at most one re-check. Without a verify skill the worker self-verifies and says so in the Ready report. Prompts are in `src/role-prompts.ts` (see `docs/role-prompts.md`); the workflow lives in tool descriptions and these prompts once.

- `src/proof.ts` runs a command for a Job and saves its log under the Job's artifacts, tied to the commit it ran on (`projects_verify_run`). `checkProofRefs` rejects a Ready report whose `r<n>` or `run:r<n>` references name missing runs, runs on another commit, or runs that did not exit 0.

Rules:
- The host never runs a verification cycle or blocks a worker on its result. It only checks proof references.
- The candidate is a commit sha. Do not add worktree hashing or drift tracking.

## Stall detector

`stallTick` in `jobs.ts`, called every 30 s per project from `durable-runtime.ts` (`PI_PROJECTS_STALL_TICK_MS`). For each running Job it follows the active leaf of the ownership tree and flags no new entry or live tool output for `stallMinutes` (default 20), or the same tool call with the same result five times. Background silence alone does not flag a progressing agent. A worker waiting on an active verifier is judged by the verifier. It posts one notice with the last three steps to the Job's chat per stall and sets `stalledAt` until progress resumes; sending instructions alone does not reset the notice.

Rule: the detector only notifies. It never steers, stops or restarts an agent.

## Settings application

`src/settings-application.ts` is the single place that decides how a changed setting reaches a running project. `EFFECTS` maps every settings field to `saved` (read when used), `models` or `context` (pushed into the live owner) or `prompts` (coordinator chats rebuilt from the saved project). Validation lives in `src/project-settings.ts` and `src/project-models.ts`. Command profiles bind when the owner opens, so changing one reopens the project once it is idle.

Rules:
- A new settings field needs an `EFFECTS` entry (the type forces it) and must not need a host restart.
- A new send to an ended agent adopts the current role model and instance instructions without replacing its frozen repository/role prompt. Steering a running agent keeps its model.
- Validate against the live catalog before saving; a refusal leaves the settings untouched.

## Result acceptance (Approve)

`src/result-acceptance.ts`: `createApprover` merges the Job's candidate sha, then pulls the main checkout when it is clean and on the default branch. Outcomes: `accepted`, `merged-pull-skipped` (with a reason), `merge-uncertain`, `auto-merge-pending`. When the PR is mergeable now it merges; when it is blocked on checks or review it waits and polls. GitHub waits locally and uses the direct merge API with a head match, never server auto-merge or queue admission. Plugins may arm a head-pinned auto-merge. The provider comes from the checkout kind: `githubMergeProvider()` for GitHub, otherwise the plugin's `merge` capability (`plugins.mergeProvider`). The web action `job-approve`, the Telegram Approve button and `Jobs.approve` share this path; on `accepted` or `merged-pull-skipped` the Job becomes `approved`.

Rules:
- Write the intent to the acceptance log (`<project>/acceptance/<job>.json`) before calling `merge`. After a call that throws, read the PR before deciding; never retry blind.
- Merge only the approved head. A PR head that differs from the Job's candidate refuses.

## Deploy

`src/deploy.ts`, CLI `deploy` asks the host (`deploy-start`), which queues it while any project has work running; the host's own detached child (`PI_PROJECTS_DEPLOY_CHILD=1`) is the only direct caller. Records the running sha, runs `npm ci` when the lockfile changed, runs `npm run check`, stops the host, starts it from the checkout and runs a smoke test (health, every active project opens, Telegram polling when paired, web page loads). A failure after the stop checks out the recorded sha, restarts, and tells the owner through Telegram. Host-level notices carry the label "Pi Projects host · Deploy". A Job run cut short by a restart (the delivery settles under another boot id) is resent a "continue" note, not failed; a failed worker has no notice of its own, the coordinator's settled answer explains it. `idleDeployTick` runs the same deploy once per day inside a time window (default 02:00 to 07:00) when new code is waiting and no Job is running. State is `deploy.json` and `deploy.lock` in the home.

Opening a project with Pi Durable 1.4.0 automatically migrates its SQLite storage to schema 2. Durable <=1.3.0 cannot reopen it. Both owner and idle deployment refuse to cross this boundary before preparation or shutdown, using the pinned lockfiles to compare schema generations. Unknown dependency metadata also refuses. For a manual upgrade across it, stop admission, stop the host and take a consistent backup of the project home, including SQLite sidecars. Do not rely on the deployer's code-only rollback after smoke tests have opened projects: restoring older code also requires restoring that backup and loses post-upgrade writes. Otherwise roll forward with Durable >=1.4.0. Never open the old-host archive through Durable; its reader stays read-only and does not migrate it.

Rule: a failed preparation must leave the running host untouched. Guarded shutdown closes admission, drains admitted requests and checks idleness again; work that arrived during preparation requeues the deploy. A paused Job keeps its resumable identity, but only becomes deployment-idle once every Harness task and submission has drained; approvals also protect deployment. Unpaused unfinished agents and queued inputs remain busy even without a placed coordinator input. Every external effect goes through `DeployDeps` so tests drive a temporary checkout.

## Reads: transcripts, binary results, archive

- `src/transcript-reader.ts` pages a conversation's entries newest first (`PAGE_ENTRIES`), with bounded previews and images by reference. A `TranscriptSource` supplies entries, either live (`storageSource`) or from an archive file. Owner and internal inputs carry native entry kinds, exposed as message `origin`. Coordinator reads attribute older inputs by exact matches in the newest 200 submissions; unmatched legacy inputs stay unclassified.
- `src/binary-results.ts` stores bytes from MCP, simulator, upload and image results as content-addressed artifacts under `artifacts/<scope>/binary/` (25 MiB limit, mime sniffed from bytes). The transcript keeps a markdown reference and a model copy of at most 200 KiB and 1024 px per side.
- `src/archive-reader.ts` opens an old host's `durable.sqlite` read-only (`readOnly`, `query_only`) and lists its chats and worker transcripts through the transcript reader. `src/archive-host.ts` keeps the old-home path in `<home>/archive.json` (default `~/.pi/agent/projects-dev`) and a few open readers; `web/app/archive.js` browses it. Host RPCs `chat-history`, `thread-history`, `transcript-text` and `transcript-image` page live conversations the same way (`web/app/transcript.js`).

Rules:
- Never `JSON.stringify` a whole tool result or entry to build a preview. Touch only the requested page's rows.
- Never inline base64 image data in a stored transcript.
- The archive never writes: no pi-durable Storage, no migrations, no WAL files.
- Coordinators read the archive of their own project through `projects_archive_list` (chats and agent transcripts, title/task filter, paged) and `projects_archive_read` (paged history, full text by `ref`, no images). `src/archive-tools.ts` binds the project id, so there are no cross-project reads, and a missing archive answers "No archive for this project." The text is untrusted; code work continues in a new worker on the old branch or PR.

## Change feed

`src/change-feed.ts` is an in-process pub/sub keyed by project. `topicsOfCommit` classifies each pi-durable commit into topics (`chat`, `jobs`, `knowledge`, `settings`) using a map of conversation ids kept from the chats and Jobs documents, so no storage read is needed; streaming deltas are ignored. `/changes` in `src/web.ts` pushes batched topic frames and the browser refetches only the changed read model; it polls only while the stream is down.

Rules: reads (`show`, snapshots, history) have no side effects. Anything that changes a read model publishes its topic.

## Telegram

`src/telegram.ts` runs the bot (long polling, pairing, chat routing, inline buttons); `src/notify.ts` turns host notices into messages; `src/telegram-html.ts` and `src/telegram-media.ts` convert markdown and upload artifacts (`docs/telegram-media.md`). Per Job it sends one progress message with plan steps and ETA and edits it in place. There is one push per task: a Ready report is not its own notice; the coordinator's settled answer is, once nothing started from that chat (running Jobs, revived workers, scouts, reviewers) is still working, and it carries Approve when a mergeable Job of that chat is Ready (same approver as the web UI). Follow PRs events wake the chat that started the Job whose PR they concern; the Job's own opened/new-head lines wake nobody. PR notices and auto-fix reports go to that chat too. Everything not tied to a Job goes to the Settings events chat (Main if archived or gone).

Owner messages and question answers from Telegram carry `origin: "telegram"` into the existing Durable admission document before submission. Their coordinator replies notify as soon as the turn settles, even while the chat has working agents; batched inputs sharing an answer notify once. These replies do not borrow an old Ready Job's Approve button. UI-origin and unsolicited background turns keep the quiet-until-settled rule. Existing notification cursors prevent history replay.

`/models` shows the selected project's role models; `/models <query>` searches configured models. `/model <role>` offers paged buttons from the project's effective scope, with the current choice and valid inherit/reset options. An absent or unusable scope never widens to the full catalog. Picker callbacks bind project, role and settings revision, recheck scoped availability before saving and expire after success. `/model <role> <provider/model>` remains an explicit selection through the same revision-checked settings RPC. Worker, scout and reviewer accept `inherit`; verifier accepts `none` when verification is off. Changes do not restart or retry agents.

Rule: Telegram never decides. Its buttons call host actions that re-check the Job's state.

## Web feature modules

`web/index.html` loads `web/app.js`, which imports one module per feature from `web/app/`: `chat`, `decisions`, `workers`, `knowledge`, `artifacts`, `composer`, `admin`, `settings`, `observability`, `creation`, `notifications`, `search`, `limits`, `prs`. `web/app/shell.js` owns `projectId`, `view`, `busy`, the request `generation` and the dialog; it exposes getters and named setters. Features register hooks with the shell (`registerActions`, `registerForms`, `onProjectChange`, `onTab`, `onRender`, `onBusyChange`, `registerDrafts`) and talk to the host through `api` and `mutate`.

Rules:
- Features never assign shell state directly. They use the setters, and they check `getGeneration()` after every `await` before touching the page, so a late response cannot render into another project.
- Everything from a provider, a transcript or a plugin is data: escape it (`esc`) before inserting HTML.
- Coordinator chat shows owner and Coordinator messages, hiding tool diagnostics, thinking, reset handoffs and internal reports/events. Worker details and transcripts retain reports, evidence and approval for actual Ready Jobs; checkpoints never offer approval. Owner-origin text is never parsed as an internal report or event. Unclassified legacy input stays readable with a neutral label, not "You".

## Plugins

`src/plugins.ts` loads modules listed in `$PI_PROJECTS_HOME/plugins.json` or `PI_PROJECTS_PLUGINS` at host start; `src/plugin-types.ts` defines the API. A plugin provides capabilities (`vcs`, `workspace`, `prs`, `follow`, `merge`, `coordinatorTools`, `rpc`, `uncertainWrites`, `workerTools`, `leaseName`, `lifecycle`, `web`). Core ships Git and GitHub. See `PLUGINS.md`.

Rules:
- A plugin registers nothing until `register` returns, and a failing plugin is skipped and reported, never fatal.
- Core keeps a plugin's provider-owned project records verbatim when the plugin is not loaded.

## Workspaces, knowledge and other modules

- Workspaces: `workspace-types.ts`, `workspace-isolation.ts`, `workspace-capabilities.ts`, `durable-workspace-binding.ts` (per-agent worktree, tools and shell guard), `worktree-maintenance.ts`, `resource-leases.ts`. Only the workspace grant gives a worker repository access. A grant whose approved root is the old host's worktree folder allocates under this host's project folder instead (the stored grant is unchanged, since the root is part of its fingerprint). A continued branch held by an old-host worktree is taken over only if that worktree is under the archive home, idle, clean and fully pushed; otherwise the block names the path and reason.
- Knowledge: `knowledge.ts`, `knowledge-search.ts`, `knowledge-types.ts`. Markdown under `knowledge/` is the source of truth; a revision is required to write. Preferences, runbooks and decisions only.
- MCP: `mcp-servers.ts` owns lazy connections and `mcp-profiles.ts` gates servers/writes by role. HTTP connections without an Authorization header reuse Pi's named-server OAuth credentials and refresh locks. `mcp-sign-in.ts` pins private credential/refresh helpers to the locally installed Pi SDK 1.4.0; an SDK upgrade must check this adapter. Projects never launches browser sign-in; missing/rejected grants direct the owner to `pi mcp login <server>`. Static Authorization and stdio behavior are unchanged, and OAuth/server error bodies never reach callers.
- Skills: `skill-profiles.ts`, `coordinator-skills.ts` (`projects_skill_file` reads a skill body on demand for the roles that have it). Skills are discovered fresh from disk on each catalog request.
- GitHub and Follow PRs: `github-*.ts`, `pr-monitor.ts`, `durable-follow.ts`, `coordinator-gh.ts`. Approve is the independent Job PR merge path. Coordinator task-branch integration is ordinary work; final direct PR merge still requires owner approval.
- Remote access: `remote.ts`, `relay/`, `REMOTE_SPEC.md`.
