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
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("workspace-cleanup unit: all checks passed");
