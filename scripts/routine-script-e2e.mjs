// E2E: script routines (scripts/routine-script-failures.md S6-S12). Private host, fake model, temp project; scripts are tiny zsh commands.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createKit, say } from "./lib/e2e-kit.mjs";
import { ACTION_POLICY } from "../src/host-agent-tools.ts";

const kit = await createKit("routine-script", { handler: ({ role }) => (role === "coordinator" ? say("noted") : undefined) });

await kit.run(async () => {
  const { rpc, check, rejects, eventually, result } = kit;
  kit.initRepo();
  const id = await kit.createProject("Scripts");
  const hour = 3_600_000,
    soon = Date.now() + hour;
  const runs = async (scheduleId) =>
    (await rpc({ action: "schedule-history", id, kind: "intents" })).items.filter((item) => item.stableId === scheduleId);
  const runOnce = async (scheduleId) => {
    const before = (await runs(scheduleId)).length;
    await rpc({ action: "schedule-run", id, scheduleId });
    return eventually(
      async () => {
        const items = await runs(scheduleId);
        return items.length > before && items.at(-1).outcome !== null && items.at(-1);
      },
      "a finished script run",
      300,
    );
  };

  // S6, S7: the exact command runs in the project folder with the checkout and cache root, and its output is kept.
  const command = `echo "  spaced  "; printf '%s\\n' "$PI_OWNER_CHECKOUT" "$PI_WORKSPACE_CACHE_ROOT" "$PWD"`;
  const echo = await rpc({ action: "routine-script-create", id, name: "Echo", command, atMs: soon, everyMs: hour });
  check(
    "S1 a script routine stores its command exactly with the default timeout",
    JSON.stringify(echo.action) === JSON.stringify({ kind: "script", command, timeoutMs: 600_000 }) && echo.text === "",
    echo,
  );
  const done = await runOnce(echo.id);
  check(
    "S7 a run records exit 0 and its duration",
    done.status === "submitted" && done.outcome === "completed" && /exit 0/.test(done.summary) && Number.isInteger(done.durationMs),
    done,
  );
  const output = await rpc({ action: "schedule-output", id, scheduleId: echo.id, requestId: done.requestId });
  const projectDir = join(kit.home, id);
  check(
    "S6 the script ran in the project folder with the owner checkout and the cache root",
    output.text === `  spaced  \n${realpathSync(kit.workspace)}\n${join(projectDir, "workspace-cache")}\n${projectDir}\n` &&
      output.truncated === false,
    output,
  );

  // S11: the command is not a prompt; only routine-script-set changes it. Timing changes freely.
  check(
    "S11 a script command cannot be changed through the prompt edit",
    /prompt/i.test(
      (await rejects({ action: "schedule-update", id, scheduleId: echo.id, revision: echo.revision, text: "rm -rf /" })) ?? "",
    ),
  );
  const retimed = await rpc({
    action: "schedule-update",
    id,
    scheduleId: echo.id,
    revision: echo.revision,
    schedule: { atMs: soon, everyMs: 2 * hour },
  });
  const changed = await rpc({
    action: "routine-script-set",
    id,
    scheduleId: echo.id,
    revision: retimed.revision,
    command: "echo changed",
    timeoutMs: 120_000,
  });
  check(
    "S11 routine-script-set changes the command and timeout and bumps the revision",
    changed.action.command === "echo changed" &&
      changed.action.timeoutMs === 120_000 &&
      changed.revision === retimed.revision + 1 &&
      changed.everyMs === 2 * hour,
    changed,
  );

  // S8: a failing run sends its output tail to Main; the successful one did not.
  const fail = await rpc({
    action: "routine-script-create",
    id,
    name: "Nightly check",
    command: 'echo "FAIL-TAIL-MARK"; exit 4',
    atMs: soon,
    everyMs: hour,
  });
  const failed = await runOnce(fail.id);
  check("S7 a failing run is failed with its exit code", failed.status === "failed" && /exit 4/.test(failed.outcome), failed);
  const notice = await eventually(
    async () => result.calls.find((call) => call.role === "coordinator" && call.user.includes("FAIL-TAIL-MARK")),
    "the failure notice reached the coordinator",
    300,
  );
  check(
    "S8 the failure notice names the routine and carries the output tail; the successful run posted nothing",
    /Nightly check/.test(notice.user) && /exit 4/.test(notice.user) && !result.calls.some((call) => call.user.includes("  spaced  ")),
    notice.user,
  );

  // S9: runs never overlap.
  const slow = await rpc({ action: "routine-script-create", id, name: "Slow", command: "sleep 3", atMs: soon, everyMs: hour });
  await rpc({ action: "schedule-run", id, scheduleId: slow.id });
  check(
    "S9 a second run while one is running is refused",
    /in flight/i.test((await rejects({ action: "schedule-run", id, scheduleId: slow.id })) ?? ""),
  );
  await eventually(async () => (await runs(slow.id)).at(-1)?.outcome === "completed", "the slow run finished", 300);

  // S10: a paused project runs no scripts.
  await rpc({ action: "pause", id });
  const paused = await runOnce(echo.id);
  check("S10 a paused project does not run the script", paused.status === "interrupted" && /paused/i.test(paused.outcome), paused);
  await rpc({ action: "resume", id, confirm: id });

  // S12: agents need the owner's approval to create a script routine or change its command, not for timing or on/off.
  check(
    "S12 the Host agent's script creation and command changes are dangerous; timing and on/off are not",
    ACTION_POLICY["routine-script-create"]?.kind === "dangerous" &&
      ACTION_POLICY["routine-script-set"]?.kind === "dangerous" &&
      ACTION_POLICY["schedule-update"]?.kind === "allow" &&
      ACTION_POLICY["schedule-enable"]?.kind === "allow" &&
      ACTION_POLICY["schedule-output"]?.kind === "allow",
  );
});
