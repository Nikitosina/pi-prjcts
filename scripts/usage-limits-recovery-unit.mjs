// Recovery of the subscription limits after a failure, with a fake usage endpoint and a fake credential resolver (no real network, no real logins).
// Bug being pinned: the poller sent whatever access token was on disk, never renewed an expired one, and after a failure the item kept an
// "expired" error that neither the poller nor the refresh button could clear. Transient failures must also never read as a sign-in problem.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'usage-recovery-'));
const agent = join(dir, 'agent'), userHome = join(dir, 'home'); mkdirSync(agent); mkdirSync(userHome);
process.env.PI_CODING_AGENT_DIR = agent; process.env.HOME = userHome; process.env.CODEX_HOME = join(dir, 'codex');
delete process.env.PI_PROJECTS_LIMITS_FIXTURE;
delete process.env.ELIZA_TOKEN;
let mode = 'ok', accepted = 'fresh', retryAfter = '1200', onElizaResponse = () => {}, onLimitedResponse = () => {}; const hits = [];
const usage = { five_hour: { utilization: 33, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 12, resets_at: '2030-01-02T00:00:00Z' } };
const server = createServer((req, res) => {
  hits.push(req.headers.authorization);
  if (mode === 'drop') return req.socket.destroy();
  if (mode === '503') { res.writeHead(503); return res.end('down'); }
  if (mode === '429') { onLimitedResponse(); res.writeHead(429, { 'retry-after': retryAfter }); return res.end(); }
  const eliza = req.url === '/eliza';
  if (req.headers.authorization !== `${eliza ? 'OAuth' : 'Bearer'} ${accepted}`) { res.writeHead(401); return res.end('no'); }
  if (eliza) onElizaResponse();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(eliza ? { account: 'owner', pool: '', usage: { all: { stats: { monthly: { requests: 3, cost: 4.25 } } }, other: { stats: { monthly: { requests: 2, cost: 0.75 } } } } } : usage));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
process.env.PI_PROJECTS_CLAUDE_USAGE_URL = process.env.PI_PROJECTS_CODEX_USAGE_URL = `http://127.0.0.1:${server.address().port}/usage`;
process.env.PI_PROJECTS_ELIZA_USAGE_URL = `http://127.0.0.1:${server.address().port}/eliza`;
const limits = await import('../src/usage-limits.ts');
const { limitsSnapshot, resetLimitsForTest, MANUAL_COOLDOWN_MS, MAX_BACKOFF_MS } = limits;
const claude = async (now, refresh) => (await limitsSnapshot(now, refresh)).providers.find(item => item.provider === 'claude');
const eliza = async (now, refresh) => (await limitsSnapshot(now, refresh)).providers.find(item => item.provider === 'eliza');
// The resolver is shared by every provider; these tests only answer for Claude.
const forClaude = fn => async id => (id === 'anthropic' ? fn() : undefined);
const setDisk = (access, expires = Date.now() + 3600_000) => writeFileSync(join(agent, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', access, refresh: 'r', expires } }));
const begin = () => { resetLimitsForTest(); limits.setLimitsTokenResolver?.(null); hits.length = 0; mode = 'ok'; accepted = 'fresh'; retryAfter = '1200'; };
const clock = () => Date.now();

// 1. A network failure says so, is not an auth problem, and the next poll after the backoff recovers on its own.
begin(); setDisk('fresh');
mode = 'drop';
let item = await claude(clock());
assert.match(item.reason, /^Couldn't reach Claude, will retry$/); assert.doesNotMatch(item.reason, /sign-in|expired/i);
assert.equal(item.status, 'no-data', 'a network error is not the signed-out state');
mode = 'ok';
item = await claude(clock() + 60_000);
assert.equal(item.samples.length, 0, 'still inside the backoff: no early retry');
item = await claude(clock() + MAX_BACKOFF_MS + 1000);
assert.equal(item.samples.length, 2); assert.equal(item.reason, null);

// 2. 5xx and 429 are transient too; 429 honours Retry-After.
begin(); setDisk('fresh'); mode = '503';
item = await claude(clock()); assert.match(item.reason, /having trouble \(HTTP 503\), will retry/); assert.equal(item.status, 'no-data');
begin(); setDisk('fresh'); mode = '429';
const limitedAt = clock();
item = await claude(limitedAt); assert.match(item.reason, /rate limited/); assert.doesNotMatch(item.reason, /sign-in/);
const limitedHits = hits.length; mode = 'ok';
await claude(limitedAt + MAX_BACKOFF_MS + 1000);
assert.equal(hits.length, limitedHits, 'the 20-minute Retry-After is not shortened by the 15-minute backoff cap');
await claude(limitedAt + MAX_BACKOFF_MS + 1000, true);
assert.equal(hits.length, limitedHits, 'manual refresh cannot override Retry-After');
await claude(limitedAt + MAX_BACKOFF_MS + 1000, 'visit');
assert.equal(hits.length, limitedHits, 'visibility refresh cannot override Retry-After');
item = await claude(limitedAt + 1200_000 + 1000);
assert.equal(hits.length, limitedHits + 1, 'polling resumes after Retry-After'); assert.equal(item.status, 'ok');
begin(); setDisk('fresh');
const httpDateAt = clock(); retryAfter = new Date(httpDateAt + 1200_000).toUTCString(); mode = '429';
item = await claude(httpDateAt); assert.match(item.reason, /rate limited/);
const httpDateHits = hits.length; mode = 'ok';
for (const refresh of [false, true, 'visit']) {
  await claude(httpDateAt + MAX_BACKOFF_MS + 1000, refresh);
  assert.equal(hits.length, httpDateHits, `an HTTP-date Retry-After holds ${refresh} polling`);
}
item = await claude(httpDateAt + 1200_000 + 1000);
assert.equal(hits.length, httpDateHits + 1, 'an HTTP-date Retry-After is honored'); assert.equal(item.status, 'ok');

// Retry-After starts when the response arrives, not when the request starts.
begin(); setDisk('fresh'); mode = '429';
const realClock = Date.now;
let delayedNow = realClock();
Date.now = () => delayedNow;
try {
  const requestedAt = delayedNow;
  onLimitedResponse = () => { delayedNow += 10_000; };
  await claude(requestedAt);
  const count = hits.length; mode = 'ok'; onLimitedResponse = () => {};
  for (const refresh of [false, true, 'visit']) {
    await claude(requestedAt + 1200_000 + 1000, refresh);
    assert.equal(hits.length, count, 'request latency must not shorten Retry-After');
  }
  await claude(delayedNow + 1200_000 + 1);
  assert.equal(hits.length, count + 1);
} finally { Date.now = realClock; onLimitedResponse = () => {}; }

// 3. A real 401 is an auth problem; a token Pi renewed on disk meanwhile is picked up by the next attempt (even the retry inside the same one).
begin(); setDisk('stale');
item = await claude(clock());
assert.match(item.reason, /rejected the sign-in \(HTTP 401\)/); assert.equal(item.status, 'unavailable');
setDisk('fresh');
item = await claude(clock() + MAX_BACKOFF_MS + 1000);
assert.equal(item.samples.length, 2, 'credentials are re-read on every attempt'); assert.equal(item.reason, null); assert.equal(item.status, 'ok');
begin(); setDisk('stale'); let reads = 0;
limits.setLimitsTokenResolver?.(forClaude(async () => (++reads === 1 ? 'stale' : 'fresh')));
item = await claude(clock());
assert.equal(item.samples.length, 2, 'after a 401 the credentials are re-read once and a different token is tried'); assert.deepEqual(hits, ['Bearer stale', 'Bearer fresh']);

// 4. An access token that expired while nobody used the provider is renewed by the resolver (Pi's locked refresh), not sent stale; manual refresh recovers too.
begin(); setDisk('stale', Date.now() - 3600_000);
let renewals = 0, offline = false;
limits.setLimitsTokenResolver?.(forClaude(async () => { renewals++; if (offline) throw Object.assign(new Error('OAuth refresh failed for anthropic'), { cause: new Error('fetch failed') }); setDisk('fresh'); return 'fresh'; }));
offline = true;
item = await claude(clock());
assert.match(item.reason, /^Couldn't renew the Claude sign-in right now, will retry$/); assert.equal(item.status, 'no-data'); assert.equal(hits.length, 0, 'no request with a token that could not be renewed');
offline = false;
item = await claude(clock() + 1000, true);
assert.equal(item.samples.length, 2); assert.deepEqual(hits, ['Bearer fresh'], 'the stale token was never sent'); assert.equal(renewals, 2);
// A refresh token the provider rejects is an auth problem, and nothing is remembered from it.
begin();
limits.setLimitsTokenResolver?.(forClaude(async () => { throw Object.assign(new Error('OAuth refresh failed for anthropic'), { cause: new Error('HTTP 400 invalid_grant') }); }));
item = await claude(clock()); assert.match(item.reason, /rejected when renewing it/); assert.equal(item.status, 'unavailable');
limits.setLimitsTokenResolver?.(forClaude(async () => 'fresh'));
item = await claude(clock() + 20_000, true); assert.equal(item.samples.length, 2, 'the next attempt asks again; the failed renewal was not cached');

// 5. Manual refresh in an error state performs a real fetch (not the cached error), subject only to the cooldown.
begin(); setDisk('stale');
await claude(clock());
const before = hits.length;
setDisk('fresh');
item = await claude(clock() + 1000, true);
assert.equal(hits.length > before, true, 'manual refresh fetched'); assert.equal(item.samples.length, 2); assert.equal(item.reason, null);
begin(); setDisk('fresh'); mode = 'drop';
await claude(clock()); const n = hits.length;
await claude(clock() + 1000, true); assert.equal(hits.length, n + 1, 'manual refresh inside the backoff still fetches');
await claude(clock() + 2000, true); assert.equal(hits.length, n + 1, 'but not twice inside the 15 s cooldown');
assert.equal(MANUAL_COOLDOWN_MS, 15_000);

// 6. A page load or the tab coming back ("visit") retries an errored provider inside its backoff, but waits for a Retry-After and the cooldown.
begin(); setDisk('fresh'); mode = 'drop';
await claude(clock()); const m = hits.length; mode = 'ok';
item = await claude(clock() + 1000, 'visit'); assert.equal(hits.length, m, 'inside the 15 s cooldown nothing is fetched');
item = await claude(clock() + MANUAL_COOLDOWN_MS + 1000, 'visit'); assert.equal(hits.length, m + 1); assert.equal(item.samples.length, 2, 'a reload recovers without waiting for the backoff');
begin(); setDisk('fresh'); mode = '429';
await claude(clock()); const k = hits.length; mode = 'ok';
await claude(clock() + MANUAL_COOLDOWN_MS + 1000, 'visit'); assert.equal(hits.length, k, 'a reload does not override Retry-After');
// A healthy provider is never polled by a visit.
begin(); setDisk('fresh');
await claude(clock()); const h = hits.length;
await claude(clock() + 60_000, 'visit'); assert.equal(hits.length, h, 'no extra poll when there is no error');

// 7. Eliza uses the existing OAuth token only on the host, returns actual USD month-to-date usage, and recovers from transient failures without losing it.
begin(); process.env.ELIZA_TOKEN = 'fresh';
item = await eliza(clock());
assert.equal(item.usage.amountUsd, 5); assert.equal(item.usage.account, 'owner'); assert.equal(item.usage.pool, null); assert.equal(item.status, 'ok');
assert.ok(item.usage.periodStartAt <= Date.now() && item.usage.periodEndAt > Date.now()); assert.ok(!JSON.stringify(item).includes('fresh'));
mode = 'drop';
item = await eliza(clock() + 1000, true); assert.equal(item.usage.amountUsd, 5); assert.match(item.reason, /^Couldn't reach Eliza, will retry$/); assert.equal(item.status, 'ok');
mode = 'ok';
item = await eliza(clock() + MANUAL_COOLDOWN_MS + 1000, true); assert.equal(item.reason, null); assert.equal(item.usage.amountUsd, 5);

// 8. Missing/rejected Eliza auth is honestly unavailable, not $0; a later valid token recovers through the same manual refresh path.
begin(); delete process.env.ELIZA_TOKEN;
item = await eliza(clock()); assert.equal(item.status, 'unavailable'); assert.equal(item.usage, null); assert.match(item.reason, /No Eliza OAuth token found/);
process.env.ELIZA_TOKEN = 'fresh';
item = await eliza(clock() + 1000, true); assert.equal(item.status, 'ok'); assert.equal(item.usage.amountUsd, 5);
begin(); accepted = 'other';
item = await eliza(clock()); assert.equal(item.status, 'unavailable'); assert.equal(item.usage, null); assert.match(item.reason, /HTTP 401/);
accepted = 'fresh';
item = await eliza(clock() + 1000, true); assert.equal(item.status, 'ok'); assert.equal(item.usage.amountUsd, 5);

// A successful old-month reading survives a response crossing midnight, but is never relabeled.
begin(); process.env.ELIZA_TOKEN = 'fresh';
const realNow = Date.now;
let now = Date.parse('2026-10-31T23:59:00Z');
Date.now = () => now;
try {
  item = await eliza(now);
  const oldReading = item.usage;
  now = Date.parse('2026-10-31T23:59:59Z');
  onElizaResponse = () => { now = Date.parse('2026-11-01T00:00:01Z'); };
  item = await eliza(now, true);
  assert.deepEqual(item.usage, oldReading, 'a boundary-crossing response cannot replace the old reading');
  assert.match(item.reason, /crossed the UTC month boundary/);
  assert.ok(item.nextAttemptAt > now, 'a discarded response schedules a retry');
  onElizaResponse = () => {};
  now = item.nextAttemptAt + 1;
  item = await eliza(now);
  assert.equal(item.reason, null);
  assert.equal(item.usage.periodStartAt, Date.parse('2026-11-01T00:00:00Z'));
} finally { Date.now = realNow; onElizaResponse = () => {}; }

delete process.env.ELIZA_TOKEN;
server.close();
console.log('usage-limits recovery: all checks passed');
