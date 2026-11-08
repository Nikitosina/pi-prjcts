// Unit checks for src/workspace-cleanup.ts: settings, disposable paths, cache trimming and old Job videos. Temp folders only.
// Failure cases: scripts/workspace-cleanup-failures.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLEANUP_SETTINGS,
  cachesToTrim,
  cleanupSettingsError,
  disposableCandidates,
  gitIgnored,
  oldJobVideos,
} from "../src/workspace-cleanup.ts";
import { workspaceCaches } from "../src/workspace-cache.ts";
import { cloneUsage, deviceLastUse, idleClones } from "../plugins/simulator/idle.ts";
import { pruneTestProducts } from "../plugins/simulator/test-products.ts";

const DAY = 86_400_000,
  now = Date.now(),
  ago = (path, ms) => utimesSync(path, new Date(now - ms), new Date(now - ms));
const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-cleanup-unit-")));
try {
  // R1 settings: relative globs only, sane bounds.
  assert.deepEqual(DEFAULT_CLEANUP_SETTINGS, { cacheCapGb: 20, unusedDays: 7, videoDays: 14, disposable: [] });
  assert.equal(
    cleanupSettingsError({ ...DEFAULT_CLEANUP_SETTINGS, disposable: ["verification-results", "e2e-results/*", "a/**/tmp"] }),
    null,
  );
  for (const glob of ["/tmp", "~/x", "../x", "a/../../x", "", "."])
    assert.match(cleanupSettingsError({ ...DEFAULT_CLEANUP_SETTINGS, disposable: [glob] }) ?? "", /relative/i, glob);
  for (const bad of [{ cacheCapGb: 0 }, { unusedDays: 0 }, { videoDays: 0 }, { disposable: Array(65).fill("x") }])
    assert.notEqual(cleanupSettingsError({ ...DEFAULT_CLEANUP_SETTINGS, ...bad }), null, JSON.stringify(bad).slice(0, 80));

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

  // R5, R6 caches: unused past the window go; over the cap go only when idle for an hour.
  const caches = join(root, "caches");
  const cache = (name, usedAgo, bytes) => {
    const dir = join(caches, name);
    mkdirSync(dir, { recursive: true });
    ago(dir, usedAgo);
    return { dir, bytes };
  };
  const set = [
    cache("fresh-small", DAY, 10),
    cache("stale", 8 * DAY, 10),
    cache("big-busy", 10 * 60_000, 500),
    cache("big-idle", 2 * 3_600_000, 500),
  ];
  const sizes = new Map(set.map((item) => [item.dir, item.bytes]));
  assert.deepEqual(
    (
      await cachesToTrim({
        dirs: [...set.map((item) => item.dir), join(caches, "missing")],
        capBytes: 100,
        unusedMs: 7 * DAY,
        now,
        sizeOf: async (dir) => sizes.get(dir) ?? 0,
      })
    ).sort(),
    [join(caches, "big-idle"), join(caches, "stale")],
  );

  // R9 using a cache marks it used.
  const controlRoot = join(root, "project"),
    intent = "aaaaaaaa-bbbb-5ccc-addd-eeeeeeeeeeee";
  const resolver = workspaceCaches({ projectId: "p", controlRoot, root: () => undefined, cacheRoot: () => null });
  const used = resolver.forIntent(intent);
  ago(used, 30 * DAY);
  resolver.forIntent(intent);
  assert.ok(now - statSync(used).mtimeMs < 60_000, "forIntent marks the cache used");

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
  const usage = await cloneUsage({ owned: [idle, booted], idle: [idle] });
  assert.equal(usage.count, 2);
  assert.equal(usage.bytes, du(idle.directory) + du(booted.directory));
  assert.equal(usage.reclaimableBytes, du(join(idle.directory, "data")));
  assert.deepEqual(await cloneUsage({ owned: [], idle: [] }), { count: 0, bytes: 0, reclaimableBytes: 0 });

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
  assert.deepEqual(await pruneTestProducts({ root: join(root, "missing"), now: Date.now(), keepMs: HOUR }), { removed: 0, bytes: 0 });
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("workspace-cleanup unit: all checks passed");
