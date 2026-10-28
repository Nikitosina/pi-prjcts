# Worker-owned verification: failure cases

Recorded before implementation. Exercise the isolated host with the fake-provider seam and inspect persisted state and reports.

- A worker turn without a verification request starts a verifier, spends an attempt, or satisfies a dependency as completed.
- A worker cannot request exactly one fresh host-selected verifier for its current candidate, or the coordinator must approve each attempt.
- A duplicate, premature, nested, unauthorized or stale request starts work, changes the target or changes frozen criteria, model, skill or budget.
- A failed verifier does not return its evidence to the same worker, or a repaired candidate cannot be checked by a fresh explicit request.
- A missing verifier resource or exhausted budget is hidden, silently reset or treated as completion. Restart, settings changes and follow-ups must preserve finality.
- Worker writes, children, background jobs or leases overlap verification, or cleanup and final drift validation are skipped before repair.
- Parent and dependency barriers fail, or stale delayed feedback creates another attempt or corrupts a later result.
- An existing open cycle or frozen worker context is silently migrated, reset or given tools inconsistent with its frozen instructions.
- Default, customized, new or reopened worker and coordinator contexts lose owner text or do not receive their applicable workflow instructions and tools.
- The coordinator cannot inspect a blocker and continue the same worker for an authorized repair, or archives unresolved work without retaining its history.
- The verifier treats author evidence as independent execution, adds future coordinator review as an unstated gate, or fails to judge each frozen criterion on its own evidence.
