// The simulator plugin's worker boot/shutdown and its cleanup step without a host: a fake simslim, a temp HOME for the device folders,
// real leases (plugins/simulator/FAILURES.md, "Worker boot and shutdown by the lease holder" W1-W9, "Parallel-testing clones" X4, X6, X7).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as typebox from "typebox";
import * as value from "typebox/value";
import * as durable from "@earendil-works/pi-durable";
import { ResourceLeases } from "../src/resource-leases.ts";
import { createSimulators, leaseName, simulatorResource } from "../plugins/simulator/simulator.ts";
import { createSimulatorTools } from "../plugins/simulator/tools.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "simulator-worker-")));
const projectId = randomUUID(),
  udid = randomUUID().toUpperCase(),
  source = randomUUID().toUpperCase();
const projectDir = join(base, "project"),
  state = join(base, "simslim.json"),
  calls = join(base, "simslim-calls.jsonl"),
  stuck = join(base, "delete-stuck");
mkdirSync(projectDir);
// The plugin finds clone folders under ~/Library/Developer/CoreSimulator/Devices; HOME points at the temp folder.
process.env.HOME = join(base, "home");
const device = join(process.env.HOME, "Library/Developer/CoreSimulator/Devices", udid);
mkdirSync(device, { recursive: true });
const name = `pi-projects ${projectId.slice(0, 8)} clone`;
writeFileSync(
  state,
  JSON.stringify([
    { udid, name, state: "Shutdown", osVersion: "18.0", set: "default" },
    { udid: source, name: "iPhone 16", state: "Shutdown", osVersion: "18.0", set: "default" },
  ]),
);
const simslim = join(base, "simslim");
writeFileSync(
  simslim,
  `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const [command, udid] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const devices = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const set = (value) => { for (const item of devices) if (item.udid === udid) item.state = value; writeFileSync(${JSON.stringify(state)}, JSON.stringify(devices)); };
if (command === "list") process.stdout.write(JSON.stringify(devices));
else if (command === "on") set("Booted");
else if (command === "shutdown") { set("Shutdown"); process.stdout.write("{}"); }
else if (command === "delete") { if (!require("node:fs").existsSync(${JSON.stringify(stuck)})) writeFileSync(${JSON.stringify(state)}, JSON.stringify(devices.filter((item) => item.udid !== udid))); process.stdout.write("{}"); }
else if (command === "status") process.stdout.write(JSON.stringify({ managedDisabled: 1, managedTotal: 1, booted: devices.find((item) => item.udid === udid)?.state === "Booted", persistent: true, verdict: "slim" }));
else { process.stderr.write("unexpected " + command); process.exit(2); }
`,
);
chmodSync(simslim, 0o755);
process.env.PI_PROJECTS_SIMSLIM = simslim;
const facts = lstatSync(device);
writeFileSync(
  join(projectDir, "simulator.json"),
  JSON.stringify({
    version: 2,
    projectId,
    enabled: true,
    sourceUdid: source,
    owned: [
      { udid, name, sourceUdid: source, directory: realpathSync(device), device: facts.dev, inode: facts.ino, born: facts.birthtimeMs },
    ],
    pending: null,
    uncertain: null,
    receipts: {},
  }),
);

// Leases as plugins.ts hands them to plugins; acquire calls are logged to prove no maintenance lease is taken.
const leases = new ResourceLeases();
leases.addNaming(leaseName);
const acquired = [];
const api = {
  lib: { typebox, value, durable },
  projects: { load: () => ({ id: projectId, deleted: false, archived: false }), dir: () => projectDir },
  leases: {
    acquire: (resource, holder, ttlMs) => {
      acquired.push(resource);
      return leases.acquire(resource, { projectId: holder.projectId, threadId: `plugin:simulator:${holder.owner}` }, ttlMs);
    },
    release: (resource, holder) => leases.release(resource, { projectId: holder.projectId, threadId: `plugin:simulator:${holder.owner}` }),
    held: (match) => leases.held(match),
  },
};
const simulators = createSimulators(api);
const tools = createSimulatorTools(api, simulators);
const worker = (threadId, conversationId) => tools.worker({ projectId, threadId, conversationId });
const boot = (threadId, conversationId) => worker(threadId, conversationId).find((tool) => tool.name === "projects_worker_simulator_boot");
const simslimCalls = () =>
  readFileSync(calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const effects = () => simslimCalls().filter(([command]) => command === "on" || command === "shutdown");
const stateOf = () => JSON.parse(readFileSync(state, "utf8")).find((item) => item.udid === udid).state;
const call = (threadId, conversationId, args, callId = randomUUID()) =>
  boot(threadId, conversationId).execute(args, { conversationId, callId }, { abortSignal: undefined });
writeFileSync(calls, "");

try {
  const action = tools
    .coordinator({ projectId, isCoordinator: () => true })
    .tools.find((tool) => tool.name === "projects_simulator_action");
  await assert.rejects(
    () => action.execute({ operation: "create", requestId: randomUUID() }, { conversationId: 1 }),
    /sourceUdid/,
    "Create without sourceUdid must be refused, even with a legacy source saved",
  );
  const snapshot = await simulators.snapshot(projectId);
  assert.ok(!("sourceUdid" in snapshot || "defaultSourceUdid" in snapshot));
  assert.ok(boot("job-a", 7), "the worker gets projects_worker_simulator_boot");

  // W1 no lease, no effect.
  await assert.rejects(() => call("job-a", 7, { operation: "boot" }), /lease/i, "W1 a worker without the lease is refused");
  assert.equal(effects().length, 0, "W1 simslim did not run");

  // W2 the holder boots with its own lease; no maintenance lease is taken and the holder keeps its lease.
  assert.ok((await leases.acquire(simulatorResource(udid), { projectId, threadId: "job-a" }, 600_000)).acquired);
  const booted = await call("job-a", 7, { operation: "boot" });
  assert.equal(stateOf(), "Booted", "W2 the clone booted");
  assert.deepEqual(
    readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((args) => args[0] === "on"),
    ["on", udid],
    "No exclusions by default",
  );
  assert.match(booted.output[0].text, /Booted/, "W2 the answer reports the booted state");
  assert.deepEqual(acquired, [], "W2 no maintenance lease was requested");
  assert.deepEqual(
    leases.held().map((item) => item.threadId),
    ["job-a"],
    "W2 the holder still holds its lease and nothing else does",
  );

  // W9 a replayed call does not run the effect again.
  const replayId = randomUUID();
  await call("job-a", 7, { operation: "shutdown" }, replayId);
  const before = effects().length;
  await call("job-a", 7, { operation: "shutdown" }, replayId);
  assert.equal(effects().length, before, "W9 a replay finds its receipt");
  // W3 shutdown confirmed.
  assert.equal(stateOf(), "Shutdown", "W3 the clone is shut down");

  // W4 reboot: shutdown, then boot.
  await call("job-a", 7, { operation: "boot" });
  writeFileSync(calls, "");
  await call("job-a", 7, { operation: "reboot" });
  assert.deepEqual(
    effects().map(([command]) => command),
    ["shutdown", "on"],
    "W4 reboot shuts down, then boots",
  );
  assert.equal(stateOf(), "Booted", "W4 the clone is booted after a reboot");

  // W5 another worker cannot act on a clone it does not hold.
  writeFileSync(calls, "");
  await assert.rejects(() => call("job-b", 8, { operation: "shutdown" }), /lease/i, "W5 another worker is refused");
  assert.equal(effects().length, 0, "W5 no effect");

  // W6 the lease-holder path reaches only boot and shutdown.
  for (const operation of ["create", "reset", "delete", "erase"])
    await assert.rejects(
      () => simulators.act(projectId, operation, randomUUID(), { udid }, { kind: "leaseHolder", threadId: "job-a" }),
      /Coordinator/,
      `W6 ${operation} is not a worker operation`,
    );

  // W7 the Coordinator stays refused while a worker leases the clone.
  await assert.rejects(
    () => simulators.act(projectId, "shutdown", randomUUID(), { udid }),
    /leased by thread job-a/,
    "W7 the Coordinator is refused",
  );

  // W8 a worker tool belongs to its own conversation.
  await assert.rejects(
    () => boot("job-a", 7).execute({ operation: "boot" }, { conversationId: 9, callId: randomUUID() }, { abortSignal: undefined }),
    /another worker conversation/,
    "W8 another conversation is refused",
  );
  // X4, X6 the cleanup step deletes this project's stray testing clones only while management is on, and only confirmed deletions count.
  const stray = randomUUID().toUpperCase(),
    foreign = randomUUID().toUpperCase();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  for (const id of [stray, foreign]) {
    const folder = join(process.env.HOME, "Library/Developer/XCTestDevices", id);
    mkdirSync(join(folder, "data"), { recursive: true });
    writeFileSync(join(folder, "device.plist"), "plist");
    for (const path of [join(folder, "device.plist"), join(folder, "data")]) utimesSync(path, twoDaysAgo, twoDaysAgo);
  }
  writeFileSync(
    state,
    JSON.stringify([
      ...JSON.parse(readFileSync(state, "utf8")),
      {
        udid: stray,
        name: `Clone 2 of pi-projects ${projectId.slice(0, 8)} ${randomUUID()}`,
        state: "Shutdown",
        osVersion: "18.0",
        set: "testing",
      },
      { udid: foreign, name: "Clone 2 of iPhone 16", state: "Shutdown", osVersion: "18.0", set: "testing" },
    ]),
  );
  const listed = (id) => JSON.parse(readFileSync(state, "utf8")).some((item) => item.udid === id);
  const deletes = () => simslimCalls().filter(([command]) => command === "delete");
  const store = JSON.parse(readFileSync(join(projectDir, "simulator.json"), "utf8"));
  // X7 a project that never used simulators does not run simslim (a host without it would fail every cleanup).
  rmSync(join(projectDir, "simulator.json"));
  writeFileSync(calls, "");
  assert.equal(await simulators.eraseIdle(projectId, 7, new AbortController().signal), "", "X7 no simulator state: nothing happens");
  assert.equal(await simulators.usage(projectId, 7, new AbortController().signal), null, "X7 no simulator state: no Storage row");
  assert.equal(simslimCalls().length, 0, "X7 simslim did not run");
  writeFileSync(join(projectDir, "simulator.json"), JSON.stringify({ ...store, enabled: false }));
  writeFileSync(calls, "");
  assert.equal(await simulators.eraseIdle(projectId, 7, new AbortController().signal), "", "X4 management off: nothing happens");
  assert.equal(deletes().length, 0, "X4 management off: no delete");
  writeFileSync(join(projectDir, "simulator.json"), JSON.stringify(store));
  writeFileSync(stuck, "");
  await assert.rejects(
    () => simulators.eraseIdle(projectId, 7, new AbortController().signal),
    /not confirmed/,
    "X4 a clone still listed after delete is a failure",
  );
  rmSync(stuck);
  const summary = await simulators.eraseIdle(projectId, 7, new AbortController().signal);
  assert.match(summary, /deleted 1 stray testing clone/, "X6 the summary counts deleted testing clones");
  assert.ok(!listed(stray) && listed(foreign), "X4 only this project's stray is gone");
  assert.ok(
    deletes().every(([, id]) => id === stray),
    "X4 simslim deletes only the stray",
  );
  // Y1 a persisted uncertain outcome or an interrupted pending write is reported as unresolved (the host refuses a plugin disable on it),
  // while the lifecycle pause itself still works, so restoring or recovering the project is not blocked.
  {
    const saved = readFileSync(join(projectDir, "simulator.json"), "utf8");
    const stored = JSON.parse(saved);
    assert.equal(simulators.unresolved(projectId), null, "Y1 a settled store reports nothing");
    writeFileSync(join(projectDir, "simulator.json"), JSON.stringify({ ...stored, uncertain: "Simulator boot outcome is unknown." }));
    assert.match(simulators.unresolved(projectId) ?? "", /unknown/i, "Y1 an uncertain outcome is reported");
    simulators.pause(projectId)();
    writeFileSync(
      join(projectDir, "simulator.json"),
      JSON.stringify({ ...stored, pending: { requestId: randomUUID(), operation: "boot", udid, sourceUdid: null } }),
    );
    assert.match(simulators.unresolved(projectId) ?? "", /interrupted/i, "Y1 an interrupted write is reported");
    simulators.pause(projectId)();
    writeFileSync(join(projectDir, "simulator.json"), saved);
    assert.equal(simulators.unresolved(projectId), null);
  }
  // Y2 a pause held by a plugin disable survives another lifecycle pause being taken and resumed (and a resume called twice).
  {
    const held = simulators.pause(projectId);
    const other = simulators.pause(projectId);
    other();
    other();
    const configure = () => simulators.configure(projectId, { enabled: true, requestId: randomUUID() });
    await assert.rejects(configure, /lifecycle is changing/, "Y2 the held pause stays");
    held();
    await configure();
  }
  console.log("simulator-worker-unit: ok");
} finally {
  rmSync(base, { recursive: true, force: true });
}
