// Unit: storage measuring (scripts/storage-usage-failures.md U1-U3).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskBytes, measureRows } from "../src/storage-usage.ts";
import { createStorageScans } from "../src/storage-scans.ts";

const root = mkdtempSync(join(tmpdir(), "storage-usage-"));
try {
  // U1: a folder's size is its own files; a symlink to a big folder elsewhere is not followed.
  const inside = join(root, "cache"),
    outside = join(root, "elsewhere");
  mkdirSync(inside);
  mkdirSync(outside);
  writeFileSync(join(inside, "small.bin"), Buffer.alloc(100 * 1024));
  writeFileSync(join(outside, "big.bin"), Buffer.alloc(4 * 1024 * 1024));
  symlinkSync(outside, join(inside, "link"));
  const size = await diskBytes([inside]);
  assert.ok(size !== null && size >= 100 * 1024 && size < 1024 * 1024, `U1 symlink not followed: ${size}`);
  assert.equal(await diskBytes([]), 0, "U1 nothing to measure is zero");
  assert.equal(await diskBytes([join(root, "gone")]), 0, "U1 a folder removed meanwhile counts as zero");
  const both = await diskBytes([inside, outside]);
  assert.ok(both !== null && both >= size + 4 * 1024 * 1024, `U1 sizes add up: ${both}`);

  // U2: an unreadable folder makes that measurement unknown, not zero.
  const locked = join(root, "locked");
  mkdirSync(join(locked, "inner"), { recursive: true });
  writeFileSync(join(locked, "inner", "x.bin"), "x");
  chmodSync(join(locked, "inner"), 0o000);
  assert.equal(await diskBytes([locked]), null, "U2 unreadable folder is unknown");
  chmodSync(join(locked, "inner"), 0o700);

  // U2: one failing or hanging row is unknown with a reason; the others still answer, in order.
  const rows = await measureRows(
    [
      { id: "ok", kind: "caches", label: "Workspace caches", measure: async () => ({ count: 2, bytes: 10, reclaimableBytes: 4 }) },
      {
        id: "boom",
        kind: "plugin",
        label: "Simulator clones",
        measure: async () => {
          throw new Error("simctl failed");
        },
      },
      { id: "slow", kind: "videos", label: "Job videos", measure: () => new Promise(() => {}) },
    ],
    300,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["ok", "boom", "slow"],
  );
  assert.deepEqual(rows[0], { id: "ok", kind: "caches", label: "Workspace caches", count: 2, bytes: 10, reclaimableBytes: 4 });
  assert.equal(rows[1].bytes, null);
  assert.equal(rows[1].reclaimableBytes, null);
  assert.match(rows[1].note, /simctl failed/);
  assert.equal(rows[2].bytes, null);
  assert.match(rows[2].note, /timed out/i);

  // U13-U16: cached scans (scripts/storage-usage-failures.md).
  const usageAt = (n) => ({ measuredAt: n, rows: [] });
  let started = 0,
    release = () => {},
    fail = false,
    clock = 1000,
    cleaning = false;
  const scans = createStorageScans({
    ttlMs: 600,
    now: () => clock,
    busy: () => cleaning,
    measure: () => {
      started++;
      return new Promise((resolve, reject) => {
        release = () => (fail ? reject(new Error("du failed")) : resolve(usageAt(clock)));
      });
    },
  });
  const idle = () => new Promise((done) => setTimeout(done, 10));
  const cold = scans.status();
  assert.deepEqual([cold.usage, cold.scanning, started], [null, true, 1], "U16 a cold status answers at once and scans in the background");
  scans.status(true);
  const joined = scans.scan();
  assert.equal(scans.status().scanning, true);
  assert.equal(started, 1, "U14 refreshes join the scan in flight");
  release();
  await joined;
  await idle();
  const warm = scans.status();
  assert.deepEqual(
    [warm.usage?.measuredAt, warm.scanning, warm.stale, started],
    [1000, false, false, 1],
    "U13 a fresh measurement is reused",
  );
  clock += 700;
  assert.equal(scans.status().stale, true, "U13 an old measurement is stale");
  assert.equal(started, 2, "U13 a stale measurement is refreshed in the background");
  fail = true;
  release();
  await idle();
  const failed = scans.status();
  assert.deepEqual([failed.usage?.measuredAt, failed.error], [1000, "du failed"], "U15 a failed scan keeps the last good measurement");
  fail = false;
  scans.status(true);
  assert.equal(started, 3, "U15 a refresh retries after a failure");
  release();
  await idle();
  cleaning = true;
  clock += 700;
  scans.status();
  assert.equal(started, 3, "U16 no scan starts while cleanup deletes");
  cleaning = false;
  scans.invalidate();
  assert.equal(started, 4, "U16 a scan starts when cleanup ends");
  assert.equal(scans.status().stale, true, "U16 numbers from before the cleanup are stale");
  release();
  await idle();
  assert.equal(scans.status().stale, false);
  scans.invalidate();
  scans.invalidate();
  assert.equal(started, 5, "U14 invalidations during a scan join it");
  release();
  await idle();
  assert.equal(started, 6, "U16 a scan that began before the invalidation is followed by one more");
  release();
  await idle();
  // U16: a scan outdated by a cleanup that then fails is still followed by one; nothing scans on request while cleanup deletes.
  const before = started;
  scans.invalidate();
  fail = true;
  scans.invalidate();
  release();
  await idle();
  fail = false;
  assert.equal(started, before + 2, "U16 the follow-up scan runs although the outdated one failed");
  cleaning = true;
  assert.equal(scans.status(true).scanning, true, "U16 the follow-up scan already runs");
  release();
  await idle();
  const quiet = started;
  assert.equal((await scans.usage(0)).measuredAt, clock, "U16 a breakdown during cleanup gets the last measurement");
  scans.status(true);
  assert.equal(started, quiet, "U16 a refresh during cleanup starts no scan");
  console.log("storage-usage unit: all checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
