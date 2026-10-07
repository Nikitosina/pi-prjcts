# Pi Durable runtime migration

Approved runtime: official `@earendil-works/pi-durable`, pinned to **1.0.0**. Feature parity, provider permissions, local-only execution and data-preservation requirements remain in `PARITY.md`.

The new `schedule-history` owner API samples at most 100 retained events/intents per page, with Unicode excerpts capped at 4,000 characters per text/outcome field. Range metadata carries full-text UTF-8 SHA-256 and continuation offsets; native event/request/submission identities are preserved. Pages are live samples, not an immutable cross-page snapshot. `schedule-snapshot` can omit history arrays and return their counts; its default response remains unchanged. Monitor policy reads use this history-free option. This bounds response text, not loading of the underlying SDK document or schedule-definition count. No read creates work or replays intents. This change is unverified; no snapshots, history requests, model/provider calls or tests ran.

## Worker dispatch and results

Durable projects use the host's dispatcher on `pi-durable`, not `pi-subagents`. The legacy coordinator uses `pi-subagents`. Independent threads can run concurrently up to `workerCap`, which defaults to 1 and can be changed in Settings while work is idle.

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

Coordinator/new-worker instruction text now describes frozen workspace tools and owner-enabled fixed profiles instead of claiming all worker execution is unavailable. It still requires actual offered tools, provider/workspace bindings and separate executable approvals. It leaves Arc execution deferred and does not change grants or execution checks. Existing frozen worker instruction text is not rewritten. This change is unverified; no workers or models ran.

## Current scope

The isolated foundation prototype uses the installed Pi 1.0 `ModelRuntime` directly for provider configuration and credential handling. It does not create a coding-agent session, start global extensions/MCP servers, or install another coding SDK. Durable, Pi and the shared pi-ai/chord/typebox packages resolve to the same host libraries. `npm run link:durable` fetches the pinned official package, verifies its npm archive integrity and links those libraries. Registry receipts remain in `.dependencies/durable/1.0.0/receipt.json`.

`src/durable-workers.ts` follows Durable's background-worker pattern: a persistent child conversation, a background ownership anchor, and durable reporter tasks. Submission IDs prevent duplicate delivery. The worker registry records reported answer IDs so two steered submissions answered together do not duplicate the report. There is no independent scheduler: Durable runs the tasks and owns their checkpoints.

`scripts/durable-fixture.ts` is a disposable verification host, **not a production migration**. It offers index-only memory, on-demand topic reads, a replay-safe gated read, an enforced mutation denial, and persisted approval questions. A separate SQLite lease enforces one owning process because Durable storage does not provide cross-process locking. SQLite commits protect process-crash recovery; this is not a power-loss guarantee.

Repeat: `npm run link:durable && npm run check && npm run e2e:durable-foundation`. Reports, prompts, subprocess stderr and snapshots go under `artifacts/durable-<timestamp>/`. No production host is restarted.

## Verified foundation prototype

`artifacts/durable-2026-10-02T09-38-05.368Z/report.json`: **16 real-model checks passed**, including singleton storage ownership, background delegation, responsive coordinator, submission deduplication, steering and safe-read replay across SIGKILL, exactly-once reporting, index-only initial context, enforced mutation denial, persisted approval questions, memory repair and recorded usage. `npm run check` passed.

A throwing memory section alone did not stop generation: Durable reported its error and continued with prior prompt state. The dispatch guard now checks `memoryIndex()` immediately before `ModelRuntime.streamSimple`; the E2E verifies no dispatch occurs for the oversized index. Do not use a reported hook/section error as an authorization gate. Migration and production integration remain unverified and are the next work; this prototype does not complete the foundation milestone.

## Integrated adapter and host

New projects now carry `runtime: "durable"`; existing records without that field stay on the original runtime. The host admits UUID-keyed messages into Durable without waiting for a model and restores those submissions after restart. Its job files are admission receipts and UI projections, not a separate execution scheduler. Completed admission IDs live in a Durable document because `Harness.inspect()` lists active submissions only.

Verified reports:
- `artifacts/durable-runtime-2026-10-02T11-01-50.834Z/report.json`: 12 real-model adapter checks, including background topic reads, enforced mutation denial, memory repair, identity preservation and unsafe-storage rejection.
- `artifacts/durable-migration-2026-10-02T10-57-19.854Z/report.json`: 9 filesystem migration checks, including byte preservation, idempotence, interruption recovery and human-edit conflicts.
- `artifacts/durable-host-2026-10-02T11-13-14.254Z/report.json`: 5 real-model host checks for nonblocking admission, existing client snapshot format, restart and no duplicate completed work.

Repeat with `npm run e2e:durable-runtime`, `npm run e2e:durable-migration`, and `npm run e2e:durable-host`. Failed runs remain in `artifacts/`. The adapter's dangling-storage-symlink check and the host's completed-job projection failed first and were repaired against these tests.

## Durable knowledge

`artifacts/durable-knowledge-2026-10-02T12-22-48.688Z-530d2f84-c1a4-4f72-920a-72c4c6f6dc7b/report.json` passed 20 real-model/filesystem checks. It captures each conversation's first prepared request, proves index-only context and on-demand coordinator/worker topic reads, verifies exactly 3,000 astral Unicode code points, rejects oversized manual indexes, observes human edits, preserves original note bytes and history, checks scoped CAS writes, and verifies separate-process SQLite contention/SIGKILL release.

Repeat: `npm run e2e:durable-knowledge`. Creation supports explicit `knowledgeAccess: "maintain"`; absent or `"read-only"` grants workers no knowledge mutation tools. The coordinator always receives `projects_knowledge_write`/`projects_note` regardless of this setting, and retained coordinators gain them on reopen. Verified by `scripts/coordinator-knowledge-write-e2e.mjs` (fake model; failures in `scripts/coordinator-knowledge-write-failures.md`). This permission does not grant shell, repository or publishing access. Human document APIs keep revision checks. Model read tools paginate text/history/notes; standing instructions remain outside learned topic files. The optional typed request observer is for private verification and is not a dispatch or authorization gate.

Integration remains partial. Durable worker controls/public UUID projections, approvals, executable workspace tools and usage views are not wired into the current host/UI. Legacy-only operations fail explicitly for Durable projects. Production state and host remain untouched.

`src/copy-only-maintenance.ts` and standalone `projects --no-start copy-*` commands expose the copy-only inspection/archive/switch/rollback helpers without `ensureHost`. Initialize a new empty owned root first; use canonical paths and exact UUID confirmation. Active and SDK-default production project homes (including overlapping paths) are denied, and runtime override variables are refused rather than cleared. The copied project must be inactive and unknown/interrupted runs block archival; switching/rollback refuse a live copied-state host. See README for exact commands. Native `/project-migration-help` explains these limits. Never open/start a copy or treat this as production migration.

`src/durable-switch.ts` provides disposable-copy switching and rollback, requiring expected identity/CWD and a verified archive. It holds the runtime's SQLite ownership lease, checks host ownership, atomically stages a validated switch marker, refuses human-edit conflicts, and keeps new Durable records on rollback. Historical tool calls remain archived data, never runnable submissions.

`artifacts/durable-switch-2026-10-02T11-37-47.531Z/report.json` passed 20 checks from the integrated package, including real installed `SessionManager` history, a real-model Durable response, exact rollback hashes, marker interruption/retry, live ownership denial and unsafe-path rejection. Repeat: `npm run e2e:durable-switch`. This establishes the copied-state migration gate, not authorization or UI support for production migration. Process-crash recovery is covered; power-loss durability is not claimed.

## Durable planning thread evidence

`artifacts/durable-threads/2026-10-02T14-56-03.351Z-22001-5b369cd3-7d92-4105-8c78-4308ec22ec11/report.json` is a disposable real-model planning verification against MAIN. It records opaque aggregate ModelRuntime stream traces (not public Durable IDs), worker-only peak 2 at cap 2, coordinator preparation with two worker streams and aggregate peak 3, actual configured worker/scout/reviewer model refs, frozen standing/profile/tool bindings, real local MCP use, dependency failure blocking, usage deltas, SDK child-conversation reuse across follow-up/reopen, and pause no-replay. Repeat with `PI_DURABLE_E2E_SOURCE_ROOT=$PWD node --experimental-strip-types scripts/durable-threads-e2e.mjs` after `npm run check`.

The report does not establish full parity, production migration safety, provider lifecycle/thread-ID correlation, or broad standing-resource discovery.

## Migration gates

1. Verify the isolated real-model runtime, recovery, steering, replay rules, memory gates, ownership and denials. Preserve failed runs; dependency compatibility is not feature evidence.
2. Add a Projects runtime module backed by Durable conversations/tasks. Keep project-facing identities stable; Durable's internal conversation/task IDs are numeric and must not replace public project or legacy run UUIDs.
3. Import legacy history without executing it. Keep original sessions, notes, decisions, immutable evidence and receipts byte-for-byte. Preserve permission defaults. Mark interrupted operations explicitly; do not turn historical tool calls into runnable tasks.
4. Verify migration and rollback in copied, disposable state. Do not migrate a project with active coordinator/worker work. Existing production projects remain on their current runtime until a safe migration is authorized; two runtimes must never own one conversation.
5. Connect native/browser clients to committed Durable state and prove both surfaces. The previous Pi RPC/scout startup failures are retained evidence, not assumed fixed by this prototype.

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

Scout and reviewer threads always get `code_read`, `code_grep`, `code_find` and `code_ls` over the project checkout (`src/durable-code-tools.ts`). The tools are read-only, and paths outside the checkout are refused, including `..`, absolute paths, `~` and symlinks that escape it. These roles never get write, edit, bash or publication tools, and admission rejects a `workspaceScopeId` for them with guidance; use role `worker` for scoped write access. Worker tools are unchanged. Threads created before this change keep their frozen tool set.

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
- `projects_skill_file` lets the coordinator read files inside an invoked skill's directory (lexical and realpath checks).
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

The owner catalog (repository + configured skills) holds up to 512 candidates, 1024 diagnostics and 16 MiB of captured main documents (`SKILL_CATALOG_LIMITS` in `src/worker-skill-types.ts`), instead of throwing above 64. `worker-skills-catalog` pages it (offset ≤ 512, limit ≤ 64); the revision is stable across pages of an unchanged catalog, so grants can use any page. The owner grant dialog reads every page and refuses a revision change mid-paging. Repository discovery uses the same limits (4096 directory entries).

`src/github-authorization.ts` was hidden by the `*auth*` ignore rule and never committed; it is now unignored and tracked.

Verified, together with the multi-chat follow-ups above, by `scripts/skills-scale-chats-e2e.mjs` (89 configured skills, three chats with a failing one, 390px screenshot, and a project created by the 95817c3 host extracted with `git archive`); failures are listed in `scripts/skills-scale-chats-failures.md`.

## Uploads and knowledge search

Owner files are project knowledge. They live in `uploads/` of the project state directory (`src/uploads.ts`): `<id>.data` (bytes), `<id>.txt` (text), then `<id>.json` (metadata, written last, so a listed upload always has its bytes). Accepted: UTF-8 text/code/Markdown, PDF and PNG/JPEG/WebP, up to 20 MiB each. Kind comes from magic bytes, not the extension. Binary data that is not valid UTF-8 is refused. PDF text is extracted with `unpdf` 1.8.1, pinned and integrity-checked by `npm run link:unpdf`. A corrupt PDF is still stored, with `extractError`. Uploading the same name and bytes again returns the existing upload. This replaces the 32 KiB pasted-reference path in the web UI. The old `library-import` API and the TUI screen are unchanged.

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
- Auto-fix: when CI fails on a PR this project published (head branch under the grant's branch prefix, or a verified `create-pr` receipt), a fix goes out. If the receipt's worker thread still exists, it gets a follow-up; otherwise a new worker gets the repository's scope (whole-repository scope first). The worker reports to the event chat. Guards: an attempt is recorded before dispatch, at most once per head SHA. Nothing is dispatched while the previous fix for that PR is queued or running. There are at most `fixCap` attempts per PR (default 3, settable 0 to 10), and auto-fix can be turned off separately. Each failure line in the event says what happened (dispatched, still running, cap reached, not published, auto-fix off, no scope).
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
