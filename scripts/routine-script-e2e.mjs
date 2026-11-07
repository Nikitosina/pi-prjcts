// E2E: script routines and the Coordinator routine tools (scripts/routine-script-failures.md S6-S16). Private host, fake model, temp project; scripts are tiny zsh commands.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { call, createKit, say } from "./lib/e2e-kit.mjs";
import { ACTION_POLICY } from "../src/host-agent-tools.ts";

const directive = (user) => {
  const match = /CO-ROUTINE (\{.*\})/.exec(user);
  return match ? JSON.parse(match[1]) : null;
};
const kit = await createKit("routine-script", {
  handler: ({ role, user, results }) => {
    if (role !== "coordinator") return undefined;
    const wanted = directive(user);
    if (wanted && !results.length) return call("projects_routines", wanted);
    return say(wanted ? `CO-RESULT ${results.at(-1)}` : "noted");
  },
});

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

  // S13: the Coordinator manages prompt routines itself through one toggleable tool, on by default.
  const toolsView = await rpc({ action: "profile-tools", projectId: id, profile: "coordinator" });
  const routinesGroup = toolsView.groups.find((group) => group.id === "routines");
  check(
    "S13 the routine tools are a switchable group, on by default",
    routinesGroup &&
      !routinesGroup.locked &&
      routinesGroup.tools.every((tool) => tool.enabled) &&
      routinesGroup.tools.some((tool) => tool.name === "projects_routines"),
    routinesGroup,
  );
  const routine = async (args) => {
    await kit.ask(id, `CO-ROUTINE ${JSON.stringify(args)}`);
    return JSON.parse(kit.toolResult("coordinator", `CO-ROUTINE ${JSON.stringify(args)}`));
  };
  const created = await routine({ action: "create", name: "Morning digest", text: "Summarize overnight CI.", atMs: soon, everyMs: hour });
  const snapshot = async () => (await rpc({ action: "schedule-snapshot", id })).schedules;
  const morning = (await snapshot()).find((item) => item.name === "Morning digest");
  check(
    "S13 the Coordinator creates a prompt routine",
    created.ok && morning?.text === "Summarize overnight CI." && morning.enabled === false,
    created,
  );
  await routine({ action: "enable", scheduleId: morning.id, enabled: true });
  const enabled = (await snapshot()).find((item) => item.id === morning.id);
  const retime = await routine({
    action: "update",
    scheduleId: morning.id,
    revision: enabled.revision,
    schedule: { atMs: soon, everyMs: 2 * hour },
  });
  const after = (await snapshot()).find((item) => item.id === morning.id);
  check("S13 the Coordinator turns a routine on and retimes it", retime.ok && after.enabled && after.everyMs === 2 * hour, retime);
  const listed = await routine({ action: "list" });
  check(
    "S13 list shows each routine's kind, timing and command or prompt",
    listed.ok &&
      listed.routines.some((item) => item.id === morning.id && item.kind === "prompt") &&
      listed.routines.some((item) => item.id === echo.id && item.kind === "script" && item.command === "echo changed") &&
      listed.routines.some((item) => item.kind === "cleanup"),
    listed,
  );
  const removed = await routine({ action: "delete", scheduleId: morning.id, revision: after.revision });
  check("S13 the Coordinator deletes a prompt routine", removed.ok && !(await snapshot()).some((item) => item.id === morning.id), removed);
  await routine({ action: "restore", scheduleId: morning.id });
  check(
    "S13 and restores it",
    (await snapshot()).some((item) => item.id === morning.id),
  );

  // S15: the cleanup routine stays.
  const cleanup = (await snapshot()).find((item) => item.action?.kind === "cleanup");
  const kept = await routine({ action: "delete", scheduleId: cleanup.id, revision: cleanup.revision });
  check("S15 the Coordinator cannot delete the cleanup routine", !kept.ok && /cannot be deleted/.test(kept.error), kept);

  // S16: run output is read back bounded.
  const loud = await rpc({
    action: "routine-script-create",
    id,
    name: "Loud",
    command: "yes LOUD-LINE | head -c 60000",
    atMs: soon,
    everyMs: hour,
  });
  const loudRun = await runOnce(loud.id);
  const outputArgs = { action: "output", scheduleId: loud.id, requestId: loudRun.requestId };
  await kit.ask(id, `CO-ROUTINE ${JSON.stringify(outputArgs)}`);
  const readCall = result.calls.findLast(
    (c) => c.role === "coordinator" && c.user.includes(JSON.stringify(outputArgs)) && c.results.length,
  );
  const read = readCall.results.at(-1);
  check(
    "S16 run output is cut to the response limit and says how to read more",
    readCall.resultLengths.at(-1) <= 8192 && read.includes("LOUD-LINE") && /"nextOffset":\d+/.test(read),
    { length: readCall.resultLengths.at(-1), head: read.slice(0, 200) },
  );

  // S14: scripts go through the owner; the approval is pinned to this project.
  const asked = await routine({
    action: "create_script",
    name: "Prune",
    command: "echo prune",
    atMs: soon,
    everyMs: hour,
    summary: "Prune caches nightly",
  });
  const pending = (await rpc({ action: "approvals-list" })).approvals.find(
    (item) => item.action === "routine-script-create" && item.state === "pending",
  );
  check(
    "S14 a Coordinator's script routine waits for the owner and targets its own project",
    asked.ok &&
      asked.approval &&
      pending?.input.id === id &&
      pending.input.command === "echo prune" &&
      !(await snapshot()).some((item) => item.name === "Prune"),
    { asked, pending },
  );
  await rpc({ action: "approval-decide", id: pending.id, decision: "approve" });
  check(
    "S14 after approval the script routine exists",
    (await snapshot()).some((item) => item.name === "Prune" && item.action?.command === "echo prune"),
  );
  const echoNow = (await snapshot()).find((item) => item.id === echo.id);
  await routine({
    action: "set_script",
    scheduleId: echo.id,
    revision: echoNow.revision,
    command: "echo sneaky",
    summary: "Change the echo",
  });
  check(
    "S14 a command change waits for the owner",
    (await snapshot()).find((item) => item.id === echo.id).action.command === "echo changed" &&
      (await rpc({ action: "approvals-list" })).approvals.some(
        (item) => item.action === "routine-script-set" && item.state === "pending" && item.input.id === id,
      ),
  );
});
