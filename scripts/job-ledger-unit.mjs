// Contracts of the job ledger read (scripts/job-ledger-failures.md). No host, no provider, no network.
import assert from "node:assert/strict";
import fs, { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const home = mkdtempSync(join(tmpdir(), "job-ledger-unit-"));
process.env.PI_PROJECTS_HOME = home;
// Count file reads under inbox/ so the cache contract is asserted on IO, not on timing.
let inboxReads = 0;
const realRead = fs.readFileSync;
fs.readFileSync = (path, ...rest) => {
  if (String(path).includes("/inbox/")) inboxReads++;
  return realRead(path, ...rest);
};
syncBuiltinESMExports();
const { jobs, saveJob, projectDir } = await import("../src/state.ts");
const reads = (fn) => {
  const before = inboxReads;
  const value = fn();
  return [inboxReads - before, value];
};

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
const many = Array.from({ length: 3000 }, (_, n) => job(n));
for (const item of many) saveJob(A, item);
// L1: after a first read, an unchanged ledger is not read again from disk.
const [coldReads, first] = reads(() => jobs(A));
assert.equal(first.length, many.length);
assert.equal(coldReads, many.length);
assert.equal(reads(() => jobs(A))[0], 0, "an unchanged ledger must not be re-read");

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

// L6: a same-name file replaced atomically by another process shows in the next read, even with the same size.
const victim = jobs(A)[5];
const swapped = { ...victim, state: "failed", error: "x".repeat(4) };
const temp = join(projectDir(A), "inbox", `${victim.id}.json.${randomUUID()}.tmp`);
writeFileSync(temp, JSON.stringify({ ...swapped, error: "x".repeat(4) }));
renameSync(temp, join(projectDir(A), "inbox", `${victim.id}.json`));
assert.equal(jobs(A).find((item) => item.id === victim.id).error, "xxxx");
const sameSize = { ...swapped, error: "yyyy" };
writeFileSync(temp, JSON.stringify(sameSize));
renameSync(temp, join(projectDir(A), "inbox", `${victim.id}.json`));
assert.equal(jobs(A).find((item) => item.id === victim.id).error, "yyyy");

// L7: attachments of a returned or saved job cannot be edited behind the ledger's back.
const withFiles = job(7000, { attachments: [randomUUID()] });
saveJob(A, withFiles);
withFiles.attachments.push(randomUUID());
assert.equal(jobs(A).find((item) => item.id === withFiles.id).attachments.length, 1);
jobs(A).find((item) => item.id === withFiles.id).attachments.push(randomUUID());
assert.equal(jobs(A).find((item) => item.id === withFiles.id).attachments.length, 1);

// L8: the cache keeps a bounded number of projects; an evicted ledger is read again.
const others = Array.from({ length: 40 }, () => randomUUID());
for (const id of others) {
  saveJob(id, job(1));
  jobs(id);
}
assert.ok(reads(() => jobs(A))[0] > 0, "the oldest ledger must have been evicted");
assert.equal(reads(() => jobs(others.at(-1)))[0], 0, "the newest ledger stays cached");

// L5: ledgers of two projects stay apart.
const other = job(1);
saveJob(B, other);
assert.deepEqual(
  jobs(B).map((item) => item.id),
  [other.id],
);

rmSync(home, { recursive: true, force: true });
console.log("job-ledger-unit ok");
