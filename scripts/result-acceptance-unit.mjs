import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprover, fileAcceptanceLog, githubMergeProvider } from "../src/result-acceptance.ts";

const root = mkdtempSync(join(tmpdir(), "acceptance-"));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
// Remote with one commit, an owner checkout on main, and a fake gh whose PR lives in state.json.
const remote = join(root, "remote.git"),
  checkout = join(root, "checkout"),
  other = join(root, "other");
git(root, "init", "-q", "--bare", "-b", "main", remote);
git(root, "clone", "-q", remote, checkout);
git(root, "clone", "-q", remote, other);
for (const dir of [checkout, other]) (git(dir, "config", "user.email", "t@example.com"), git(dir, "config", "user.name", "t"));
writeFileSync(join(other, "a.txt"), "1\n");
(git(other, "add", "."), git(other, "commit", "-qm", "one"), git(other, "push", "-q", "origin", "main"));
git(checkout, "pull", "-q", "origin", "main");
const head = "a".repeat(40);
const state = join(root, "state.json"),
  calls = join(root, "calls.log");
const save = (patch) =>
  writeFileSync(
    state,
    JSON.stringify({
      state: "OPEN",
      isDraft: false,
      headRefOid: head,
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      ...patch,
    }),
  );
writeFileSync(
  join(root, "gh"),
  `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
fs.appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");
if (a[1] === "view") { process.stdout.write(JSON.stringify(s)); process.exit(0); }
if (a[1] === "ready") { s.isDraft = false; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s)); process.exit(0); }
if (s.mergeFail) { process.stderr.write(s.mergeFail + "\\n"); process.exit(1); }
if (s.hang) { setTimeout(() => {}, 1e6); return; }
if (a.includes("--auto") && s.mergeStateStatus === "CLEAN") { process.stderr.write("Pull request is in clean status\\n"); process.exit(1); }
if (!a.includes("--auto")) { s.state = "MERGED"; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s)); }
`,
);
chmodSync(join(root, "gh"), 0o755);
process.env.PI_PROJECTS_GH_CLI = join(root, "gh");

const log = fileAcceptanceLog(join(root, "log"));
const finished = [];
const approver = createApprover({
  provider: () => githubMergeProvider(),
  checkout: () => checkout,
  log,
  pollMs: 20,
  waitMs: 400,
  finished: (j, result) => finished.push([j.id, result]),
});
const settled = async (id) => {
  for (let i = 0; i < 200 && !finished.some(([found]) => found === id); i++) await new Promise((done) => setTimeout(done, 10));
  return finished.find(([found]) => found === id)?.[1];
};
let n = 0;
const job = (patch = {}) => ({ id: `job-${++n}`, pr: "7", candidateSha: head, ...patch });
const merges = () =>
  readFileSync(calls, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("pr merge"));

// Mergeable: one pinned squash merge, clean main pulled.
save({});
writeFileSync(join(other, "a.txt"), "2\n");
(git(other, "commit", "-qam", "two"), git(other, "push", "-q", "origin", "main"));
let outcome = await approver.approve(job());
assert.equal(outcome.kind, "accepted");
assert.match(merges()[0], /--squash --match-head-commit a{40}/);
assert.equal(readFileSync(join(checkout, "a.txt"), "utf8"), "2\n");

// Head moved: nothing is merged.
const before = merges().length;
save({ headRefOid: "b".repeat(40) });
await assert.rejects(approver.approve(job()), /not the approved/);
assert.equal(merges().length, before);

// Already merged (second Approve): no merge call, still accepted.
save({ state: "MERGED" });
assert.equal((await approver.approve(job())).kind, "accepted");
assert.equal(merges().length, before);

// Dirty main checkout: merged, pull skipped with the reason.
save({});
writeFileSync(join(checkout, "a.txt"), "dirty\n");
outcome = await approver.approve(job());
assert.equal(outcome.kind, "merged-pull-skipped");
assert.match(outcome.reason, /uncommitted/);
git(checkout, "checkout", "-q", "--", "a.txt");

// Not mergeable yet: auto-merge armed, Approve answers pending at once, and the flow finishes in the background.
save({ mergeStateStatus: "BLOCKED" });
setTimeout(() => save({ state: "MERGED", mergeStateStatus: "BLOCKED" }), 100);
const armed = job();
const started = Date.now();
assert.equal((await approver.approve(armed)).kind, "auto-merge-pending");
assert.ok(Date.now() - started < 90, "Approve does not wait for the merge");
assert.ok(readFileSync(calls, "utf8").includes("--auto"));
assert.equal((await settled(armed.id)).kind, "accepted");

// Auto-merge never completes within the wait: the background flow ends pending, resumable.
save({ mergeStateStatus: "BLOCKED" });
const waiting = job();
assert.equal((await approver.approve(waiting)).kind, "auto-merge-pending");
assert.equal((await settled(waiting.id)).kind, "auto-merge-pending");

// Aborting the signal (owner close) ends the background flow with an error.
save({ mergeStateStatus: "BLOCKED" });
const stopped = new AbortController(),
  aborted = job();
assert.equal((await approver.approve(aborted, stopped.signal)).kind, "auto-merge-pending");
stopped.abort();
assert.ok((await settled(aborted.id)) instanceof Error);

// A draft PR is marked ready before it merges.
save({ isDraft: true });
const draft = job();
assert.equal((await approver.approve(draft)).kind, "accepted");
const trail = readFileSync(calls, "utf8").split("\n");
assert.ok(trail.indexOf("pr ready 7") >= 0 && trail.indexOf("pr ready 7") < trail.findLastIndex((l) => l.startsWith("pr merge")));

// Conflicts and refusals are errors, not outcomes.
save({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
await assert.rejects(approver.approve(job()), /conflicts/);
save({ mergeFail: "required status check is expected" });
const refused = job();
await assert.rejects(approver.approve(refused), /Merge refused/);
assert.equal(log.read(refused.id), undefined, "a refusal leaves no record behind");

// A merge call that dies with an unreadable PR afterwards is uncertain, never retried blindly.
const flaky = createApprover({
  provider: () => ({
    ...githubMergeProvider(),
    inspect: (() => {
      let first = true;
      return async (t) => {
        if (first) return ((first = false), { state: "open", draft: false, head, base: "main", mergeable: "yes" });
        throw new Error("network down");
      };
    })(),
    merge: async () => {
      throw new Error("timeout");
    },
  }),
  checkout: () => checkout,
  log,
});
outcome = await flaky.approve(job());
assert.equal(outcome.kind, "merge-uncertain");

// An uncertain merge record never blocks a later Approve, even at a new head; only a merged record at another head does.
const later = "b".repeat(40);
const retried = job();
assert.equal(log.read(retried.id), undefined);
outcome = await flaky.approve(retried);
assert.equal(outcome.kind, "merge-uncertain");
assert.equal(log.read(retried.id).state, "merging");
save({ headRefOid: later });
assert.equal((await approver.approve({ ...retried, candidateSha: later })).kind, "accepted");
await assert.rejects(approver.approve({ ...retried, candidateSha: head }), /already merged/);

// Concurrent Approve joins the running flow.
save({});
const one = job();
const [x, y] = await Promise.all([approver.approve(one), approver.approve(one)]);
assert.equal(x, y);
console.log("result-acceptance-unit ok");
