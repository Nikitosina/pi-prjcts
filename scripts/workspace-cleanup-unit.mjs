// Unit checks for src/workspace-cleanup.ts: settings, disposable paths, cache trimming and old Job videos. Temp folders only.
// Failure cases: scripts/workspace-cleanup-failures.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLEANUP_SETTINGS,
  cacheUsage,
  cachesToTrim,
  cleanupSettingsError,
  disposableCandidates,
  disposableWorktrees,
  gitIgnored,
  oldJobVideos,
  removePaths,
  settledWorkspaces,
  withCleanupDefaults,
} from "../src/workspace-cleanup.ts";
import { sweepWorkspaceCaches, workspaceCaches } from "../src/workspace-cache.ts";
import { cloneUsage, deviceLastUse, idleClones, strayTestClones } from "../plugins/simulator/idle.ts";
import { pruneTestProducts, hourlyPruneApplies } from "../plugins/simulator/test-products.ts";

const DAY = 86_400_000,
  now = Date.now(),
  ago = (path, ms) => utimesSync(path, new Date(now - ms), new Date(now - ms));
const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-cleanup-unit-")));
try {
  // R1 settings: relative globs only, sane bounds.
  assert.deepEqual(DEFAULT_CLEANUP_SETTINGS, { cacheCapGb: 20, budgetGb: 50, unusedDays: 7, videoDays: 14, disposable: [] });
  assert.equal(
    cleanupSettingsError({ ...DEFAULT_CLEANUP_SETTINGS, disposable: ["verification-results", "e2e-results/*", "a/**/tmp"] }),
    null,
  );
  for (const glob of ["/tmp", "~/x", "../x", "a/../../x", "", "."])
    assert.match(cleanupSettingsError({ ...DEFAULT_CLEANUP_SETTINGS, disposable: [glob] }) ?? "", /relative/i, glob);
  for (const bad of [{ cacheCapGb: 0 }, { budgetGb: 0 }, { unusedDays: 0 }, { videoDays: 0 }, { disposable: Array(65).fill("x") }])
    assert.notEqual(cleanupSettingsError({ ...DEFAULT_CLEANUP_SETTINGS, ...bad }), null, JSON.stringify(bad).slice(0, 80));
  // R19 settings stored before the budget get it by default and stay valid; set values are kept.
  const stored = { cacheCapGb: 30, unusedDays: 3, videoDays: 14, disposable: ["x"] };
  assert.deepEqual(withCleanupDefaults(stored), { ...stored, budgetGb: 50 });
  assert.equal(cleanupSettingsError(withCleanupDefaults(stored)), null);

  // R2-R4 disposable paths: matches inside the worktree, not through symlinks, not written in the last day, and only when git ignores them.
  const worktree = join(root, "wt"),
    outside = join(root, "outside");
  mkdirSync(join(worktree, "e2e-results", "run-1"), { recursive: true });
  mkdirSync(join(worktree, "verification-results"), { recursive: true });
  mkdirSync(join(worktree, "fresh-results"), { recursive: true });
  mkdirSync(join(worktree, "tracked-results"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "precious.txt"), "keep");
  symlinkSync(outside, join(worktree, "linked-results"));
  writeFileSync(join(worktree, "tracked-results", "kept.txt"), "tracked");
  writeFileSync(join(worktree, ".gitignore"), "*-results/\n/linked-results\n");
  execFileSync("git", ["init", "-q", worktree]);
  execFileSync("git", ["-C", worktree, "add", "-f", ".gitignore", "tracked-results/kept.txt"]);
  for (const name of ["e2e-results/run-1", "e2e-results", "verification-results", "tracked-results", "linked-results"])
    utimesSync(join(worktree, name), new Date(now - 2 * DAY), new Date(now - 2 * DAY));
  const candidates = disposableCandidates(worktree, ["*-results", "linked-results", "e2e-results/*"], now);
  assert.deepEqual(
    candidates.sort(),
    [
      join(worktree, "e2e-results"),
      join(worktree, "e2e-results", "run-1"),
      join(worktree, "tracked-results"),
      join(worktree, "verification-results"),
    ].sort(),
    "symlinks and fresh matches are never candidates",
  );
  const ignored = await gitIgnored(worktree, candidates);
  assert.deepEqual(
    ignored.sort(),
    [join(worktree, "e2e-results"), join(worktree, "e2e-results", "run-1"), join(worktree, "verification-results")].sort(),
    "a folder holding tracked files is not ignored",
  );
  assert.deepEqual(await gitIgnored(join(root, "not-a-repo"), [join(root, "not-a-repo", "x")]), [], "without git nothing is ignored");
  // R26 disposable paths stay in the worktree of a running Job or an open agent; a Coordinator chat's worktree is not exempt.
  assert.deepEqual(
    disposableWorktrees({
      live: ["running", "done", "chat", "agent", "unknown"].map((intentId) => ({ intentId, workspacePath: `/wt/${intentId}` })),
      items: [
        { intentId: "running", threadId: "job-running" },
        { intentId: "done", threadId: "job-approved" },
        { intentId: "chat", threadId: "chat-1" },
        { intentId: "agent", threadId: "scout-open" },
      ],
      running: new Set(["job-running", "scout-open"]),
    }),
    ["/wt/done", "/wt/chat", "/wt/unknown"],
  );

  // R5, R6, R18 caches: unused past the window go; over the cap or the project budget go only when idle for an hour, oldest first.
  const caches = join(root, "caches");
  const cache = (name, usedAgo, bytes, settled = false) => ({ dir: join(caches, name), usedAgo, bytes, settled });
  const set = [
    cache("fresh-small", DAY, 10),
    cache("stale", 8 * DAY, 10),
    cache("big-busy", 10 * 60_000, 500),
    cache("big-idle", 2 * 3_600_000, 500),
    cache("settled-busy", 60_000, 5, true),
  ];
  for (const item of set) mkdirSync(item.dir, { recursive: true });
  const uses = new Map(set.map((item) => [item.dir, { bytes: item.bytes, lastWriteMs: now - item.usedAgo }]));
  const usageOf = async (dir) => uses.get(dir);
  const plan = await cachesToTrim({
    caches: [...set.map(({ dir, settled }) => ({ dir, settled })), { dir: join(caches, "missing"), settled: true }],
    capBytes: 100,
    budgetBytes: 10_000,
    unusedMs: 7 * DAY,
    now,
    usageOf,
  });
  assert.deepEqual(plan.trimmed.map((item) => item.dir).sort(), [
    join(caches, "big-idle"),
    join(caches, "settled-busy"),
    join(caches, "stale"),
  ]);
  assert.deepEqual([plan.count, plan.bytes, plan.trimmedBytes], [5, 1025, 515], "a missing cache counts nothing");

  // R18 the budget: four 40-byte caches under a 100-byte budget lose the least recently written idle ones until under it.
  const budgeted = [
    cache("b-oldest", 3 * DAY, 40),
    cache("b-busy", 10 * 60_000, 40),
    cache("b-old", 2 * DAY, 40),
    cache("b-new", 2 * 3_600_000, 40),
  ];
  for (const item of budgeted) {
    mkdirSync(item.dir, { recursive: true });
    uses.set(item.dir, { bytes: item.bytes, lastWriteMs: now - item.usedAgo });
  }
  const overBudget = await cachesToTrim({
    caches: budgeted.map(({ dir }) => ({ dir, settled: false })),
    capBytes: 1000,
    budgetBytes: 100,
    unusedMs: 7 * DAY,
    now,
    usageOf,
  });
  assert.deepEqual(
    overBudget.trimmed,
    [
      { dir: join(caches, "b-oldest"), bytes: 40 },
      { dir: join(caches, "b-old"), bytes: 40 },
    ],
    "oldest first, the busy one stays",
  );

  // R9 the last use is the newest write anywhere inside, not the folder's own mtime; touching the folder is not a use.
  const controlRoot = join(root, "project"),
    intent = "aaaaaaaa-bbbb-5ccc-addd-eeeeeeeeeeee";
  const resolver = workspaceCaches({ projectId: "p", controlRoot, root: () => undefined, cacheRoot: () => null });
  const used = resolver.forIntent(intent);
  mkdirSync(join(used, "DerivedData", "Build"), { recursive: true });
  writeFileSync(join(used, "DerivedData", "Build", "app.o"), Buffer.alloc(8192));
  for (const path of [join(used, "DerivedData", "Build", "app.o"), join(used, "DerivedData", "Build"), join(used, "DerivedData"), used])
    ago(path, 30 * DAY);
  resolver.forIntent(intent);
  const stale = await cacheUsage(used);
  assert.ok(now - stale.lastWriteMs > 29 * DAY, "handing out the cache is not a use");
  assert.ok(stale.bytes >= 8192, "the walk counts the bytes on disk");
  writeFileSync(join(used, "DerivedData", "Build", "app.o"), Buffer.alloc(8192, 1));
  assert.ok(now - (await cacheUsage(used)).lastWriteMs < 60_000, "a write deep inside is a use");
  assert.deepEqual(await cacheUsage(join(root, "absent")), { bytes: 0, lastWriteMs: 0 });

  // R17 settled workspaces: a worker's whose Job is approved or dismissed, or whose PRs are all merged or closed, and not running.
  const item = (intentId, threadId, pullRequests = [], kind = "worker") => ({ kind, intentId, threadId, pullRequests });
  assert.deepEqual(
    [
      ...settledWorkspaces({
        items: [
          item("approved", "j-approved"),
          item("dismissed", "j-dismissed"),
          item("merged", "j-ready", [
            { number: 1, state: "merged" },
            { number: 2, state: "closed" },
          ]),
          item("open-pr", "j-ready", [
            { number: 1, state: "merged" },
            { number: 3, state: "open" },
          ]),
          item("ready", "j-ready"),
          item("running-merged", "j-running", [{ number: 4, state: "merged" }]),
          item("reader-merged", "live-reader", [{ number: 5, state: "merged" }]),
          item("chat", "coordinator:main", [{ number: 6, state: "merged" }], "coordinator"),
          item(undefined, "j-approved"),
        ],
        jobs: [
          { id: "j-approved", status: "approved" },
          { id: "j-dismissed", status: "failed", dismissedAt: now },
          { id: "j-ready", status: "ready" },
          { id: "j-running", status: "running", dismissedAt: now },
        ],
        live: new Set(["live-reader"]),
      }),
    ].sort(),
    ["approved", "dismissed", "merged"],
  );

  // R21 a path that cannot be removed (a file the owner locked) is reported, and the paths after it still go.
  // R27 read-only folders inside a doomed path do not stop it; a symlink out is not followed to change modes.
  const removals = join(root, "removals"),
    stuck = join(removals, "stuck"),
    gone = join(removals, "gone"),
    readOnly = join(removals, "read-only"),
    elsewhere = join(root, "elsewhere-read-only");
  mkdirSync(stuck, { recursive: true });
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(stuck, "locked-file"), "x");
  execFileSync("chflags", ["uchg", join(stuck, "locked-file")]);
  mkdirSync(join(readOnly, "App.app", "_CodeSignature"), { recursive: true });
  writeFileSync(join(readOnly, "App.app", "_CodeSignature", "CodeResources"), "x");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "keep"), "x");
  chmodSync(elsewhere, 0o500);
  symlinkSync(elsewhere, join(readOnly, "App.app", "link-out"));
  for (const dir of [join(readOnly, "App.app", "_CodeSignature"), join(readOnly, "App.app")]) chmodSync(dir, 0o500);
  try {
    const result = await removePaths([stuck, readOnly, gone]);
    assert.deepEqual(result.removed, [readOnly, gone]);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0], new RegExp(`^${stuck}: `));
    assert.ok(!existsSync(gone) && !existsSync(readOnly) && existsSync(join(stuck, "locked-file")));
    assert.equal(statSync(elsewhere).mode & 0o777, 0o500, "R27 a folder behind a symlink keeps its mode");
    assert.ok(existsSync(join(elsewhere, "keep")));
    const orphanRoot = join(root, "orphans"),
      orphan = join(orphanRoot, "aaaaaaaa-bbbb-5ccc-addd-000000000001"),
      lockedOrphan = join(orphanRoot, "aaaaaaaa-bbbb-5ccc-addd-000000000002");
    mkdirSync(orphan, { recursive: true });
    mkdirSync(lockedOrphan, { recursive: true });
    writeFileSync(join(lockedOrphan, "file"), "x");
    execFileSync("chflags", ["uchg", join(lockedOrphan, "file")]);
    const swept = await sweepWorkspaceCaches({ roots: [orphanRoot], live: new Set() });
    assert.deepEqual(swept.removed, [orphan]);
    assert.equal(swept.failed.length, 1, "the sweep reports the orphan it could not remove instead of throwing");
    execFileSync("chflags", ["nouchg", join(lockedOrphan, "file")]);
  } finally {
    execFileSync("chflags", ["nouchg", join(stuck, "locked-file")]);
    execFileSync("chmod", ["-R", "u+w", removals]);
    chmodSync(elsewhere, 0o700);
  }

  // R23 removing a large tree leaves the event loop free: the host keeps answering every project meanwhile.
  const big = join(root, "big-cache");
  for (let d = 0; d < 100; d++) {
    mkdirSync(join(big, String(d)), { recursive: true });
    for (let f = 0; f < 300; f++) writeFileSync(join(big, String(d), String(f)), "x");
  }
  let last = performance.now(),
    worstGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
  }, 5);
  const removedBig = await removePaths([big]);
  clearInterval(ticker);
  worstGap = Math.max(worstGap, performance.now() - last);
  assert.deepEqual(removedBig.removed, [big]);
  assert.ok(worstGap < 250, `the event loop stalled ${Math.round(worstGap)} ms while removing 30000 files`);

  // R7, R8 videos: approved or dismissed Jobs past the window lose videos only; others keep everything.
  const artifacts = join(controlRoot, "artifacts");
  const job = (id) => {
    const dir = join(artifacts, id);
    mkdirSync(join(dir, "binary"), { recursive: true });
    for (const name of ["run.mp4", "binary/clip.MOV", "screen.webm", "shot.png", "log.txt", "report.md"])
      writeFileSync(join(dir, name), name);
    return dir;
  };
  const jobs = [
    { id: "old-approved", status: "approved", endedAt: now - 20 * DAY },
    { id: "old-dismissed", status: "failed", endedAt: now - 30 * DAY, dismissedAt: now - 15 * DAY },
    { id: "recent-approved", status: "approved", endedAt: now - 3 * DAY },
    { id: "recently-dismissed", status: "stopped", endedAt: now - 30 * DAY, dismissedAt: now - 2 * DAY },
    { id: "old-ready", status: "ready", endedAt: now - 40 * DAY },
    { id: "running", status: "running", endedAt: null },
  ];
  for (const item of jobs) job(item.id);
  const videos = oldJobVideos({ controlRoot, jobs, now, days: 14 });
  assert.deepEqual(
    videos.sort(),
    ["old-approved", "old-dismissed"]
      .flatMap((id) => ["run.mp4", "binary/clip.MOV", "screen.webm"].map((name) => join(artifacts, id, name)))
      .sort(),
  );
  assert.deepEqual(oldJobVideos({ controlRoot: join(root, "none"), jobs, now, days: 14 }), [], "no artifacts folder, nothing to remove");
  assert.ok(existsSync(join(artifacts, "old-approved", "shot.png")));

  // R16 simulator clones: only owned, shut-down, unleased clones unused past the window are idle. device.plist changes on boot and shutdown.
  const devices = join(root, "Devices");
  const device = (udid, plistAgo, dataAgo) => {
    const directory = join(devices, udid);
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(join(directory, "device.plist"), "plist");
    ago(join(directory, "device.plist"), plistAgo);
    ago(join(directory, "data"), dataAgo);
    return { udid, directory };
  };
  const idle = device("IDLE", 9 * DAY, 8 * DAY),
    booted = device("BOOTED", 9 * DAY, 9 * DAY),
    leased = device("LEASED", 9 * DAY, 9 * DAY),
    recentData = device("RECENT", 9 * DAY, DAY),
    missing = device("MISSING", 9 * DAY, 9 * DAY);
  assert.equal(Math.round((now - deviceLastUse(idle.directory)) / DAY), 8, "the newest of device.plist and data counts");
  assert.equal(deviceLastUse(join(devices, "absent")), Number.POSITIVE_INFINITY, "an unreadable device is never idle");
  const states = new Map([
    ["IDLE", "Shutdown"],
    ["BOOTED", "Booted"],
    ["LEASED", "Shutdown"],
    ["RECENT", "Shutdown"],
  ]);
  assert.deepEqual(
    idleClones({
      owned: [idle, booted, leased, recentData, missing],
      states,
      leased: (owned) => owned.udid === "LEASED",
      now,
      unusedMs: 7 * DAY,
    }).map((owned) => owned.udid),
    ["IDLE"],
  );
  // U8 (scripts/storage-usage-failures.md): the Storage row counts every owned clone; erasing frees the idle ones' data.
  writeFileSync(join(idle.directory, "data", "disk.img"), Buffer.alloc(64 * 1024));
  writeFileSync(join(booted.directory, "data", "disk.img"), Buffer.alloc(128 * 1024));
  const du = (path) => Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) * 1024;
  const usage = await cloneUsage({ owned: [idle, booted], idle: [idle], strays: [] });
  assert.equal(usage.count, 2);
  assert.equal(usage.bytes, du(idle.directory) + du(booted.directory));
  assert.equal(usage.reclaimableBytes, du(join(idle.directory, "data")));
  assert.deepEqual(await cloneUsage({ owned: [], idle: [], strays: [] }), { count: 0, bytes: 0, reclaimableBytes: 0 });

  // X1-X3 (plugins/simulator/FAILURES.md): testing clones of this project's simulators, shut down and unused for an hour, are strays.
  const projectId = "6dab15f5-cd63-409c-af48-7ec9d20aa073",
    ours = (n, request) => `Clone ${n} of pi-projects 6dab15f5 ${request}`;
  const testing = join(root, "XCTestDevices");
  const testDevice = (udid, name, state, usedAgo, set = "testing") => {
    mkdirSync(join(testing, udid, "data"), { recursive: true });
    writeFileSync(join(testing, udid, "device.plist"), "plist");
    ago(join(testing, udid, "device.plist"), usedAgo);
    ago(join(testing, udid, "data"), usedAgo);
    return { udid, name, state, set, osVersion: "26.5" };
  };
  const request = "b7d1e2a4-16a9-4c3e-9f01-160990000003";
  const testDevices = [
    testDevice("STRAY", ours(2, request), "Shutdown", 2 * DAY),
    testDevice("GONE-OWNER", ours(1, "7beaef1b-64da-4ab2-963a-00b26cbdde63"), "Shutdown", 3 * DAY),
    testDevice("BOOTED", ours(3, request), "Booted", 2 * DAY),
    testDevice("STARTING", ours(4, request), "Shutdown", 10 * 60_000),
    testDevice("OTHER-PROJECT", `Clone 2 of pi-projects 15a2e06c ${request}`, "Shutdown", 2 * DAY),
    testDevice("PLAIN", "Clone 1 of iPhone 17", "Shutdown", 2 * DAY),
    testDevice("LOOKALIKE", `Clone 2 of my pi-projects 6dab15f5 ${request}`, "Shutdown", 2 * DAY),
    testDevice("DEFAULT-SET", ours(5, request), "Shutdown", 2 * DAY, "default"),
  ];
  const strays = strayTestClones({ devices: testDevices, projectId, root: testing, now });
  assert.deepEqual(
    strays.map((item) => item.udid),
    ["STRAY", "GONE-OWNER"],
    "X1-X3 only this project's shut-down testing clones idle for an hour, also of a deleted clone",
  );
  assert.equal(strays[0].directory, join(testing, "STRAY"));
  // X5 the Storage row counts the strays whole: deleting them frees all of it.
  writeFileSync(join(testing, "STRAY", "data", "disk.img"), Buffer.alloc(256 * 1024));
  const withStrays = await cloneUsage({ owned: [idle], idle: [], strays: [strays[0]] });
  assert.equal(withStrays.count, 2);
  assert.equal(withStrays.bytes, du(idle.directory) + du(join(testing, "STRAY")));
  assert.equal(withStrays.reclaimableBytes, du(join(testing, "STRAY")));

  // T1-T4 (plugins/simulator/FAILURES.md): finished XcodeBuildMCP test products past the window go, except each workspace's newest.
  const xbm = join(root, "XcodeBuildMCP", "workspaces");
  const HOUR = 3600_000;
  const products = (key) => join(xbm, key, "test-products");
  const product = (key, name, ageHours, { marker = true, bytes = 32 * 1024 } = {}) => {
    const path = join(products(key), name);
    mkdirSync(join(path, "Debug-iphonesimulator"), { recursive: true });
    writeFileSync(join(path, "Debug-iphonesimulator", "App.bin"), Buffer.alloc(bytes));
    const at = new Date(Date.now() - ageHours * HOUR);
    if (marker) {
      writeFileSync(`${path}.xcodebuildmcp-completed`, "");
      utimesSync(`${path}.xcodebuildmcp-completed`, at, at);
    }
    utimesSync(path, at, at);
    return path;
  };
  const name = (stamp, pid) => `test_sim_2026-11-06T${stamp}-000Z_pid${pid}_0a1b2c3d.xctestproducts`;
  const deadPid = 999_999;
  const old1 = product("app-1", name("01-00-00", deadPid), 10);
  const old2 = product("app-1", name("02-00-00", deadPid), 9);
  const newestFinished = product("app-1", name("03-00-00", deadPid), 8);
  const running = product("app-1", name("04-00-00", process.pid), 7, { marker: false });
  const young = product("app-1", name("05-00-00", process.pid), 0.5, { marker: false });
  const crashed = product("app-2", name("01-00-00", deadPid), 12, { marker: false });
  const lone = product("app-2", name("02-00-00", deadPid), 11);
  const foreign = join(products("app-1"), "my-build.xctestproducts");
  mkdirSync(foreign, { recursive: true });
  utimesSync(foreign, new Date(Date.now() - 20 * HOUR), new Date(Date.now() - 20 * HOUR));
  mkdirSync(join(xbm, "app-1", "DerivedData", "old"), { recursive: true });
  const escape = join(root, "outside.xctestproducts");
  mkdirSync(escape);
  writeFileSync(join(escape, "keep"), "x");
  symlinkSync(escape, join(products("app-2"), name("00-00-00", deadPid)));
  const pruned = await pruneTestProducts({ root: xbm, now: Date.now(), keepMs: 2 * HOUR });
  assert.ok(!existsSync(old1) && !existsSync(old2) && !existsSync(crashed), "finished runs past the window are removed");
  assert.ok(!existsSync(`${old1}.xcodebuildmcp-completed`), "T4 the completion marker goes with its folder");
  assert.ok(existsSync(running) && existsSync(young), "T1 a running or recent run stays");
  assert.ok(existsSync(newestFinished) && existsSync(lone), "T2 each workspace keeps its newest finished run");
  assert.ok(existsSync(foreign) && existsSync(join(xbm, "app-1", "DerivedData", "old")), "T3 other folders stay");
  assert.ok(existsSync(join(escape, "keep")), "T3 a symlink is never followed");
  assert.equal(pruned.removed, 3);
  assert.ok(pruned.bytes >= 3 * 32 * 1024, `T4 freed bytes are counted: ${pruned.bytes}`);
  // T5: the host-wide hourly timer runs only while some project still has the plugin on (a disabled plugin touches nothing).
  assert.equal(hourlyPruneApplies([{ disabledPlugins: ["simulator"] }, {}]), true, "T5 one project has it on");
  assert.equal(hourlyPruneApplies([{ disabledPlugins: ["simulator"] }, { disabledPlugins: ["other", "simulator"] }]), false, "T5 all off");
  assert.equal(hourlyPruneApplies([]), false, "T5 no projects");
  assert.deepEqual(await pruneTestProducts({ root: join(root, "missing"), now: Date.now(), keepMs: HOUR }), { removed: 0, bytes: 0 });
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("workspace-cleanup unit: all checks passed");
