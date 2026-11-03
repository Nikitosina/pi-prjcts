# UI 2.0 backend: failure modes (written before the code)

Contract: `docs/ui2-contract.md`. Scripts: `ui2-settings-e2e` (tiers, profiles, tools, prompt, ui, host feed, create), `memory-e2e` (Memory), `worker-quota-e2e` (tier fallback chain), `jobs-e2e` (no verifier).

## Model tiers (`tiers-get`, `tiers-set`, `<home>/tiers.json`)

- T1 First read with no file must not invent new behaviour: generated tiers only list models projects already use, and no project gets a tier assigned, so every effective model stays the same.
- T2 Generation must be stable: two reads return the same tiers and revision (it is written once, not regenerated per read).
- T3 A stale revision is refused and the file is unchanged.
- T4 A tier naming an uninstalled model, an empty model list, duplicate ids or duplicate models in one tier is refused before saving.
- T5 Removing a tier that a project profile uses is refused (it would silently change that project's model).
- T6 The catalog lists context window, prices and availability without network calls; a model without credentials is listed as unavailable, not dropped.
- T7 A damaged `tiers.json` is an error, never silently replaced by generated tiers.
- T8 Saving tiers reaches open projects that use them without a restart (next request uses the new first model).

## Profiles (`profiles-get`, `profiles-set`)

- P1 Absent profiles keep today's behaviour: legacy `model` / `models` / `fallbackModels` and thinking `medium`.
- P2 An unknown tier id, an unknown profile, or a thinking level outside the union is refused and nothing is saved.
- P3 A stale revision is refused (same revision as `settings-snapshot`).
- P4 A coordinator tier change reaches Main and every chat at their next request, without a restart; a busy chat keeps its in-flight request.
- P5 Worker/scout/reviewer changes apply at the next delegation; a running worker keeps its model (steer rule).
- P6 The thinking level actually reaches the provider request (reasoning effort) for each role, not only the stored settings.
- P7 A disabled tool is not offered to that role's next turn: absent from the provider request's tool list. A disabled group removes every tool of the group.
- P8 Disabling a tool for one profile does not remove it from another.
- P9 Disabling can never remove the tools a role needs to finish its contract silently: the `job` tool (worker) and `agents` (coordinator) are locked and refused.
- P10 The model chosen from a tier skips models without credentials; a tier with no usable model is refused when assigned.

## Tier fallback (jobs)

- F1 Quota on the first tier model moves the worker to the second, then the third, in order; never back to an earlier one.
- F2 When the last tier model is exhausted, the Job waits for the bounded quota retries and then fails, as today.
- F3 Without a tier the legacy single `fallbackModels` move is unchanged.
- F4 A rate limit (after Durable's own retries) moves on only when the profile has a tier.
- F5 `jobs-snapshot` names each Job's and agent's own current model (its conversation's agent model), so a tier move or a tier that differs from the legacy `models.worker` is not hidden behind the project setting.

## Profile tools (`profile-tools`)

- L1 Must not contact an MCP server (a dead server URL still answers instantly) and must not allocate a workspace (no new worktree directory).
- L2 Every group has an id that the disabled list understands; `enabled` matches what the role is offered after the filter.
- L3 MCP servers appear as one group each with a `mcp-writes:<server>` pseudo-tool; skills appear as one `skill` group.
- L4 Works for a closed project (does not need an open runtime, or opens it the normal way without side effects).

## Prompt render (`prompt-render`)

- R1 Sections are the real assembled text: joining the instruction sections equals the instructions the agent is configured with.
- R2 Order: host contract (locked), instance AGENTS.md, repository instructions, project instructions (editable, the old objective), role instructions (editable), preferences brief, memory index, skills list (locked).
- R3 Missing instance or repository instructions produce an empty or absent section, never an error.
- R4 Token counts are labelled as estimates.

## UI document (`ui-get`, `ui-set`)

- U1 Defaults from the contract when no file exists.
- U2 Stale revision refused; unknown keys, unknown theme, unknown animation level and malformed hotkeys refused.
- U3 A patch merges (setting `theme` keeps `hotkeys`); `panels` merges per key.
- U4 Saving publishes host topic `ui`; a subscriber to `/changes?project=host` receives it.
- U6 A document saved before `statusItems` existed reads as today's status line: every built-in item, in today's order, all shown.
- U7 `statusItems` accepts only the fixed item ids, each exactly once: an unknown id, a duplicate or a missing id is refused and nothing is saved.
- U8 A `statusItems` patch replaces the whole list (order and shown/hidden) and keeps every other field; `statusLine` still hides the whole bar on its own.
- U9 The Host agent's `ui_set` changes `statusItems` through the same validation; a refused list answers with the reason and leaves the document unchanged.

## Host change topics

- H1 `/changes?project=host` needs the same token and origin checks as project streams.
- H2 Host topics never reach a project stream and project topics never reach the host stream.

## Create

- C1 A Git checkout with a github.com origin gets the whole-repository workspace and one-click GitHub authorization in the same create.
- C2 GitHub authorization failing (no gh, wrong origin) does not fail the create; the project still opens with its workspace.
- C3 A later revoke still shows the blocker; nothing re-grants silently on open.

## Verifier removal

- V1 New worker turns are not offered the verifier subagent role; `subagent` accepts reviewer and scout only.
- V2 Workers are offered `projects_verify_run` and its runs back Ready proof (`checkProofRefs` unchanged).
- V3 Turning verification on no longer needs a verifier model.
- V4 Recorded verifier conversations still read (transcripts, Jobs snapshot) after the change.

## Memory (`memory-index`, `memory-undo`, prompt brief)

- M1 Reading the index never moves or rewrites a file (byte-identical tree and mtimes before and after).
- M2 Classification without front matter: `preferences.md` → preference, `decisions/` → decision, `runbooks/` and `architecture/` → procedure, `research/legacy/`, `plans/`, `research/` and UUID-named notes → archive. Front matter wins over the folder.
- M3 Malformed front matter falls back to the folder classification and never throws.
- M4 Archive entries are excluded unless `includeArchive`.
- M5 Broken links: a link or `supersededBy` to a missing entry is listed; links outside knowledge are ignored.
- M6 Undo restores the exact previous text of a revision and removes a just-created entry; a stale revision is refused; undo is itself a revision in history.
- M7 The prompt index replaces the hand-written MEMORY.md injection, excludes archive and stays bounded.
- M8 The preferences brief reaches every role prompt (coordinator, worker, scout, reviewer), is bounded (4,000 chars) with its revision, and only lists current preferences.
- M9 A superseded decision is marked in the index with its replacement.
- M10 The coordinator prompt states the auto-remember rules and that memory grants no execution authority.

## Round 2

Scripts: `chat-stop-e2e` (S), `automations-e2e` (A), `memory-e2e` (M11–M13), `ui2-settings-e2e` (L5), `host-agent-e2e` (H3–H6), `ui2-trial-e2e` (X).

### Chat stop (`chat-stop`)

- S1 Stopping a running coordinator turn of a chat aborts that turn only: another chat's running turn keeps going.
- S2 The stopped turn drains like other Stops: the answer stops streaming, history is kept, the chat accepts the next message and answers it.
- S3 `chat-stop` on an idle chat returns `{ stopped: false }` and changes nothing; an unknown chat or an inactive project is refused.
- S4 The chat topic is published, so a client watching `/changes` refetches.

### Automations (`schedule-run`, `schedule-update`, `schedule-delete`, `schedule-restore`)

- A1 Every schedule has a `revision` and a `name` (null when none); records saved before the change read with revision 0.
- A2 `schedule-update` with a stale revision is refused and nothing changes; a fresh one changes name, prompt and timing, bumps the revision, and the next run time follows the new timing.
- A3 Rescheduling a consumed one-shot is refused instead of silently never running.
- A4 `schedule-run` submits the prompt to the coordinator now, also for a disabled schedule, and the run appears in the schedule's history; a second run while one is in flight is refused.
- A5 `schedule-delete` with a stale revision is refused; a fresh one removes the schedule (no longer listed, never fires) and returns the deleted record.
- A6 `schedule-restore` within the window brings the exact record back (enabled state, timing, name, revision); after the window, or for an id never deleted, it is refused; restoring over a live id is refused.
- A7 Toggling with `schedule-enable` bumps the revision, so an edit made from an older read is refused.

### Memory undo across reload (`memory-recent`)

- M11 Each recent write lists path, revision, author and time, and `undone: true` once `memory-undo` reverted it, including a creation whose entry is gone.
- M12 A write that a later write replaced reports `current: false`, so the client does not offer an undo that `memory-undo` would refuse.
- M13 The list is bounded and newest first; undo records themselves are not listed as writes.

### Locks and Host agent

- L5 `owner_approval_request` is locked for the coordinator: a profile cannot disable it by name or with `group:core`, and `profile-tools` shows it locked.
- H3 `host-agent-settings` with `model: null` clears the pin and the tier's model applies; with no tier, the newest project's model applies.
- H4 `chat-stop`, `schedule-run`, `schedule-update` and `schedule-restore` are allowed for the Host agent; `schedule-delete` is dangerous and files an approval instead of running.
- H5 `memory-recent` is allowed.

### Trial launcher (`npm run ui2`)

- X1 It uses only `~/.pi/agent/projects-ui2` (created 0700 when missing), even when `PI_PROJECTS_HOME` is set in the caller's environment, and creates nothing in other homes.
- X2 It prints a working `/ui2/` URL with the token and a stop command; the URL serves the UI 2.0 page.
- X3 A second start while that home's host runs refuses and leaves the running host alone.
- X4 The stop command stops that host and only that host.

### Review findings (2026-11-03)

- G1 The Host agent turning on idle auto-deploy (`deploy-settings` with `idle: true`) files an approval instead of saving; saving other deploy fields with `idle: false` runs at once.
- G2 Agent-facing results never carry `telegram-snapshot` `pairing.code` or `automation-snapshot` / `automation-update` `webhook.secret`; the browser's responses still do.
- G3 An approved dangerous request's outcome posted to an agent is redacted the same way (`webhook-rotate` returns the new secret).
- G4 A `plugin` call is gated by the plugin's declared policy per method (and per params): reads and safe writes run, `dangerous` methods file an approval, and a method the plugin does not classify is dangerous. The simulator's `reset` and `delete` operations and `recover` are dangerous; `snapshot` is a read.
- G5 The coordinator's tier advances on quota or a rate limit: the failed chat moves to the tier's next model and continues once (stable request id per failed submission, so a replayed commit does not submit twice); the end of the tier leaves the failure visible; a chat without a tier keeps today's behaviour; other chats keep their model.
- G6 `skill:<name>` in a profile's disabled tools is stored as the skill profile (`skillProfiles.off[profile]`), so the prompt's skill index and `projects_skill_file` follow it, `profile-tools` shows it off, `profiles-get` lists it back, and turning one skill back on for one profile leaves the other profiles as they were.
- H6 A `host-agent-settings` patch choosing a tier clears a model pin in the same patch, so the tier applies.
