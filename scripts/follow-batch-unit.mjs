// Unit: a frozen Follow batch delivers nothing of a plugin the project has turned off since the batch was frozen, and keeps the rest.
import assert from "node:assert/strict";
import { deliverable, groupProviders, ownerKey, prLabel, priorRepo, prRef, repoKey } from "../src/follow-batch.ts";

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

// B2 a batch frozen before provider tags mixes providers per chat: whole while nothing it recorded is off, held back once a recorded provider is off.
const old = { ...batch, groups: [{ input: batch.groups[0].input, chat: 1 }], count: 4 };
assert.equal(deliverable(old, []).count, 4, "B2 a legacy batch with nothing off delivers whole");
assert.equal(deliverable(old, ["other"]).count, 4, "B2 a provider the batch never recorded does not hold it");
const held = deliverable(old, ["gated"]);
assert.deepEqual([held.groups.length, held.count], [0, 0], "B2 a legacy batch that recorded a now-disabled provider is held back");
assert.deepEqual(
  held.notices.map((item) => item.key),
  ["gh:a/b#1:merged"],
  "B2 the other provider's notice stays",
);

// B3 a PR is told apart by provider, repository and number.
assert.notEqual(ownerKey("github", "a/b", 7), ownerKey("gated", "a/b", 7), "B3 same repository and number, other provider");
assert.notEqual(ownerKey("github", "a/b", 7), ownerKey("github", "a/c", 7), "B3 same provider and number, other repository");
assert.deepEqual(prRef("a/b#7:ci:abc:failed"), { repositoryId: "a/b", number: 7 }, "B3 item id");
assert.deepEqual(prRef("fake-repo#12"), { repositoryId: "fake-repo", number: 12 }, "B3 id without a suffix");
assert.equal(prRef("no number here"), null);
// B4 repository records are told apart by provider; a record an older host stored under the bare id goes to the provider that tagged it.
assert.equal(repoKey("github", "a/b"), "a/b", "B4 GitHub's key is unchanged");
assert.notEqual(repoKey("alpha", "a/b"), repoKey("beta", "a/b"), "B4 two providers with one repository id");
assert.notEqual(prLabel("alpha", "a/b", 7), prLabel("github", "a/b", 7), "B4 a plugin's PR name is prefixed, GitHub's is not");
assert.equal(prLabel("github", "a/b", 7), "a/b#7");
const stored = { "a/b": { baselined: true, prs: {}, provider: "alpha" }, "plain-id": { baselined: true, prs: {} } };
assert.equal(priorRepo(stored, "alpha", "a/b").record, stored["a/b"], "B4 the tagging provider continues from the bare key");
assert.equal(priorRepo(stored, "alpha", "a/b").superseded, "a/b");
assert.equal(priorRepo(stored, "beta", "a/b").record, undefined, "B4 another provider with the same id does not");
assert.equal(priorRepo(stored, "github", "a/b").record, undefined, "B4 neither does GitHub");
assert.equal(
  priorRepo(stored, "beta", "plain-id").record,
  stored["plain-id"],
  "B4 an untagged record of a non-owner/name id belongs to a plugin",
);
assert.equal(
  priorRepo({ "a/b": { baselined: true, prs: {} } }, "alpha", "a/b").record,
  undefined,
  "B4 an untagged owner/name record is GitHub's",
);
assert.equal(
  priorRepo({ [repoKey("alpha", "a/b")]: stored["a/b"] }, "alpha", "a/b").superseded,
  null,
  "B4 a scoped record supersedes nothing",
);

// B5 the providers a group may carry: its tag, else every provider the batch recorded.
assert.deepEqual(groupProviders(batch, group("gated", 1, 1)), ["gated"], "B5 a tagged group");
assert.deepEqual(groupProviders(batch, { input: batch.groups[0].input, chat: 1 }).sort(), ["github", "gated"].sort(), "B5 a legacy group");
console.log("follow-batch-unit: ok");
