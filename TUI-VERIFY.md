# Native Projects UI verification

The command desk, work board, and decision inbox must operate inside Pi against
its real detached Projects host. Browser fixtures are not proof of terminal behavior.

Native `R` now opens retained schedules, GitHub monitors, event/intent metadata and plan/admission blockers. Lists page the cached snapshot in 100-record groups; this is not server-side snapshot pagination. Enable/disable and event opt-in require separate default-cancel confirmation showing project and definition. Opening/rereading performs only owned snapshot requests, not polls or creation. Accepted changes are not retried when the panel closes. Creation remains in the stable-ID CLI and starts disabled. Arc monitoring stays deferred. This change is unverified; no snapshot/toggle, provider/model call or native test ran.

Native `R` now requests history-free definition snapshots and opens `schedule-history` only on explicit history navigation. Pages contain 30 records with at most 4,000 Unicode characters per text/outcome excerpt. `[ / ]` page records, `{ / }` page text, `v` selects events, `t` selects intents and `r` rereads the live page. Boundary schemas/range checks reject mismatched pages, project-bound events, invalid continuation and outcome/range mismatches. Closed panels do not apply late replies. Recorded full-text hashes are identifiers, not proof of effects; these pages are sampled history, not a stable cross-page snapshot. This change is unverified; no history/snapshot, native/model/provider call or tests ran. This supersedes the panel's earlier full-history rendering, not historical verification evidence.

## Routine-history wiring failure cases recorded before implementation

- Native definition views still request the entire event/intent text log.
- Record/text paging drops continuation, changes lens or mutates retained IDs/status.
- Out-of-range or mismatched pages render as a complete history.
- Closed panels apply late history responses to the next panel/project.
- Excerpt hashes are presented as verified execution or a stable cross-page snapshot.

## Routine-panel failure cases recorded before implementation

- Native inspection creates a second timer/poller or resumes a paused project.
- Enable/disable or opt-in is automatic on panel open, refresh or reconnect.
- A changed/closed panel applies a response or decision to another project.
- Displayed retained records are mistaken for current provider state or execution proof.
- Confirmation hides routine identity/definition or overwrites retained ticks/cursors.

## Failure cases

- Pi cannot resolve its supplied TUI package, or reload registers duplicate commands.
- A terminal-only command tries to open a custom screen in RPC or print mode.
- A wide or narrow screen overflows, crashes on resize, or hides its exit controls.
- An external title, transcript, note, or artifact emits terminal control sequences.
- Navigation keys consume text, pasted Unicode, or multiline editor input.
- Layout switches lose selection, drafts, or the active project.
- Polling replaces an answer draft or resets the reader's scroll position.
- A question answer only changes the UI instead of the durable host record.
- Review acceptance launches work, publishes code, or accepts the wrong record.
- Requested changes or worker steering target a different project or run.
- The stop action terminates a worker without explicit confirmation.
- Closing the screen stops the host or workers, leaks timers, or sends a local model prompt.
- A late response resurrects a disposed screen or overwrites a newer project's state.
- A host disconnect drops a draft, replays an accepted action, or shows stale state as connected.
- Evidence displays an unchecked file or passes binary data through the text renderer.
- Raw worker JSON and polling output flood the underlying chat while the screen is open.
- A fresh session opens the command desk instead of the chosen decision inbox.
- Coordinator replies cannot be read without leaving the native screen.
- An in-flight send clears text typed after submission or in another project.

## Durable wiring failure cases, implementation only

Verification remains suspended. These cases are recorded before the native wiring changes:

- Durable work disappears because the screen only reads legacy `runs`.
- A thread UUID is sent to legacy `workers` or `control` endpoints.
- Multiple work items on one thread appear to be independent conversations.
- A lost steering/follow-up response creates a new request identity on retry.
- Switching projects or cancelling a form discards an unsent answer or steering draft.
- A delayed plan response updates a different project, or an old snapshot appears connected after a failed refresh.
- History paging hides truncated message text or fabricates missing history.
- A question answer claims to resume a paused coordinator or authorize execution.

## Native approval failure cases, recorded before wiring

- Pending approvals after the first page are unreachable or silently counted as absent.
- An approval decision uses a different project, operation ID or fingerprint than the inspected record.
- Plain approval silently enables execution, or an approval click also executes a merge.
- Changed scope, deferred Arc operations or auto-merge appear executable.
- Reconnect automatically decides or executes an operation after a lost response.
- Original merge-outcome inspection performs another merge or grants retry permission instead of reading retained evidence.
- A decided record is overwritten instead of remaining immutable.
- Multiline approval details emit embedded newlines, or push confirmation choices off a narrow terminal. Details must remain scrollable while choices stay visible.

## Native knowledge failure cases, recorded before wiring

- The editor writes a different project/path or silently changes the draft's expected revision after a conflict.
- Polling, cancellation, a failed save or reopening the view loses the draft.
- Rereading a document replaces a retained draft instead of showing both versions.
- Saving an empty document is impossible, or MEMORY.md bypasses the managed Unicode limit.
- Control-bearing document text executes terminal escapes during editing or history inspection.
- Historical text is treated as a current document or restored without a revision-checked owner write.

## Native library failure cases, recorded before wiring

- A selected artifact is replaced by another ID/hash between listing and reading.
- A chunk's base64, hash, offset, size or continuation does not match the pinned artifact.
- Image chunks are rendered before the full image hash is checked.
- Invalid UTF-8 or a split code point is silently replaced and displayed as original text.
- Paging loses access to retained records, or a late response revives a closed library panel.
- Browsing imports files, launches commands or grants agent library access.

## Native usage/lifecycle failure cases, recorded before wiring

- Worker-page usage is presented as a full-project total, SDK estimates as billing receipts, or live reads as atomic accounting.
- Legacy worker names are fabricated into reusable thread UUIDs.
- A late usage response targets another project or hides later worker pages.
- Resume silently replays interrupted work, or restore automatically resumes admission.
- Archive/delete targets another project or implies checkout/remote-PR cleanup.
- A lifecycle action executes without confirmation, or reconnect automatically repeats it.
- Retained inactive projects expose thread or operation execution controls as authorized.

## Native settings failure cases, recorded before wiring

- A change targets another project or silently replaces a conflicted draft's expected revision.
- Selecting a model makes a model request, claims network/credential validity, or hides later catalog pages.
- Changing defaults claims to retarget existing frozen threads.
- Read-only knowledge/library/question grants silently broaden, or concurrency bypasses the host's hard limit/idle checks.
- Save, cancellation, rereading or reopening loses an unsaved text draft.
- A lost save response automatically retries against a new revision.
- Empty objectives cannot be saved or external control-bearing settings enter the terminal editor unsanitized.

## Native draft persistence failure cases, recorded before wiring

- Reload/restart loses an unresolved thread request UUID or a knowledge/settings draft's original CAS revision.
- Restoring drafts sends messages, launches work, grants authority or retries uncertain actions.
- UI state comes from abandoned branches rather than the active Pi session branch.
- Malformed/oversized state partially replaces good in-memory drafts or silently truncates text.
- Closing a child panel or the full screen clears drafts before persistence.
- Repeated unchanged polling appends duplicate UI-state entries.

## Native topic creation failure cases, recorded before wiring

- Creating a topic overwrites an existing document instead of using null-revision CAS.
- Invalid paths escape managed knowledge folders or create an invented current-document identity.
- Cancelling/reloading loses the new path or body draft, or rebases it onto a concurrently created file.
- Topic creation silently edits MEMORY.md or exceeds its managed index limit.

## Native upload failure cases, recorded before wiring

- A confirmation uploads different bytes/metadata/project than the preview.
- Invalid base64, path-like filenames or more than 32 KiB reaches import admission.
- A lost response creates a new UUID automatically or reuses the same UUID for changed bytes.
- Reload loses the upload UUID/fingerprint, or admission proceeds after its UI snapshot cannot be recorded.
- A completed receipt clears a different or subsequently edited draft.
- Uploading reads arbitrary local files, invokes a command, fabricates native worker provenance or grants agent library access.

## Native provider receipt failure cases, recorded before wiring

- CI/review receipts are shown as current remote state rather than retained observations tied to a head.
- A fresh inspection uses another repository, scope, PR or head than the selected receipt.
- Uncertain writes gain replay permission, or local-head verification is presented as commit/push execution.
- Later receipt pages are unreachable, or provider feedback executes terminal controls/acts as instruction.
- Inspecting an uncertain effect loses its native task/call identity or performs a new publication.
- Deferred Arc appears to have an implemented GitHub-backed adapter.

## Retained project selection failure cases, recorded before wiring

- Deleted projects vanish from ordinary listing and cannot be reopened for explicit paused restore.
- Entering a known UUID resumes/replays work or fabricates a listed project.
- Failed/cancelled UUID entry loses the draft or selects another project.
- A second snapshot failure leaves ordinary chat attached to one project while the screen displays another.

Native `p` and the initial project picker now offer explicit known-owned-UUID attachment, including retained deleted projects missing from ordinary listing. The screen's UUID-entry draft is included in its existing session snapshot; opening does not restore/resume/replay. `P` remains the separately confirmed paused-restore path. The extension now returns the first successfully bound snapshot from attachment rather than issuing a second `show` that could fail after changing ordinary-chat selection. Snapshot identity is checked before attachment widgets/messages are applied. Attachment now validates the requested snapshot before replacing the previous selected project, so failed or superseded reads keep the old attachment. The status widget no longer derives Durable worker counts from the legacy active-run array. These changes are unverified; no project attachment or lifecycle call was run.

## Native creation failure cases recorded before implementation

- Cancelling the optional objective prompt becomes an empty string and still creates a project.
- A project/session selection changes while creation prompts or transport are pending, then a stale completion replaces it.
- Creation succeeds but attachment fails, obscuring the created UUID and encouraging recreation.

Native creation now distinguishes objective-prompt cancellation from an explicitly submitted empty objective. Workspace/model and selection generation are captured before prompts; a superseded selection prevents admission, and a late successful creation does not replace it. The returned owned project UUID is displayed before attachment, and attachment errors include that UUID with a no-recreation warning. New creations now retain an exact request UUID/body via Pi's custom session entries and send that UUID to the backend. `/project-create-retry <UUID>` requires fresh confirmation and a matching current-branch request; old unbound creations are not adopted. Startup performs no retry. The backend binding and all these changes remain unverified; no creation, retry, attachment or prompt walkthrough ran.

Native inbox approval records now load from a separate pending-only page, independent of all-records history paging. Its header uses the total pending count; row titles distinguish shown decisions and offer all-records navigation. Completed history cannot fill the inbox page, and loading approvals is not presented as a caught-up state. The snapshot status filter is optional; older unfiltered callers keep their existing semantics. This is unverified; no snapshot or walkthrough ran.

## Current native implementation, unverified

The native screen now reads `plan-snapshot` for Durable work and shows work IDs separately from reusable thread UUIDs. It uses `thread-history` with message and Unicode text paging, `thread-send`, `thread-steer` and confirmed `thread-stop`. Legacy projects keep their legacy controls. Steering confirmation precedes composing the replacement.

Thread forms retain their request UUID across failed responses and retry only the same submitted text while unresolved. Coordinator and form drafts survive project switches, cancellation and reopening the view within the same loaded Pi extension. Pi session-entry draft snapshots are now implemented; restart/reload behavior remains unverified. No automatic action replay occurs on reconnect. Failed refreshes retain the old view with a disconnected indicator.

Question answers no longer claim to resume a Durable coordinator or authorize execution. `/project-workers` routes Durable IDs through owned thread history instead of legacy worker control.

No native walkthrough, screenshots, terminal capture, typecheck, model request or E2E has been performed for this batch. Native approvals now include pending records in the default inbox, a paged all-records view with `o` and `[ / ]`, separately confirmed plain/executable decisions, and a separately confirmed exact-head GitHub merge control. Approval does not execute a merge. Scope-changed records, deferred Arc and auto-merge cannot execute through this control. Confirmations keep choices visible and allow scrolling the exact binding with Tab. No reconnect replays a decision or execution. These controls remain unverified and no merge was performed.

`K` now opens a native knowledge panel for document browsing, editing and recorded revision inspection. Managed saves retain the original expected revision, including after rereading a conflicting file. Current text and the retained draft are displayed separately. Discarding a draft requires a separate choice and never changes the host file. Empty saves use the same managed write API and MEMORY.md keeps its backend Unicode limit. Control-bearing initial text is read-only in this editor; read/history views strip terminal controls. The editor viewport keeps the cursor visible within the available panel height. Drafts survive reopening within the loaded extension and are included in Pi session-entry snapshots; restart/reload behavior remains unverified. `n` from the knowledge list now composes a managed topic path and body. Creation uses null-revision CAS and cannot reuse an existing-document draft's write revision.

This knowledge batch is unverified. No host, model, typecheck or E2E was run. `L` now opens a paged native library through `library-list` and `library-read`, without opening arbitrary local files. Reads pin the full selected metadata and hash, validate canonical base64 and chunk hashes/continuations, and show byte ranges. Complete images are rendered only after assembling bounded chunks and checking the full artifact hash. Invalid or incomplete UTF-8 is shown as base64; valid text previews strip terminal controls. Closing the panel stops further image reads and late results cannot revive it. Browsing performs no import, command launch or agent grant.

This library batch is unverified.

`U` now opens owner-backed usage with worker paging and rereading. It distinguishes reusable UUID threads from retained legacy names, labels worker totals as page-only, displays model/tool buckets, and preserves the SDK's live-read and estimated-cost caveats. It does not claim atomic accounting or billing evidence.

The native approved-merge view now also offers `h` for separately confirmed original-outcome inspection. It reads retained evidence rather than merging/replaying or granting retry permission. Creation prompts now distinguish trusting Pi resources from separate workspace/tool/publication grants and executable approvals. These additions remain unverified.

`P` now offers separately confirmed pause, leave-interrupted resume, archive, restore and retained delete. Restore remains paused. Confirmation pins the project UUID and explains retained conversations, workspaces and remote PRs; these controls perform no repository cleanup. Inactive project thread/operation controls are blocked locally as well as by the host. Coordinator drafts remain unsent while admission is paused/inactive.

These usage/lifecycle controls are unverified. No host, model, typecheck, E2E or live lifecycle operation was run. `S` now opens native settings for name/objective, per-role model defaults, knowledge/library/question grants and hard worker cap. Every save shows the exact patch and expected revision, requires confirmation, and uses host idle/model/CAS checks. Model selection pages the offline installed catalog and marks missing configured credentials without making model requests. Text drafts keep their original revision across cancellation, rereading and reopen; conflicts show current text alongside the retained draft with an explicit local discard choice. Empty objectives are supported. Existing frozen threads are not silently retargeted.

This settings batch is unverified. No settings change, host/model request, typecheck or E2E was executed. Native drafts now snapshot through public `pi.appendEntry` and restore from the latest `projects-drafts` entry on the active session branch. The snapshot includes thread request UUIDs/submitted text and knowledge/settings CAS revisions. The open screen checkpoints every 1.5 seconds and on disposal. Unchanged snapshots are not appended again. Validation and duplicate-key checks finish before replacing maps; snapshots over 1 MiB or schema limits retain in-memory drafts and show a deduplicated error instead of truncating. Restoring data performs no submission, approval or action replay. This is periodic UI persistence, not a proven crash/power-loss guarantee.

Draft persistence is unverified; no restart/reload walkthrough was executed. New topic creation is now wired with managed path validation and null-revision writes. It preserves path/body drafts in backward-compatible Pi session snapshots, does not invent a current-document identity, and does not automatically edit MEMORY.md. Concurrently created files cause a revision conflict rather than overwrite.

Topic creation remains unverified; no knowledge write, host/model request, typecheck or E2E was executed. `A`, or `u` from the library list, now opens a confirmed reference importer for pasted UTF-8 or canonical base64 up to 32 KiB. It reads no local files and launches no commands. Preview pins project UUID, import UUID, metadata, byte count, SHA-256 and fingerprint. Unresolved drafts retain their original UUID/fingerprint; changed payloads require an explicit separate new draft while the old draft remains retained. Import admission records the Pi UI snapshot first and stops if that snapshot fails. Completed receipts must match exact bytes/metadata and owner-import provenance before clearing the matching unchanged draft. Upload drafts are included in backward-compatible session snapshots. Uploading does not grant agents library access. Thread form submissions also snapshot their UUID/submitted text before RPC admission.

Uploads remain unverified; no import, host/model request, typecheck or E2E was executed. `G` now opens paged native GitHub read/write receipt views. Read receipts retain PR/head/scope and native conversation/task/call identity; CI, review, conflict and base-file observations remain explicitly historical. `f` performs an explicit owner head-pinned PR/CI/review refresh against the selected authorized repository, not a fabricated worker receipt. Uncertain write inspection requires separate confirmation for the exact native key and current scope/repository mapping; it can settle the original journal only through the backend matching-evidence checks and never publishes or grants replay permission. Local Git verification is labelled as inspection, not commit/push execution. Provider result JSON is rendered as sanitized data. Arc remains deferred. Inspection results expose provider continuation metadata; deeper inspection pages remain available through the public API/CLI, not these result views.

These provider controls remain unverified. No provider request, model, publication, typecheck or E2E was executed. Browser wiring remains pending.

## End-to-end proof

Run a real Pi CLI in a pseudo-terminal and a separate real host in an isolated
project store. Exercise all layouts, resizing, Unicode editor input, persistent
questions, reviews, evidence, and closing/reopening. Send a bounded task to the
configured real coordinator and inspect its stored result. Record the complete
ANSI terminal stream, readable screen captures, assertions, and host snapshots.
No unit tests or fake host are used.

Historical: `e2e:tui` (legacy runs) was removed with the legacy runtime; no TUI E2E remains. The runner installs pyte into the run's isolated
artifact directory to capture terminal screens, without modifying your Python
installation. It uses real configured models and can incur provider usage.
