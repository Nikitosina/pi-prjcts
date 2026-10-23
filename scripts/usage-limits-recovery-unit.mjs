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
let mode = 'ok', accepted = 'fresh'; const hits = [];
const usage = { five_hour: { utilization: 33, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 12, resets_at: '2030-01-02T00:00:00Z' } };
const server = createServer((req, res) => {
  hits.push(req.headers.authorization);
  if (mode === 'drop') return req.socket.destroy();
  if (mode === '503') { res.writeHead(503); return res.end('down'); }
  if (mode === '429') { res.writeHead(429, { 'retry-after': '1200' }); return res.end(); }
  if (req.headers.authorization !== `Bearer ${accepted}`) { res.writeHead(401); return res.end('no'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(usage));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
process.env.PI_PROJECTS_CLAUDE_USAGE_URL = process.env.PI_PROJECTS_CODEX_USAGE_URL = `http://127.0.0.1:${server.address().port}/usage`;
const limits = await import('../src/usage-limits.ts');
const { limitsSnapshot, resetLimitsForTest, MANUAL_COOLDOWN_MS, MAX_BACKOFF_MS } = limits;
const claude = async (now, refresh) => (await limitsSnapshot(now, refresh)).providers.find(item => item.provider === 'claude');
// The resolver is shared by every provider; these tests only answer for Claude.
const forClaude = fn => async id => (id === 'anthropic' ? fn() : undefined);
const setDisk = (access, expires = Date.now() + 3600_000) => writeFileSync(join(agent, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', access, refresh: 'r', expires } }));
const begin = () => { resetLimitsForTest(); limits.setLimitsTokenResolver?.(null); hits.length = 0; mode = 'ok'; accepted = 'fresh'; };
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
item = await claude(clock()); assert.match(item.reason, /rate limited/); assert.doesNotMatch(item.reason, /sign-in/);

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

server.close();
console.log('usage-limits recovery: all checks passed');
