import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FAKE_MODEL, pinFakeRoles, startFakeModel } from "./fake-model.mjs";

// Deploys a temporary clone of this repository on an isolated PI_PROJECTS_HOME; never the owner's checkout or home.
const repo = resolve(import.meta.dirname, ".."),
  base = realpathSync(mkdtempSync("/tmp/pdeploy-")),
  clone = join(base, "checkout");
// Offline: the hosts this script starts see only the fake model.
const fake = await startFakeModel(join(base, "fake"));
process.env.PI_PROJECTS_HOME = join(base, "home");
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
execFileSync("git", ["clone", "-q", repo, clone]);
symlinkSync(join(repo, "node_modules"), join(clone, "node_modules"));
(git("config", "user.email", "t@example.com"), git("config", "user.name", "t"));
const { deploy, deployPending, hostDeps, inDeployWindow, idleDeployTick, readDeployState, recordHostSha } =
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
    // The same typecheck as `npm run check`, incremental across the deploys: a cold one per deploy fills the CI budget.
    if (command === "npm" && args.join(" ") === "run check")
      return execFileSync(
        join(cwd, "node_modules", ".bin", "tsc"),
        ["--noEmit", "--incremental", "--tsBuildInfoFile", join(base, "tsbuildinfo")],
        {
          cwd,
          encoding: "utf8",
        },
      ).trim();
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
  },
};
const commit = (message) => git("commit", "-qam", message);
const marks = join(base, "marks");
mkdirSync(marks);
const until = async (what, check, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await sleep(250);
  }
};
const show = (id) => request({ action: "show", id }, false);
const answerOf = (id, job) =>
  until(`job ${job} settles`, async () => {
    const view = await show(id);
    if (view.jobs.find((item) => item.id === job)?.state !== "done") return undefined;
    return JSON.stringify(view.messages.at(-1));
  });
/** A deploy whose stop starts `command` in the project's coordinator first and reports how long the stop held the host. */
async function deployDuring(project, command, mark) {
  let job, heldMs;
  const result = await deploy({
    ...deps,
    async stopForDeploy(sha) {
      job = (await request({ action: "message", id: project, text: `FAKE-CALL bash ${JSON.stringify({ command })}` })).id;
      await until(`${mark} starts`, async () => existsSync(join(marks, mark)));
      const started = Date.now();
      const stopping = await real.stopForDeploy(sha);
      heldMs = Date.now() - started;
      return stopping;
    },
  });
  return { result, job, heldMs };
}
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

  // 1b. A checkout that changed during preparation fails the deploy; the host keeps running and nothing is queued.
  const beforeRace = (await health()).pid;
  result = await deploy({ ...deps, stopForDeploy: async () => false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed during preparation/);
  assert.equal((await health()).pid, beforeRace);
  assert.equal(readDeployState().queuedAt, undefined);

  // 1c. Deploy is live: a tool call that ends inside the window finishes, the host stops right after it, and the turn continues.
  const live = await request({ action: "create", name: "pi-prjcts", cwd: clone, model: FAKE_MODEL });
  await pinFakeRoles(request, live.id);
  const other = await request({ action: "create", name: "Other", cwd: join(base, "marks"), model: FAKE_MODEL });
  let pid = (await health()).pid;
  let run = await deployDuring(live.id, `touch ${marks}/fast; sleep 3; echo FAST_DONE`, "fast");
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.ok(run.heldMs > 1500 && run.heldMs < 9000, `the stop waited for the short call only: ${run.heldMs} ms`);
  assert.notEqual((await health()).pid, pid);
  let answer = await answerOf(live.id, run.job);
  assert.match(answer, /FAST_DONE/);
  assert.doesNotMatch(answer, /interrupted/i);

  // 1d. A call longer than the window is cut off after 10 s, its process dies, and the turn continues after the start.
  pid = (await health()).pid;
  run = await deployDuring(live.id, `touch ${marks}/slow; sleep 61; echo SLOW_DONE`, "slow");
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.ok(run.heldMs >= 9500 && run.heldMs < 20_000, `the stop held the host for the window: ${run.heldMs} ms`);
  assert.notEqual((await health()).pid, pid);
  assert.equal(spawnSync("pgrep", ["-f", "sleep 61"]).stdout.toString().trim(), "", "the cut-off process is gone");
  answer = await answerOf(live.id, run.job);
  assert.match(answer, /interrupted/i, "the model learns its call was cut off");
  assert.doesNotMatch(answer, /SLOW_DONE/);

  // 1e. The pi-prjcts Coordinator redeploys itself without approval; its call returns after the restart with the outcome.
  assert.ok((await show(live.id)).coordinatorAccess.toolNames.includes("projects_redeploy"));
  assert.ok(!(await show(other.id)).coordinatorAccess.toolNames.includes("projects_redeploy"), "only the host's own project");
  pid = (await health()).pid;
  const selfJob = (await request({ action: "message", id: live.id, text: "FAKE-CALL projects_redeploy {}" })).id;
  answer = await answerOf(live.id, selfJob);
  assert.match(answer, new RegExp(`Deployed ${git("rev-parse", "HEAD").slice(0, 8)}`));
  assert.notEqual((await health()).pid, pid);
  const { lastResult } = readDeployState();
  assert.ok(lastResult.requestId, "the result names the call that asked for it");
  assert.equal(lastResult.stop.cutOff, 0, "its own call is not counted as running work");
  assert.ok(lastResult.stop.heldMs < 5000, `its own call does not hold the window: ${lastResult.stop.heldMs} ms`);

  // 2. A lockfile change runs npm ci once, and the host restarts.
  appendFileSync(join(clone, "package-lock.json"), "\n");
  commit("lock");
  commands.length = 0;
  result = await deploy(deps);
  assert.equal(result.ok, true, JSON.stringify(result));
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
  assert.match(result.reason, /^Projects host exited with code 1 before it answered/, "the start ends when the new host dies");
  assert.equal(git("rev-parse", "HEAD"), good);
  assert.ok((await health()).pid > 0);
  assert.match(told.at(-1), /Rolled back/);
  assert.equal(readDeployState().lastGood, good);

  // 4. A dirty checkout is refused before anything stops.
  pid = (await health()).pid;
  appendFileSync(join(clone, "README.md"), "dirty\n");
  await assert.rejects(deploy(deps), /uncommitted/);
  assert.equal((await health()).pid, pid);
  git("checkout", "--", "README.md");

  // 5. Windows and the nightly trigger, which deploys live like every other deploy.
  const at = (hour) => new Date(2026, 0, 5, hour, 30);
  assert.ok(inDeployWindow(at(2)) && inDeployWindow(at(6)) && !inDeployWindow(at(7)) && !inDeployWindow(at(1)));
  assert.ok(inDeployWindow(at(23), { startHour: 22, endHour: 6 }) && inDeployWindow(at(3), { startHour: 22, endHour: 6 }));
  assert.ok(!inDeployWindow(at(12), { startHour: 22, endHour: 6 }));
  let started = 0;
  const tick = (hour) => idleDeployTick({ now: at(hour), pending: () => true, start: () => void started++ });
  assert.equal(await tick(12), "outside-window");
  assert.equal(await tick(3), "started");
  assert.equal(await tick(4), "already-tried");
  assert.equal(started, 1);

  // 6. Following a branch (B1-B5): the deploy fetches origin/<branch>, checks it apart, and only then fast-forwards the checkout.
  // The rollback above left the checkout detached, as it does for the owner.
  const branch = "follow";
  git("checkout", "-q", "-B", branch);
  const upstream = join(base, "origin.git"),
    pusher = join(base, "pusher");
  execFileSync("git", ["clone", "-q", "--bare", clone, upstream]);
  git("remote", "set-url", "origin", upstream);
  git("fetch", "-q", "origin");
  git("branch", "-q", "--set-upstream-to", `origin/${branch}`);
  execFileSync("git", ["clone", "-q", "-b", branch, upstream, pusher]);
  const push = (file, text, message) => {
    writeFileSync(join(pusher, file), text);
    execFileSync("git", ["-C", pusher, "add", file]);
    execFileSync("git", ["-C", pusher, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", message]);
    execFileSync("git", ["-C", pusher, "push", "-q", "origin", branch]);
    return execFileSync("git", ["-C", pusher, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  const following = { ...deps, branch };
  const before = git("rev-parse", "HEAD");
  // B4: the nightly check sees the commit waiting on origin, which the local HEAD does not show.
  const merged = push("MERGED.md", "merged\n", "merged on origin");
  assert.equal(await deployPending(clone, undefined, branch), true);
  assert.equal(git("rev-parse", "HEAD"), before, "checking for new code does not move the checkout");
  // B5: without a branch nothing is fetched, so the local HEAD is all there is.
  assert.equal(await deployPending(clone), false);
  // B2: a commit that fails the check leaves the checkout and the host as they were.
  pid = (await health()).pid;
  const broken = push("src/broken-check.ts", "export const value: number = 'text';\n", "fails the check");
  result = await deploy(following);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.sha, broken);
  assert.match(result.reason, /preparation failed/);
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal((await health()).pid, pid);
  execFileSync("git", ["-C", pusher, "revert", "--no-edit", "HEAD"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  execFileSync("git", ["-C", pusher, "push", "-q", "origin", branch]);
  const fixed = execFileSync("git", ["-C", pusher, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // B3: local commits not on origin, another branch, or a dirty checkout are refused and left alone.
  appendFileSync(join(clone, "README.md"), "local only\n");
  commit("local only");
  const local = git("rev-parse", "HEAD");
  await assert.rejects(deploy(following), /not on origin/);
  assert.equal(git("rev-parse", "HEAD"), local);
  git("reset", "-q", "--hard", before);
  git("checkout", "-q", "-b", "side");
  await assert.rejects(deploy(following), new RegExp(`on side; deploys follow ${branch}`));
  git("checkout", "-q", branch);
  git("branch", "-q", "-D", "side");
  // B1: the newest origin commit is checked, the checkout fast-forwards to it and the host restarts on it.
  result = await deploy(following);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sha, fixed);
  assert.equal(git("rev-parse", "HEAD"), fixed);
  assert.ok(existsSync(join(clone, "MERGED.md")) && git("merge-base", "--is-ancestor", merged, "HEAD") === "");
  assert.notEqual((await health()).pid, pid);
  assert.equal(await deployPending(clone, undefined, branch), false);

  // 7. The web UI is the one the host started with (W1, ui2-web-failures S12): a change on disk waits for the restart.
  const web = new URL((await request({ action: "web" }, false)).url).origin;
  const served = async (path) => {
    const answer = await fetch(web + path);
    return { status: answer.status, etag: answer.headers.get("etag"), text: await answer.text() };
  };
  const chatFile = join(clone, "web", "chat.js"),
    original = readFileSync(chatFile, "utf8");
  const before8 = await served("/chat.js");
  assert.ok(before8.text === original, "the host serves web/chat.js as it is on disk at start");
  writeFileSync(chatFile, `${original}\n// pulled but not deployed\n`);
  const after8 = await served("/chat.js");
  assert.ok(after8.text === original, "a changed web file is not served by the host that started before it");
  assert.equal(after8.etag, before8.etag);
  commit("web change");
  result = await deploy(deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  const deployed8 = await served("/chat.js");
  assert.match(deployed8.text, /pulled but not deployed/, "the restarted host serves the new file");
  assert.notEqual(deployed8.etag, before8.etag);

  // 8. A pull that moves the host's own checkout deploys it at once (D1-D7). Its own home, so these fake deploys leave the host above alone.
  const hostHome = process.env.PI_PROJECTS_HOME,
    selfHome = join(base, "self-home");
  mkdirSync(selfHome);
  process.env.PI_PROJECTS_HOME = selfHome;
  try {
    const { pullMainCheckout, describeMainPull, watchSelfCheckout } = await import("../src/main-pull.ts");
    const { selfDeployer } = await import("../src/deploy.ts");
    const repoAt = (dir) => {
      execFileSync("git", ["init", "-q", "-b", "main", dir]);
      const g = (...args) =>
        execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
      const make = (name) => (
        writeFileSync(join(dir, name), `${name}\n`),
        g("add", name),
        g("commit", "-qm", name),
        g("rev-parse", "HEAD")
      );
      return { g, make };
    };
    const self = join(base, "self"),
      otherCheckout = join(base, "other-checkout");
    const s = repoAt(self),
      o = repoAt(otherCheckout);
    const c0 = s.make("c0");
    s.g("checkout", "-q", "-b", "incoming");
    const c1 = s.make("c1"),
      c2 = s.make("c2");
    s.g("checkout", "-q", "main");
    o.make("o0");
    o.g("checkout", "-q", "-b", "incoming");
    const o1 = o.make("o1");
    o.g("checkout", "-q", "main");
    let running = c0,
      closing = false,
      failStart = false;
    const starts = [],
      selfTold = [],
      reports = [];
    const deployFor = selfDeployer({
      head: () => s.g("rev-parse", "HEAD"),
      running: () => running,
      closing: () => closing,
      start: () => {
        if (failStart) throw new Error("spawn EACCES");
        // What the host's startDeploy records before the child takes the lock.
        writeFileSync(join(selfHome, "deploy.json"), JSON.stringify({ current: { requestId: `r${starts.length}`, at: Date.now() } }));
        starts.push(s.g("rev-parse", "HEAD"));
      },
      tell: async (text) => void selfTold.push(text),
      report: (text) => void reports.push(text),
      retryMs: 50,
    });
    const unwatch = watchSelfCheckout({
      root: join(self, "."),
      head: async () => s.g("rev-parse", "HEAD"),
      running: () => running,
      deploy: deployFor,
    });
    const ended = () => writeFileSync(join(selfHome, "deploy.json"), "{}");
    const quiet = new AbortController().signal;
    /** A provider whose pull fast-forwards the checkout to `to` (nothing when absent), or skips with a reason. */
    const provider = (to, skip) => ({
      pullMain: async ({ checkout }) => {
        if (skip) return { pulled: false, reason: skip };
        if (to) execFileSync("git", ["-C", checkout, "merge", "-q", "--ff-only", to]);
        return { pulled: true };
      },
    });
    const pull = (checkout, to, skip) => pullMainCheckout({ provider: provider(to, skip), checkout, base: "main", signal: quiet });

    // D2: a no-op pull, a skipped pull and a pull of another project's checkout start nothing.
    let outcome = await pull(self);
    assert.deepEqual(outcome, { pulled: true }, "an up-to-date pull is only a pull");
    outcome = await pull(self, undefined, "the checkout has uncommitted changes");
    assert.equal(outcome.deploy, undefined);
    outcome = await pull(otherCheckout, o1);
    assert.equal(outcome.pulled, true);
    assert.equal(outcome.deploy, undefined, "another project's checkout never deploys the host");
    assert.equal(starts.length, 0);

    // D1 and D3: two pulls that each move the checkout start exactly one deploy, of the commit the first one reached.
    const [one, two] = await Promise.all([pull(self, c1), pull(self, c2)]);
    assert.equal(starts.length, 1, JSON.stringify({ starts, one, two }));
    assert.deepEqual(starts, [c1]);
    assert.deepEqual(one.deploy, { kind: "started", sha: c1 });
    assert.equal(describeMainPull(one), `main checkout pulled; host deploy of ${c1.slice(0, 8)} started`);
    assert.equal(two.deploy.kind, "waiting", JSON.stringify(two));
    assert.match(describeMainPull(two), new RegExp(`host deploy of ${c2.slice(0, 8)} waits for the running deploy`));
    assert.equal(
      JSON.parse(readFileSync(join(selfHome, "deploy.json"), "utf8")).current.requestId,
      "r0",
      "the first request stays recorded",
    );

    // D4: once the running deploy has ended with c1, the commit the second pull reached deploys; exactly once.
    running = c1;
    ended();
    await until("the waiting deploy starts", async () => starts.length === 2);
    assert.deepEqual(starts, [c1, c2]);
    await sleep(300);
    assert.equal(starts.length, 2, "the waiting deploy starts once");
    // A waiting deploy whose commit the running one already shipped starts nothing.
    s.g("reset", "-q", "--hard", c0);
    running = c0;
    outcome = await pull(self, c1);
    assert.equal(outcome.deploy.kind, "waiting");
    running = c1;
    ended();
    await sleep(300);
    assert.equal(starts.length, 2, "nothing left to deploy after the running deploy shipped the pulled commit");

    // D7: a pull while the host is stopping starts nothing.
    s.g("reset", "-q", "--hard", c0);
    running = c0;
    closing = true;
    outcome = await pull(self, c1);
    assert.equal(outcome.deploy.kind, "not-started");
    assert.match(outcome.deploy.reason, /stopping/);
    assert.equal(starts.length, 2);
    closing = false;

    // D6: a deploy that cannot start says so in the pull line, deploy.log, the host log and Telegram.
    s.g("reset", "-q", "--hard", c0);
    failStart = true;
    outcome = await pull(self, c1);
    assert.deepEqual(outcome.deploy, { kind: "not-started", sha: c1, reason: "spawn EACCES" });
    assert.match(describeMainPull(outcome), new RegExp(`host deploy of ${c1.slice(0, 8)} not started: spawn EACCES`));
    assert.match(selfTold.at(-1), new RegExp(`^Pi Projects host · Deploy\nDeploy of ${c1.slice(0, 8)} did not start: spawn EACCES`));
    assert.match(readFileSync(join(selfHome, "deploy.log"), "utf8"), /did not start: spawn EACCES/);
    assert.ok(
      reports.some((text) => /did not start: spawn EACCES/.test(text)),
      JSON.stringify(reports),
    );
    assert.ok(
      reports.some((text) => text.includes(`deploy started: the main checkout was pulled to ${c1.slice(0, 8)}`)),
      JSON.stringify(reports),
    );
    failStart = false;
    unwatch();
    // Unwatched, a moving pull is only a pull again.
    s.g("reset", "-q", "--hard", c0);
    outcome = await pull(self, c1);
    assert.deepEqual(outcome, { pulled: true });
  } finally {
    process.env.PI_PROJECTS_HOME = hostHome;
  }
  console.log("deploy-e2e ok");
} finally {
  await request({ action: "shutdown" }, false).catch(() => {});
  await new Promise((done) => setTimeout(done, 500));
  fake.close();
  rmSync(base, { recursive: true, force: true });
}
