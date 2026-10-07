# Browser Durable wiring

Implementation only. Verification remains suspended. Historical browser pause/resume evidence remains unchanged; new code is not accepted parity evidence.

## Failure cases recorded before implementation

- Durable workers disappear because the browser reads legacy runs only.
- A reusable thread UUID reaches legacy worker/control endpoints.
- Work IDs and reusable conversation/thread identities are confused.
- Lost follow-up/steering responses lose their request UUID or reuse it for changed text.
- Project switches, cancellation, reconnect or reload drop unsent drafts or replay actions.
- A late response closes/replaces a different project's dialog.
- Message/text paging hides truncation or fabricates missing history.
- Provider/task text injects HTML rather than remaining data.
- Answers claim to resume paused Durable work or grant execution.
- Existing explicit pause/resume confirmations are removed or silently changed.

## Approval failure cases recorded before wiring

- Plain approval enables execution or automatically executes a merge.
- A decision/execution targets a different project, ID or fingerprint from the displayed binding.
- Inactive/changed scopes, deferred Arc, auto-merge or command approvals reach generic merge execution.
- Pending records beyond the first page are presented as absent.
- A lost response/reconnect replays consent or execution, or retained confirmation text is auto-filled.
- A response closes a newer dialog or implies effect verification from an executor response alone.

## Browser-routine history failure cases recorded before implementation

- Definition pages still download all event/intent text after opting out of history.
- Record/text navigation loses project binding or renders mismatched pagination/ranges.
- Intent outcomes are clipped without continuation or mistaken for effect proof.
- Late history replies replace a newer project/dialog.

## Browser-routine control failure cases recorded before implementation

- Viewing/reconnecting starts a client poller or creates/enables a routine.
- Late routine snapshots update a different project/dialog.
- Confirmation targets a different ID, setting or definition from the reviewed cache.
- Retained ticks/cursors are presented as successful execution or current provider status.
- Event opt-in is enabled implicitly with a monitor toggle or pause is silently resumed.

## Review-decision binding failure cases recorded before implementation

- Detached Accept/Request changes buttons resolve a matching entry UUID in another project.
- A replaced or resolved review is accepted using the old displayed run binding.
- Request changes opens a draft against a different run than the reviewed result.

## Question-choice binding failure cases recorded before implementation

- A detached choice button resolves the same question UUID in a different selected project.
- A stale choice index submits replacement text instead of the choice the user saw.
- Resolved questions or missing choices are submitted again through stale buttons.

## Question-draft binding failure cases recorded before implementation

- Two projects sharing a retained question UUID share or overwrite answer drafts.
- Restored UUID-only drafts are assigned to whichever project opens first.
- Explicit adoption overwrites a newer scoped draft or submits the answer automatically.
- A project/dialog switch changes adoption's displayed question or copies different text from the reviewed draft.

## Pending-approval paging failure cases recorded before implementation

- Completed history fills the first approval page and hides pending inbox decisions.
- A loaded-page count is mistaken for the total pending count or produces a false caught-up message.
- Filtering changes existing unfiltered history semantics or broadens approval authority.
- Native all-records paging replaces the inbox's separately loaded pending records.

## Knowledge failure cases recorded before wiring

- Editing silently uses a newer revision after a reread/conflict instead of the draft's original revision.
- Topic creation overwrites an existing file or automatically changes MEMORY.md.
- Cancellation/reload loses path/body drafts, or restoration automatically writes them.
- A write response affects another project/dialog or deletes a newer draft.
- MEMORY.md accepts more than 3,000 Unicode code points, or unsafe control text enters an editor.
- History truncation is hidden, or a historical revision is written without a fresh explicit CAS decision.

## Library failure cases recorded before wiring

- Paged artifacts are missing or loaded from another project; cached metadata changes without detection.
- A growing/unbounded response exceeds the 10 MiB artifact limit.
- Images/downloads appear before byte length, chunk hash and pinned full SHA-256 checks.
- Binary/UTF-8 boundary bytes disappear through lossy decoding.
- A late read renders in a newer dialog/project or leaks a retained object URL.
- Viewing bytes is presented as proof of task correctness or authorization.

## Upload failure cases recorded before wiring

- Pasted content exceeds 32 KiB or base64/UTF-8 conversion loses bytes.
- A failed/lost response loses its UUID/fingerprint, or changed unresolved content reuses that UUID.
- A new request identity replaces an unresolved draft automatically.
- A response imports/deletes a newer draft or affects another project/dialog.
- Restored drafts execute automatically, include restored confirmation, or silently disappear when storage is full.
- Human imports claim native worker provenance or expose arbitrary local file access.

## Settings failure cases recorded before wiring

- A settings save uses a refreshed revision instead of its displayed original base.
- Missing credentials/offline catalog entries appear as proven model connectivity.
- Changing defaults silently retargets existing threads or broadens grants without confirmation.
- Drafts disappear on conflicts or a late save deletes a newer draft.
- Confirmation is restored or a reload retries changes automatically.
- A project/dialog switch during preparation admits an action on the wrong binding.

## Usage/lifecycle failure cases recorded before wiring

- A worker page total is presented as whole-project cost, billing or verified spend.
- Usage inspection starts generations, invents UUIDs for legacy names, or opens separate historical stores.
- Archive/delete discards repository work, receipts or remote PRs.
- Restore resumes/replays work or lifecycle confirmation targets a switched project.
- Retained deletion makes known project IDs inaccessible to restore from the UI.
- A late response closes another dialog or makes an execution claim.

## Provider view failure cases recorded before wiring

- Retained receipts are presented as live PR/CI/review state or provider text as instructions/authority.
- Fresh reads target a different repository, scope, PR or head than displayed.
- A stale/missing grant or deferred Arc scope reaches provider operations.
- Local-head verification is presented as executed commit/push or a remote write.
- Uncertain-effect inspection republishes/replays, invents native task identity or treats absent markers as retry permission.
- A late provider response renders in another dialog/project.

## Creation-copy failure case

The creation confirmation must not imply that a Durable project receives owner-checkout editing, worker tools, provider publication or executable-effect authority merely from creation. Separate explicit grants remain necessary.

## Late-error/reconnect failure cases recorded before wiring

- An old API failure attaches to another project's current dialog.
- A same-project failure overwrites a newer dialog rather than reporting outside it.
- Startup/list refresh finishes after a project switch and reselects the old project.
- Closing a dialog aborts accepted work or retries unknown mutations.
- Draft storage errors clear data or make a request appear accepted.

## Creation-draft failure cases recorded before implementation

- Cancellation/reload drops creation fields or restores the trusted-resource checkbox.
- A lost response is resubmitted from the same draft without a backend idempotency receipt.
- Creation success overwrites another draft or hides its returned project UUID.
- A new draft erases an unresolved creation instead of retaining it separately.

## Creation-completion failure cases recorded before implementation

- A successful create response selects its new project after the user switches projects or dialogs.
- A failed list refresh hides the UUID from an already successful creation response.
- A late creation acknowledgement closes another dialog or is mistaken for permission to recreate.

## Narrow-layout failure cases recorded before implementation

- Long UUIDs, hashes, model references or control labels force horizontal scrolling.
- A long dialog scrolls its Close control out of reach or extends behind viewport chrome.
- A sticky composer obscures decisions on a short/narrow viewport.
- Mobile action targets are too small, or controls remain clipped inside flex/grid children.

## Status

Browser implementation in progress. Durable work now comes from `plan-snapshot`, with work IDs distinguished from reusable thread UUIDs. The default inbox is retained. The activity sidebar and all-work dialog expose owned thread history with message/Unicode text paging, follow-up, separately confirmed steering and stop. Legacy projects keep their legacy endpoints. Question answers do not claim to resume paused Durable work or grant execution.

Coordinator/answer/task-form drafts snapshot to bounded tab `sessionStorage`. Thread request UUIDs/submitted text are preserved across failed responses and same-origin tab reload; restoring drafts submits nothing. Native thread admission stops when its draft snapshot cannot be stored. Unchanged snapshots are deduplicated, malformed snapshots validate before map restoration, and oversized state is not silently truncated. This is tab/origin-local persistence, not proof across closed tabs, host-port changes or crashes. Post-submission edits retain a separate fresh request identity only after a known successful response.

Dialog/project generation checks reject late history results and prevent successful old actions from closing a different/newer dialog. Existing explicit pause/resume/recovery behavior remains wired, with project/version-bound closing. Workspace copy now distinguishes Durable scoped isolation from legacy direct-checkout execution.

All new code is unverified. No browser launch, host/model/provider request, typecheck, E2E, screenshot or terminal capture performed. Browser approvals now join the default inbox from a pending-only operation page, so completed history cannot hide decisions. The heading uses the full pending total, with an explicit shown-records note and paged all-records view. The public snapshot's optional status filter pages after filtering; omitted filters retain existing history semantics. Decisions bind exact project/operation/fingerprint, keep plain approval separate from executable consent, and cannot upgrade immutable records. Executable consent requires typed project confirmation; exact-head GitHub merge execution is separately confirmed with the same identity. Inactive/changed scopes are disabled; Arc/auto-merge/command execution are unavailable through the generic merge control. Confirmation inputs are neither restored nor auto-filled. No response is treated as effect proof or new retry permission. Dialog version guards remain in place.

These approval controls are unverified; no consent, merge, provider request, browser launch or E2E was performed. Managed knowledge now has browsing, revision metadata, confirmed CAS editing, topic creation with a null revision, and read-only history with 20-revision display pages. The history API still returns the whole journal. MEMORY.md has a visible Unicode code-point count and a client-side 3,000-point check in addition to the backend guard. Unsafe controls/invalid Unicode cannot enter an editor. Path/body drafts persist in the bounded tab snapshot. Rereading preserves original draft revisions; discarding/restarting from the last read document requires a separate explicit action. No automatic index update or rollback is wired. Project/dialog checks guard responses and changed drafts survive old acknowledgements. Confirmation text is not persisted.

Knowledge wiring is unverified; no managed writes, browser launch or tests ran. The browser library now pages owned metadata, pins native provenance/metadata and SHA-256 through `library-read`, validates its prefix hash/bounds, and verifies full bytes before displaying images or downloads. Larger artifacts use the authenticated evidence stream with an exact pinned-size/10 MiB bound, then a full SHA-256 check. Binary/partial UTF-8 ranges display lossless base64; previews explicitly show byte ranges. Object URLs are revoked on dialog changes. Reads label byte verification separately from task correctness/effects. No upload or file access is added in this batch.

Library wiring is unverified; no artifact reads, browser launch or tests ran. Browser uploads now accept pasted UTF-8/canonical base64 only, with exact-byte round trips and a 32 KiB decoded cap. Separate new draft/UUID creation is explicit. Retained unresolved fingerprints reject changed metadata/bytes; prepared confirmations bind project/UUID/name/title/data/hash and require typed project consent. UUID/fingerprint persist before transport. Responses must match an owner reference with no native provenance. Updated drafts survive old responses. Restore submits nothing; confirmation text is excluded from snapshots. Preparation also checks project/dialog generation before admission.

Upload wiring is unverified; no imports, browser launch or tests ran. Browser settings now have revision snapshots, retained name/objective drafts, confirmed single-field grant/cap changes, and per-role offline model catalog paging. Missing-credential choices remain disabled; configured metadata is explicitly not connectivity/quota/transport evidence. Save proposals capture their original revision and exact changes, require typed project confirmation, and check returned values before removing matching drafts. Rereads do not rebase conflicts; replacing a draft with a last-read base is separately confirmed. Existing thread models/instructions stay frozen. No confirmation or action proposal is restored for automatic submission.

Settings wiring is unverified; no saves, model requests, browser launch or tests ran. Browser usage now pages owner-backed worker conversations, includes coordinator/model/tool counters, and labels worker totals as page-only and SDK cost as an estimate rather than billing. Reusable thread UUIDs and retained legacy names remain distinct. No historical store reopening or generation request is added.

Lifecycle adds separately confirmed archive, retained delete and restore while preserving existing pause/resume recovery controls. Typed confirmation binds the project UUID; restore stays paused. Repository work, allocated workspaces and remote PRs are retained. An explicit known-UUID opener can inspect deleted projects missing from ordinary listing without restoring/resuming them. Dialog/project guards remain in place.

Usage/lifecycle wiring is unverified; no usage reads, lifecycle calls, browser launch or tests ran. Browser provider views now page PR/CI/review/conflict/base-file read observations and publication/uncertainty receipts with their original SDK conversation/task/call identity. Retained state is labelled separately from current remote state. Local Git verification explicitly does not claim executed commit/push. Current scope/repository grants are required for fresh pinned reads or effect inspection. An explicit known-PR/exact-head form covers cases with no prior read receipt and allows CI/review continuation pages without inventing a worker receipt. Confirmed write-effect inspection may settle only original matching evidence; missing markers stay uncertain and no replay permission is created. Executable merge approvals also have a separately confirmed original-outcome inspection control. Arc remains deferred, and provider text is escaped data. Provider cache entries are bounded to the currently loaded receipt page.

Provider wiring is unverified; no remote reads/writes/inspections, browser launch or tests ran. Browser API errors now carry their UI project/generation/dialog binding. Errors from a switched project are not shown in the new project; same-project errors from an old dialog go to the action alert without replacing a newer dialog. Event handlers also bind local preparation/validation errors. Startup and manual-list refresh discard switched-project responses; manual refresh preserves the explicitly opened retained project in the picker. These guards do not abort accepted backend requests or retry mutations. Late-error/reconnect behavior remains unverified. Recent-evidence buttons now use the same bounded, metadata-pinned, full-SHA-256 library reader rather than the older preview path. This removes the separate lossy/unbounded client decoder; it is also unverified.

Narrow-layout CSS now permits long metadata/control labels to wrap, constrains flex/grid children and form fields, and uses a separately scrollable dialog body with Close outside that scrolling area. Dialog height uses dynamic viewport bounds with fallback. Narrow/short viewports use a non-sticky composer; mobile buttons have a 44px minimum height. These layout changes are unverified: no browser launch, resize, screenshot or walkthrough ran. Earlier historical screenshots do not establish the new layout.

Browser creation completion now captures its initiating project/generation/dialog. A successful response retains the created project UUID in the tab's project list and reports it before requesting a list refresh. Failed listing identifies that already-created UUID and warns against recreating it. Late success/list responses do not select the new project or close another dialog. Creation now supports an optional backend-bound request UUID and immutable project-record fingerprint, implemented but unverified. New browser drafts use that binding; older unbound outcomes retain their previous restriction. Creation fields persist as bounded tab-local drafts without the consent checkbox. Before transport, the draft becomes unknown and must be stored successfully; storage failure prevents admission. Unknown outcomes cannot be edited. Only a newly backend-bound draft offers a separately consented exact retry; unbound old outcomes cannot be resubmitted. Explicit separate new drafts retain prior unknown entries. Successful responses retain their returned project UUID; only known-success client entries can be dismissed, without deleting the project. Restoring these records performs no creation or attachment. Tab/origin storage is not closed-tab, host-port or crash persistence. These changes are unverified; no creation, listing or reload was performed.

Pending-only approval paging is unverified. No snapshots, decisions, browser/native launch or tests ran. Later pending records remain reachable through retained all-records paging; counts distinguish total pending decisions from shown rows.

Browser answer drafts and custom-answer expansion are now keyed by project plus question UUID. Form submission/input capture checks the displayed project binding. Older UUID-only drafts remain stored and are never auto-filled into a project. An explicit adoption dialog pins the target and reviewed text, requires typed project confirmation, refuses to overwrite a newer scoped draft, and copies only client draft state without answering or deleting the old draft. This change is unverified; no adoption, answer, reload or browser test ran.

Question choice/custom-answer/adoption buttons now carry their displayed project binding. Choice submission checks that the question remains pending and that its index still names the exact displayed text; detached/stale buttons fail instead of resolving against another project's view. This is unverified; no answers or browser tests ran.

Review Accept/Request changes buttons now pin their project and displayed run. Missing/resolved/replaced reviews reject stale clicks. Revision forms retain the displayed run and recheck it on submission, preserving text without submitting if that review changed. This is unverified; no review decisions or tests ran.

Browser routine views now show retained schedule/monitor definitions, event/intent metadata, sampled plan pause state and uncertain-effect admission blockers. Lists slice the returned full snapshots locally in 100-record pages; this is not server-side pagination or an atomic policy snapshot. Enable/disable and event opt-in are separate typed-project confirmations tied to the displayed cache/dialog. Opening/rereading does not create routines or a client poller. Backend checks still govern opt-in, authorization, pause and consumed one-shot behavior. Creation remains CLI-only and stores disabled definitions. Confirmation fields/actions do not persist or replay. This change is unverified; no snapshot/toggle, provider/model call or browser test ran.

Browser routine definitions now use `includeHistory:false` and retained counts; the history button requests bounded `schedule-history` pages instead of downloading/rendering the whole text log. Record/text navigation pins its project and checks page/range/native identity metadata, with separate event/intent lenses and explicit Unicode continuations. Late replies cannot replace a newer dialog/project. Full-text hashes identify recorded strings, not verified effects; excerpts do not establish the entire hash. Definitions still page sampled arrays locally. This change is unverified; no snapshots/history, browser/model/provider calls or tests ran. It supersedes earlier full-history rendering, not historical evidence.

All new native/browser controls still lack walkthrough evidence. No milestone acceptance or parity completion is claimed.
