# Local Projects parity contract

Goal: `muqkitvc-u9sges`. Baseline audit: 2026-10-02. No feature is complete merely because a prompt asks for it.

Runtime revision approved through `/goal-tweak`: use official Pi Durable as the Projects execution runtime. Keep Pi 1.0 clients, credentials, all parity requirements, provider permissions, exclusions and data-preservation constraints. The previous native execution evidence is a baseline, not proof of Durable parity. The first milestone is isolated runtime verification before a recoverable production migration.

## Sources and exclusions

- Cursor blog: https://cursor.com/blog/projects
- Cursor changelog: https://cursor.com/changelog/projects
- Claude Code Projects: https://code.claude.com/docs/en/claude-projects

Implement local equivalents. Exclude cloud hosting, remote/local routing, Slack and unrelated external integrations, shared-user collaboration, hosted mobile access, commercial billing, and cloud-scale capacity claims. Keep execution ownership separate from placement without building a remote transport. Mac sleep pauses execution. Project coordinators do not integrate pi-goal-x.

## Current implementation and acceptance

Five goal milestones are accepted: parity contract, Durable foundation, knowledge, persistent threads/planning, and workspace isolation. Later changes to those components remain unverified. Focused historical GREENs are not acceptance of the remaining provider, scheduling, lifecycle, UI or final-report milestones. Failed/UNKNOWN attempts and original artifacts remain retained.

The owner suspended all verification. Native/browser implementation has now begun after the backend batches, but no new walkthrough, typecheck, model/provider probe or E2E has run. No production host restart/migration or additional provider effect is authorized by this implementation. Current development-write authority remains limited to the previously authorized GitHub scratch branch/commit/publication/PR/comment scope. Historical Arc provisioning permissions below are not current Arc command/write/cleanup authority; the adapter and commands are deferred. Actual merge, auto-merge, deployment, destruction and production writes remain unauthorized.

| Workflow | Current implementation | Evidence boundary |
| --- | --- | --- |
| Persistent coordinator, reusable threads, DAG and isolated scopes | Official Durable owner, scoped admission and frozen execution identity | Accepted foundation; later admission/history/steering changes unverified |
| Knowledge | Bounded index, on-demand topics, CAS/history/migration; native `K` and browser managed editor | Accepted knowledge foundation; new editors/topic creation/draft persistence unverified |
| Provider selection and multiple scopes | Explicit immutable workspace bindings; Git/Arc allocation | Accepted isolation foundation; Arc adapter/commands deferred |
| GitHub publication | Native intents and scoped Git-data PR/comment workflows; optional local-publication bridge | Earlier focused scratch GREENs retained; local command/base-integration workflows and complete provider parity unverified |
| CI/review fixes and conflicts | Scoped diagnostics/base reads/replies, fixed worker commands and exact-head publication checks | No complete nonempty CI-fix/conflict workflow evidence |
| Execution approvals | Plain records remain non-executable; exact executable merge/command approval, separate execution and inspection | Record foundation has focused evidence; new executors/process/artifact recovery and UI unverified; auto-merge blocked |
| Recurrence and provider events | Opt-in durable schedules/monitors, coalescing/cursors/backoff/pause/uncertainty gates | Earlier one-shot GREENs do not verify recurrence, DST, restart or monitor races |
| Lifecycle | Pause/recovery resume/archive/retained delete/paused restore; native `P` and browser confirmations | Earlier focused lifecycle GREENs retained; new ownership/locking/UI changes unverified |
| Models/settings/usage | Confirmed revision checks, offline role catalog, frozen defaults, owner-backed usage paging | Implemented, unverified; configured metadata does not prove model connectivity/default transport |
| Files/library | Scoped captures, project-bound grants, hash-pinned chunks, confirmed 32 KiB owner imports | New capture/import/command artifact and UI workflows unverified |
| Native Pi UI | Default inbox plus Durable threads, approvals, knowledge/library, settings, usage, lifecycle and GitHub views | Implementation only; no new fullscreen/regular/narrow walkthrough or captures |
| Browser UI | Same default inbox and owned controls; bounded tab-local drafts and late-success guards | Implementation only; old pause/resume evidence does not cover new controls |
| Recovery | Retained native identity, no blind mutation replay, conservative uncertainty inspection | Focused earlier crash proofs are limited; newer command/provider/automation/UI races unverified |

Browser details are in `BROWSER-WIRING.md`. Draft retention is bounded periodic/session or tab/origin-local state, not a proven crash/power-loss guarantee. Neither source implementation nor SDK byte/process status establishes task correctness or remote-effect success.

## Implementation-only checkpoint

Current review closeout incorporates owner setup pass 2: native/browser owner panels and revision-checked workspace/GitHub authorization and revocation, fixed-profile operations, and repository-skill grants are implemented but unverified. The trusted configured-skill catalog remains unavailable. Copy-only maintenance is implemented for owned disposable copies, not production migration. Exact-head GitHub merge execution is implemented but unverified and separately approval-gated; auto-merge is unavailable. No grants or external effects were authorized/performed for this review. See `IMPLEMENTATION-REVIEW.md` for entry points, safe review boundaries, blockers and checklist. The current goal remains 5/10 accepted; these changes do not advance acceptance. No tests, typechecks, builds, UI/runtime launches or provider operations were performed for this closeout. Preserve all existing historical evidence and failed/UNKNOWN/BLOCK records.

The user suspended E2Es, typechecks, and other verification. The additions below are implemented but unverified. They do not satisfy milestone acceptance or replace earlier evidence.

| Backend addition | Interface and limits |
| --- | --- |
| Review-thread replies | `github-authorize.reviewReplies: true` explicitly enables scoped `reply_review`. Omitting the flag retains prior permission; `false` revokes it. Replies require this task branch and verified head, native write intents, and marker inspection after uncertainty. No review approval or thread-resolution permission. |
| Review feedback | `provider-review-inspect`, scoped `inspect_reviews`; paged, untrusted comments and reviews |
| Upstream file inspection | Scoped `read_base_file`; only assigned ownership paths, exact PR head/base, bounded UTF-8 blobs with Git-object and SHA-256 checks. No symlinks, submodules, or writes. Native-linked receipts include presence and content identity. |
| Conflict inspection | `provider-conflict-inspect`, scoped `inspect_conflicts`; exact head/base, mergeability, divergence and paged commits. File listings may be truncated. No conflict resolution, rebase, merge, or force-push executor is implied. |
| CI failure details | `provider-ci-detail`, scoped `inspect_ci_detail`; exact PR head, check-run output and paged annotations, native-linked read receipts |
| Executable merge approval | A new `operation-decide` approval must include `execution: true`; `operation-execute` requires project confirmation and exact approval fingerprint. Existing approval records remain non-executable. Squash merge uses the approved head; uncertain results require `operation-inspect`. Auto-merge remains unavailable. No merge was executed during development. |
| Recurring schedules | `schedule-create.everyMs` or `calendar`; daily/weekly IANA timezone rules skip nonexistent times and select the earlier repeated time. Schedules start disabled; missed ticks coalesce and unresolved runs block recurrence. |
| Provider monitors | Explicit event opt-in and enablement; PR/CI/review reads, backoff and transactional event/cursor recording. Transition sequence distinguishes repeated observations from retries. Previously observed monitors without a sequence require a new explicitly enabled monitor. |
| Lifecycle locking | Pause, recovery resume, archive, retained delete and paused restore block admission during their transition, but open/drain/close the official owner outside the project lock. Settings updates, GitHub authorization and Durable workspace grants also acquire the owner, perform idle checks and await shutdown outside the project lock. Settings retain their admission guard until the revision-checked save completes, without opening an absent runtime. Settings, authorization and lifecycle owner-close failures block reopening until an explicit owned-host restart. GitHub authorization rechecks both workspace authority and the existing publication grants before saving. Concurrent runtime closes share one shutdown promise, drain both provider subsystems even if one fails, and retain aggregate errors. A failed SDK close retains the in-process owner claim. Failed startup also drains every initialized provider subsystem and wake operation, preserves the primary failure alongside cleanup errors, and releases the owner claim only after successful storage cleanup. A host shutdown request immediately blocks new dispatch, transitions and owner openings while retaining its delayed ACK flush. Shutdown callers share one operation; all cached owners receive cleanup attempts, and observed cleanup failures produce exit 1 rather than success. In-flight API operations are tracked and settled after runtime cancellation, before lock removal/process exit, so normal shutdown does not cut off accepted library/metadata writes. Coordinator admissions, worker follow-ups and steering share the admission mutex and reject a closing runtime; planning and stop also reject a closed runtime. Archive/delete still retain repository resources and remote effects. This locking change is unverified; older lifecycle evidence does not verify it. |
| Fixed worker command profiles | Owner-selected implementation, unverified: `command-profile-set`/`command-profiles-snapshot` persist confirmed, revision-checked fixed argv/scope grants and pinned executable identity. Changes close idle owners outside the project lock; existing projects gain no profiles. Enabled workspace-effect profiles now have a scoped fixed-input executor, native pre-spawn intents, bounded output, owned group cancellation and receipt paging. Uncertainty blocks repeat launches, scoped writes, publication and automatic work. Deployment/destructive profiles now propose separate exact command operations and require recorded owner approval with `execution: true`, confirmed project ID and matching profile/scope/thread/allocation/request identity. Worker questions and profile grants do not authorize launch; generic merge execution rejects command approvals. Trusted repository code, not an OS sandbox. Failure cases and current limits: `COMMANDS.md`. |
| Provider read binding stability | CI summaries, check-run detail, Actions jobs, review feedback and conflict reads recheck PR number, exact head SHA/ref/fork identity and base SHA/ref/repository after provider reads. Changed bindings reject the result; they do not retarget the request or grant write authority. |
| Actions job diagnostics | `provider-ci-job-inspect` and scoped `_inspect_ci_job` select job/step status without downloading raw logs. Check-run results expose job IDs only from canonical repository Actions URLs. Job/run/repository IDs must match; the tested commit must equal the PR head, or have both a matching recorded PR association and checked ancestry containing that exact head. The PR head is rechecked after reads; native-linked receipts retain job/run/tested SHA, relationship and failed step numbers, not raw output. Provider data is untrusted and grants no command permission. |
| Frozen thread instructions | Continuations retain their original instruction text when project names/objectives change. New threads use the current defaults. Role, standing revision, tool bindings and workspace identity checks remain active. Configured scoped conversations must still match their frozen instruction text; current knowledge execution controls apply regardless of that text. This does not retarget repository instructions or grant tools. |
| Legacy worker recovery | Startup scans retained legacy conversation inputs and root-owned reporter tasks through the official owner, and pauses when unfinished work exists. Only legacy task definitions are installed for cancellation, not a legacy delegate tool. Startup recovery and project pause abort those actual reporters/conversations without creating replacement thread UUIDs or replaying work. Missing retained identities or reporter registry entries remain blockers. Historical worker-crash evidence does not verify this change. |
| Owner effect inspection | `github-write-inspect` reads retained publication/PR/comment/review-reply markers without requiring an active worker or allocated-workspace access. Current trusted repository/scope authorization and numeric identity are checked before/after reads and before recording a positive result. Original native identity remains unchanged. Missing markers stay uncertain with no retry permission; comments/PR lookup are paged. Owner close aborts and drains these reads. |
| Monitor cancellation | Cancelled reads, disabled monitors, pause and event opt-out do not advance baseline cursors or increment provider-failure backoff. Observed legacy monitors without a sequence counter are rejected when enabling. Polls hold while automatic admission is blocked by an uncertain provider write; rejection by that gate is not a provider outage. |
| Automatic uncertainty gate | Schedules and owner-local events stop admission while any project GitHub publication or approved-operation intent remains uncertain. Due schedules are not consumed by this gate; enabled schedules revisit it at 60 seconds. Event rejection leaves monitor cursor advancement uncommitted. Schedule snapshots expose the blocker. If uncertainty appears between tick recording and submission, that intent is interrupted rather than replayed. New SDK admission failures persist a SHA-256 fingerprint rather than raw error text; existing receipts are unchanged. Manual effect inspection remains available; absence never clears the gate. |
| Durable questions | An explicit `decisionAccess: "coordinator"` settings grant offers `projects_question` only to the coordinator. A bounded root journal records UUID, arguments and actual native task/call identity before file materialization. Startup materializes recorded questions without replaying model work; conflicting retained metadata blocks recovery. Revocation removes the tool while retaining recorded questions. Answers remain manual delivery and do not grant execution or publication authority. |
| Retained decisions | Durable `answer`/`review` resolve owned Decision inbox entries without opening the legacy coordinator. New answers and revisions persist as manual-delivery results, retain owner notes, and create no queued job or automatic resume. Exact retries do not reconstruct missing legacy jobs. Work continuation remains an explicit message/follow-up under the pause gate. Acceptance is not publication or merge authority. |
| Thread history | `thread-history` pages genuine user/assistant messages from the existing owned conversation, with Unicode text ranges and explicit next-message/next-text offsets. It never takes arbitrary conversation IDs. `legacy-thread-history` provides the same read-only user/assistant history by a retained worker name, without raw conversation IDs, new UUIDs or continuation. Both APIs bound each response to a 262,144-character text allowance. The SDK view can materialize the transcript internally; only the response is paged. |
| Model selection | `models-snapshot` pages installed chat-model metadata without catalog/network refresh or model dispatch. Model settings require an installed model and configured credential metadata before the idle owner is closed. This does not establish live provider connectivity or token validity. |
| Usage | `usage-snapshot`; official owner-backed conversation ledgers, model/tool buckets, coordinator totals and paged worker totals. Includes retained legacy workers with their original names, not invented thread UUIDs. Aliases referring to a planned thread share its usage row. Conversations are counted once; reasoning/cache subsets are not added to token totals again. Reads are live, not an atomic accounting snapshot. Costs are SDK estimates, not billing receipts. |
| Settings | `settings-snapshot`, confirmed revision-checked `settings-update`; models, knowledge access, worker cap. New worker threads use role defaults; existing threads resolve their frozen model through the configured model registry. Missing models/credentials and changed tools or standing instructions remain blockers. Runtime shutdown drains outside the project lock. |
| Thread steering | `thread-steer`; replacement work and superseded history are persisted before aborting; dispatcher admission waits for the thread drain. Exact retries reuse the replacement and do not stop newer work. Interrupted steering is retained rather than replayed. |
| Thread stopping | `thread-stop`; retained conversations/work, admission blocked while aborts drain, incomplete stops trigger paused startup recovery |
| Worker evidence capture | New workspace grants with `evidenceCapture: true` offer a scoped capture tool. It uses the existing capability reader and exact source revision; records include project/scope/work/conversation/task/call identities. Old scopes keep their prior tools. Unsafe native execution is not replayed; interrupted captures may leave retained files even if no success response was returned. |
| Coordinator evidence access | Confirmed settings `libraryAccess: coordinator` enables project-bound `projects_library_list`/`projects_library_read`; `none` revokes access. Existing projects receive no grant automatically. Caller identity and current authorization are rechecked around reads. Workers receive neither tool. |
| Captured-file library | `library-list`, revision-checked `library-read`; paged metadata, bounded base64 chunks and SHA-256 checks. Owner-confirmed `library-import` accepts canonical base64 up to 32 KiB within the existing 64 KiB request limit, with an expected SHA-256 and stable import UUID. Exact completed retries reuse the original record; conflicting UUIDs and incomplete captures remain blocked and retained. It accepts supplied bytes, never local paths, and adds no agent import tool. Large/chunked uploads remain unimplemented. |

Arc/Arcanum inspection adapter remains deferred by the user. The native/browser controls listed above are now implemented but unverified. Full provider parity, conflict/CI-fix acceptance, lifecycle acceptance, scheduling acceptance and UI acceptance remain outstanding.

## Frozen baseline checklist

This table records the original native MVP baseline, not current implementation status. Use the current overview above and later evidence sections for the Durable implementation. Historical missing/partial labels are retained as baseline context.

| Workflow | Baseline code/status | Required acceptance evidence |
| --- | --- | --- |
| Arbitrary coordinator requests | Durable coordinator (`durable-runtime.ts`); legacy `coordinator-prompt.ts` removed | A real request starts bounded work, a quick question answers in place, and the master never edits or executes shell commands |
| Follow-ups and steering | Existing active-run control; partial | A follow-up targets the correct persistent thread, including after it becomes idle; unrelated work gets a new thread |
| Durable threads | Native runs and archived receipts; partial | A thread retains identity, context, model, attempts, outcomes, and approvals across continuation and host restart |
| Durable work planning | Flat queued requests; partial | Persist dependencies and blocked work; restarting does not rerun completed mutations |
| Hard concurrency limits | One writer per owner checkout; partial | Configurable enforced project limits; unrelated isolated writers run concurrently |
| Multi-repository projects | Single `cwd`; missing | Several repositories/scopes use one explicit project provider; mismatches fail before mutation |
| Git writer isolation | Missing | Owned worktrees preserve the owner checkout and other writers; safe cleanup retains dirty work |
| Arc writer isolation | Missing | Documented Arc worktrees use a shared object store and bounded scope; preserve dirty work and obey disk safety checks |
| File-based knowledge | `knowledge.ts`, typed host/model APIs; 38-check E2E passed; final startup rerun blocked | `knowledge/MEMORY.md` indexes preferences and topic documents; agent and human tools edit them safely |
| Bounded memory injection | Index-only coordinator/worker prompts; real-model E2E passed | Index has at most 3,000 Unicode characters; topics and old logs are not automatically injected |
| On-demand knowledge | Paginated project-bound model tools; real coordinator/worker E2E passed | A real coordinator and worker retrieve an older topic when needed, without dumping the knowledge tree |
| Memory history/migration | Content history, journal/conflict archive, repeatable import receipts; native crash-lock recovery verified; final startup rerun blocked | Migration is repeatable and recoverable; originals remain byte-identical; conflicts do not overwrite edits |
| Standing project instructions | Objective and ambient context; partial | Instructions are separate from learned memory and reach each new thread; changes do not silently rewrite old execution |
| Per-role models and effort | Stored models; partial | Editable validated project settings apply to new work and preserve already resolved thread models |
| Local tools and MCP | Local coding tools; MCP missing | Workers receive applicable skills/instructions and only explicitly permitted tools; missing access becomes a blocker |
| GitHub PR lifecycle | Publication blocked; missing | Authorized scratch PR demonstrates branch, commit, push, PR update, comments, checks, fixes, and conflicts |
| Arc/Arcanum PR lifecycle | Publication blocked; missing | Same lifecycle through the arc/arcanum-go split, respecting skill publication, title, ownership, and read-recovery gates |
| Enforced approvals | Pattern guards and fail-closed dialogs; partial | Authorized projects may publish ordinary work; merge/auto-merge, destruction, and deployment need explicit approval |
| PR/review/CI monitoring | Missing | Opt-in monitoring persists cursors, deduplicates events, backs off on failure, and never blindly repeats uncertain writes |
| Scheduled routines | Missing | Due work survives restart, obeys pause and limits, and does not duplicate runs |
| Pause/resume/archive/delete | Host stop only; missing | Project-wide controls stop execution/schedules, preserve history, confirm destructive actions, and never discard repository work |
| Decision inbox and thread controls | Native/browser clients; works with limited data | Live UI exposes new thread, PR, settings, approval, memory, and usage workflows without chat flooding |
| File/evidence library | Immutable verification captures; partial | Browse retained artifacts with ownership and integrity checks; file status is not proof that verification passed |
| Usage visibility | No project usage view; missing | Usage is attributed to coordinator, thread, attempt, and model, with transparent limits |
| Recovery | Session restoration, no blind interrupted-request replay; partial | Cover new threads, dependencies, memory revisions, schedules, events, approvals, and publication receipts |

Existing evidence: `artifacts/decision-inbox-release/report.json`. It verifies the MVP baseline, not this broader parity contract.

## Durable verification status

The checklist above describes the native baseline. New projects use Durable; unchanged existing projects keep their original runtime until an explicit safe migration. The current Durable host does not yet expose every baseline workflow.

| Workflow | Durable status and evidence |
| --- | --- |
| Coordinator messages and restart | Host admission, answer projection and restart passed 5 checks in `artifacts/durable-host-2026-10-02T11-13-14.254Z/report.json` |
| Background conversations and steering | Foundation prototype passed 16 checks in `artifacts/durable-2026-10-02T09-38-05.368Z/report.json`; host worker UUIDs, inspection/control and idle-thread follow-ups remain pending |
| Request deduplication and storage ownership | Runtime adapter passed 12 real-model checks in `artifacts/durable-runtime-2026-10-02T11-01-50.834Z/report.json` |
| Knowledge | 20-check Durable E2E passed in `artifacts/durable-knowledge-2026-10-02T12-22-48.688Z-530d2f84-c1a4-4f72-920a-72c4c6f6dc7b/report.json`: Unicode limits, index-only requests, on-demand reads, human edits, permission scopes, CAS/history/migration and lock recovery; native/browser editing UI remains pending |
| Legacy migration | Archive preparation passed 9 filesystem checks in `artifacts/durable-migration-2026-10-02T10-57-19.854Z/report.json`; copied-state switch/rollback and real native-session inspection passed 20 checks in `artifacts/durable-switch-2026-10-02T11-37-47.531Z/report.json`; production migration remains opt-in and unperformed. Removed with the legacy runtime: legacy records are now refused (DURABLE.md, "Legacy runtime removed") |
| Permissions | Offered knowledge/note mutation tools fail closed; production approvals, executable workspaces and authorized publishing are not implemented |
| Usage | Prototype recorded usage; host/UI attribution and settings remain pending |
| Durable planning threads | `artifacts/durable-threads/2026-10-02T14-56-03.351Z-22001-5b369cd3-7d92-4105-8c78-4308ec22ec11/report.json` passed real-model planner checks: strict UUID/DAG validation, actual worker cap and coordinator-overlap measurement, configured worker/scout/reviewer model streams, frozen standing/tool/profile settings, SDK child-conversation reuse across follow-up/reopen, dependency failure blocking, detached snapshots, usage, and pause unsafe no-replay. This is evidence for those local contracts only, not full thread/workflow parity or production migration acceptance. |
| Public idle lifecycle, Pi 1.0.2 | Pause, idle resume, pause persistence after an owned host restart, archive, paused restore and confirmed retained deletion are implemented. Focused public-host E2Es passed; full lifecycle acceptance remains pending. Evidence and limits are below. |
| Other checklist features | Multiple repositories, Git/Arc isolation, provider workflows, monitoring, schedules, active-work lifecycle/recovery and expanded UI require their separate acceptance evidence |

Typecheck passes. Repeat commands and dependency pinning are in `DURABLE.md`. Failed native startup, archive counting, dangling-storage symlink and completed-job projection runs are retained. These reports do not establish full parity or permission to migrate production.

## Current public-host lifecycle slice

Current tested baseline: installed Pi 1.0.2 and official Durable 1.0.0. No install, downgrade, duplicate SDK, production migration or restart was performed. Earlier Pi 1.0.0 evidence keeps its original scope; the cause of that installation change remains unknown.

All actions below use owner `POST /api` requests with a project `id`. These are host contracts, not completed CLI/native/browser workflows.

- `pause` acknowledges `paused:true`. `show` exposes the Durable plan's persisted pause flag. Messages are refused before queued-job persistence.
- Plain `resume` acknowledges `paused:false` only for an idle project without prior plan work or coordinator submissions. Prior history still requires an explicit recovery choice.
- `resume` with `recovery:"leave-interrupted"` requires `confirm` equal to the project ID. It drains a pause before reopening dispatch. Interrupted work keeps its status and receipts; this action does not retry it. A focused real-model E2E proves confirmed resume with completed coordinator history, no replay of that request, and completion of a distinct new request. A focused real-model E2E also verifies overlapping coordinator/worker cancellation and no replay of the interrupted child after confirmed recovery. It excludes a new post-recovery model request; the broader attempt failed and its cause remains unknown.
- `plan-snapshot` exposes the existing Durable pause/drain flags, worker cap and work/status/blocker projection through the owner API. Focused E2Es cover an empty paused retained plan and a real worker's running/interrupted plan states.
- `show` includes `durableInspection.workers`, keyed by stable thread UUID, with owned child conversation messages, submissions and generation receipts. The existing single Durable owner reads them; tests do not open databases. Child messages are bounded to the latest 30.
- `archive` pauses and closes the Durable owner, preserves project state and knowledge, and records `project.archived:true`. Ordinary resume and new messages refuse. Archived projects are excluded from startup autoload.
- `restore` clears archive metadata and retains `paused:true`; it does not resume or admit work.
- `delete` requires `confirm` equal to the project ID. It records a retained deleted/archived tombstone and removes the project from the normal list. State, knowledge and workspace files are not physically removed. Owner `show` and knowledge reads remain available. Resume and messages refuse. Explicit restore clears the tombstone while retaining pause. A focused public-host E2E verifies this after a clean owned host restart.

Focused evidence, including logs, actual exits, public exchanges, preimages, closure receipts and repeat instructions:

| Contract | Evidence |
| --- | --- |
| Pause acknowledgement and admission refusal, RED then GREEN | `artifacts/pause-public-contract-00bbe38a-15eb-4637-aacb-5f5e786f7238/summary.json` |
| Idle resume, RED then GREEN | `artifacts/resume-idle-public-contract-5f4884e0-4fd4-414a-8c72-815cc534f902/summary.json` |
| Pause survives restart; both owned hosts close normally | `artifacts/paused-restart-public-contract-e620d848-b124-4f5c-acbb-f932f43ad850/summary.json` |
| Archive retains identity and managed knowledge, RED then GREEN | `artifacts/archive-public-contract-6ffb1a87-a592-466c-a9cf-a69c76727ccf/summary.json` |
| Restore retains knowledge and pause, RED then GREEN | `artifacts/restore-public-contract-6dca814d-4a13-4aef-941e-835834ea449e/summary.json` |
| Delete confirmation and retained state/workspace file, RED then GREEN | `artifacts/delete-retained-public-contract-cbecf97b-01fd-4678-886a-6521938a211a/summary.json` |
| Deleted state survives restart; explicit restore returns the same paused project to the list; knowledge/workspace content survive | `artifacts/deleted-restart-restore-public-contract-1a8e7797-8525-434b-ac5a-0c5567dd6ffe/summary.json` |
| Static check through restore, before deletion implementation | `artifacts/lifecycle-static-check-1a5a7cce-a234-4dfc-bcd1-8ae5a297425a/result.json` |
| Static check including retained deletion; actual exit 0, source/index/HEAD unchanged | `artifacts/lifecycle-static-check-20024d53-9b39-4a68-8c2d-2f5d8fe6744b/result.json` |
| Public read-only paused plan inspection, RED then GREEN | `artifacts/plan-snapshot-public-contract-820f4eba-9181-4c19-8d94-a0d2a2b74f16/summary.json` |
| Confirmed leave-interrupted resume with real completed coordinator history, RED then GREEN; old generation retained and distinct new request completed; typecheck passed | `artifacts/recovery-resume-real-model-public-contract-b338bbb5-849e-406e-a4c3-1e7dc8ce522d/summary.json` |
| Active coordinator pause and clean restart with naturally stale running ledger, RED then GREEN; aborted generation/input retained, no replay, distinct new request completed; typecheck passed | `artifacts/active-paused-restart-public-contract-15691b8c-3490-4d1b-b885-11a0458ca0f6/summary.json` |
| Empty owned worker receipt projection, RED then GREEN; typecheck passed | `artifacts/worker-projection-public-contract-38aecee5-2498-4721-9a48-32a7217e17a1/summary.json` |
| Overlapping real coordinator/worker generations aborted by pause; interrupted child/input/plan retained after confirmed recovery without replay; post-recovery model request excluded | `artifacts/worker-cancel-no-replay-public-contract-e6442738-4ec5-40fc-b0f5-de3609308ab9/summary.json` |
| Enabled one-shot deadline passes while paused without recording or submitting work; resume completes exactly one linked real answer | `artifacts/schedule-paused-deadline-public-contract-0d6c17e6-bf8b-4072-8b06-5b7ef55a1be1/summary.json` |
| Running scheduled generation/input aborted by pause; intent retained interrupted, consumed deadline cannot be re-enabled; distinct explicit new deadline completes | `artifacts/schedule-active-pause-public-contract-c8a74e4a-60dc-4608-975c-b0f4f883f796/summary.json` |
| Archive interrupts overlapping real coordinator/worker generations; confirmed retained delete, clean restart and paused restore preserve child identities, aborted receipts, interrupted ledger, knowledge revision and workspace file | `artifacts/nonempty-retained-restart-public-contract-8dcf5922-2f76-4c4d-8b90-0aedae93d352/summary.json` |
| Intentional owned live coordinator crash, RED then unchanged-test GREEN; restart persists pause before SDK resume, retains interrupted input/job and aborted generation, confirmed recovery completes distinct real answer; typecheck passed | `artifacts/active-crash-recovery-public-contract-a9f0592d-94e8-4ab3-b5a3-c19417bd7440/summary.json` |
| Secret-free generation failure projection, RED then unchanged-test GREEN on a genuine failed request; only allowlisted heuristic hint and SHA256 exposed; typecheck passed | `artifacts/generation-diagnostic-public-contract-2a82df2e-583f-47d6-a13e-c05408a0f5da/summary.json` |
| Actual no-start CLI pause/idle resume/archive/paused restore/plan/confirmed retained delete, RED then unchanged-test GREEN; zero jobs/models, all CLI children normally closed; TS2322 retained then corrected with Request schema parsing, rerun GREEN and typecheck passed | `artifacts/cli-lifecycle-public-contract-e7a5332d-c161-4c3e-9ec4-7d06c0cce064/summary.json` |
| CLI `--leave-interrupted --confirm <same-project-id>` confirmation and host-policy forwarding on empty owned plan, RED then unchanged-test GREEN; missing/wrong confirmation preserves pause; zero jobs/models and typecheck passed | `artifacts/cli-recovery-public-contract-553dabf9-869b-4768-815f-d0cd2745eb4f/summary.json` |
| Real Chrome browser pause control, cancel/confirm, paused status and disabled messaging with retained draft; RED then unchanged-test GREEN on empty owned plan; zero jobs/generations, actual normal Chrome/host closure and ESRCH, typecheck and web syntax passed | `artifacts/browser-pause-public-contract-03e8a90a-3667-4acf-96a3-7a8054ae6289/summary.json` |
| Real Chrome saved-plan/resume dialog, cancel/wrong confirmation refusal and exactly one UUID-confirmed `leave-interrupted` HTTP request; empty plan unpauses without work and keeps draft; RED then corrected-fixture V3 GREEN, V1/V2 fixture failures retained; typecheck/web syntax passed | `artifacts/browser-resume-public-contract-4add0b35-60ec-479a-b50e-62e3f1d2f639/summary.json` |

Tests used fresh owned homes, plain workspaces, UUIDs and direct UNIX HTTP. The idle lifecycle and plan-inspection tests performed no model or provider work. The owner subsequently authorized the E2E work needed for verification. Recovery-resume RED completed one real coordinator arithmetic request; GREEN completed two. They performed no VCS or provider-resource operations, and shared auth/model/settings files stayed unchanged. Read-only Git evidence commands ignored global/system configuration only after owner approval; repository-local configuration was still checked. No configuration files or Node environment variables were cleared or changed. Failed startup attempts remain retained separately.

Repeat-wrapper path adaptations are compile-checked where noted, not claimed as fresh repeated runs. Independent review is deferred to a large completed implementation slice. Active coordinator pause now has focused evidence. The test observed a placed input and running request-phase generation, paused it, restarted without an intervening `show`, and retained the interrupted ledger/input and aborted generation. The host skips ledger admission while the Durable plan is paused. Confirmed recovery kept the interrupted request and allowed a distinct new real answer. Both owned hosts closed normally. This is clean restart, not a crash test. A focused cancellation/no-replay E2E also observed a real background-worker request-phase generation overlapping the coordinator. Pause made both generations terminal aborted, retained the child's unanswered/aborted input and interrupted plan item, and confirmed recovery did not create another child generation. This proves that focused contract, not new post-recovery model availability.

The broader worker-pause attempt failed its new arithmetic request with `model_error`: `artifacts/worker-pause-failed-attempt-ee496711-3447-4d30-8863-bac92eb2c45e/summary.json`. A separate diagnostic attempt did not reproduce that error and stopped with actual exit 2: `artifacts/model-diagnostic-unreproduced-attempt-03c9934d-3544-4eb5-95b2-5d0fd0c8f8a3/summary.json`. Its new request completed, but it is not a GREEN diagnostic run. No safe-diagnostic implementation or cause/fix claim was added. The first artifact-builder failure on `input:null` was retained; a corrected null-input guard appended only missing summary/observations without overwriting files or rerunning the E2E.

Focused one-shot schedule E2Es verify that a deadline passing while paused creates no intent or generation until resume. Resume completes one linked answer without duplicates. They also verify aborting an already-running scheduled generation/input, retaining its interrupted intent, refusing to re-enable that consumed deadline, and completing a distinct explicit new deadline. These tests use real model calls and real elapsed time, not injected clocks or databases.

A nonempty retained-state E2E archives a real running coordinator/worker pair, confirms deletion, cleanly restarts the host and restores the same project while paused. The stable worker UUID/conversation/generation identities, interrupted work/ledger, aborted receipts, managed knowledge revision and owned workspace file survive. Both hosts close normally. Public `show` can lazily open a retained owner, so this is not proof that archived/deleted owners were excluded from automatic startup.

An owned active-coordinator crash E2E reached RED because unclean restart remained unpaused. Startup now checks unfinished native inputs on owned root/worker conversations in SDK pages of 100 and queued/running plan work before `Harness.resume()`. It uses the existing persisted DurablePlanning pause/drain, not a second gate or storage owner. The unchanged E2E passed GREEN: the original input/job remained interrupted, its generation became terminal aborted, confirmed recovery did not replay it, and a distinct real request completed. The first host was deliberately crashed with SIGKILL through its live owned ChildProcess; its abrupt close, genuine ESRCH and raw refusal are recorded separately. Only the final host has a normal shutdown ACK and zero-exit close. Shared files, locks, source/index/HEAD preservation and typecheck passed.

A worker-crash fixture attempt failed its copied literal-one coordinator generation assertion after delegation had created two before crash. Public reopened receipts retained those same two IDs and the aborted child, but later assertions were not reached. It remains a failed attempt: `artifacts/worker-crash-fixture-failed-attempt-7cad2847-eacf-437e-a45a-ff261b12c344/summary.json`. A distinct corrected v2 fixture then stopped before any crash because its first root generation failed with `model_error`; no worker existed. That attempt has actual exit 2, clean normal cleanup/preservation, and an unknown cause: `artifacts/worker-crash-model-failed-attempt-8ac8a642-8f6d-4d82-a0cc-83f51fd0ea36/summary.json`. No application changes or automatic retries were made for either attempt. The worker-crash test path is stopped pending error diagnosis.

The host now exposes `outcome.diagnostic` on public generation receipts. Successful/aborted/other nonfailed outcomes have null; failures have only an allowlisted heuristic hint and SHA256 fingerprint of the SDK's error text. Raw text and credentials are not copied into this projection. The schema separates successful, failed and other variants. A genuine failed request verified the failed branch as `other`, fingerprint `521aa955a0efaff58361eb3fabf77f0e82f403d2cd41b1459a38af79276837a0`; the actual cause remains unknown. This is a GREEN diagnostic-projection contract, not a successful-model or worker-crash contract. The successful/aborted null branch still needs fresh verification. No historical errors were reclassified.

CLI lifecycle commands now forward the existing typed host requests. `--no-start` contacts only an existing host, and `delete` requires `--confirm` with the matching UUID. Real CLI subprocess E2Es cover pause, idle resume, plan, archive, paused restore and retained deletion with wrong/missing confirmation refusal and no model work. The initial behavior run passed but typecheck failed TS2322; both are retained. Request-schema parsing corrected the combined command union, then the unchanged E2E and typecheck passed. A separate model-free CLI E2E verifies `--leave-interrupted --confirm <same-project-id>` on an empty owned plan. Missing/wrong confirmation keeps pause; matching flags reach the host policy. This verifies parsing/forwarding, not prior-work recovery through the CLI. Nonempty CLI recovery, missing-host no-start behavior and browser no-start refusal remain unverified. A real Chrome E2E now covers the browser's confirmed pause control on an empty Durable plan. Cancel preserves the unpaused state; confirmation shows the owner-backed paused state, disables messaging and retains the draft. It creates no jobs/generations, records screenshots, keeps launch tokens out of exchange artifacts, and proves normal Chrome/host exit with ESRCH. The first GREEN runner construction failed before test execution; that failure is retained. A corrected immutable runner executed the unchanged E2E successfully. Browser resume now reads the owner-backed saved plan, offers idle resume or UUID-confirmed `leave-interrupted` recovery, and binds dialogs/actions to the captured project. The real Chrome E2E verifies cancel/wrong confirmation without mutation, exactly one explicit recovery HTTP request, enabled messaging with the draft intact and zero model work on an empty plan. RED preceded implementation. V1 stopped on an exclusive screenshot-name collision; V2 stopped at the temporary permit-directory namespace check. Both are retained. V3 corrected filenames and namespace only, kept behavioral assertions unchanged and passed. Typecheck and web syntax passed. Nonempty browser recovery, idle browser resume, active-work pause, project-switch dialog races, archive/delete/restore browser controls and native lifecycle controls remain unverified or pending.

Worker/tool/external-write crashes, pre-native-admission and schedule-intent crash gaps, schedule restart, actual repository/remote PR retention, startup exclusion of archived/deleted owners, recurring schedules/provider monitors, native/browser confirmations and final consolidated acceptance remain unverified. The lifecycle milestone is not complete.

## Knowledge milestone evidence

`artifacts/knowledge-2026-10-02T06-59-25.281Z/report.json`: 33 checks passed with real coordinator/scout models, captured system prompts, immutable-note preservation, concurrent revision rejection, symlink denials, host restart, and prepared/conflicting journal fixtures. Repeat: `npm run e2e:knowledge`. `npm run check` passed.

The initial run exposed that Pi logs a throwing `before_agent_start` handler and still allows a model turn. Coordinator validation now also gates queued prompts, worker launches, and the model stream; workers abort invalid-index provider requests. The failed evidence remains under `artifacts/knowledge-2026-10-02T06-46-38.293Z/`.

PID-lock deletion was replaced with SQLite's native process lock. `artifacts/knowledge-2026-10-02T07-11-40.044Z/report.json` passed 38 checks, including separate-process contention, SIGKILL lock release, exactly one accepted revision, and journal recovery. Node's built-in SQLite is used only for locking; Markdown remains authoritative.

Final verification is blocked, not accepted: adding database/journal symlink checks passed those checks, but the scout never started within 240 seconds (`artifacts/knowledge-2026-10-02T07-20-56.551Z/failure.json`, native run `ce1d788d-6b93-4fa9-a42c-5ba5370fdf37`, terminal state `not-started`, no session/output). Concurrent core regression timed out on Pi RPC `get_commands` (`artifacts/2026-10-02T07-20-56.826Z/report.json`). The RPC process was idle with global MCP subprocesses; root cause is unproven. E2E-owned processes were stopped; source checksums and evidence are in `artifacts/knowledge-lanes/native-lock-status.json`. Do not substitute another runner or claim the final rerun passed.

The terminal/browser knowledge editor remains in the pending UI milestone. No production host restart or remote provider mutation was performed.

## Backend repository authorization slice

Frontend work is deferred until the remaining backend work is implemented, as the owner requested. Existing browser pause/resume work and evidence remain preserved; the browser archive/delete/restore proposal has not run.

GitHub workspace grants now keep each repository ID bound to its original provider, owner checkout, approved root, ownership prefix and shared-store identity. A changed root or prefix is refused without changing persisted authorization/catalog. The same binding can add another file scope while retaining the original repository and scope. The public-host E2E used this checkout only for read-only metadata, fresh project state and fresh approved roots; no models, VCS writes or provider calls ran. Read-only Git subprocesses receive command-scoped configuration isolation; Node/global settings remain unchanged.

Evidence: `artifacts/repository-binding-public-contract-d189869d-d51f-494a-97b0-5ddbfb0018ae/summary.json`. V1/V2 copied-fixture identity failures are retained. V3 observed RED, then the unchanged V3 test passed GREEN after the binding guard; typecheck passed. This is authorization groundwork, not proof of executable operation approvals, Arc grants, provider workflows or provider milestone acceptance.

## Backend operation approval records

The host now exposes typed `operation-request`, `operation-decide` and paged `operation-snapshot` requests. Records live in a root-owned native Durable document under the existing Harness/storage owner. A proposed merge/auto-merge binds one request UUID to the exact project, provider, repository, workspace scope, PR number, expected head and authorization revision. Exact retries retain the same record. Changed requests, foreign scope/provider, wrong/missing project confirmation, wrong fingerprint and cross-project decisions refuse without changing approval state. Decisions are immutable and idempotent. A later scope grant invalidates the old authorization revision; inspection marks the retained approval `scopeCurrent:false`.

Evidence: `artifacts/operation-approval-public-contract-d56e2e66-8441-4f98-beb6-7378993cb5ae/summary.json`. RED preceded implementation. First GREEN failed when `structuredClone` met a native document object on retry; that attempt is retained. Detaching the record's scalar fields and scalar-only operation payload fixed it, then the unchanged E2E and final typecheck passed. Two fresh owned projects and read-only repository metadata were used; no model work or provider executor ran. Frontend work remains deferred.

These are decision records, not executable grants. No provider executor consumes them, and no live PR identity/head lookup has been implemented. Single-use execution, uncertain external-write recovery, deployment/destruction approvals, actual providers, restart/crash persistence and several positive/limit branches remain unverified or unimplemented. The fixture's `providerCalls:0` is a declared scenario limit, not a measured provider call counter; the source has no provider executor. Provider milestone acceptance remains pending.

## Authorized GitHub scratch resource

The owner explicitly authorized GitHub scratch branch/commit/push/PR/comment writes in `Nikitosina/pi-projects-e2e` under `pi-projects-e2e/*`. Arc writes, merge/auto-merge, deployment, destruction and production writes remain excluded.

A retained draft PR was provisioned with GitHub Git-object requests: `https://github.com/Nikitosina/pi-projects-e2e/pull/1`, expected head `3ddd3a14f6482a8fc31824c468143b40f6dfc49c`, repository ID `1402157054`. Its base tree had no GitHub workflow files; this is not proof about arbitrary external integrations. Every write intent was saved before its one invocation. No retry, local checkout change or frontend work occurred. Read-only verification passed twice.

Evidence: `artifacts/github-scratch-pr-provision-851fba69-6c4d-4210-a5db-bac2d20ae616/summary.json` and `verification.json`. Repeat only the read-only verifier, not provisioning. This is development fixture provisioning, not application Git commit/push/PR workflow evidence. Live backend inspection, executable approval enforcement and provider milestone acceptance remain pending.

## Backend live GitHub PR inspection

`provider-pr-inspect` now reads a PR through the configured installed `gh`, using fixed GET-only arguments. It requires the exact trusted GitHub repository binding, checks the live numeric repository ID and PR base repository, and can require an expected head SHA. It returns selected metadata only. Foreign repository/provider, wrong numeric identity and changed head refuse. Network waits do not hold the project admission/control lock; authorization is checked again before returning. CLI errors expose a fingerprint, not raw output.

Evidence: `artifacts/github-pr-inspection-public-contract-7523b524-3322-4fec-8aa3-bb9bd668242e/summary.json`. The real owned draft PR1 was inspected through a fresh owned host. RED then unchanged-test GREEN and typecheck passed. The project remained paused with zero jobs/generations; source/index/HEAD/shared backing files and GitHub config hashes were preserved. No provider write or frontend work ran.

This proves read-only inspection, not local checkout-to-remote matching, executable approvals, write workflows, Arc inspection or provider parity. Active provider-child cancellation/drain, authorization-change races and timeout/auth/malformed-response branches remain unverified. Provider milestone acceptance remains pending.

## Backend live GitHub CI inspection

`provider-ci-inspect` returns selected check runs and commit statuses for the inspected PR head. It uses the same authorized repository/provider and numeric-identity checks as PR inspection. An expected head can be required. Results contain totals and page continuation; empty checks do not imply successful CI.

Evidence: `artifacts/github-ci-inspection-public-contract-7174f580-d3c9-4bed-8098-1ac502c20d90/summary.json`. V2 reached RED, then unchanged-test GREEN and typecheck passed. Real scratch PR1 reported zero checks/statuses and a pending aggregate. Foreign repository/provider, wrong identity and stale head refused. The project stayed paused with zero jobs/generations. No provider writes or frontend work ran. Launcher-cwd and protected-file-set fixture failures are retained.

Nonempty passing/failing checks, pagination beyond 100, CI fixes, concurrent PR changes and active provider-child shutdown remain unverified. This is read-only inspection, not provider milestone acceptance. Model-dependent verification remains held; the diagnostic scope question is unanswered.

## Provider prerequisites and verification permissions

Read-only checks completed on 2026-10-02:

- Node `v26.8.2`, installed Pi `1.0.0`, and `tsc` are available.
- Git and `gh` are installed. `gh api user --jq .login` returned `Nikitosina`.
- Arc `21203362 (2026-09-25)` and `ya` are installed. `ya whoami` resolved `nikitarat`; existing Arc mounts were listed without changing them.
- GitHub identity is verified, not authorization to mutate any repository. Arc/ya identity does not prove all Arcanum service permissions.
- User authorized creation of private `Nikitosina/pi-projects-e2e` for test branches, PRs, comments, and CI. No merge, auto-merge, or deletion without approval.
- User authorized `junk/nikitarat/pi-projects-e2e` in a new isolated Arc worktree with a shared object store. Allow scoped test commits, pushes, unpublished PRs, and test comments. No publication to review, merge, deployment, discard, or unsafe cleanup.
- These permissions are scratch-target verification permissions, not permission to modify production repositories. Confirm actual service access and target state before each mutation. Missing service access blocks the affected provider verification, not local memory development.

Publication policy: after project authorization, ordinary commits, pushes, PR creation/update, review responses, and CI fixes may run automatically. Merge/auto-merge, destructive actions, and deployment still require explicit approval. Existing projects keep their old publication restrictions until their owner opts in.

## Failure cases to record before each milestone

Pi Durable foundation:
- Installing Durable duplicates or downgrades the coding SDK or its shared pi-ai/chord/typebox libraries; credential reuse exposes or replaces secrets.
- Native and Durable both own a conversation, or two processes open the same Durable storage.
- A retried request creates a second submission, worker, or completion report.
- A background worker blocks the master's quick replies, loses steering, or disappears on restart.
- SIGKILL loses a queued request, transcript, usage, child identity, or a pending approval.
- An interrupted read is replayed incorrectly; a mutating tool or uncertain external write is blindly repeated.
- A tool/hook exception permits an unapproved operation or an invalid memory index to reach the model.
- Pausing stops only foreground work; active background tasks or timers keep executing.
- Hot configuration changes retarget an already-authorized tool call to another provider, checkout, model or tool scope.
- Legacy migration changes project identity, discards original sessions/notes/receipts/evidence/decisions, broadens permissions, or starts active production work without approval.

Knowledge:
- Oversized MEMORY.md is saved or enters a prompt, including Unicode and manual edits.
- Topics, preferences, or historical notes bloat every prompt.
- Traversal, symlinks, or a foreign project expose or overwrite data.
- Two agents or a human and agent overwrite one another's edits.
- Crash between saving a revision and materializing a document loses history or content.
- Two processes reclaim the same dead-owner lock and remove a newly acquired lock, allowing both writes to pass. Missing-owner or permission-denied lock probes must not count as proof of death.
- A native lock stays held after SIGKILL, same-process requests deadlock, SQLITE_BUSY is treated as a successful write, or a lock database/journal symlink redirects outside the private state directory. Missing SQLite support must fail visibly rather than fall back to an unsafe lock.
- Repeated migration duplicates notes, replaces a human edit, or deletes originals.
- Restart uses stale topic content or silently repairs an invalid human-edited index.

Threads/planning/settings:
- Follow-up starts duplicate work, the wrong thread, or an obsolete attempt.
- Dependencies start too soon; limits race; settings changes affect already running work unexpectedly.
- Missing tools are substituted, skipped, or falsely reported as successful.

Isolation/providers/approvals:
- A writer changes the owner's checkout, another worker, or a mismatched provider repository.
- Cleanup discards dirty files, unmounts an active consumer, or creates a separate Arc cache unnecessarily.
- A denied operation bypasses approvals; existing projects silently gain publication authority.
- An uncertain external write is repeated and creates a duplicate PR/comment/publication.
- Wrong PR content, revision, ownership, or provider is used for review or auto-merge.

Scheduling/lifecycle/UI:
- Restart repeats due work, loses event cursors, or schedules while paused/archived.
- Pause leaves a writer running; resume blindly repeats interrupted work.
- Delete removes a repository, dirty worktree, or remote PR without specific approval.
- Polling drops drafts, sends an action to a different project, or loses approval state.
- UI labels stopped/failed work as verified, or permits unsafe artifact previews.

## Release gate

Use disposable workspaces, real configured models, and explicitly authorized scratch provider targets. Save per-milestone assertions, logs, captures, receipts, checksums, and repeat commands. Type checks must pass. Mocks alone do not prove provider parity. All applicable checklist rows need evidence before goal completion; exclusions or changed contracts require the user's decision.
