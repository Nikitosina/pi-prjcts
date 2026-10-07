# Host owner acquisition

Implementation only. Verification remains suspended.

## Failure cases recorded before implementation

- A snapshot, message, decision, schedule or event route opens Durable storage/runtime while holding the project lock.
- Slow initialization prevents pause/settings/lifecycle admission from taking the lock.
- A runtime closes or is replaced between acquisition and the locked operation, then the stale owner receives work.
- Moving acquisition removes current project/authority/transition checks.
- Legacy message routing opens a coordinator under the same project lock or adopts a newly migrated project.
- Provider transport, model waits or abort/drain waits move into the project lock.

## Preflight failure cases recorded before implementation

- A request already denied by inactive state or invalid confirmation opens a runtime before failing.
- Preflight alone permits authority to change during acquisition, without repeating validation under the lock.
- A stale opening's rejected promise removes a replacement owner's map entry.

## Current implementation, unverified

`withDurableOwner` acquires the existing official owned runtime outside the project lock. It validates project identity before acquisition and repeats it under the lock, then requires the exact captured opening promise to remain in the host's runtime map. A closed/replaced owner cannot silently receive the operation.

Plan/receipt/approval snapshots, approval records/decisions, schedule/event/monitor controls, thread follow-ups, scoped worker submission and Durable messaging now use this helper. Their existing active-project, pause and authority checks remain in the locked local operation or its Durable transaction. Provider transport and thread stop/steering/lifecycle abort/drain remain outside project locks.

Write routes with pre-existing inactive/confirmation checks now validate before acquisition and repeat validation under the lock. This covers decisions, follow-ups, messages, monitor creation and scoped admission; read-only retained snapshots remain available. Opening-promise rejection deletes a map entry only if that exact promise is still current, never a replacement.

Legacy messaging checks ownership/active state before acquiring its coordinator outside the lock, then checks the exact owner promise and runtime kind before saving/pumping its job. It cannot silently adopt a migrated project.

No new owner, storage implementation, replay, authority or runtime fallback. No host/model/provider calls, typechecks or E2Es ran. No lock-contention, shutdown, settings/auth transition or replacement-owner race proof is established.
