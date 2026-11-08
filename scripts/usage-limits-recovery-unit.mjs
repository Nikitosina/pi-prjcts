// Recovery of the subscription limits after a failure, with a fake usage endpoint and a fake credential resolver (no real network, no real logins).
// Bug being pinned: the poller sent whatever access token was on disk, never renewed an expired one, and after a failure the item kept an
// "expired" error that neither the poller nor the refresh button could clear. Transient failures must also never read as a sign-in problem.
// Refresh is manual only (scripts/limits-manual-failures.md M1-M6): reads never fetch, and only the refresh button recovers.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "usage-recovery-"));
const agent = join(dir, "agent"),
  userHome = join(dir, "home");
mkdirSync(agent);
mkdirSync(userHome);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.HOME = userHome;
process.env.CODEX_HOME = join(dir, "codex");
delete process.env.PI_PROJECTS_LIMITS_FIXTURE;
delete process.env.ELIZA_TOKEN;
let mode = "ok",
  accepted = "fresh",
  retryAfter = "1200",
  onElizaResponse = () => {},
  onLimitedResponse = () => {};
const hits = [];
const usage = {
  five_hour: { utilization: 33, resets_at: "2030-01-01T00:00:00Z" },
  seven_day: { utilization: 12, resets_at: "2030-01-02T00:00:00Z" },
};
const server = createServer((req, res) => {
  hits.push(req.headers.authorization);
  if (mode === "drop") return req.socket.destroy();
  if (mode === "503") {
    res.writeHead(503);
    return res.end("down");
  }
  if (mode === "429") {
    onLimitedResponse();
    res.writeHead(429, { "retry-after": retryAfter });
    return res.end();
  }
  const eliza = req.url === "/eliza";
  if (req.headers.authorization !== `${eliza ? "OAuth" : "Bearer"} ${accepted}`) {
    res.writeHead(401);
    return res.end("no");
  }
  if (eliza) onElizaResponse();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      eliza
        ? {
            account: "owner",
            pool: "",
            usage: { all: { stats: { monthly: { requests: 3, cost: 4.25 } } }, other: { stats: { monthly: { requests: 2, cost: 0.75 } } } },
          }
        : usage,
    ),
  );
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
process.env.PI_PROJECTS_CLAUDE_USAGE_URL = process.env.PI_PROJECTS_CODEX_USAGE_URL = `http://127.0.0.1:${server.address().port}/usage`;
process.env.PI_PROJECTS_ELIZA_USAGE_URL = `http://127.0.0.1:${server.address().port}/eliza`;
const limits = await import("../src/usage-limits.ts");
const { limitsSnapshot, resetLimitsForTest, MANUAL_COOLDOWN_MS } = limits;
const claude = async (now, refresh) => (await limitsSnapshot(now, refresh)).providers.find((item) => item.provider === "claude");
const eliza = async (now, refresh) => (await limitsSnapshot(now, refresh)).providers.find((item) => item.provider === "eliza");
// The resolver is shared by every provider; these tests only answer for Claude.
const forClaude = (fn) => async (id) => (id === "anthropic" ? fn() : undefined);
const setDisk = (access, expires = Date.now() + 3600_000) =>
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access, refresh: "r", expires } }));
const begin = () => {
  resetLimitsForTest();
  limits.setLimitsTokenResolver?.(null);
  hits.length = 0;
  mode = "ok";
  accepted = "fresh";
  retryAfter = "1200";
};
const clock = () => Date.now();
// Refreshes are the owner's clicks; each one comes after the 15 s per-provider cooldown unless a check says otherwise.
const HOUR = 3600_000,
  GAP = MANUAL_COOLDOWN_MS + 1000;

// 1. A network failure says so, is not an auth problem, and keeps no schedule: nothing retries until the owner refreshes (M3).
begin();
setDisk("fresh");
mode = "drop";
let item = await claude(clock(), true);
assert.match(item.reason, /^Couldn't reach Claude$/);
assert.doesNotMatch(item.reason, /sign-in|expired|will retry/i);
assert.equal(item.status, "no-data", "a network error is not the signed-out state");
assert.equal(hits.length, 1);
mode = "ok";
item = await claude(clock() + HOUR);
assert.equal(hits.length, 1, "a read an hour later does not retry");
assert.equal(item.samples.length, 0);
item = await claude(clock() + HOUR, true);
assert.equal(item.samples.length, 2, "the refresh recovers");
assert.equal(item.reason, null);

// 2. 5xx and 429 are transient too; 429 honours Retry-After for the refresh button (M5).
begin();
setDisk("fresh");
mode = "503";
item = await claude(clock(), true);
assert.match(item.reason, /having trouble \(HTTP 503\)$/);
assert.equal(item.status, "no-data");
begin();
setDisk("fresh");
mode = "429";
const limitedAt = clock();
item = await claude(limitedAt, true);
assert.match(item.reason, /rate limited/);
assert.doesNotMatch(item.reason, /sign-in/);
const limitedHits = hits.length;
mode = "ok";
await claude(limitedAt + 16 * 60_000, true);
assert.equal(hits.length, limitedHits, "manual refresh cannot override Retry-After");
assert.ok((await claude(limitedAt)).nextAttemptAt >= limitedAt + 1200_000, "the snapshot says when a refresh can fetch again");
item = await claude(limitedAt + 1200_000 + 1000, true);
assert.equal(hits.length, limitedHits + 1, "a refresh fetches after Retry-After");
assert.equal(item.status, "ok");
assert.equal(item.nextAttemptAt, null);
begin();
setDisk("fresh");
const httpDateAt = clock();
retryAfter = new Date(httpDateAt + 1200_000).toUTCString();
mode = "429";
item = await claude(httpDateAt, true);
assert.match(item.reason, /rate limited/);
const httpDateHits = hits.length;
mode = "ok";
await claude(httpDateAt + 16 * 60_000, true);
assert.equal(hits.length, httpDateHits, "an HTTP-date Retry-After holds the refresh");
item = await claude(httpDateAt + 1200_000 + 1000, true);
assert.equal(hits.length, httpDateHits + 1, "an HTTP-date Retry-After is honored");
assert.equal(item.status, "ok");

// Retry-After starts when the response arrives, not when the request starts.
begin();
setDisk("fresh");
mode = "429";
const realClock = Date.now;
let delayedNow = realClock();
Date.now = () => delayedNow;
try {
  const requestedAt = delayedNow;
  onLimitedResponse = () => {
    delayedNow += 10_000;
  };
  await claude(requestedAt, true);
  const count = hits.length;
  mode = "ok";
  onLimitedResponse = () => {};
  await claude(requestedAt + 1200_000 + 1000, true);
  assert.equal(hits.length, count, "request latency must not shorten Retry-After");
  await claude(delayedNow + 1200_000 + 1, true);
  assert.equal(hits.length, count + 1);
} finally {
  Date.now = realClock;
  onLimitedResponse = () => {};
}

// 3. A real 401 is an auth problem; a token Pi renewed on disk meanwhile is picked up by the next attempt (even the retry inside the same one).
begin();
setDisk("stale");
item = await claude(clock(), true);
assert.match(item.reason, /rejected the sign-in \(HTTP 401\)/);
assert.equal(item.status, "unavailable");
setDisk("fresh");
item = await claude(clock() + GAP, true);
assert.equal(item.samples.length, 2, "credentials are re-read on every attempt");
assert.equal(item.reason, null);
assert.equal(item.status, "ok");
begin();
setDisk("stale");
let reads = 0;
limits.setLimitsTokenResolver?.(forClaude(async () => (++reads === 1 ? "stale" : "fresh")));
item = await claude(clock(), true);
assert.equal(item.samples.length, 2, "after a 401 the credentials are re-read once and a different token is tried");
assert.deepEqual(hits, ["Bearer stale", "Bearer fresh"]);

// 4. An access token that expired while nobody used the provider is renewed by the resolver (Pi's locked refresh), not sent stale.
begin();
setDisk("stale", Date.now() - 3600_000);
let renewals = 0,
  offline = false;
limits.setLimitsTokenResolver?.(
  forClaude(async () => {
    renewals++;
    if (offline) throw Object.assign(new Error("OAuth refresh failed for anthropic"), { cause: new Error("fetch failed") });
    setDisk("fresh");
    return "fresh";
  }),
);
offline = true;
item = await claude(clock(), true);
assert.match(item.reason, /^Couldn't renew the Claude sign-in right now$/);
assert.equal(item.status, "no-data");
assert.equal(hits.length, 0, "no request with a token that could not be renewed");
offline = false;
item = await claude(clock() + GAP, true);
assert.equal(item.samples.length, 2);
assert.deepEqual(hits, ["Bearer fresh"], "the stale token was never sent");
assert.equal(renewals, 2);
// A refresh token the provider rejects is an auth problem, and nothing is remembered from it.
begin();
limits.setLimitsTokenResolver?.(
  forClaude(async () => {
    throw Object.assign(new Error("OAuth refresh failed for anthropic"), { cause: new Error("HTTP 400 invalid_grant") });
  }),
);
item = await claude(clock(), true);
assert.match(item.reason, /rejected when renewing it/);
assert.equal(item.status, "unavailable");
limits.setLimitsTokenResolver?.(forClaude(async () => "fresh"));
item = await claude(clock() + GAP, true);
assert.equal(item.samples.length, 2, "the next attempt asks again; the failed renewal was not cached");

// 5. Manual refresh in an error state performs a real fetch (not the cached error), subject only to the cooldown (M4).
begin();
setDisk("fresh");
mode = "drop";
await claude(clock(), true);
const n = hits.length;
await claude(clock() + 1000, true);
assert.equal(hits.length, n, "not twice inside the 15 s cooldown");
await claude(clock() + GAP, true);
assert.equal(hits.length, n + 1, "after the cooldown it fetches again");
assert.equal(MANUAL_COOLDOWN_MS, 15_000);

// 6. Reads never fetch (M1): not for an errored provider, not for a healthy one. The host's `visit` read is in scripts/ui2-limits-e2e.mjs (M2).
begin();
setDisk("fresh");
mode = "drop";
await claude(clock(), true);
const m = hits.length;
mode = "ok";
for (const refresh of [undefined, false]) {
  item = await claude(clock() + HOUR, refresh);
  assert.equal(hits.length, m, `a ${refresh} read fetches nothing`);
  assert.equal(item.reason, "Couldn't reach Claude", "the read reports the last refresh as it was");
}
begin();
setDisk("fresh");
for (const refresh of [undefined, false]) await claude(clock() + HOUR, refresh);
assert.equal(hits.length, 0, "a read of a never-refreshed provider fetches nothing");

// 7. Eliza uses the existing OAuth token only on the host, returns actual USD month-to-date usage, and recovers from transient failures without losing it.
begin();
process.env.ELIZA_TOKEN = "fresh";
item = await eliza(clock(), true);
assert.equal(item.usage.amountUsd, 5);
assert.equal(item.usage.account, "owner");
assert.equal(item.usage.pool, null);
assert.equal(item.status, "ok");
assert.ok(item.usage.periodStartAt <= Date.now() && item.usage.periodEndAt > Date.now());
assert.ok(!JSON.stringify(item).includes("fresh"));
mode = "drop";
item = await eliza(clock() + GAP, true);
assert.equal(item.usage.amountUsd, 5);
assert.match(item.reason, /^Couldn't reach Eliza$/);
assert.equal(item.status, "ok");
mode = "ok";
item = await eliza(clock() + 2 * GAP, true);
assert.equal(item.reason, null);
assert.equal(item.usage.amountUsd, 5);

// 8. Missing/rejected Eliza auth is honestly unavailable, not $0; a later valid token recovers through the same manual refresh path.
begin();
delete process.env.ELIZA_TOKEN;
item = await eliza(clock(), true);
assert.equal(item.status, "unavailable");
assert.equal(item.usage, null);
assert.match(item.reason, /No Eliza OAuth token found/);
process.env.ELIZA_TOKEN = "fresh";
item = await eliza(clock() + GAP, true);
assert.equal(item.status, "ok");
assert.equal(item.usage.amountUsd, 5);
begin();
accepted = "other";
item = await eliza(clock(), true);
assert.equal(item.status, "unavailable");
assert.equal(item.usage, null);
assert.match(item.reason, /HTTP 401/);
accepted = "fresh";
item = await eliza(clock() + GAP, true);
assert.equal(item.status, "ok");
assert.equal(item.usage.amountUsd, 5);

// A successful old-month reading survives a response crossing midnight, but is never relabeled.
begin();
process.env.ELIZA_TOKEN = "fresh";
const realNow = Date.now;
let now = Date.parse("2026-10-31T23:59:00Z");
Date.now = () => now;
try {
  item = await eliza(now, true);
  const oldReading = item.usage;
  now = Date.parse("2026-10-31T23:59:00Z") + GAP;
  onElizaResponse = () => {
    now = Date.parse("2026-11-01T00:00:01Z");
  };
  item = await eliza(now, true);
  assert.deepEqual(item.usage, oldReading, "a boundary-crossing response cannot replace the old reading");
  assert.match(item.reason, /crossed the UTC month boundary/);
  onElizaResponse = () => {};
  now += GAP;
  item = await eliza(now, true);
  assert.equal(item.reason, null);
  assert.equal(item.usage.periodStartAt, Date.parse("2026-11-01T00:00:00Z"));
} finally {
  Date.now = realNow;
  onElizaResponse = () => {};
}

delete process.env.ELIZA_TOKEN;
server.close();
console.log("usage-limits recovery: all checks passed");
