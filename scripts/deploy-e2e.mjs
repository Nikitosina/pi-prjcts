import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
const { deploy, hostDeps, inDeployWindow, idleDeployTick, readDeployState } = await import("../src/deploy.ts");
const { health, request } = await import("../src/client.ts");
const told = [],
  commands = [];
const deps = {
  ...hostDeps(clone, { startAttempts: 80, smokeMs: 3000 }),
  tell: async (text) => void told.push(text),
  run: async (command, args, cwd) => {
    commands.push([command, ...args].join(" "));
    // The temporary checkout shares this repository's node_modules, which npm ci would delete.
    if (command === "npm" && args[0] === "ci") return "";
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
  },
};
const commit = (message) => git("commit", "-qam", message);
try {
  // 1. First deploy starts the host from the checkout and records the sha.
  let result = await deploy(deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  const first = (await health()).pid;
  assert.equal(readDeployState().lastGood, git("rev-parse", "HEAD"));
  assert.match(told.at(-1), /Deployed/);

  // 2. A lockfile change runs npm ci once, and the host restarts.
  appendFileSync(join(clone, "package-lock.json"), "\n");
  commit("lock");
  commands.length = 0;
  result = await deploy(deps);
  assert.equal(result.ok, true);
  assert.equal(commands.filter((c) => c === "npm ci").length, 1);
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
