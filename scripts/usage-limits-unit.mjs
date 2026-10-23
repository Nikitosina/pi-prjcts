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
const { observeLimitHeaders, limitsSnapshot, resetLimitsForTest, windowForSeconds } = await import('../src/usage-limits.ts');
const find = (snapshot, provider) => snapshot.providers.find(item => item.provider === provider);

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

// Poll cadence: with a failing source the endpoint is retried only after the backoff, never inside the minute.
resetLimitsForTest();
writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ claude: [{ window: '5h', usedPercent: 50, resetsAt: null }] }));
process.env.PI_PROJECTS_LIMITS_FIXTURE = join(dir, 'fixture.json');
const first = await limitsSnapshot(10_000);
assert.equal(find(first, 'claude').samples[0].source, 'endpoint');
writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ claude: [{ window: '5h', usedPercent: 80, resetsAt: null }] }));
assert.equal(find(await limitsSnapshot(40_000), 'claude').samples[0].usedPercent, 50, 'no second poll within 60 s');
assert.equal(find(await limitsSnapshot(71_000), 'claude').samples[0].usedPercent, 80, 'polls again after 60 s');
// A fresh passive sample keeps the endpoint idle.
observeLimitHeaders('anthropic', { 'anthropic-ratelimit-unified-5h-utilization': '0.9' }, Date.now());
assert.equal(find(await limitsSnapshot(Date.now() + 1000), 'claude').samples[0].usedPercent, 90);
console.log('usage-limits unit checks passed');
