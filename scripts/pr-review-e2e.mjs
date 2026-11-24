import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit } from "./lib/e2e-kit.mjs";
import { reviewFixture, advanceReview } from "./lib/pr-review-fixture.mjs";
const kit = await createKit("pr-review");
kit.initRepo();
const f = reviewFixture(kit.root, kit.workspace, kit.core);
Object.assign(kit.hostEnv, f.env);
await kit.run(async () => {
  const id = await kit.createProject("Review");

  const read = (action, opts = {}) => kit.rpc({ action: `pr-review-${action}`, id, provider: "github", pr: "7", ...opts });
  for (const [action, opts] of [
    ["open", { pr: "-7" }],
    ["file", { head: f.first, path: "../secret" }],
  ])
    await assert.rejects(read(action, { ...opts, id: "00000000-0000-0000-0000-000000000000" }), /Invalid data:/);
  writeFileSync(join(kit.workspace, "untracked"), "unchanged");
  const status = () => kit.git(kit.workspace, "status", "--porcelain=v1", "-b");
  const tracked = join(kit.workspace, "README.md");
  writeFileSync(tracked, "staged");
  kit.git(kit.workspace, "add", "README.md");
  writeFileSync(tracked, "unstaged");
  const fingerprint = () => [
    status(),
    kit.git(kit.workspace, "rev-parse", "HEAD"),
    kit.git(kit.workspace, "show", ":README.md"),
    readFileSync(tracked, "utf8"),
    readFileSync(join(kit.workspace, "untracked"), "utf8"),
  ];
  const before = fingerprint();
  assert.equal((await read("open", { seen: true })).head, f.first);
  const files = await read("files", { head: f.first });
  assert.deepEqual(
    files.files.map((x) => x.path),
    ["calendar.js", "docs/calendar.md", "package-lock.json", "src/workdays.js"],
  );
  assert.ok(files.files[0].stats.additions > 100 && files.files[0].stats.deletions > 100);
  const path = "calendar.js";
  assert.match((await read("file", { head: f.first, path })).diff, /\+export const days = 7/);
  await read("viewed", { head: f.first, path, viewed: true });
  assert.equal((await read("files", { head: f.first })).files[0].viewed, true);
  const add = (comment) => read("add", { head: f.first, path, side: "RIGHT", from: 1, to: 3, comment });
  await add("Check weekends");
  await add("Check holidays");
  const { drafts, revision } = await add("Keep pending");
  const op = { kind: "review", verdict: "REQUEST_CHANGES", summary: "Two questions", draftIds: drafts.slice(0, 2).map((d) => d.id) };
  const publish = (revision, operation, head = f.first) => read("publish", { revision, operation, head, confirmed: true });
  await publish(revision, op);
  const writes = () =>
    readFileSync(f.env.FAKE_GH_CALLS, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((x) => x.mutation);
  assert.deepEqual(
    writes().map((w) => w.input),
    [
      {
        pullRequestId: "PR_7",
        commitOID: f.first,
        event: "REQUEST_CHANGES",
        body: "Two questions",
        threads: ["Check weekends", "Check holidays"].map((body) => ({
          body,
          path,
          side: "RIGHT",
          line: 3,
          startLine: 1,
          startSide: "RIGHT",
        })),
      },
    ],
  );
  let room = await read("open");
  assert.ok(room.drafts[0].published && !room.drafts[2].published);
  const threadId = room.threads[0].id;
  for (const operation of [
    { kind: "reply", threadId, body: "Thanks" },
    { kind: "resolve", threadId },
    { kind: "unresolve", threadId },
  ]) {
    await publish(room.revision, operation);
    room = await read("open");
  }
  assert.equal(room.threads[0].comments.at(-1).body, "Thanks");
  assert.equal(room.threads[0].resolved, false);
  advanceReview(f, f.second);
  await assert.rejects(publish(room.revision, { ...op, draftIds: [drafts[2].id] }, f.second), /outdated/i);
  await read("open");
  room = await read("add", { head: f.second, path, side: "RIGHT", from: 1, to: 1, comment: "Found after a timeout" });
  const lost = room.drafts.at(-1).id;
  const faulty = JSON.parse(readFileSync(f.state));
  faulty.loseReviewAnswer = true;
  writeFileSync(f.state, JSON.stringify(faulty));
  const attempt = () => publish(room.revision, { ...op, draftIds: [lost] }, f.second);
  await attempt();
  const blocked = await read("open");
  assert.ok(blocked.uncertain && blocked.threads.length && blocked.drafts.length);
  await assert.rejects(read("delete", { draftId: lost, revision: blocked.revision }));
  const local = await read("add", { head: f.second, path, side: "RIGHT", from: 1, to: 1, comment: "Still drafting" });
  await read("edit", { draftId: local.drafts.at(-1).id, revision: local.revision, comment: "Updated locally" });
  await assert.rejects(attempt(), /uncertain|changed/i);
  assert.equal(writes().length, 5);
  const unavailable = JSON.parse(readFileSync(f.state));
  unavailable.graphql = { errors: true };
  writeFileSync(f.state, JSON.stringify(unavailable));
  const offline = await read("open");
  assert.ok(offline.uncertain);
  assert.match(offline.url, /pull\/7$/);
  await read("checked", { revision: offline.revision, confirmed: true, found: true });
  delete unavailable.graphql;
  writeFileSync(f.state, JSON.stringify(unavailable));
  room = await read("open");
  assert.equal(room.drafts.find((d) => d.id === lost).published, offline.url);
  assert.ok(!room.drafts[2].published);
  assert.equal(writes().length, 5);
  assert.equal((await read("open", { seen: true })).previous, f.first);
  const range = { head: f.second, since: f.first };
  assert.deepEqual(
    (await read("files", range)).files.map((x) => [x.path, x.viewed]),
    [[path, false]],
  );
  assert.match((await read("file", { ...range, path })).diff, /-export const days = 7;\n\+export const days = 5/);
  assert.deepEqual((await read("lines", { head: f.first, path, from: 1, count: 1 })).lines, ["export const days = 7;"]);
  advanceReview(f, f.moved);
  await read("open", { seen: true });
  const moved = { head: f.moved, since: f.second };
  assert.equal((await read("files", moved)).baseMoved, true);
  await assert.rejects(read("file", { ...moved, path }), /base moved/i);
  const upstream = JSON.parse(readFileSync(f.state, "utf8"));
  upstream.pulls[0].baseRefOid = f.moved;
  writeFileSync(f.state, JSON.stringify(upstream));
  assert.equal((await read("open")).iterations.find((it) => it.head === f.moved).base, f.movedBase);
  upstream.repo.id++;
  writeFileSync(f.state, JSON.stringify(upstream));
  await assert.rejects(read("open"), /identity/i);
  assert.deepEqual(fingerprint(), before);
  kit.git(kit.workspace, "config", `url.${f.bare}.insteadOf`, f.url);
  await assert.rejects(read("file", { head: f.first, path }), /origin|checkout/i);
  kit.check("exact revisions, interdiff, viewed marks and checkout isolation", true);
});
