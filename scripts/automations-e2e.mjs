// E2E: schedule run now, edit, delete and restore (docs/ui2-contract.md "Automations"). Failure cases A1-A7 in
// scripts/ui2-backend-failures.md. Private host, fake model; the restore window is shortened through the environment.
import { createKit, say, delay } from "./lib/e2e-kit.mjs";

const RESTORE_MS = 4000;
let release;
const hold = new Promise((ok) => (release = ok));
const kit = await createKit("automations", {
  env: { PI_PROJECTS_SCHEDULE_RESTORE_MS: String(RESTORE_MS) },
  handler: ({ role, user }) => {
    if (role !== "coordinator") return undefined;
    if (user.includes("AUTO-HOLD"))
      return (async function* () {
        await hold;
        yield say("held run done");
      })();
    return say("scheduled run done");
  },
});

await kit.run(async () => {
  const { rpc, check, rejects, eventually, result } = kit;
  kit.initRepo();
  const id = await kit.createProject("Automations");
  const hour = 3_600_000,
    soon = Date.now() + hour;
  const list = async () => (await rpc({ action: "schedule-snapshot", id, includeHistory: false })).schedules;
  const find = async (scheduleId) => (await list()).find((item) => item.id === scheduleId);

  const named = await rpc({ action: "schedule-create", id, atMs: soon, everyMs: hour, text: "AUTO-ONE ping", name: "Hourly ping" });
  const plain = await rpc({ action: "schedule-create", id, atMs: soon, everyMs: hour, text: "AUTO-HOLD long run" });
  check("A1 a schedule has a name and revision 0", named.name === "Hourly ping" && named.revision === 0, named);
  check("A1 a schedule without a name reads null", plain.name === null && plain.revision === 0, plain);

  // Edit.
  check(
    "A2 a stale edit is refused",
    /revision/i.test((await rejects({ action: "schedule-update", id, scheduleId: named.id, revision: 3, name: "Nope" })) ?? ""),
  );
  check("A2 a refused edit changes nothing", (await find(named.id)).name === "Hourly ping");
  const later = soon + hour;
  const edited = await rpc({
    action: "schedule-update",
    id,
    scheduleId: named.id,
    revision: 0,
    name: "Renamed",
    text: "AUTO-TWO ping",
    schedule: { atMs: later, everyMs: 2 * hour },
  });
  check(
    "A2 an edit changes name, prompt and timing and bumps the revision",
    edited.name === "Renamed" &&
      edited.text === "AUTO-TWO ping" &&
      edited.everyMs === 2 * hour &&
      edited.nextAtMs === later &&
      edited.revision === 1,
    edited,
  );
  const enabled = await rpc({ action: "schedule-enable", id, scheduleId: named.id, enabled: true });
  check("A7 toggling bumps the revision", enabled.revision === 2, enabled);
  check(
    "A7 an edit from before the toggle is refused",
    (await rejects({ action: "schedule-update", id, scheduleId: named.id, revision: 1, name: "Old read" })) !== null,
  );

  // Run now.
  const before = result.calls.length;
  const run = await rpc({ action: "schedule-run", id, scheduleId: plain.id });
  check("A4 run now records a schedule run", run.kind === "schedule" && run.stableId === plain.id, run);
  await eventually(
    async () => result.calls.slice(before).some((call) => call.role === "coordinator" && call.user.includes("AUTO-HOLD")),
    "the disabled schedule ran now",
  );
  check(
    "A4 a second run while one is in flight is refused",
    /running|in flight|already/i.test((await rejects({ action: "schedule-run", id, scheduleId: plain.id })) ?? ""),
  );
  release();
  await kit.settle(id);
  const history = await rpc({ action: "schedule-history", id, kind: "intents" });
  check(
    "A4 the run is in the schedule's history",
    history.routines.some((routine) => routine.routineId === plain.id && routine.recentRuns.length === 1),
    history.routines,
  );

  const once = await rpc({ action: "schedule-create", id, atMs: soon, text: "AUTO-ONCE ping" });
  await rpc({ action: "schedule-run", id, scheduleId: once.id });
  await kit.settle(id);
  check(
    "A3 rescheduling a consumed one-shot is refused",
    /one-shot|consumed/i.test(
      (await rejects({
        action: "schedule-update",
        id,
        scheduleId: once.id,
        revision: (await find(once.id)).revision,
        schedule: { atMs: later },
      })) ?? "",
    ),
  );

  // Delete and restore.
  const current = await find(named.id);
  check(
    "A5 a stale delete is refused",
    (await rejects({ action: "schedule-delete", id, scheduleId: named.id, revision: current.revision - 1 })) !== null,
  );
  const deleted = await rpc({ action: "schedule-delete", id, scheduleId: named.id, revision: current.revision });
  check("A5 delete returns the deleted record", JSON.stringify(deleted.schedule) === JSON.stringify(current), deleted);
  check("A5 a deleted schedule is no longer listed", !(await find(named.id)));
  const restored = await rpc({ action: "schedule-restore", id, scheduleId: named.id });
  check("A6 restore brings the exact record back", JSON.stringify(restored) === JSON.stringify(current), { restored, current });
  check("A6 the restored schedule is listed and enabled", (await find(named.id))?.enabled === true);
  check("A6 restoring over a live id is refused", (await rejects({ action: "schedule-restore", id, scheduleId: named.id })) !== null);
  check(
    "A6 restoring an id never deleted is refused",
    (await rejects({ action: "schedule-restore", id, scheduleId: "never-deleted" })) !== null,
  );
  await rpc({ action: "schedule-delete", id, scheduleId: named.id, revision: restored.revision });
  await delay(RESTORE_MS + 500);
  check(
    "A6 restore after the window is refused",
    /window|expired|no deleted/i.test((await rejects({ action: "schedule-restore", id, scheduleId: named.id })) ?? ""),
  );
});
