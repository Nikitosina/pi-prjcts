# Pi Durable runtime migration

Approved runtime: official `@earendil-works/pi-durable`, pinned to **1.0.0**. Feature parity, provider permissions, local-only execution and data-preservation requirements remain in `PARITY.md`.

The new `schedule-history` owner API samples at most 100 retained events/intents per page, with Unicode excerpts capped at 4,000 characters per text/outcome field. Range metadata carries full-text UTF-8 SHA-256 and continuation offsets; native event/request/submission identities are preserved. Pages are live samples, not an immutable cross-page snapshot. `schedule-snapshot` can omit history arrays and return their counts; its default response remains unchanged. Monitor policy reads use this history-free option. This bounds response text, not loading of the underlying SDK document or schedule-definition count. No read creates work or replays intents. This change is unverified; no snapshots, history requests, model/provider calls or tests ran.

## Worker dispatch and results

Durable projects use the host's dispatcher on `pi-durable`, independently of the interactive subagent manager. The legacy runtime has been removed entirely; see "Legacy runtime removed" below. Independent threads can run concurrently up to `workerCap`, which defaults to 1 and can be changed in Settings while work is idle.

The coordinator chooses `worker`, `scout`, or `reviewer`. Roles select configured models/instructions. Every role still needs an owner-authorized scope and receives only that scope's tools. Existing threads keep their frozen role/model.

Each new attempt settles independently and sends its bounded answer or failure to the coordinator. A slow sibling does not hold its slot or report. Reports use persisted request IDs; pause defers them, resume retries aborted reports, and restart does not replay completed reports. Reports are untrusted worker text, not verification evidence. Terminal work from before this feature is not replayed automatically.

The browser shows tool states in gray/green/red. Worker conversations reuse coordinator chat formatting, open on the latest page, refresh without replacing the composer, and retain older pages and confirmed steering/stop controls.

Local fake-model E2Es:
- `env -u PI_PACKAGE_DIR node scripts/durable-worker-report-e2e.mjs`
- `env -u PI_PACKAGE_DIR node scripts/worker-chat-ui-e2e.mjs`

Artifacts retain JSON results, host logs, and browser screenshots under `artifacts/durable-worker-report-*` and `artifacts/worker-chat-ui-*`. These checks do not verify real-model behavior.

## Coordinator worker management

Durable coordinators receive four worker-management tools on startup, including retained pre-feature conversations. Workers do not receive these tools.

- `projects_workers`: paged work/thread status, roles, model, scope, dependencies, priority, pause/drain and report state.
- `projects_worker_read`: paged conversation and tool activity plus recent generation state and actual configured tool names. It does not expose hidden reasoning or arbitrary filesystem logs. Requested message count is clamped to `floor(262144 / textLimit)` rather than rejected for exceeding the combined text allowance. Responses include effective `limit` and `textLimit`, `nextOffset` for messages, and per-message `nextTextOffset`. For example, `100 × 16000` returns at most 16 items and `50 × 7000` at most 37. The same paging applies to HTTP and retained legacy history. This tool allows up to 2 MiB of serialized output so bounded JSON pages are not cut by the harness's default 32 KiB output limit.
- `projects_worker_control`: `follow_up`, `steer`, `pause`, `resume`, `stop`, `retry`, `priority`, `parallelism`.
- `projects_worker_plan`: batch admission with UUID work/thread IDs and dependency validation.

A worker pause drains that worker's tasks and preserves unfinished work. The coordinator and other workers stay active. Individual pauses survive host restart and project resume. Steering requires an unpaused worker and replaces current/queued work after draining it. Stop also cancels individually paused work. Retry creates a new work item on the frozen thread and retains terminal history. Stable request IDs deduplicate follow-up, steering and retry; conflicting reuse fails.

Higher priorities run first; equal priorities retain admission order. The live parallelism cap is 1–32, persisted in Durable planning. Lowering it lets active work finish. It may differ from the owner-configured Settings cap. Changing that owner-configured cap resets the live cap when the runtime reopens.

Tools accept only this project's IDs. No control grants workspace access, changes a frozen thread role/model/scope, approves publication, or turns worker output into verified evidence. Select another role with a new delegation. Project pause still blocks admission and model dispatch.

Run `env -u PI_PACKAGE_DIR node scripts/coordinator-worker-control-e2e.mjs` for the isolated host/fake-model E2E. Failure inventory is `scripts/coordinator-worker-control-failures.md`. Retained artifacts are `artifacts/coordinator-worker-control-*/result.json` and `host.log`.

## Routine dictionary-key failure cases recorded before implementation

- A caller-chosen `__proto__` schedule/event ID invokes an inherited setter instead of storing an own record.
- An admitted schedule/event disappears from snapshots or cannot be found for an exact retry.
- Rejecting or renaming unusual IDs breaks retained identities rather than fixing the write mechanism.

Schedule/event insertion now replaces the dictionary with an object-spread copy containing a computed own key. It does not invoke the inherited `__proto__` setter or change retained IDs. Existing reads still use own-property lookup. This is unverified; no routine admissions, SDK calls or tests ran.

## Routine-history paging failure cases recorded before implementation

- UI snapshot requests return the whole retained event/intent text log.
- Pagination rewrites history or invents SDK submission identities.
- Unicode excerpts lose continuation metadata or disguise truncation as full text.
- Historical outcomes exceed the page text budget or appear as current execution proof.
- New snapshot options change the existing full-snapshot response by default.

## CLI routine-control failure cases recorded before implementation

- CLI retries invent a new schedule/monitor identity or replace explicit start time with the current clock.
- Ambiguous or unsafe numeric arguments alter recurrence, repository identity or PR number.
- Polling/event opt-in is silently enabled while creating a monitor.
- Arming/disabling routines targets a different project than the explicit confirmation.
- CLI starts its own timer/polling loop instead of submitting to the owned Durable runtime.

## Selected-repository standing failure cases recorded before implementation

- A scope for repository B receives only repository A's standing instructions.
- Resource loading accidentally includes knowledge topics or silently adds tools/skills authority.
- Continuation appends new standing text to an already configured conversation.
- Changed selected-repository resources retain the same workspace binding or permit a tool effect.
- Same-primary-repository bindings change gratuitously, invalidating otherwise unchanged frozen threads.

## Standing-resource loading failure cases recorded before implementation

- Reading an entire file before slicing defeats the resource limit.
- Silent truncation drops repository safety instructions or splits UTF-16 surrogate pairs.
- Invalid UTF-8 becomes replacement characters in the frozen instructions.
- A symlinked `.pi` parent escapes the repository despite a regular final file.
- Dangling symlinks are treated as missing; directories/devices/FIFOs are read as instructions.
- Replacement or detected modification during reading changes the resource behind its frozen revision.
- A close failure hides the original read failure.

## Worker capability-description failure cases recorded before implementation

- Coordinator instructions claim workers cannot execute even when a frozen workspace binding offers fixed command profiles.
- Worker instructions reserve all commits/pushes for humans despite explicit owner-enabled fixed profiles.
- Prompt changes imply that configuration alone grants tools or executable approval.

Scoped first configuration now builds worker instruction text from the selected repository's bounded standing resources, rather than another repository's text. Project objectives/worker policy still apply. Nonempty additional-repository resources enter the workspace binding digest. Tool hooks recheck the pinned selected root/text and block changed or unavailable resources. This loads only the named standing resources, never the knowledge tree, and adds no tools or grants. Existing configured instruction text is not rewritten; incompatible additional-repository bindings block instead of silently adopting new text. Same-primary and empty additional-repository binding digests retain their previous shape. A legacy configured thread with incorrect standing text needs an explicitly new thread, not an implicit repair. This change is unverified; no allocations, workers, models or tests ran.

Standing resources now read at most 64,001 bytes per file and reject files above 64,000 bytes or 16,000 UTF-16 code units instead of truncating. The loader rejects invalid UTF-8, dangling/final symlinks, a symlinked `.pi` parent and nonregular resources. It uses a captured no-follow/nonblocking descriptor, checks file/directory identity and sampled file metadata, and preserves read plus cleanup failures. These checks do not establish a race-free filesystem snapshot. Valid unchanged text retains the existing revision formula and BOM handling. This change is unverified; no standing reads, workers or tests ran.

Coordinator/new-worker instruction text now describes frozen workspace tools and owner-enabled fixed profiles instead of claiming all worker execution is unavailable. It still requires actual offered tools, provider/workspace bindings and separate executable approvals. It leaves provider plugin execution deferred and does not change grants or execution checks. Existing frozen worker instruction text is not rewritten. This change is unverified; no workers or models ran.

## Current scope

The isolated foundation prototype uses the installed Pi 1.0 `ModelRuntime` directly for provider configuration and credential handling. It does not create a coding-agent session, start global extensions/MCP servers, or install another coding SDK. Durable, Pi and the shared pi-ai/chord/typebox packages resolve to the same host libraries. `npm run setup` (or `npm run link:durable` after `link-host.mjs`) fetches the pinned official package and unpdf, verifies each archive against a pinned sha512 and links those libraries. Any installed Pi 1.x that satisfies Durable's declared ranges is accepted (Pi 1.1.0 at the time of writing); `scripts/setup-e2e.mjs` checks a fresh checkout, idempotency and the refusals. Registry receipts remain in `.dependencies/durable/1.0.0/receipt.json`.

`src/durable-workers.ts` follows Durable's background-worker pattern: a persistent child conversation, a background ownership anchor, and durable reporter tasks. Submission IDs prevent duplicate delivery. The worker registry records reported answer IDs so two steered submissions answered together do not duplicate the report. There is no independent scheduler: Durable runs the tasks and owns their checkpoints.

## Foundation guards

The disposable foundation prototype (`scripts/durable-fixture.ts`, `durable-foundation-e2e.mjs`) was a real-model check of the Durable library itself, not of this product; it is deleted. What it proved is covered by the E2Es below (ownership, dedup, restart, index-only context, mutation denial, memory repair).

A throwing memory section alone did not stop generation: Durable reported its error and continued with prior prompt state. The dispatch guard now checks `memoryIndex()` immediately before `ModelRuntime.streamSimple`; the E2E verifies no dispatch occurs for the oversized index. Do not use a reported hook/section error as an authorization gate. The adapter E2E (`scripts/durable-runtime-e2e.mjs`) checks that no dispatch happens for the oversized index.

## Integrated adapter and host

Every project carries `runtime: "durable"`; records without it are refused ("Legacy runtime removed"). The host admits UUID-keyed messages into Durable without waiting for a model and restores those submissions after restart. Its job files are admission receipts and UI projections, not a separate execution scheduler. Completed admission IDs live in a Durable document because `Harness.inspect()` lists active submissions only.

Verified on the offline fake model (`scripts/fake-model.mjs`; see "Offline legacy scripts" below):
- `scripts/durable-runtime-e2e.mjs` (13 checks): storage ownership, idempotent admission, restart, UUID worker reading a topic on demand, coordinator notes allowed but read-only worker notes denied, oversized memory blocking dispatch, repair, unsafe-storage rejection.
- `scripts/durable-host-e2e.mjs` (5 checks): nonblocking admission, snapshot format, host restart, no duplicate completed work.

Repeat with `npm run e2e:durable-runtime` and `npm run e2e:durable-host`. Failed runs remain in `artifacts/`.

## Durable knowledge

`scripts/durable-knowledge-e2e.mjs` passes 20 fake-model/filesystem checks (`scripts/durable-knowledge-e2e.mjs`). It captures each conversation's first prepared request, proves index-only context and on-demand coordinator/worker topic reads, verifies exactly 3,000 astral Unicode code points, rejects oversized manual indexes, observes human edits, preserves original note bytes and history, checks scoped CAS writes, and verifies separate-process SQLite contention/SIGKILL release.

Repeat: `npm run e2e:durable-knowledge`. Creation supports explicit `knowledgeAccess: "maintain"`; absent or `"read-only"` grants workers no knowledge mutation tools. The coordinator always receives `projects_knowledge_write`/`projects_note` regardless of this setting, and retained coordinators gain them on reopen. Verified by `scripts/coordinator-knowledge-write-e2e.mjs` (fake model; failures in `scripts/coordinator-knowledge-write-failures.md`). This permission does not grant shell, repository or publishing access. Human document APIs keep revision checks. Model read tools paginate text/history/notes; standing instructions remain outside learned topic files. The optional typed request observer is for private verification and is not a dispatch or authorization gate.

Integration remains partial. Durable worker controls/public UUID projections, approvals, executable workspace tools and usage views are not wired into the current host/UI. Production state and host remain untouched.

## Durable planning thread evidence

`scripts/durable-threads-e2e.mjs` is an offline planning verification (fake model with three model ids and held replies so streams overlap). It records opaque aggregate ModelRuntime stream traces (not public Durable IDs), worker-only peak 2 at cap 2, coordinator preparation with two worker streams and aggregate peak 3, configured worker/scout/reviewer model refs, frozen standing/profile/tool bindings, local MCP use, dependency failure blocking, usage deltas, SDK child-conversation reuse across follow-up/reopen, and pause with no unsafe-effect replay (the requeued attempt after resume is a fresh model turn; the fake does not repeat the call). Behaviour that changed since the original version: a reopen adopts the configured worker cap (parallelism is adjustable), `attempt.toolNames` lists the full tool set, and a reopened plan is paused until `resumePlan()`. Repeat with `node scripts/durable-threads-e2e.mjs`.

The report does not establish full parity, production migration safety, provider lifecycle/thread-ID correlation, or broad standing-resource discovery.

## Legacy runtime removed

The pi-subagents era runtime is gone: legacy coordinator prompt/worker policy (`coordinator-prompt.ts`, `worker-policy.ts`, `knowledge-tools.ts`), copy-only maintenance/migration/switch (`copy-only-maintenance.ts`, `durable-migration.ts`, `durable-switch.ts`), RPC actions `delegate`/`workers`/`control`/`review`, CLI `delegate`/`workers`/`steer`/`stop`/`copy-*`, native `/project-delegate` and `/project-migration-help`, review/run items in the native and browser clients, the `activeRuns`/`runStates` snapshot fields, and the legacy E2Es (`e2e`, `e2e:inbox`, `e2e:tui`, `e2e:knowledge`, `e2e:durable-migration`, `e2e:durable-switch`). `src/coordinator.ts` is now `src/project-resources.ts` (only `loadProjectResourceLoader`). Native `/project-steer`/`/project-stop` now take Durable thread IDs (`thread-steer`/`thread-stop`); `/project-workers` lists Durable work.

- **Refuse, not adopt.** `loadProject` throws `LegacyProjectError` for any `project.json` without `runtime: "durable"`: "Project "<name>" (<id>) uses the removed legacy runtime and cannot be opened. Only Durable projects are supported; its files in <dir> are left untouched." `list` skips such records, the host logs `{"event":"legacy-project-refused"}` once per record at start, and the browser shows the message and opens a listed project when the URL names one. Nothing is written to the record. Adopting was rejected: legacy records carry `runs`, a pi `sessionFile`, review decisions and `writer-launch.json`, which a fresh Durable coordinator would silently ignore.
- Kept: `sessionFile`/`runs` stay in the schema as optional retired fields (the owner's live project has `sessionFile: null, runs: []`); old `review` decision files are skipped by the inbox; Durable-era compatibility (`projects.legacy-worker-recovery`, `legacy-thread-history`, legacy usage rows, the monitor guard, notes import into `research/legacy/`) is for older Durable stores, not the removed runtime.
- Kept: `PI_SUBAGENT*` scrubbing when spawning the host, because the host loads global extensions and the owner's pi-subagent-manager reads `PI_SUBAGENT_EXTRA_AGENT_DIRS`.
- `skills-scale-chats` F19 (started the 95817c3 host) is dropped. No TUI pseudo-terminal E2E remains.
- Known `npm run check` error (terminal UI removed; the setup-screen one is gone): `src/workspace-capabilities.ts(169,21)`.

E2E: `env -u PI_PACKAGE_DIR node scripts/legacy-removal-e2e.mjs` (`npm run e2e:legacy-removal`; failure cases `scripts/legacy-removal-failures.md`). A legacy record next to a Durable project: list/host start/restart unaffected, five id actions refused with the message, refusal logged once, removed RPCs rejected by the schema, removed CLI commands print usage, stale review file ignored, record byte-identical; in the browser a message, a delegated worker with its report, and a question answer all work, and a legacy URL shows the refusal banner. Passed 25 checks: `artifacts/legacy-removal-2026-10-08T15-24-52.923Z/`. The full fake-model regression list passed sequentially afterwards (watchdog needed one rerun: a resume-then-restart race once denied a message with "Project plan is paused").

## Runtime rules

- Freeze provider, working directory, model and allowed tool scope for each admitted attempt. Project defaults affect new work, not already-authorized calls.
- Safe reads may replay. Mutations and uncertain external writes stay unsafe unless an explicit idempotency/effect-check protocol proves otherwise.
- An approval binds to its operation, provider/repository, arguments and relevant revision. A stored Boolean alone is not authority for changed work.
- Normal coordinator cancellation may leave background workers alive. Project pause must cross background ownership and stop new work and timers.
- Keep standing instructions and applicable skills separate from the bounded memory index. Load topics only on demand. Missing required tools/MCP access must be visible, never substituted silently.
- Pin experimental dependencies. Re-run recovery and migration verification before upgrading them.

## Coordinator stability

Model streams use a 300 s idle timeout and up to 3 Durable-checkpointed retries for retryable provider/transport errors (previously 60 s and none, which failed long-reasoning coordinator turns with `WebSocket idle timeout`). Retries resend only the failed model request; executed tool calls are not repeated. Failed turns keep the provider error text in `job.error`/`project.problem`; only the newest settled turn sets attention, so a later success clears it. The browser shows a Retry button per failed turn and a context-fill ring beside Send (newest usage plus estimates of later messages, over the coordinator model's context window).

Verified by `scripts/coordinator-stability-e2e.mjs` (fake model and headless Chrome; failures in `scripts/coordinator-stability-failures.md`). The 300 s value itself is not exercised: the fake model uses HTTP completions, not the Codex WebSocket path.

## Live coordinator stream

`GET /live?project=<id>` (bearer token, same as `/api`) is a server-sent event stream built on Durable `viewState()`. Each frame is a compact projection of `pi.live`: running flag, attempt, tail of the partial answer (max 4,000 chars), thinking flag and the tail of the reasoning summary (max 300 chars), running tools, retry error and time, compaction, and transcript length. Durable commits partials at most every 100 ms; identical frames are dropped. The browser reads it with `fetch` (EventSource cannot send the token), shows a live bubble above the composer, refreshes the snapshot when the transcript length or running state changes (waiting for a refresh that actually ran before moving the bubble on, so a committed step never blinks out), drops the stream on project switch and reconnects with backoff (1–15 s). The runtime ends every open stream on close.

The rail Knowledge card and the Knowledge tab show documents as a folder tree (see Browser UI polish); the browser fetches `knowledge-list` on each refresh.

Verified by `scripts/coordinator-live-e2e.mjs`; failures in `scripts/coordinator-live-failures.md`.

## Scout and reviewer code access

Scout and reviewer threads always get `code_read`, `code_grep`, `code_find` and `code_ls` (`src/durable-code-tools.ts`). Their root is per thread: a PR-head snapshot or the parent worker's worktree (see "Worktree lifecycle" below), otherwise the project checkout. The tools are read-only, and paths outside the root are refused, including `..`, absolute paths, `~` and symlinks that escape it. These roles never get write, edit, bash or publication tools; a `workspaceScopeId` passed for them is ignored (the receipt says so); use role `worker` for scoped write access. Worker tools are unchanged. Threads created before this change keep their frozen tool set.

## Archiving work

Running, queued, interrupted and blocked work shows in the Workers card. Completed, failed and stopped work moves to Recent results until archived. The coordinator archives with `projects_worker_archive` (`workIds` or `terminal: true`), and the owner archives from the Activity tab. Archive sets `archivedAt` only: the work record, thread conversation and report are kept, and `projects_workers`/`plan-snapshot` report `archived: true`. Running, queued, interrupted and unknown work is refused. Activity hides archived work unless "Show archived" is on.

The live coordinator bubble streams inside the transcript scroll (`#transcript`) and follows the bottom only while the reader is there. Scrolling up pauses following until the reader scrolls back down or sends a message.

Verified by `scripts/coordinator-workers-ui-e2e.mjs`; failures in `scripts/coordinator-workers-ui-failures.md`.

## Delegation defaults and answers

New projects default to `decisionAccess: "coordinator"`, so the coordinator can ask with `projects_question`. Existing projects with no stored value keep `none`, and an explicit `none` removes the tool. Answering a question records it and then sends `Owner answered your question "<title>": <answer>` to the coordinator, which continues its turn. Delivery is best effort: on a paused or archived project the answer is still recorded, and the failed delivery is logged as a host event. Answers grant no extra permissions.

`projects_delegate` with role `worker`, no `workspaceScopeId` and no `requiredTools` uses the project's only whole-repository scope when exactly one exists. With several scopes or a folder-limited scope, the choice stays explicit. Scout and reviewer are unaffected. The admission receipt now includes `workspaceScopeId`, so the coordinator sees which scope it got.

Verified by `scripts/delegate-defaults-e2e.mjs`; failures in `scripts/delegate-defaults-failures.md`. The cases with multiple scopes and a folder-limited scope are covered by code inspection only.

## Coordinator GitHub tools

When the project has a GitHub authorization, the coordinator gets three tools (`src/coordinator-github-tools.ts`). It no longer has to delegate a worker to read an issue:
- `projects_github_issue_read`: an issue or PR with body, labels, assignees, milestone and comments (50 per page). A PR adds its branches, draft/merged state and diff size.
- `projects_github_issues`: list or search issues and PRs. Search is always scoped with `repo:<authorized repo>`.
- `projects_github_issue_write`: create, comment (issue or PR), update title/body/labels/assignees/milestone, close (completed or not planned, optional comment), reopen. It returns the URL.

Rules:
- The owner chose that the existing GitHub authorization covers these writes; there is no per-write approval. Nothing merges, deletes or touches code; branches, commits and PRs stay with workers.
- Every call re-reads the project: the repository must be in a current grant (owner matches, workspace revision unchanged). `repository` is optional when exactly one is authorized. Writes first check that the repository still has the authorized numeric id.
- The tools are offered only while an authorization exists; the extension is installed always so recorded calls still resolve.
- Errors keep gh's one-line reason (for example `Not Found (HTTP 404)`), with tokens redacted.
- Writes are `replay: "unsafe"`: an interrupted call is reported, never rerun. The description tells the coordinator to search before retrying.

## Owner skills (`/` in the composer)

- Typing `/` at the start of the coordinator composer opens a skill picker. It lists every skill pi loads for the project: repository `.agents/skills`/`.pi/skills` first, then the owner's, then pi packages, including skills with `disable-model-invocation`. There is no 64-skill cap; the owner has 89. Picking inserts `/skill:<name> `. Filtering ranks by name, then description; ↑/↓, Enter/Tab and Esc work, and Enter picks rather than sends. A `/` after other text never opens it, and the global `/` shortcut still just focuses the composer.
- On send the host expands `/skill:<name> args` exactly like pi: `<skill name location>` block, frontmatter stripped, then the args (`src/coordinator-skills.ts`). An unknown name is refused and the draft kept. The job keeps the typed text. The transcript shows the user message as `/skill:<name> args`, rendered as a chip.
- `projects_skill_file` reads files inside a skill's directory (lexical and realpath checks). It is limited to the caller's role skill set (see Skill profiles); the coordinator may also read skills the owner invoked with `/skill:` (recorded in `invoked-skills.txt` in the project home).
- The admission cap is now 120000 characters for the expanded text; owner input stays capped at 32000.
- `GET coordinator-skills` returns the list.

Verified by `scripts/coordinator-github-skills-e2e.mjs` (fake model, `scripts/fake-gh.mjs` extended with issue and search endpoints, private `HOME`); failures in `scripts/coordinator-github-skills-failures.md`.

## Browser UI polish

Polished by driving the UI on a real coordinator (`openai-codex/gpt-6-luna`) against this repository.

### Layout
- The page never scrolls. Header and tabs stay fixed, and the transcript, rail, work list and thread scroll independently. Below 820 px the layout reverts to normal page flow, and the sidebar collapses to a project picker.

### Header
- The eyebrow appears only when something needs you.
- The subtitle is the project objective.
- The state chip reads Working / Idle / Paused.
- Only the relevant one of Pause and Resume is shown.

### Conversation
- Worker reports (`[Durable work …]` user messages) render as collapsible "<Role> report" cards that link to their thread. A look-alike message stays plain.
- Tool calls are one-line human labels (for example "Delegated to scout: …", "Edited web/styles.css"); the raw call is available on expand.
- Messages from today show the time only.
- Markdown keeps numbered lists together across blank lines, and colours `diff` code blocks.

### Composer
- `/` opens the skill picker (see Owner skills).
- The textarea auto-grows.
- The hint shows the model.
- The context ring shows a percentage.

### Rail
- The Needs-you card is hidden when nothing is pending. When something is, the question appears once, with neutral choices.
- Workers shows only active work, with "View all work (n)" linking to Activity.
- Order: Needs you, Workers, Knowledge, Recent results.
- Recent results lists finished work and opens its thread.
- The Knowledge card is a compact folder tree of topic documents; it hides the starter files and `research/legacy/`.

### Activity
Master-detail layout: the work list on the left, with the selected row marked; the thread pane on the right. The thread pane shows:
- a header with status, role, model and the task, which expands on click
- the transcript
- the follow-up composer
- evidence, changes and steer/stop controls in a collapsible section

### Knowledge
- Documents form a folder tree: folders first with counts and a collapse chevron, then files (MEMORY.md and preferences.md first, then newest). Rows show author, relative time and size. `research/legacy/` starts collapsed; collapsed folders stay collapsed across refreshes and are shared with the rail.
- Documents render as markdown, with plain Edit and History.

### Copy and confirmations
- Typed project-UUID confirmations are removed from every dialog, at the owner's request. Forms send the project ID as a hidden field, so the host contracts are unchanged.
- Legalistic copy in create, knowledge and workspace texts is shortened.

### Live chain
- The host returns the last 30 conversational messages plus every tool row between them (cap 400 rows), dropping empty assistant rows, so a long tool chain never hides the turn that started it. It used to be the last 30 rows of any kind.
- Assistant steps carry their reasoning summary (`thinking`, max 300 chars). The transcript shows it as a quiet "Thought" line, so models that think instead of writing preamble text (`gpt-5.6-sol`) still leave a trace of each step.
- The live bubble always has a status line: "Thinking · <summary>", the human tool label ("Read knowledge…"), or "Writing…".
- When the owner scrolls up during a run, a pill pinned above the composer shows the same status and jumps back to the latest.

Verified by `scripts/live-chain-e2e.mjs`; failures in `scripts/live-chain-failures.md`.

Verified by `scripts/ui-polish-e2e.mjs`; failures in `scripts/ui-polish-failures.md`. Regression E2Es were updated for the deliberate changes: Workers card versus Recent results, tool-call icon colours, rail line format, one-click revoke, and the knowledge tree selectors in ui-polish and coordinator-live.

## Multiple chats per project

Each chat is its own Durable coordinator conversation. Main is the original root conversation; existing projects open with Main only and keep their transcript. Other chats are ownerless conversations listed in the root's `projects.chats` document. Each gets the root's coordinator configuration (model, instructions, tools, extensions) on creation, and again on every open if it differs, so recovery re-adds tools the same way it does for the root. Chats share knowledge, standing instructions, the one plan/worker pool, the Activity tab and the inbox.

- Coordinator-only tools (worker management, questions, GitHub, library, skill files, knowledge writes) accept Main and any chat conversation, never a worker thread.
- `projects_delegate` and `projects_worker_plan` admit into the root's plan from any chat. The work records the delegating chat (`chatConversationId`), and its report goes to that chat only. A follow-up, steer or retry reports to the chat that issued it; an owner thread follow-up keeps the thread's chat. An owner answer wakes the chat that asked the question.
- Host: `show`/`message` take an optional `chatId` (`main` or a UUID); jobs record `chatId`, and each chat has its own ledger. `chat-create` and `chat-update` (title, archived) manage the list. Main cannot be archived. An archived chat keeps its history and refuses messages until restored. A new chat is titled from its first message. `/live?project=…&chat=…` streams one chat. Project pause aborts every chat.
- UI: chat pills above the transcript (busy dot), New chat, Rename, Archive, and an Archived list with Open and Restore. The URL keeps `chat`, and drafts are kept per chat.

- Usage (`usage-snapshot`) returns `chats` (every non-Main chat, archived included) and `chatTotal`; the web usage card and usage-over-time list a row per chat (`Chat · <title>`) plus a chat count. The plan snapshot carries each work item's `chatConversationId` (null = Main), and the Observability trace has one node per chat (busy, archived, needs attention) with each worker thread under the chat that delegated its latest work. Health "Coordinator" is busy when any chat is.
- Attention is per project, not per viewed chat: `show` also settles the unsettled jobs of other chats (`chatSubmissions`), flags each chat whose newest settled turn failed (`chats[].attention`, red pill dot), and sets `project.problem` to the viewed chat's error or else `Chat "<title>": <error>` with an Open chat button. A later success in that chat clears it.
- Projects written before multi-chat (95817c3: no `projects.chats` doc, jobs without `chatId`) open with Main only and keep their transcript and ledger. At 390px the chat bar stays inside the viewport; the pill list scrolls horizontally.

Verified by `scripts/multi-chat-e2e.mjs` (fake model and headless Chrome, private HOME, with a host restart); failures are listed in `scripts/multi-chat-failures.md`.

## Owner worker-skills catalog scale

The owner catalog (repository + configured skills) holds up to 512 candidates, 1024 diagnostics and 16 MiB of captured main documents (`SKILL_CATALOG_LIMITS` in `src/worker-skill-types.ts`), instead of throwing above 64. `worker-skills-catalog` pages it (offset ≤ 512, limit ≤ 64); the revision is stable across pages of an unchanged catalog. The worker-skill grant model (grant dialog, `worker-skills-grant*` RPCs, `owner-skill-grant`/`-revoke` CLI, `projects_skill_read`) is retired in favour of Skill profiles; saved `workerSkillGrants` stay in project files only to keep existing worker binding revisions stable. Repository discovery uses the same limits (4096 directory entries).

`src/github-authorization.ts` was hidden by the `*auth*` ignore rule and never committed; it is now unignored and tracked.

Verified, together with the multi-chat follow-ups above, by `scripts/skills-scale-chats-e2e.mjs` (89 configured skills, three chats with a failing one, 390px screenshot, and a project created by the 95817c3 host extracted with `git archive`); failures are listed in `scripts/skills-scale-chats-failures.md`.

## Uploads and knowledge search

Owner files are project knowledge. They live in `uploads/` of the project state directory (`src/uploads.ts`): `<id>.data` (bytes), `<id>.txt` (text), then `<id>.json` (metadata, written last, so a listed upload always has its bytes). Accepted: UTF-8 text/code/Markdown, PDF and PNG/JPEG/WebP, up to 20 MiB each. Kind comes from magic bytes, not the extension. Binary data that is not valid UTF-8 is refused. PDF text is extracted with `unpdf` 1.8.1, pinned and integrity-checked by `npm run setup` (`scripts/link-durable.mjs`). A corrupt PDF is still stored, with `extractError`. Uploading the same name and bytes again returns the existing upload. This replaces the 32 KiB pasted-reference path in the web UI. The old `library-import` API and the TUI screen are unchanged.

- Transport: `POST /upload?project=<id>` takes the raw body and an `x-filename` header (URI-encoded), behind the same bearer token and origin checks as `/api`. A declared length over 20 MiB gets 413 before the body is read. `GET /uploads/<project>/<id>` serves the bytes for the viewer. RPC: `upload-list`, `upload-read` (text page), `upload-delete`. `show` includes `uploads`.
- Search: `projects_search` runs BM25 (k1 1.2, b 0.75) over chunks of about 1200 characters from knowledge documents and upload text. It skips stop words and splits camelCase identifiers. There are no embeddings. Each hit returns a path or `uploadId`, a character offset and a snippet of at most 320 characters. Chunks are cached by revision or SHA-256, so edits and deletes show at once. `projects_upload_list` and `projects_upload_read` page upload text, and a small image is returned as image content. These are knowledge tools: Main, every chat and new worker threads (scout, reviewer and scoped workers included) get them without the library grant. Worker-captured library evidence stays behind `libraryAccess`. Reopened coordinators gain the tools through the existing knowledge-tool recovery.
- Attachments: the composer has a paperclip button and accepts dropped files. Files upload right away, show as chips, and `message` carries `attachments` (at most 10 upload IDs of this project). The coordinator receives the text plus an `[Attached files: …]` block that names each upload. An image of 5 MiB or less is also sent as image content when the coordinator model declares `input: ["image"]`. Otherwise it is a stored reference only. Jobs keep `attachments`, so a restart re-admits them. The transcript renders the block as chips that open the viewer.
- Knowledge tab: an Uploads list (kind, size, age) with Upload files and drop anywhere on the tab. A viewer shows images, and extracted text for PDF and text files, with a Delete button. Tool rows read "Searched knowledge for …" and "Read upload …".
- Also in this change: Observability health "Failed jobs" counts failed and interrupted jobs across all chats (`show.failedJobs`). "Project" reads "needs attention" when any chat's newest turn failed. The CLI `owner-skills-catalog` pages through the whole catalog (64 per page, one revision) and prints every candidate. Both are checked in `scripts/skills-scale-chats-e2e.mjs` (L1, L2).

Verified by `scripts/uploads-search-e2e.mjs`, which uses fake text and vision models, headless Chrome, a host restart and a 390px viewport. The failures it covers are listed in `scripts/uploads-search-failures.md`. A red run against 94ea815 is kept in `artifacts/uploads-search-red-*`. C7 (re-admitting a queued job with attachments after a crash) follows the same code path, but no E2E covers it.

## Events in: Follow PRs and the generic webhook

Both are owner opt-ins in Settings → Events in, stored in `automations.json` beside `project.json` (0600; `src/project-automations.ts`). Events from either go to one chat: Main by default, or the chat chosen there; an archived or unknown chosen chat falls back to Main. They use the existing event-ingest path (`scheduleRuntime.ingest`), now with a target chat (the intent records `conversationId`, and reconcile looks the submission up in that chat) and an `automation` flag that replaces the `eventOptIn` gate, because the Settings toggle is the opt-in. Uncertain provider writes still block admission, and a paused project records the event as interrupted, as before. The transcript shows these inputs as event cards ("GitHub activity", "Webhook · <type>"), not as owner messages. RPC: `automation-snapshot`, `automation-update`, `webhook-rotate`, `follow-poll`.

### Follow PRs

`src/durable-follow.ts`. When on, each authorized GitHub repository (`githubAuthorization`) is polled every 1, 5, 15 or 60 minutes (a 15 s tick checks whether a poll is due; `PI_PROJECTS_FOLLOW_TICK_MS` overrides the tick in tests), plus Check now. The host already opens every Durable project at start, so polling resumes after a restart.

- Reads (fake-gh compatible): the repository identity (numeric ID must match the grant), the newest 30 PRs (`state=all`), check runs for each open PR head until CI is terminal for that head, and reviews, issue comments and review comments when the PR's `updated_at` changed. Commit statuses (the legacy status API) are not read.
- Reported changes: opened, merged, closed, reopened, new head, CI failed (names of failing checks), CI passed, and new reviews and comments (bots marked). The first poll per repository is a silent baseline. Everything new in one poll goes out as one `github.follow` event, whose ID is a hash of the per-change IDs. The per-PR state (`projects.pr-follow` doc on the root) advances in the same commit that records the event, so a crash or a failed poll never loses or repeats a change.
- Auto-fix: when CI fails on a PR this project published (a verified `create-pr` receipt only, the same rule as auto-merge; a branch prefix alone is "not published by this project"), a fix goes out. If the receipt's worker thread still exists, it gets a follow-up; otherwise a new worker gets the repository's scope (whole-repository scope first). The worker reports to the event chat. Guards: an attempt is recorded before dispatch, at most once per head SHA. Nothing is dispatched while the previous fix for that PR is queued or running. There are at most `fixCap` attempts per PR (default 3, settable 0 to 10), and auto-fix can be turned off separately. Each failure line in the event says what happened (dispatched, still running, cap reached, not published, auto-fix off, no scope).
- Failures: a gh error leaves the state untouched, shows as the follow problem in Settings, and backs off (interval × 2^n, at most a day). A paused project does not poll. Without a GitHub authorization, polling reports a blocker.
- Settings shows the last check, the changes sent, any problem and each fix attempt with its work status.

Verified by `scripts/follow-prs-e2e.mjs` (fake model, fake gh, headless Chrome, a host restart and a 390px viewport); failures in `scripts/follow-prs-failures.md`. A red run against f8ffe5c is kept in `artifacts/follow-prs-red-*`. The follow-up-to-the-publishing-thread path has no E2E (the E2E PRs are not published by a worker), so only the new-worker path is covered.

### Generic webhook

`src/webhook.ts`: a separate loopback listener whose port is kept in `<home>/webhook.json`, so the URL survives restarts. It moves only if that port is taken. `POST /hook/<projectId>`:
- Auth: `Authorization: Bearer <secret>` or `X-Hub-Signature-256` / `X-Signature-256: sha256=<HMAC-SHA256 of the raw body>`, compared in constant time. The 64-hex secret is per project; Rotate (two clicks in Settings, or `webhook-rotate` with confirmation) replaces it at once.
- A disabled webhook and an unknown or inactive project all answer 404. Bodies over 1 MiB get 413 before buffering. More than 20 authenticated deliveries a minute per project get 429 with `Retry-After`.
- Delivery ID: `X-Event-Id`, `X-GitHub-Delivery`, `X-Request-Id` or `Idempotency-Key`, else the SHA-256 of the body. A repeat answers 200 `duplicate: true`. The same ID with a different body gets 409. Event kind is `webhook.<X-Event-Type | X-GitHub-Event | delivery>`. The body arrives as UTF-8 text (first 30,000 characters) under an "untrusted data" preamble. A new delivery gets 202.
- The browser port has no `/hook`, the webhook port has no `/api`, and the browser token is not a webhook secret.

Verified by `scripts/webhook-e2e.mjs` (fake model, headless Chrome, a host restart and a 390px viewport); failures in `scripts/webhook-failures.md`. A red run against f8ffe5c is kept in `artifacts/webhook-red-*`.

`scripts/fake-gh.mjs` now also serves PR `state`, `merged_at`, `updated_at` and `user`, `state=all` listing, check runs per commit, PR reviews, review comments and issue comments on PRs, and `failPaths` fault injection.

## Auto-merge (per-project opt-in)

Settings → Events in → Auto-merge (`automations.json` `autoMerge.enabled`; off by default, and files written before this feature read as off). It runs inside the Follow PRs poll (`src/durable-follow.ts`), so Follow PRs must be on. Otherwise merges keep the owner-approval flow (`src/github-operations.ts` is unchanged).

A PR merges only when all of these hold, re-read at merge time:
- the project published it: a verified `create-pr` receipt for that PR number (a `pi/` branch name alone is not enough);
- it is open, its head and base are in the authorized repository and the base is the grant's base branch, and the GitHub authorization is still current;
- every check run at the head completed and passed (at least one), and every required status check from branch protection passed, as a check run or as a commit status (404 = no protection);
- a reviewer thread approved that exact head SHA with `projects_review_verdict`.

Flow: when CI turns green on a published PR head with no verdict, the poll dispatches one reviewer for that head (the PR diff, up to 20,000 chars, in the task; the report goes to the event chat). `projects_review_verdict` (`src/durable-review.ts`) is offered to new reviewer threads only and refuses calls from any other thread; a verdict kicks a poll. A new push needs a new review. A draft PR is marked ready (GraphQL) only after every gate passed. The merge is `PUT …/merge` with `sha` = the reviewed head and `merge_method: squash`, so GitHub refuses it if the head moved.

Receipts (`merges` in the `projects.pr-follow` doc): `uncertain` is recorded before the call, then `merged` (merge commit) or `failed`. A 4xx is a definite failure and that head is not retried. Any other error leaves `uncertain`; the next poll reads the PR first: merged with the receipt's marker in the merge commit message → `merged`; still open → retryable failure (at most 3 attempts per head). A paused project does not poll. Each status change for a PR goes to the event chat once (merged, waiting for review, changes requested, required check missing, refused, outcome unknown); Settings lists receipts and the latest status per PR.

Also: a head whose CI failed is re-read on later polls, so a re-run that passes on the same head is reported (and can unblock a merge).

Verified by `scripts/auto-merge-e2e.mjs` (fake model, fake gh with branch protection, commit statuses, merge, GraphQL ready-for-review, a push racing the merge call and a merge that answers 502; a worker really publishes the PRs through `open_draft_pr`; host restart; 390 px). Failures are listed in `scripts/auto-merge-failures.md`; A20 is by inspection. A red run against 26aca32 is kept in `artifacts/auto-merge-red-*`.

## Nested subagents (one level)

A top-level **worker** thread gets `projects_delegate_child` (extension `projects.worker-delegation`, `src/durable-planning.ts`), whether scoped or unscoped. The coordinator, scouts, reviewers and child threads never get it, and the tool also refuses calls from them. The tool takes `{task, role}`. A child worker gets the parent's `workspaceScopeId` (its own worktree, like any thread). A scout or reviewer child gets read-only code tools. At most 2 of a parent's children may be queued or running. The tool description tells workers to delegate only genuinely independent parallel work, do small reads/checks themselves and use at most one reviewer per head. Children share the project worker pool and cap: the parent ends its turn, and the children then run.

- **Link.** `parentThreadId` is stored on the child's work items and thread record. Every later attempt on a child thread keeps it. It shows in `plan-snapshot` and in `projects_workers` (work and threads, with report `delivered to parent`).
- **Reports.** When a child settles, its result becomes a follow-up work item on the parent thread: text `[Child work <id>, …]`, with the stable requestId `child-report:<workId>:<attempt>` and the parent's chat. The coordinator never gets the child report. It gets only the parent's answer after its last child settled, in the chat that delegated the parent. A parent answer given while its children are still queued or running is held (`report` marked delivered with a `held:` requestId; `projects_workers` shows `held until children finish`). Each child report tells the parent how many children are still running. If the parent is gone or stopped, the child reports to that chat as usual.
- **Stop.** Stopping a parent stops its children's queued and running work with the same stop id (blocker "Stopped with its parent worker"). The cascade drains together.
- **UI.**
  - Activity nests children (`.work-children[data-parent] > .work.child`, "sub-agent" label) under the parent's newest row.
  - The Observability trace nests child threads (`.trace-child`) under the parent thread, not under the chat.
- **E2E.** `scripts/nested-subagents-e2e.mjs`. Failure cases are in `scripts/nested-subagents-failures.md`.

## Notifications: browser and Telegram

`src/notify.ts` keeps one host-wide notice feed in `<home>/notifications.json` (0600, newest 200, `seq` cursor). Every 3 s (`PI_PROJECTS_NOTIFY_TICK_MS`) it scans each open Durable project: unresolved inbox questions and reviews, pending operation approvals, and per chat the coordinator input submissions newer than the last one handled (`chatSubmissions(chatId, after)`). A done turn with text becomes a `result`, an unanswered turn that was not aborted becomes an `error`. Because it reads submissions and not the busy flag, a turn that starts and ends between scans is still reported. Projects that existed when the feed file was first created, and archived chats, are baselined silently, so nothing old floods out. A restart replays nothing. RPC: `notify-feed {after?}`; with no `after` it returns only the cursor.

### Browser notifications

Settings → Notifications → This browser. The toggle is off by default. Turning it on asks for Notification permission; if permission is denied it stays off and says it is blocked. The setting is kept in `localStorage` (per origin). While on, the page polls `notify-feed` every 3 s. Its first read only takes the cursor, so a reload never replays. Notices show only while `document.visibilityState === "hidden"`. They are titled `project · chat` with a 300-character body, and clicking one focuses the tab and opens that project and chat in the Coordinator tab. To keep the origin, and with it the permission and the toggle, the browser listener now reuses its previous port from `web.json` when the port is free. Opening the new `#token=` address in the same tab is a fragment change, so the page takes the new token and reloads.

### Telegram two-way

`src/telegram.ts`. There is one bot per host. The token is set in Settings and checked with `getMe` (a 401 is refused). It is stored only in `<home>/telegram.json` (0600), is never returned by `telegram-snapshot`, and is redacted from errors. `PI_PROJECTS_TELEGRAM_API` overrides the Bot API base URL; tests use a local fake.
- **Pairing.** Pair issues a 6-digit code that lasts 10 minutes. `/pair <code>` from a private chat makes that chat the owner. Five wrong codes cancel the code, group chats cannot pair, and wrong attempts get no reply. Every other chat and every button press from another user is ignored without a reply. Pairing starts the outbox at the current feed `seq`, so it does not flood the chat with history.
- **Long polling.** `getUpdates` runs with a 25 s timeout (`PI_PROJECTS_TELEGRAM_POLL_S`). The offset is persisted after each update. Failures back off from 1 s doubling to 60 s (`PI_PROJECTS_TELEGRAM_BACKOFF_MS`) or follow `retry_after`. A 401 stops polling with a visible error, and a 409 is reported. Shutdown and a token change abort the long poll.
- **Duplicates.** Every effect is idempotent, so replayed updates do nothing twice. Plain text is admitted with a `requestId` derived from the bot and update ID (the `message` RPC now takes an optional `requestId` and returns the existing job). An answer is skipped if the question is already answered, and an approval is skipped if it is no longer pending.
- **Routing.** `/projects` and `/project <name|n>`, `/chats` and `/chat <name|n|new title>` (inline buttons) pick the chat that receives plain text. `/status` shows the current target. Replying to a notice sends the text to that notice's chat; replying to a question answers it. A refused admission, for example a paused project, comes back as the error text.
- **Outbound.** The outbox sends feed notices after `sentSeq` in order. A failure stops the batch and retries with backoff. Texts are clipped under Telegram's 4096-character limit. Questions come with one button per choice; the answer goes through the `answer` RPC and wakes the chat that asked, then the buttons are removed. Approvals have Approve and Reject buttons, which apply to the exact record and fingerprint, plain consent without execution. Reviews have Accept.
- **Settings card.** Token field, bot, paired chat, current target, polling state, last problem, the pairing code with instructions, Unpair, and Remove bot (two clicks). Changing to another bot resets the pairing, offset and route.
- **RPC.** `telegram-snapshot`, `telegram-token`, `telegram-pair`, `telegram-unpair`, `telegram-remove {confirm:"remove"}`.

Also: Follow PRs clears a "Project is paused" `lastError` as soon as the project resumes, and polls on the next tick.

Verified by `scripts/browser-notify-e2e.mjs` (fake model, stubbed Notification API and visibility in headless Chrome, host restart, 390 px) and `scripts/telegram-e2e.mjs` (fake model, fake Bot API with two bots, a retained update log, fault injection, a restart with a rewound offset, 390 px). Shared harness: `scripts/notify-kit.mjs`. Failure cases are in `scripts/browser-notify-failures.md` and `scripts/telegram-failures.md`. Red runs are kept in `artifacts/browser-notify-red-*` and `artifacts/telegram-red-*`.

## Full-text search (Cmd/Ctrl+K)

One project at a time: every chat (archived ones too), every worker thread (sub-agents included), knowledge documents and upload text. Open it with the header Search button or Cmd/Ctrl+K, which works from any field, the composer included. The `/` composer shortcut is unchanged.
- **Host.** RPC `search {id, query, limit ≤ 50}` (`searchProject` in `src/knowledge-search.ts`) uses the same BM25 and tokenizer as `projects_search`. Transcripts come from `runtime.searchSources()`, which returns the text messages of each chat and thread with their `index`. That index is the position in `coordinatorMessages`, so it matches both the coordinator transcript and `thread-history` offsets. Message chunks are cached per conversation and position, and keys that are gone are dropped. Tool rows are not indexed. Hits carry their source: `chat` (chatId, chat title, archived, role, index, at), `worker` (threadId, a role and task label, child, role, index, at), `knowledge` (path, offset) or `upload` (uploadId, filename, offset). Ties go to the newer hit. A legacy project searches knowledge and uploads only (by inspection).
- **Jump.** `show` takes `focus` (a transcript index). The window then reaches back to that message: text rows from 3 rows before it, plus tool rows near it and in the normal tail. Projected messages carry `index` (`data-index` in the DOM). The UI keeps the focus across the 2 s refreshes and live frames. It highlights the message (`.search-focus`, `mark.search-mark`), opens a report or event card, and scrolls to it once. Sending a message, Jump to latest or switching chat or project returns to the normal tail.
  - A worker hit opens Activity on that thread at `index - 5`.
  - A knowledge hit opens the document with every match marked, scrolled to the match at the hit offset (`.current`).
  - An upload hit reads the text from 2,000 characters before the offset, so matches past the first 20,000 characters show too.
- **Dialog.** Search runs on input after 180 ms. A slower earlier query, a closed dialog or a project switch never overwrites the newest list. Arrow keys and Enter pick a result. Snippets are escaped and terms are marked. The dialog says when nothing matches, and why a stop-word-only query is refused. At 390 px the header shows only the icon, and rows wrap.

## Worker failures in the notice feed

`src/notify.ts` also scans the plan. Each work item that ends `failed` becomes one `error` notice ("Worker failed" or "Sub-agent failed", with role, task and blocker; `workId` and `threadId`). It goes to the chat that delegated the work (`chatConversationId`). Browser notifications and Telegram pick it up unchanged. Stopped and interrupted work is not reported. Seen keys are `work:<id>`, and a retry is a new work ID. Failed work that existed before this change, or before a project's first scan, is baselined silently (`workBaselined`), so an upgrade does not flood the feed.

Both are verified by `scripts/search-ui-e2e.mjs` (fake model and headless Chrome; 21 fill turns, an archived chat, a worker thread, a failing worker, a stopped worker, a 30 kB upload, a host restart from a pre-feature feed file, 390 px). Failures are listed in `scripts/search-ui-failures.md`. A red run is kept in `artifacts/search-ui-red-*`. `scripts/notify-kit.mjs` gained an optional `respond` hook for scripting the fake model.

## Offline schedule positive E2Es

`scripts/durable-local-schedule-positive-e2e.mjs` and `scripts/durable-local-schedule-host-positive-e2e.mjs` no longer call the owner's `openai-codex` models. `scripts/fake-model.mjs` starts a local OpenAI-completions SSE server (`fake/fake-model`, replies `X` to the last `Reply exactly X`) and points HOME, `PI_CODING_AGENT_DIR` and `PI_OFFLINE` at private dirs before the SDK loads, so no owner credentials are reachable; the spawned hosts inherit that. `create` still stores the built-in codex role defaults, so both scripts pin every role to the fake model with `settings-update` before any request, and finally assert every model request went to the fake (`fakeModelRequests` in `report.json`). Failures: `scripts/offline-setup-failures.md`. Other older `durable-*` scripts still name codex models and remain real-model only.

## Telegram formatting

Notices reach Telegram as `parse_mode: "HTML"`, not raw Markdown. `src/telegram-html.ts` converts the model's Markdown: headings → bold lines, `**`/`__` bold, `*`/`_` italic (not inside words, so snake_case and `2*3*4` stay), `~~` strike, inline code, fenced code → `<pre><code class="language-x">` (an unterminated fence, e.g. clipped by the feed's 3,500-char cap, is closed), pipe tables → `<pre>`, `-`/`*` lists → `•` lines (indent kept), numbered lists as typed, `>` runs → one `<blockquote>`, `[text](url)` → `<a>` only for http(s)/mailto/tg (others keep the label). Model `<`, `>`, `&` are escaped; the project/chat header is bold and the footer italic. `splitTelegramHtml` cuts at line breaks into parts ≤ 4,096, closing open tags at a cut and reopening them in the next part, never inside an entity; buttons go on the last part and every part routes replies. `telegram.json` keeps `sentPart {seq, parts}`, so a retry after a mid-way failure sends only the missing parts. If Telegram answers 400 "can't parse entities", that part is resent as plain text (tags stripped, entities decoded) and the outbox moves on. Bot command replies stay plain text. Verified by `scripts/telegram-e2e.mjs` (fake Bot API validates the HTML subset and nesting; checks T23–T32 in `scripts/telegram-failures.md`).

## Browser notifications: none arrived on the live host

The live feed was fine (66 notices since 07:15, Telegram got them); the page dropped them. The poll advanced its cursor and showed notices only when `visibilityState === "hidden"`, so with the browser window on screen and another app in front (still `visible`), or on the first poll after a throttled/frozen tab came back, every notice was consumed silently. Each host restart also minted a new web token, so an open tab's polls got 401 forever, swallowed by `catch {}` while Settings said "On". Fixes (`web/app.js`, `src/web.ts`):
- Away = tab hidden or window not focused (`document.hasFocus()`). Leaving (blur, hidden, `freeze`, `pagehide`) sets `notifyAway`, cleared only by a poll made while present; coming back polls at once, so a backlog collected while polling stalled still notifies. One poll at a time.
- The host reuses the previous token as well as the port from `web.json`, so a tab left open across a restart keeps its session and its notifications.
- A failing feed shows "On, but not receiving notices: …" (401 → reopen the inbox link) until it recovers. A dismissed permission prompt explains itself. "Send a test notification" checks OS-level delivery (macOS notification settings for the browser, Focus), which a page cannot detect.

Verified by `scripts/browser-notify-e2e.mjs` (N12–N17, failures 12–17 in `scripts/browser-notify-failures.md`); the red run before the fix is `artifacts/browser-notify-red-n12-*` (no notification while visible but unfocused).

## Quiet coordinator (reporting, plan-first)

- Settled-work reports are batched: the coordinator agent uses `followUpMode: "all"` (`src/durable-runtime.ts`), so reports queued while it is busy arrive in one turn.
- The report text (`reportText` in `src/durable-planning.ts`) echoes at most 500 characters of the task and says whether other work for that chat is still queued or running. If so, the coordinator is told not to write to the owner and to end with no text or one short status line. If nothing else is running, it is told to give one concise final summary of the whole request (or ask the owner).
- Notifications (`src/notify.ts`): a "Finished" notice goes out only when the chat has no queued or running work and no later work-report turn follows (batched submissions sharing one answer notify once), so intermediate status lines stay quiet.
- Coordinator instructions: plan first, prefer following up an existing thread over new threads, no micro-delegation ("status" checks), at most one reviewer per PR head, report to the owner only at the end.
- Coordinator repository instructions: the coordinator gets the project checkout's AGENTS.md and related standing files (the same loader as workers) under "Repository instructions". They are re-read on every open; recovery reconfigures the coordinator and chats when the text differs.

Verified by `scripts/quiet-coordinator-e2e.mjs` (one parent worker with 2 children plus 2 scouts: 5 threads, 2 coordinator report turns, 1 owner notification; AGENTS.md edit applied after restart). Failures in `scripts/quiet-coordinator-failures.md`. The receipt-only auto-fix rule is covered by `scripts/follow-prs-e2e.mjs`.

## Skill profiles

- Settings → Skills: "All profiles" plus per-role additions for Coordinator, Worker, Scout and Reviewer. Candidates are every skill pi loads (repository, global, packages), grouped by source and searchable. Children use their role's set. Stored as `project.skillProfiles` (`settings-update` `changes.skills`; `null` resets). The default for new and existing projects is the repository skills in "All profiles", nothing else.
- Prompts carry only names and descriptions of the role's effective set (`skillIndex` in `src/skill-profiles.ts`); skills with `disable-model-invocation` are left out. Names that no longer load are ignored. Workers no longer get every configured skill inlined.
- Bodies are read on demand with `projects_skill_file` (coordinator, workers, scouts, reviewers), restricted to the caller's role set; the thread's role comes from the planning document.
- The owner `/` picker still lists every skill.

Verified by `scripts/skill-profiles-e2e.mjs` (2 repository + 4 global skills, per-role prompts including a child worker, refused cross-role read, path escape, thread created before the change, `/skill:` grant to the coordinator, 390px picker). Failures in `scripts/skill-profiles-failures.md`.

## Worktree lifecycle (git policy, PR-head reads, setup, cleanup)

- Git policy (`guardWorkerGitCommand` in `src/durable-workspace-binding.ts`): whole-repository workers may fetch, `merge`, `merge-base`, `rebase`, `cherry-pick` and resolve conflicts. Pushes may go to their own branch or any other project branch (the GitHub branch prefix, `pi/` by default), including `--force-with-lease` there. Blocked: pushes to the base/default branch, `main`, `master` or non-project branches, plain `--force`/`-f`, `+ref`, deletes, `--mirror`/`--all`/`--tags`, bare `git push origin`, `git branch -D`, `gh pr merge`. A blocked segment still blocks the whole compound command (partial execution is not safe), and the message names that segment. Still best-effort, not a sandbox.
- Any thread may continue a project PR branch: the coordinator follows up the owning thread, or names the branch to another worker, which fetches it, commits on top and pushes `HEAD:<branch>`. No transfer/cherry-pick threads. The YOLO text no longer says "after pushing, call open_draft_pr"; workers open a PR only when the task asks for one.
- PR-head reads: `projects_delegate` takes `ref` (branch, `pull/<n>` or SHA) for scouts/reviewers. The host validates it, fetches it from origin into `refs/pi-read/*` and a detached snapshot `<project home>/read-heads/<sha>` (deduplicated by commit, recreated if cleaned while the thread is read again). An unknown or option-like ref refuses the delegation. A worker's child scout/reviewer reads the parent's worktree (its current, even uncommitted, changes). Auto-merge reviewers read the exact head they judge.
- Worktree setup: Settings → Worktrees → Setup command (`project.worktreeSetup`, `settings-update` `changes.worktreeSetup`, `""` removes). Runs once with `sh -c` in each new whole-repository worktree before the worker starts (`PI_WORKTREE` set, 15 min limit, `PI_PROJECTS_SETUP_TIMEOUT_MS`). The result is recorded in `<project home>/worktree-setup/<intent>.json`, shown in Settings and put into the worker's instructions (failures with exit code and output tail).
- Cleanup (`src/worktree-maintenance.ts`, RPC `worktrees-snapshot` / `worktrees-cleanup`): a worker worktree is removable when no queued/running work uses its thread (or its children), it has no uncommitted or untracked changes (ignored files such as `node_modules` are fine), no PR for its branch is open, and its commits are on a remote or its PR is merged/closed. Removal is `git worktree remove` without force; branches are kept; the isolation receipt is marked released. PR-head snapshots are removable when no active scout/reviewer reads them. Settings lists every worktree with size, PR state, setup result and the reason it is kept, plus "Clean up worktrees (size)". The same rule runs automatically every 30 min (`PI_PROJECTS_WORKTREE_CLEANUP_MS`), not while the project is paused or closing. A follow-up on a cleaned thread fails with "worktree was cleaned up … continue branch X".
- `attempt.toolNames` in plan snapshots now lists the tools actually bound (frozen `requiredTools` still drive profile checks).

Verified by `scripts/worktree-lifecycle-e2e.mjs` (setup via Settings, W1 opens PR #1, a second thread merges main with a conflict, uses merge-base, rebases and force-with-lease pushes W1's branch; push to main/plain force blocked; child reviewer reads the parent's uncommitted file; reviewer with `ref` reads the PR head; scope ignored for a scout; bad/unknown refs refused; failing setup visible; 6 threads total; cleanup keeps open-PR/dirty/unpushed worktrees, removes merged W1 and the snapshot from the Settings button, automatic cleanup after restart). Guard matrix in `scripts/worker-yolo-e2e.mjs`. Failures in `scripts/worktree-lifecycle-failures.md`.

## Context and compaction settings (per project)

- Settings → Context and compaction: context window override (default: the model catalog / `models.json` window), compact automatically on/off, compact at (% of the window), keep recent (tokens). Stored as `project.contextSettings` (`settings-update` `changes.context`; `null` resets). Validated: window 4,096–10M, threshold 10–95%, keep-recent at most half the window.
- Applied live, without reopening the runtime or waiting for idle: the host passes Durable a `compaction` getter (Durable reads settings on every resolution) and wraps `models.getModel` so the coordinator model reports the overridden `contextWindow` (Durable's thresholds and the context ring both read it). Other models and other projects keep their catalog window. The policy is harness-wide, so workers use it too, computed against the coordinator window.
- Threshold semantics: compaction starts in the background at the threshold; a generation blocks to compact only when the answer reserve (≤ 16,384 tokens) is reached. Off disables threshold compaction; manual and overflow compaction still work.
- "Compact now" (`compact` RPC, optional `chatId`): in the context ring popup of each chat and in the Settings card. Refused while paused, for archived chats, or while that chat is already compacting; a short chat finishes with nothing to compact. The ring shows "compacting…".

Verified by `scripts/context-settings-e2e.mjs` (UI save, busy-coordinator save, invalid values, threshold compaction at 50% of a 20,000 override keeping the newest message, auto-compact off, Compact now from the ring, paused/archived/short chats, restart, reset, second project unaffected). Failures in `scripts/context-settings-failures.md`.

## Worker artifacts folder (C7)

- Each whole-repository worker thread gets `<projectHome>/artifacts/<threadId>/` (0700, outside the worktree, survives cleanup; children get their own). The path is in the worker instructions and in `$PI_ARTIFACTS_DIR` of every bash call. Workers are told to save evidence (screenshots, videos, logs) there and list the files in their result; no capture tools are built. The dangling `projects_evidence` instruction is gone. Scouts, reviewers and folder-scoped workers have no shell and no folder.
- Cap: 500 MB per thread, soft. Over-cap is reported (listing, report, thread pane); nothing is deleted.
- The settled report (to the coordinator, or to the parent for children) appends a list of up to 20 files as `artifact:<threadId>/<path>` refs. Coordinator tools (`projects.artifacts`): `projects_artifacts_list` (overview or one thread) and `projects_artifact_read` (text pages, images ≤5 MB as image content, metadata for video/binary). Known threads of this project only.
- Safety (`src/artifacts.ts`): bounded walk (2000 entries, depth 8), symlinks skipped and reported, never followed; `..`/absolute/NUL/backslash refused; realpath must stay in the thread folder; files opened `O_NOFOLLOW` and must be regular.
- Serving: `GET /artifacts/<project>/<thread>/<path>` with the web Bearer token (401 without). CSP gains `media-src 'self' blob:`.
- Chat: `![caption](artifact:<thread>/<path>)` renders images inline and webm/mp4 as `<video controls>`; `[label](artifact:…)` and other kinds are links fetched only on click. Blob URLs are cached (300 entries) so re-renders do not refetch; a missing file shows "(missing artifact)". Activity thread pane shows an Artifacts box (sizes, cap warning, skipped symlinks, inline previews), refreshed at most every 4 s.
- E2E: `scripts/artifacts-e2e.mjs` (failure cases `scripts/artifacts-failures.md`).

## Worker watchdog (C12)

- `src/durable-watchdog.ts`. Config in `automations.json` `watchdog {enabled, everyMs}`; absent = on, 15 min (Settings › Events in › Worker watchdog; applies without restart). `PI_PROJECTS_WATCHDOG_MS` overrides the interval (tests); `PI_PROJECTS_WATCHDOG_TICK_MS` the in-process poll (default 15 s).
- Durable clock: doc `projects.watchdog` on the root (`armedAtMs`, `lastTickAtMs`, `seq`, `ticks`). Armed when a worker is running, disarmed when none runs (idle projects never tick; the next worker starts a fresh interval). Due at `max(armedAtMs, lastTickAtMs) + everyMs`, so restarts neither reset nor fire it. Skipped while paused/pausing, closed or off.
- Delivery: `schedules.ingest` with event ID `watchdog:<project8>:<seq>`; the guard requires `doc.seq === seq-1` and `onRecord` advances seq in the same transaction (no duplicate ticks across timers). Recorded intents are resubmitted on recovery; `whenBusy: followUp` queues behind an owner turn. Target: the events chat (archived/unknown → Main).
- Digest per running worker (≤12 workers, 7 lines each): runtime of the current run and whether it is a STEER (`steering` flag now in the plan snapshot), last 6 tool calls with an argument hint, calls/repeated identical calls (≥3, same tool+args) and errors since the last check, tokens since the last check (assistant `usage`) and thread total, `git status --porcelain` of its worktree (errors → "unknown").
- Policy (in the check text and coordinator prompt): leave healthy workers alone; steer an unproductive one once with a concrete nudge; if its run is already a steer and still unproductive, stop and redispatch/rescope; end the turn with no text; owner hears only in the final summary or via needs-you. `notify.ts` skips `event:watchdog:` submissions (never "Finished"). The chat renders checks as compact "Watchdog check" cards.
- E2E: `scripts/watchdog-e2e.mjs` (failure cases `scripts/watchdog-failures.md`).

## Dark / light / system theme (Track T)
Settings > Appearance: System / Light / Dark, stored per browser in `localStorage["pi-projects-theme"]` (absent = System; invalid values fall back to System). `web/theme.js` is a blocking `<script>` in `<head>` (the CSP forbids inline scripts) that sets `<html data-theme="light|dark">` before first paint and follows `prefers-color-scheme` live for System. `web/styles.css` uses CSS custom properties only: semantic tokens (`--bg --panel --line --text --muted --accent*`) plus a derived `--k-<hex>` palette for status tints and dots (light = original value, dark = same hue with mirrored lightness). Dark is Claude-like warm charcoal (#262624 page, #30302e cards, #1f1e1d sidebar/code, #faf9f5 text, terracotta accent). `color-scheme` follows the theme so scrollbars, checkboxes and dialogs are native-dark. Small light-mode fixes: `.skill-tabs .count` no longer a terracotta pill with grey text, stepper done badge a touch darker for contrast, `mark` text explicit. The chat renderer has no table support, so tables are not styled.
E2E: `scripts/theme-e2e.mjs` (failure cases in `scripts/theme-failures.md`): emulated `prefers-color-scheme`, light palette pinned, live System follow, first-paint theme before `<body>`, persistence, per-tab dark scan (no light surfaces, WCAG contrast >= 4.5) for all tabs, search dialog, toast; light/dark screenshots in the artifact.

## Offline legacy scripts

Scripts that used to call the owner's `openai-codex/gpt-5.6-*` models now run on `scripts/fake-model.mjs` (private HOME and SDK dir, `PI_OFFLINE`; no owner credentials reachable). The fake replies `X` to `Reply exactly X` and can script tool use from directives in the last user message: `FAKE-CALL <tool> <json>` (repeatable; `~regex` picks an offered tool by name, `$REV` is the last 64-hex string from a tool result), `FAKE-CALL-ONCE` (only the first request carrying it calls), `FAKE-SAY <text>`. Worker-report turns ignore directives. `startFakeModel(root, { models, delayMs })` adds model ids and holds replies; `pinFakeRoles` pins a created project's role models (`create` stores codex defaults). Converted: durable-host, durable-runtime, durable-knowledge, durable-local-schedule, durable-workspace, durable-workspace-same-scope, durable-workspace-pause-reopen, durable-workspace-frozen-standing-negative, durable-workspace-owner-catalog, workspace-physical-lock-multiprocess, workspace-root-denial, workspace-write, durable-threads (the two schedule *-positive scripts were already offline). Deleted as obsolete: durable-foundation and `durable-fixture.ts` (library prototype), durable-owner-catalog-legacy (legacy upgrade path), durable-owner-catalog-positive (superseded by durable-workspace-owner-catalog) and `durable-owner-sdk-records.mjs`.

Found while converting: `withWriteLock` in `src/workspace-capabilities.ts` used SQLite's synchronous busy wait, which blocks the event loop so a holder in the same process could never finish (two same-process writers on one lock failed with "database is locked" after the wait). It now polls `BEGIN IMMEDIATE` until `waitMs`.

## Terminal UI removed

The pi TUI extension (`src/extension.ts`, `src/project-*-screen.ts`, drafts/items/native-data), the `pi-tui` peer dependency and the extension entry are gone (`package.json` keeps `"pi": { "extensions": [] }`). Host, CLI (`src/cli.ts`) and web UI remain. The package has no pi extension. The empty manifest is required: the owner's `~/.pi/agent/settings.json` lists `./projects-mvp` under `packages`, and without a manifest pi tries to load the directory as an extension and `loadProjectResourceLoader` throws "Failed to load extension" for every project. settings.json is not edited; the entry can be removed by the owner at will.

## MCP servers (S6)

The owner's pi `mcp.json` (`~/.pi/agent/mcp.json`; `PI_PROJECTS_MCP_CONFIG` overrides it for tests) lists servers. pi-durable agents do not run coding-agent extensions, so the host owns the connections: `src/mcp-servers.ts` (catalog + pool: one lazy `@earendil-works/pi-mcp` connection per server and cwd, per-call timeout from `timeout` seconds, idle close after 10 min, a timed-out/crashed connection is dropped so the next call reconnects, closed on host shutdown).

- Two stable gateway tools in extension `projects.mcp` (`src/mcp-tools.ts`), offered to coordinator (Main and chats), workers, scouts, reviewers and child workers, re-added on recovery: `projects_mcp_tools` (servers for your role; one server's tools paged, with `write` flag and input schema) and `projects_mcp_call` (replay unsafe; output capped at 64 KiB, images up to 1 MiB, untrusted). No per-tool registration: durable freezes tool names per conversation.
- Per-profile selection like skills: Settings, MCP servers card (`#mcp-picker`): All profiles + Coordinator/Worker/Scout/Reviewer, default none, saved as `Project.mcp = { all, coordinator, worker, scout, reviewer, writes }`. MCP-only settings changes apply live (no idle requirement, no reopen); the role set is read fresh on every call. Instructions carry a fixed note (`MCP_NOTE`), never a server list.
- Statuses: ready, disabled (`enabled:false`), needs-sign-in (http with `oauth`/`auth`: interactive OAuth is not run), invalid (bad config or `!command` values, which are never executed). Locked in the picker; calls are refused. Env, headers and args never leave the host (catalog shows name, description or `stdio: <command basename>`, status). `${VAR}` in values reads the host env. Project-level `.pi/mcp.json` is not read (global file only).
- Writes: per-server "Allow writes", default off. A tool is a write when annotations say so (`readOnlyHint:false` or `destructiveHint:true`), a read when `readOnlyHint:true`, else by name words (create/update/delete/start/cancel/force/transition/merge/publish/set/add/move/bulk/change/remove/... see `WRITE_WORDS`). A blocked call returns an error telling the agent to ask the owner; it never reaches the server.
- cwd: coordinator/chats run servers in `project.cwd`; a worker in its frozen worktree (`attempt.cwd`); scout/reviewer in their read root. Servers whose config sets `cwd` keep it.
- RPC: `mcp-catalog`, `mcp-probe` (Test button: connects and counts tools).
- Existing worker threads created before this feature keep their frozen tool list (no MCP until a new thread).
- E2E: `scripts/mcp-e2e.mjs` (fake stdio server `scripts/fake-mcp-server.mjs`, shared harness `scripts/lib/e2e-kit.mjs`), failures `scripts/mcp-failures.md`. Artifacts under `artifacts/mcp-<timestamp>/` (report.json + screenshots).

## Settings UI polish (web)

Settings tab = left section nav (chip strip when narrow) + sections (heading, lead, card): Owner setup, Project, Skills, MCP servers, Worktrees, Context, Automations, Notifications, Appearance, Approvals, Danger zone. Element ids and data-actions are unchanged. Skills and MCP pickers render in three parts (shell, list, chrome): toggling a checkbox only patches counts/Save/"Unsaved changes", so scroll, order, focus and DOM nodes never move; search re-renders only the list. Select all / Clear exist per source group, and for everything shown (respecting the search filter; inherited and not-ready rows untouched). Picker Save/Reset carry `data-off` so the global busy refresh does not re-enable them. Light theme tokens darkened (muted, accent-ink, accent-solid) so all text is >= 4.5:1 in light and dark. E2E: `scripts/settings-polish-e2e.mjs` (failures: `scripts/settings-polish-failures.md`; `ROUND=n` captures design screenshots only); contrast helper in `scripts/lib/contrast-scan.mjs`, also used by theme-e2e (now asserts light contrast on all tabs).
