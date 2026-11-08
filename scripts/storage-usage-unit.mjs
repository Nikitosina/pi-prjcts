// Unit: storage measuring (scripts/storage-usage-failures.md U1-U3).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskBytes, measureRows } from "../src/storage-usage.ts";

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
  console.log("storage-usage unit: all checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
