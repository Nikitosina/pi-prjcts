// Unit: a frozen Follow batch delivers nothing of a plugin the project has turned off since the batch was frozen, and keeps the rest.
import assert from "node:assert/strict";
import {
  deliverable,
  deliveryOf,
  groupEventId,
  groupProviders,
  ownerKey,
  prLabel,
  priorRepo,
  prRef,
  repoKey,
  scopeBare,
  settle,
} from "../src/follow-batch.ts";

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

// B6 what a scheduler answer means for a group: reached the chat, proven not to have, or unknown. Only the middle one gets a new attempt id.
assert.equal(deliveryOf({ status: "submitted", submissionId: 3 }), "submitted", "B6 submitted");
assert.equal(
  deliveryOf({ status: "interrupted", submissionId: null }),
  "refused",
  "B6 interrupted before any submission is a proven refusal",
);
assert.equal(deliveryOf({ status: "interrupted", submissionId: 4 }), "submitted", "B6 an aborted run was submitted");
assert.equal(deliveryOf({ status: "failed", submissionId: 4 }), "submitted", "B6 a failed run was submitted");
assert.equal(deliveryOf({ status: "failed", submissionId: null }), "uncertain", "B6 a failure without a receipt is not proven");
assert.equal(deliveryOf({ status: "uncertain", submissionId: null }), "uncertain", "B6 uncertain");
assert.equal(deliveryOf({ status: "recorded", submissionId: null }), "uncertain", "B6 a recorded intent may still be submitted by someone");
assert.equal(groupEventId(group("gated", 1, 1)), "e-gated-1", "B6 the first attempt keeps the identity");
assert.equal(groupEventId({ ...group("gated", 1, 1), attempt: 2 }), "e-gated-1~2", "B6 a retry adds the attempt");

// B7 settling a delivery: confirmed groups leave, the rest wait with their provider's record and notices; a refusal bumps the attempt.
const [gh, gated, other] = [group("github", 1, 2), group("gated", 1, 3), group("gated", 2, 4)];
const two = { ...batch, groups: [gh, gated, other], count: 9 };
const mixed = settle(
  two,
  new Map([
    [gh, "submitted"],
    [gated, "submitted"],
    [other, "refused"],
  ]),
  [],
);
assert.deepEqual(mixed.confirmed, [gh, gated], "B7 the submitted groups are confirmed");
assert.deepEqual(
  mixed.waiting.map((item) => [item.chat, item.attempt, item.waiting]),
  [[2, 1, "refused"]],
  "B7 the refused one waits as the next attempt",
);
assert.equal(mixed.count, 5, "B7 only confirmed groups are counted");
assert.deepEqual(mixed.heldRepos, ["x/y"], "B7 the record of the provider with a waiting group stays out");
assert.deepEqual(
  mixed.publish.map((item) => item.key),
  ["gh:a/b#1:merged"],
  "B7 GitHub's notice is published (its notice key says gh)",
);
assert.deepEqual(
  mixed.carry.map((item) => item.key),
  ["gated:x/y#2:ci"],
  "B7 the waiting provider's notice is carried",
);
const off = settle(
  two,
  new Map([
    [gh, "submitted"],
    [gated, "held"],
    [other, "held"],
  ]),
  ["gated"],
);
assert.deepEqual(
  off.waiting.map((item) => [item.attempt ?? 0, item.waiting]),
  [
    [0, "held"],
    [0, "held"],
  ],
  "B7 held groups keep their attempt",
);
const uncertain = settle(
  two,
  new Map([
    [gh, "submitted"],
    [gated, "uncertain"],
    [other, "submitted"],
  ]),
  [],
);
assert.deepEqual(
  uncertain.waiting.map((item) => [item.attempt ?? 0, item.waiting]),
  [[0, "uncertain"]],
  "B7 an uncertain group keeps its id",
);
const legacy = settle({ ...batch, groups: [{ input: batch.groups[0].input, chat: 1 }], count: 4 }, new Map(), []);
assert.deepEqual([legacy.heldAll, legacy.heldRepos.length, legacy.count], [true, 2, 0], "B7 an unresolved legacy group holds every record");

// B8 bare records tagged by a provider move to the provider's key whatever is connected; attempts move with them unless GitHub follows the
// repository too (then they are copied, never guessed to be one side's); GitHub's, untagged and scoped records stay.
const record = (provider) => ({ baselined: true, prs: {}, ...(provider ? { provider } : {}) });
const fix = (sha) => ({ sha, at: 1, mode: "none", workId: null, threadId: null, error: null });
const repos = { "a/b": record("ghost"), "c/d": record("ghost"), "e/f": record("github"), "g/h": record(), "ghost::c/d": record("ghost") };
const fixes = { "a/b#1": [fix("1")], "c/d#2": [fix("2")], "e/f#3": [fix("3")] };
assert.equal(scopeBare(repos, fixes, ["c/d"]), true, "B8 something moved");
assert.deepEqual(
  Object.keys(repos).sort(),
  ["e/f", "g/h", "ghost::a/b", "ghost::c/d"].sort(),
  "B8 tagged bare records are scoped; others stay",
);
assert.equal(repos["ghost::a/b"].repositoryId, "a/b", "B8 the scoped record names its repository");
assert.deepEqual(
  Object.keys(fixes).sort(),
  ["c/d#2", "e/f#3", "ghost:a/b#1", "ghost:c/d#2"].sort(),
  "B8 unambiguous attempts move, ambiguous ones are copied",
);
assert.equal(scopeBare(repos, fixes, ["c/d"]), false, "B8 a second run changes nothing");
console.log("follow-batch-unit: ok");
