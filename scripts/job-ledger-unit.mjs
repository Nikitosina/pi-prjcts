// Contracts of the job ledger read (scripts/job-ledger-failures.md). No host, no provider, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const home = mkdtempSync(join(tmpdir(), "job-ledger-unit-"));
process.env.PI_PROJECTS_HOME = home;
const { jobs, saveJob, projectDir } = await import("../src/state.ts");

const A = randomUUID(),
  B = randomUUID();
const job = (n, extra = {}) => ({
  id: randomUUID(),
  text: `message ${n}`,
  at: new Date(1700000000000 + n * 1000).toISOString(),
  state: "done",
  error: null,
  ...extra,
});
const timed = (fn) => {
  const start = performance.now();
  const value = fn();
  return [performance.now() - start, value];
};

const many = Array.from({ length: 3000 }, (_, n) => job(n));
for (const item of many) saveJob(A, item);
// L1: after a first read, an unchanged ledger is not read again from disk.
const [cold, first] = timed(() => jobs(A));
assert.equal(first.length, many.length);
const warm = Math.min(...Array.from({ length: 3 }, () => timed(() => jobs(A))[0]));
assert.ok(warm * 3 < cold, `an unchanged ledger must not be re-read: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms`);

// L2: a save shows in the next read.
const changed = { ...many[10], state: "failed", error: "boom" };
saveJob(A, changed);
assert.equal(jobs(A).find((item) => item.id === changed.id).error, "boom");
const added = job(5000);
saveJob(A, added);
assert.equal(jobs(A).at(-1).id, added.id);
assert.equal(jobs(A).length, many.length + 1);

// L3: a file removed from, or added to, the folder shows in the next read.
unlinkSync(join(projectDir(A), "inbox", `${many[0].id}.json`));
assert.ok(!jobs(A).some((item) => item.id === many[0].id));
const outside = job(6000);
writeFileSync(join(projectDir(A), "inbox", `${outside.id}.json`), JSON.stringify(outside));
assert.ok(jobs(A).some((item) => item.id === outside.id));

// L4: editing a returned job without saving does not change the ledger.
jobs(A)[0].state = "running";
assert.notEqual(jobs(A)[0].state, "running");

// L5: ledgers of two projects stay apart.
const other = job(1);
saveJob(B, other);
assert.deepEqual(
  jobs(B).map((item) => item.id),
  [other.id],
);

rmSync(home, { recursive: true, force: true });
console.log("job-ledger-unit ok");
