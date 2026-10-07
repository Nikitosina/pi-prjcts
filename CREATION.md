# Creation request identity

Implementation only. Verification remains suspended.

## Failure cases recorded before implementation

- A lost creation response followed by the same request produces another project.
- Concurrent calls with one request ID overwrite each other or reset current settings.
- Reusing a request ID with changed name, workspace, objective, model or knowledge grant silently retargets it.
- A colliding legacy/project UUID or partial directory is overwritten or adopted without an original creation binding.
- A workspace symlink changes between attempts and retargets the owned project.
- Retrying initialization restores deleted/archived state, starts work, or acquires a runtime under a project lock.
- A partial initialization failure replaces its retained project or erases existing knowledge.

## Client failure cases recorded before wiring

- Old unresolved client-only UUIDs are reclassified as backend-bound requests and create duplicates.
- Restoring a draft/session entry automatically retries or restores consent.
- Retrying changes the originally submitted name, workspace, objective, model or grants.
- A retry response names a different project UUID or switches a superseded selection.
- Native retries infer requests from ordinary messages or entries outside the current session branch.

## CLI failure cases recorded before wiring

- Adding retry syntax changes the existing `create <name> <workspace> [objective]` argument meaning.
- A retry silently generates another UUID or drops fields from a native/browser request.
- A failed command reports no retained request identity, encouraging replacement creation.

## Current API implementation, unverified

An optional owner creation request UUID also identifies its new project. Its immutable request fingerprint is stored in the project record. Exact retries reuse that project without resetting settings, granting execution, restoring or resuming. Changed inputs and unrelated/partial UUID collisions are blocked. Calls without a request UUID keep the historical unique-project behavior.

`create` now accepts optional `requestId`. Its UUID becomes the new project UUID; `Project.creation` retains the request ID and SHA-256 fingerprint. Input hashing distinguishes explicit model/grant choices from omitted defaults. Workspace metadata resolves before the project lock; record admission/reuse is serialized by that UUID. Existing directories and metadata must be regular owned records with the same creation binding. Changed fingerprints, unrelated UUID collisions and changed canonical workspace targets are rejected without replacing files.

Knowledge initialization remains outside the project lock and uses its existing idempotent locking. Archived/deleted retries return retained state without initializing knowledge or restoring/resuming. Reused requests return current project metadata without resetting models, settings, instructions or grants. Creation opens no Durable runtime and requests no model. Calls without `requestId` retain unique-project behavior.

New browser creation drafts now send their retained UUID as `requestId`. Stored `requestBound` distinguishes these requests from older client-only drafts. Bound unknown outcomes offer an explicitly consented exact retry; old unbound unknown outcomes stay blocked. Consent is not persisted, fields stay pinned, and the returned UUID must match the request.

Native creation records its schema-validated exact request in a Pi custom session entry before transport. `/project-create-retry <UUID>` reads only matching entries on the current session branch, rejects conflicting bindings, requires fresh interactive confirmation, and reuses the stored request unchanged. No request is inferred from ordinary messages, adopted from an old unbound creation, or replayed on session startup. Superseded selections cannot be attached by the response. CLI `create-once <request-uuid> <name> <workspace> [objective]` now exposes the same API identity and includes the UUID in failed-response diagnostics. Existing `create` syntax is unchanged. The CLI does not reconstruct richer native/browser requests or silently omit their explicit model/grant fields. `--no-start` retains its existing behavior.

No unit tests, typechecks, CLI/host calls or E2Es ran. No creation concurrency, lost-response, symlink or restart proof is established.
