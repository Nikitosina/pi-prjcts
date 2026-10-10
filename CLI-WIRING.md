# Durable CLI wiring

Implementation only. Verification remains suspended. Existing CLI/lifecycle evidence is historical and does not verify these additions.

## Thread failure cases recorded before implementation

- Reusable thread UUIDs are sent to legacy run/control endpoints.
- Follow-up/steering loses its caller-provided request UUID or retries changed text under it.
- History pages accept malformed offsets, hide text continuation or fabricate legacy thread UUIDs.
- Stop accepts extra arguments that accidentally look like steering text.
- Failed-response diagnostics encourage a replacement request rather than inspection/exact retry.
- Read-only history opens a separate historical owner or starts a generation.

## Scoped submission failure cases recorded before implementation

- Durable delegation reaches the legacy coordinator or creates a second orchestration path.
- Scope selection broadens grants or carries caller-provided paths/provider data.
- Missing/changed authorization, archived/deleted state or pause admits work.
- Failed/lost submissions use a new request/thread identity on retry.
- Runtime acquisition occurs under the project lock or submission races pause/steering admission.
- CLI/native callers invent numeric SDK identities or silently change the legacy delegate interface.

## Current interface, unverified

Keep legacy `workers`, `steer` and `stop` unchanged. Add separate `thread-send`, `thread-steer`, `thread-stop`, `thread-history` and `legacy-thread-history` commands using the existing public host operations and ownership checks. Request identity is explicit; no automatic retries or replacement UUIDs. The host owns message/Unicode paging and frozen thread binding.

- `thread-send <project-id> <thread-id> <request-id> <text>`
- `thread-steer <project-id> <thread-id> <request-id> <text>`
- `thread-stop <project-id> <thread-id> --confirm <same-thread-id>`
- `thread-history <project-id> <thread-id> [message-offset] [Unicode-text-offset]`
- `legacy-thread-history <project-id> <retained-name> [message-offset] [Unicode-text-offset]`

History uses 30 messages and 4,000 Unicode characters per slice, prints the public structured response and its continuation metadata, and validates decimal offsets through the existing request schema. Retained names are never converted into invented UUIDs. Failed send/steer responses print the original thread/request identity and require inspection or exact same-text retry. Stop uses explicit same-thread confirmation. Existing legacy commands and `--no-start` are unchanged.

## Scoped worker submission, unverified

The new public `work-submit` operation accepts only an owned project, existing workspace scope, thread UUID, request UUID and text. It uses the same official Durable planning/dispatcher path as coordinator delegation, with worker role fixed and work identity equal to request identity. It does not create scopes, bind caller-provided paths or grant tools. Runtime acquisition is outside the project lock; current active-project/scope checks repeat inside it. Public plan admission now shares the existing schedule/submission mutex. Pause/frozen bindings, limits and missing-capability blockers remain in Durable planning and workspace preparation.

- CLI: `submit-scoped <project-id> <scope-id> <thread-id> <request-id> <task>`
- Native: `/project-submit-scoped <scope-id> <thread-id> <request-id> <task>`

Native exact request bodies are retained in custom session entries, without startup replay. Both clients preserve caller IDs in failed-response diagnostics. Legacy `delegate` remains separate and unchanged; it is not silently rerouted to Durable.

No CLI/native/host/model calls, typechecks or tests ran. No admission, authority race, pause, isolation, paging, lost-response or cancellation proof is established.

## Routine controls, unverified

These commands submit to the existing public Durable operations. They start no client timer or polling loop. Schedule/monitor IDs and start times are explicit and retained in failed-response diagnostics. Numeric arguments must be nonnegative safe decimal integers, then pass the public request schema. Provider bindings, event opt-in, pause, consumed one-shot restrictions and unresolved-write blockers remain backend checks.

```text
schedules <project-id> [--without-history]
schedule-history <project-id> <events|intents> [record-offset] [Unicode-text-offset]
monitors <project-id>
schedule-once <project-id> <schedule-id> <start-epoch-ms> <text> --confirm <project-id>
schedule-interval <project-id> <schedule-id> <start-epoch-ms> <interval-ms> <text> --confirm <project-id>
schedule-daily <project-id> <schedule-id> <start-epoch-ms> <IANA-zone> <HH:mm> <text> --confirm <project-id>
schedule-weekly <project-id> <schedule-id> <start-epoch-ms> <IANA-zone> <HH:mm> <days> <text> --confirm <project-id>
schedule-enable <project-id> <schedule-id> <true|false> --confirm <project-id>
event-opt-in <project-id> <true|false> --confirm <project-id>
monitor-create <project-id> <monitor-uuid> <repository-id> <numeric-repository-id> <PR-number> <pr|ci|review> <interval-ms> --confirm <project-id>
monitor-enable <project-id> <monitor-uuid> <true|false> --confirm <project-id>
```

History-free snapshots return retained event/intent counts without their text arrays. `schedule-history` prints 30 records with up to 4,000 Unicode characters per text/outcome slice and full-text hash/range metadata. Pages are live samples, not a stable historical cursor or current execution proof. Original recorded submission IDs remain unchanged. These reads do not replay work.

Weekly days are comma-separated integers, Sunday `0` through Saturday `6`, without duplicates. Calendar start time is an explicit not-before bound, not the caller's current clock. Calendar behavior/DST is still unverified. Schedule and monitor creation store disabled definitions. CLI creation still requires confirmation; enable separately to arm them. Monitor creation does not enable project event opt-in; opt in separately. Disabling retains schedule ticks and monitor cursor history. CLI confirmation adds no repository/tool/publication authority and does not resume the project.

No routine creation, enable/disable, snapshots, provider polls, model calls or tests ran. Local timers still require an awake Mac; these controls add no cloud or sleep execution.

## Owner setup, unverified

The host exposes `owner-setup-snapshot`, which returns active and retained workspace scopes/repositories, GitHub bindings, fixed profile metadata, skill grant summaries, configured-catalog availability, and separate workspace/GitHub/grants/profile revisions. Mutations require explicit same-project confirmation and the revision read from that snapshot. Workspace and GitHub revocation retain immutable identity history; they stop future admission and do not delete worktrees, receipts or remote objects. Revision conflicts require a fresh snapshot and new consent.

```text
owner-setup <project-id>
owner-workspaces <project-id>
owner-skills-catalog <project-id>
owner-skills-grants <project-id>
owner-command-profiles <project-id>
owner-github-inspect <project-id> <exact-owner/repository>
owner-profile-read <project-id> <profile-id>
owner-workspace-grant <project-id> <repository-id> <owner-checkout> <approved-root> <ownership-prefix> <files-json> <base-revision> <workspace-revision> --confirm <project-id>
owner-workspace-revoke <project-id> <scope-id> <workspace-revision> --confirm <project-id>
owner-github-authorize <project-id> <repository-id> <numeric-repository-id> <branch-prefix> <github-revision> --confirm <project-id>
owner-github-revoke <project-id> <repository-id> <github-revision> --confirm <project-id>
owner-profile-set <project-id> <profile-revision> <profile-json> --confirm <project-id>
owner-skill-grant <project-id> <catalog-revision> <grants-revision> <selection-json> --confirm <project-id>
owner-skill-revoke <project-id> <grant-id> <grants-revision> --confirm <project-id>
```

`owner-github-inspect` verifies the exact owner/repository against the selected checkout's credential-free origin, then performs the existing read-only GitHub repository GET to return the numeric ID and default branch. It does not create authorization. `profile-json` contains the exact `CommandProfileInput` shape. Its argv and executable are owner-entered fixed values; they are never model arguments. Set `enabled:false` to disable. Profile creation does not supply executable approval for deployment/destructive effects. `selection-json` follows `WorkerSkillGrantInput` and uses catalog IDs, not paths. The standalone host cannot access a trusted loaded configured-skill catalog, so only repository candidates are available. There is no provider plugin setup. Native setup is `O`; browser setup is the Owner setup button. Both use the same host request schemas and do not retain confirmation fields.

These routes and screens are implementation only. No owner grant, revocation, registration, provider request, test, build, typecheck or UI run was performed.
