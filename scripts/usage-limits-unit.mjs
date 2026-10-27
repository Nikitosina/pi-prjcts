// Unit checks for src/usage-limits.ts using header shapes recorded from real responses (values only, no credentials).
// No network: the endpoint pollers are replaced by PI_PROJECTS_LIMITS_FIXTURE and a missing file.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'usage-limits-'));
process.env.PI_PROJECTS_LIMITS_FIXTURE = join(dir, 'missing.json');
// Private agent dir and HOME: the real Cursor sign-in is never read, and no request leaves the machine.
const agent = join(dir, 'agent'), userHome = join(dir, 'home'); mkdirSync(agent); mkdirSync(userHome);
process.env.PI_CODING_AGENT_DIR = agent; process.env.HOME = userHome;
const seen = [];
const fake = createServer((req, res) => { seen.push({ url: req.url, cookie: req.headers.cookie }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ billingCycleEnd: '2026-11-01T00:00:00.000Z', individualUsage: { plan: { enabled: true, totalPercentUsed: 75.5 } } })); });
await new Promise(ok => fake.listen(0, '127.0.0.1', ok));
process.env.PI_PROJECTS_CURSOR_DASHBOARD = `http://127.0.0.1:${fake.address().port}`;
const { MIN_POLL_MS, MANUAL_COOLDOWN_MS, observeLimitHeaders, limitsSnapshot, resetLimitsForTest, windowForSeconds, parseElizaUsage } = await import('../src/usage-limits.ts');
const find = (snapshot, provider) => snapshot.providers.find(item => item.provider === provider);

// Eliza: sum actual monthly cost across usage buckets. The account and UTC calendar-month bounds come from the response and documented reset rule.
const october = Date.parse('2026-10-26T18:00:00Z');
const elizaBody = { account: 'owner', pool: '', usage: { all: { stats: { monthly: { requests: 58, cost: 5.25 } } }, 'chain:top_opensource': { stats: { monthly: { requests: 10, cost: 0.095 } } } } };
assert.deepEqual(parseElizaUsage(elizaBody, october), { amountUsd: 5.345, periodStartAt: Date.parse('2026-10-01T00:00:00Z'), periodEndAt: Date.parse('2026-11-01T00:00:00Z'), account: 'owner', pool: null });
// EffectiveUsage caps the chain bucket at 300 and moves its 200 overflow into all. The
// dedicated claude bucket is separate. 220 + 300 + 50 therefore counts the 500 chain spend once.
const bucket = cost => ({ stats: { monthly: { requests: 1, cost } } });
const overlapping = parseElizaUsage({ ...elizaBody, usage: {
  all: { ...bucket(220), by_family: { gpt: { monthly: { requests: 1, cost: 20 } } } },
  'chain:kimi_zai': { ...bucket(300), by_family: { kimi: { monthly: { requests: 1, cost: 500 } } } },
  claude: bucket(50),
} }, october);
assert.equal(overlapping.amountUsd, 570, 'chain overflow and dedicated buckets are not double counted');
assert.throws(
  () => parseElizaUsage(elizaBody, Date.parse('2026-10-31T23:59:59Z'), Date.parse('2026-11-01T00:00:01Z')),
  /crossed the UTC month boundary/,
  'a response crossing the boundary is discarded rather than assigned to the new month',
);
const beforeBoundary = parseElizaUsage(elizaBody, Date.parse('2026-10-31T23:59:59Z'), Date.parse('2026-10-31T23:59:59.500Z'));
assert.equal(beforeBoundary.periodStartAt, Date.parse('2026-10-01T00:00:00Z'));
assert.equal(beforeBoundary.periodEndAt, Date.parse('2026-11-01T00:00:00Z'));
assert.equal(parseElizaUsage({ ...elizaBody, usage: {} }, october), null, 'an empty usage object is no data, not a fabricated zero');
for (const bad of [{ ...elizaBody, account: '' }, { ...elizaBody, pool: null }, { ...elizaBody, usage: { all: { stats: { monthly: { cost: -1 } } } } }, { ...elizaBody, usage: { all: { stats: { monthly: {} } } } }, { ...elizaBody, usage: { all: { stats: { monthly: { cost: null } } } } }]) assert.throws(() => parseElizaUsage(bad, october), /unreadable usage response/);

// Anthropic unified headers: utilization is a 0..1 fraction, reset is epoch seconds.
observeLimitHeaders('anthropic', { 'anthropic-ratelimit-unified-5h-utilization': '0.11', 'anthropic-ratelimit-unified-5h-reset': '1792750800', 'anthropic-ratelimit-unified-7d-utilization': '0.36', 'anthropic-ratelimit-unified-7d-reset': '1792774800', 'anthropic-ratelimit-unified-status': 'allowed' }, 1_000);
let claude = find(await limitsSnapshot(1_000), 'claude');
assert.deepEqual(claude.samples.map(({ window, usedPercent, resetsAt, observedAt, source }) => ({ window, usedPercent, resetsAt, observedAt, source })), [
  { window: '5h', usedPercent: 11, resetsAt: 1792750800000, observedAt: 1_000, source: 'headers' },
  { window: '7d', usedPercent: 36, resetsAt: 1792774800000, observedAt: 1_000, source: 'headers' },
]);

// Codex: primary/secondary are classified by window length, so a weekly-only plan is never shown as 5h; an empty secondary is ignored.
resetLimitsForTest();
observeLimitHeaders('openai-codex', { 'X-Codex-Primary-Used-Percent': '3', 'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-at': '1793294761', 'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0', 'x-codex-secondary-reset-at': '' }, 2_000);
const codex = find(await limitsSnapshot(2_000), 'codex');
assert.deepEqual(codex.samples.map(({ window, usedPercent, resetsAt }) => ({ window, usedPercent, resetsAt })), [{ window: '7d', usedPercent: 3, resetsAt: 1793294761000 }]);
assert.equal(windowForSeconds(300 * 60), '5h'); assert.equal(windowForSeconds(604800), '7d'); assert.equal(windowForSeconds(86400), null); assert.equal(windowForSeconds(0), null);

// Garbage and other providers never create numbers.
resetLimitsForTest();
observeLimitHeaders('anthropic', { 'anthropic-ratelimit-unified-5h-utilization': 'abc' });
observeLimitHeaders('openai', { 'x-codex-primary-used-percent': '5', 'x-codex-primary-window-minutes': '300' });
observeLimitHeaders('anthropic', { 'anthropic-ratelimit-unified-7d-utilization': '', 'anthropic-ratelimit-unified-7d-reset': '1' });
const none = await limitsSnapshot(3_000);
assert.equal(find(none, 'claude').samples.length, 0); assert.equal(find(none, 'claude').status, 'no-data');
assert.equal(find(none, 'cursor').status, 'unavailable'); assert.equal(find(none, 'cursor').samples.length, 0);

// Cursor: signed out is unavailable (and offers Connect); a stored sign-in gives the monthly window from the usage summary.
assert.equal(find(none, 'cursor').connect.state, 'idle');
resetLimitsForTest();
const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'auth0|user_1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.y`;
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ cursor: { type: 'oauth', access: jwt, refresh: 'r', expires: Date.now() + 3600_000 } }));
const cursor = find(await limitsSnapshot(5_000), 'cursor');
assert.deepEqual(cursor.samples.map(({ window, usedPercent, resetsAt }) => ({ window, usedPercent, resetsAt })), [{ window: 'mo', usedPercent: 75.5, resetsAt: Date.parse('2026-11-01T00:00:00.000Z') }]);
assert.equal(seen.length, 1); assert.equal(seen[0].url, '/api/usage-summary'); assert.ok(seen[0].cookie.startsWith('WorkosCursorSessionToken=auth0%7Cuser_1%3A%3A'));
assert.ok(!JSON.stringify(cursor).includes(jwt), 'the token never reaches the snapshot');
// An expired sign-in is not sent anywhere.
resetLimitsForTest();
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ cursor: { access: `x.${Buffer.from(JSON.stringify({ sub: 's', exp: 1 })).toString('base64url')}.y` } }));
assert.equal(find(await limitsSnapshot(6_000), 'cursor').status, 'unavailable'); assert.equal(seen.length, 1);
fake.close();

// Poll cadence: with a failing source the endpoint is retried only after the backoff, never inside the 5-minute minimum.
resetLimitsForTest();
writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ claude: [{ window: '5h', usedPercent: 50, resetsAt: null }] }));
process.env.PI_PROJECTS_LIMITS_FIXTURE = join(dir, 'fixture.json');
const first = await limitsSnapshot(10_000);
assert.equal(find(first, 'claude').samples[0].source, 'endpoint');
writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ claude: [{ window: '5h', usedPercent: 80, resetsAt: null }] }));
assert.equal(MIN_POLL_MS, 300_000); assert.equal(MANUAL_COOLDOWN_MS, 15_000);
assert.equal(find(await limitsSnapshot(71_000), 'claude').samples[0].usedPercent, 50, 'no second poll after 60 s');
assert.equal(find(await limitsSnapshot(309_000), 'claude').samples[0].usedPercent, 50, 'no second poll inside 5 min');
assert.equal(find(await limitsSnapshot(311_000), 'claude').samples[0].usedPercent, 80, 'polls again after 5 min');
// A fresh passive sample keeps the endpoint idle for the 5-minute window.
observeLimitHeaders('anthropic', { 'anthropic-ratelimit-unified-5h-utilization': '0.9' }, Date.now());
assert.equal(find(await limitsSnapshot(Date.now() + 1000), 'claude').samples[0].usedPercent, 90);

// Manual refresh: bypasses the minimum, the backoff and fresh header samples; rate-limited per provider; failure keeps the last numbers.
resetLimitsForTest();
let mode = 'ok', hits = 0;
const flaky = createServer((req, res) => { hits++; if (mode === 'fail') { res.writeHead(500); res.end('boom'); return; } res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ billingCycleEnd: '2026-11-01T00:00:00.000Z', individualUsage: { plan: { enabled: true, totalPercentUsed: 10 } } })); });
await new Promise(ok => flaky.listen(0, '127.0.0.1', ok));
process.env.PI_PROJECTS_CURSOR_DASHBOARD = `http://127.0.0.1:${flaky.address().port}`;
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ cursor: { type: 'oauth', access: jwt, refresh: 'r', expires: Date.now() + 3600_000 } }));
const T = 1_000_000_000;
assert.equal(find(await limitsSnapshot(T), 'cursor').samples[0].usedPercent, 10); assert.equal(hits, 1);
await limitsSnapshot(T + 60_000); assert.equal(hits, 1, 'a normal snapshot inside 5 min does not poll');
mode = 'fail';
let refreshed = find(await limitsSnapshot(T + 60_000, true), 'cursor');
assert.equal(hits, 2, 'manual refresh bypasses the 5-minute minimum');
assert.equal(refreshed.samples[0].usedPercent, 10, 'failure keeps the last numbers'); assert.ok(refreshed.reason, 'failure reason is reported');
await limitsSnapshot(T + 61_000, true); assert.equal(hits, 2, 'second click inside the 15 s cooldown is ignored');
await limitsSnapshot(T + 62_000); assert.equal(hits, 2, 'the failure backoff holds off a normal snapshot');
mode = 'ok';
refreshed = find(await limitsSnapshot(T + 60_000 + MANUAL_COOLDOWN_MS + 1, true), 'cursor');
assert.equal(hits, 3, 'manual refresh bypasses the backoff after the cooldown');
assert.equal(refreshed.reason, null); assert.equal(refreshed.samples[0].usedPercent, 10);
flaky.close();
console.log('usage-limits unit checks passed');
