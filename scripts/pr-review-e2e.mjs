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
    ["calendar.js", "calendar.md", "package-lock.json"],
  );
  const path = "calendar.js";
  assert.match((await read("file", { head: f.first, path })).diff, /\+export const days = 7/);
  await read("viewed", { head: f.first, path, viewed: true });
  assert.equal((await read("files", { head: f.first })).files[0].viewed, true);
  advanceReview(f, f.second);
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
  assert.deepEqual(fingerprint(), before);
  kit.git(kit.workspace, "config", `url.${f.bare}.insteadOf`, f.url);
  await assert.rejects(read("file", { head: f.first, path }), /origin|checkout/i);
  kit.check("exact revisions, interdiff, viewed marks and checkout isolation", true);
});
