import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprover, describeAcceptance, fileAcceptanceLog, githubMergeProvider } from "../src/result-acceptance.ts";
import { watchSelfCheckout } from "../src/main-pull.ts";

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
git(checkout, "remote", "set-head", "origin", "--auto");
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
if (a[1] === "view") { process.stdout.write(JSON.stringify({ ...s, url: "https://github.com/owner/repo/pull/7" })); process.exit(0); }
if (a[1] === "ready") { s.isDraft = false; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s)); process.exit(0); }
if (s.mergeFail) { process.stderr.write(s.mergeFail + "\\n"); process.exit(1); }
if (s.hang) { setTimeout(() => {}, 1e6); return; }
if (a.includes("--auto") && s.mergeStateStatus === "CLEAN") { process.stderr.write("Pull request is in clean status\\n"); process.exit(1); }
if (a[0] === "api") {
 if (!a.includes("sha=" + s.headRefOid)) { process.stderr.write("head mismatch"); process.exit(1); }
 s.state = "MERGED"; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
 process.stdout.write(JSON.stringify({ merged: true, message: "merged" }));
}
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
    .filter((l) => l.startsWith("api "));

// Mergeable: one pinned squash merge, clean main pulled.
save({});
writeFileSync(join(other, "a.txt"), "2\n");
(git(other, "commit", "-qam", "two"), git(other, "push", "-q", "origin", "main"));
let outcome = await approver.approve(job());
assert.equal(outcome.kind, "accepted");
assert.match(merges()[0], /--method PUT repos\/owner\/repo\/pulls\/7\/merge -f sha=a{40} -f merge_method=squash/);
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

// Unknown remote default: merged, but never pull on the assumption that the current branch is default.
git(checkout, "remote", "set-head", "origin", "--delete");
save({});
outcome = await approver.approve(job());
assert.equal(outcome.kind, "merged-pull-skipped");
assert.match(outcome.reason, /default branch is unknown/);
git(checkout, "remote", "set-head", "origin", "--auto");

// Not mergeable yet: wait locally, answer pending at once, then merge the pinned head in the background.
save({ mergeStateStatus: "BLOCKED" });
const armed = job();
assert.equal((await approver.approve(armed)).kind, "auto-merge-pending");
assert.equal(finished.length, 0, "Approve answered before the merge finished");
assert.ok(!readFileSync(calls, "utf8").includes("--auto"));
setTimeout(() => save({ mergeStateStatus: "CLEAN" }), 50);
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
assert.ok(trail.indexOf("pr ready 7") >= 0 && trail.indexOf("pr ready 7") < trail.findLastIndex((l) => l.startsWith("api ")));

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
// Approve that pulls the host's own checkout to a new commit starts the host's deploy (deploy-failures D1) and says so; the pull does not wait for it.
save({});
const asked = [],
  hostRuns = git(checkout, "rev-parse", "HEAD");
const unwatch = watchSelfCheckout({
  root: checkout,
  head: async () => git(checkout, "rev-parse", "HEAD"),
  running: () => hostRuns,
  deploy: (sha) => (asked.push(sha), { kind: "started", sha }),
});
writeFileSync(join(other, "a.txt"), "3\n");
(git(other, "commit", "-qam", "three"), git(other, "push", "-q", "origin", "main"));
const pushed = git(other, "rev-parse", "HEAD");
outcome = await approver.approve(job());
unwatch();
assert.deepEqual(outcome, { kind: "accepted", head, deploy: { kind: "started", sha: pushed } });
assert.deepEqual(asked, [pushed]);
assert.equal(
  describeAcceptance(outcome),
  `Merged ${head.slice(0, 8)} and updated the main checkout. The host deploy of ${pushed.slice(0, 8)} started.`,
);
console.log("result-acceptance-unit ok");
