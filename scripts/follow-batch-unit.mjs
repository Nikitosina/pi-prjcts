// Unit: a frozen Follow batch delivers nothing of a plugin the project has turned off since the batch was frozen, and keeps the rest.
import assert from "node:assert/strict";
import { deliverable } from "../src/follow-batch.ts";

const group = (provider, chat, count) => ({
  input: { eventId: `e-${provider}-${chat}`, kind: `${provider}.follow`, payload: provider },
  chat,
  provider,
  count,
});
const batch = {
  repos: { "a/b": { baselined: true, prs: {}, provider: "github" }, "x/y": { baselined: true, prs: {}, provider: "gated" } },
  notices: [
    { key: "gh:a/b#1:merged", at: 1 },
    { key: "gated:x/y#2:ci", at: 2 },
  ],
  count: 5,
  groups: [group("github", 1, 2), group("gated", 1, 3)],
  switchedOff: [],
};

const all = deliverable(batch, []);
assert.equal(all.groups.length, 2, "B1 nothing is off: every group is delivered");
assert.equal(all.count, 5);

const without = deliverable(batch, ["gated"]);
assert.deepEqual(
  without.groups.map((item) => item.provider),
  ["github"],
  "B1 the group of the disabled plugin is not delivered, the other provider's is",
);
assert.equal(without.count, 2, "B1 the count follows the delivered groups");
assert.deepEqual(
  without.notices.map((item) => item.key),
  ["gh:a/b#1:merged"],
  "B1 the disabled plugin's notices are dropped",
);
assert.deepEqual(Object.keys(batch.repos), ["a/b", "x/y"], "B1 the saved repository records are untouched");

const old = { ...batch, groups: [{ input: batch.groups[0].input, chat: 1 }], count: 4 };
assert.equal(deliverable(old, ["gated"]).count, 4, "B2 a batch frozen before provider tags still delivers whole");
console.log("follow-batch-unit: ok");
