// Benchmark (not part of verify): jobs-snapshot latency and the host's idle CPU per notifier tick on a project with many ended agents and a few live ones.
// Usage: node scripts/jobs-snapshot-bench.mjs [agents=400] [live=4] [idleSeconds=30]. Prints JSON; set BENCH_OUT to also save it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, call, say } from "./lib/e2e-kit.mjs";

const [total = 400, live = 4, idleSeconds = 30] = process.argv.slice(2).map(Number);
const releases = [];
const kit = await createKit("jobs-snapshot-bench", {
  handler: ({ role, user, results }) => {
    if (role === "scout" && user.includes("HOLD-LIVE"))
      return (async function* () {
        await new Promise((ok) => releases.push(ok));
        yield say("released");
      })();
    if (role === "coordinator" && user.includes("MARK-BULK")) {
      if (results.length >= total + live) return say("spawned");
      const index = results.length;
      return call("projects_delegate", {
        role: "scout",
        task: index < live ? `HOLD-LIVE ${index}` : `ENDED ${index}`,
        title: `bench ${index}`,
      });
    }
    return undefined;
  },
});
const cpuSeconds = (pid) => {
  const text = execFileSync("/bin/ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).trim();
  return text.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

await kit.run(async () => {
  kit.initRepo();
  const id = await kit.createProject("Bench");
  // A long-lived project carries a large owner-authorized scope list; parsing it dominates every project load.
  const file = join(kit.home, id, "project.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const [scope] = stored.workspaceAuthorization.scopes;
  scope.files = Array.from({ length: 1000 }, (_, index) => `src/module-${index}/file-${index}.ts`);
  writeFileSync(file, JSON.stringify(stored, null, 2));
  await kit.rpc({ action: "message", id, text: "MARK-BULK" });
  const snapshot = async () => (await kit.rpc({ action: "jobs-snapshot", id })).agents;
  await kit.eventually(
    async () => (await snapshot()).filter((agent) => agent.endedAt !== null).length >= total,
    "agents did not end",
    3000,
  );
  const agents = await snapshot();
  const times = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    await kit.rpc({ action: "jobs-snapshot", id });
    times.push(performance.now() - started);
  }
  const pid = (await kit.rpc()).pid;
  await kit.delay(3000);
  const before = cpuSeconds(pid);
  await kit.delay(idleSeconds * 1000);
  const idleCpu = cpuSeconds(pid) - before;
  const report = {
    agents: agents.length,
    ended: agents.filter((agent) => agent.endedAt !== null).length,
    jobsSnapshotMs: { median: Math.round(median(times)), min: Math.round(Math.min(...times)), max: Math.round(Math.max(...times)) },
    idleHostCpuSecondsPerSecond: Number((idleCpu / idleSeconds).toFixed(3)),
    idleHostCpuMsPerNotifierTick: Math.round((idleCpu / (idleSeconds / 3)) * 1000),
  };
  console.log(`BENCH ${JSON.stringify(report)}`);
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
  for (const release of releases) release();
});
