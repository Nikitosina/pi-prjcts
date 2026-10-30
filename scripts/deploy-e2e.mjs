import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// Deploys a temporary clone of this repository on an isolated PI_PROJECTS_HOME; never the owner's checkout or home.
const repo = resolve(import.meta.dirname, ".."),
  base = mkdtempSync("/tmp/pdeploy-"),
  clone = join(base, "checkout");
process.env.PI_PROJECTS_HOME = join(base, "home");
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
execFileSync("git", ["clone", "-q", repo, clone]);
symlinkSync(join(repo, "node_modules"), join(clone, "node_modules"));
(git("config", "user.email", "t@example.com"), git("config", "user.name", "t"));
const { deploy, deployPending, hostDeps, inDeployWindow, idleDeployTick, readDeployState, recordHostSha, queueDeploy, clearQueuedDeploy } =
  await import("../src/deploy.ts");
const { health, request } = await import("../src/client.ts");
const told = [],
  commands = [];
// Generous budgets: a deploy on a busy machine takes a while to start the host.
const real = hostDeps(clone, { startAttempts: 300, smokeMs: 10_000 });
const deps = {
  ...real,
  stopHost: async () => (commands.push("stop host"), real.stopHost()),
  tell: async (text) => void told.push(text),
  run: async (command, args, cwd) => {
    commands.push(`${cwd === clone ? "checkout" : "check"}: ${[command, ...args].join(" ")}`);
    // npm ci would delete the node_modules this repository shares with the temporary checkout; the check worktree gets a link instead.
    if (command === "npm" && args[0] === "ci") {
      if (cwd !== clone && !existsSync(join(cwd, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(cwd, "node_modules"));
      return "";
    }
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
  },
};
const commit = (message) => git("commit", "-qam", message);
try {
  // 0. Without a recorded start sha there is no rollback target, so nothing deploys.
  await assert.rejects(deploy(deps), /unknown/);
  assert.equal(commands.length, 0);
  recordHostSha(git("rev-parse", "HEAD"));
  assert.equal(await deployPending(clone), false);

  // 1. First deploy starts the host from the checkout and records the sha.
  let result = await deploy(deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  const first = (await health()).pid;
  assert.equal(readDeployState().lastGood, git("rev-parse", "HEAD"));
  assert.match(
    told.at(-1),
    /^Pi Projects host · Deploy\nDeployed [0-9a-f]{8} \(.+\); the host passed/,
    "the notice says it is the host's and names the commit",
  );
  // The host records the sha it started from.
  assert.equal(await deployPending(clone), false);

  // 2. A lockfile change runs npm ci once, and the host restarts.
  appendFileSync(join(clone, "package-lock.json"), "\n");
  commit("lock");
  commands.length = 0;
  result = await deploy(deps);
  assert.equal(result.ok, true);
  // Install and check run in a separate worktree while the host is up; the checkout installs only after the stop.
  const stopAt = commands.indexOf("stop host");
  assert.equal(commands.filter((c) => c === "check: npm ci").length, 1);
  assert.ok(commands.indexOf("check: npm ci") < stopAt && commands.indexOf("check: npm run check") < stopAt);
  assert.ok(
    !commands.slice(0, stopAt).some((c) => c.startsWith("checkout: npm")),
    "the running host's checkout is untouched before the stop",
  );
  assert.equal(commands.filter((c) => c === "checkout: npm ci").length, 1);
  assert.ok(commands.indexOf("checkout: npm ci") > stopAt);
  assert.notEqual((await health()).pid, first);
  const good = git("rev-parse", "HEAD");

  // 3. A change that passes the check but cannot start rolls back to the recorded sha and restarts.
  const hostFile = join(clone, "src", "host.ts");
  writeFileSync(hostFile, readFileSync(hostFile, "utf8") + '\nif (Date.now() > 0) throw new Error("broken deploy");\n');
  commit("broken");
  result = await deploy(deps);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true, JSON.stringify(result));
  assert.equal(git("rev-parse", "HEAD"), good);
  assert.ok((await health()).pid > 0);
  assert.match(told.at(-1), /Rolled back/);
  assert.equal(readDeployState().lastGood, good);

  // 3b. Queued deploys are state the host reads at its next idle moment.
  queueDeploy();
  assert.ok(readDeployState().queuedAt > 0);
  clearQueuedDeploy();
  assert.equal(readDeployState().queuedAt, undefined);

  // 4. A dirty checkout is refused before anything stops.
  const pid = (await health()).pid;
  appendFileSync(join(clone, "README.md"), "dirty\n");
  await assert.rejects(deploy(deps), /uncommitted/);
  assert.equal((await health()).pid, pid);
  git("checkout", "--", "README.md");

  // 5. Windows and the idle trigger.
  const at = (hour) => new Date(2026, 0, 5, hour, 30);
  assert.ok(inDeployWindow(at(2)) && inDeployWindow(at(6)) && !inDeployWindow(at(7)) && !inDeployWindow(at(1)));
  assert.ok(inDeployWindow(at(23), { startHour: 22, endHour: 6 }) && inDeployWindow(at(3), { startHour: 22, endHour: 6 }));
  assert.ok(!inDeployWindow(at(12), { startHour: 22, endHour: 6 }));
  let started = 0;
  const tick = (hour, idle) => idleDeployTick({ now: at(hour), idle, pending: () => true, start: () => void started++ });
  assert.equal(await tick(12, () => true), "outside-window");
  assert.equal(await tick(3, () => false), "busy");
  assert.equal(await tick(3, () => Promise.reject(new Error("unknown"))), "busy");
  assert.equal(await tick(3, () => true), "started");
  assert.equal(await tick(4, () => true), "already-tried");
  assert.equal(started, 1);
  console.log("deploy-e2e ok");
} finally {
  await request({ action: "shutdown" }, false).catch(() => {});
  await new Promise((done) => setTimeout(done, 500));
  rmSync(base, { recursive: true, force: true });
}
