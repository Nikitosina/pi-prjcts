// Unit checks for src/usage-limits.ts using header shapes recorded from real responses (values only, no credentials).
// No network: the endpoint pollers are replaced by PI_PROJECTS_LIMITS_FIXTURE and a missing file.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'usage-limits-'));
process.env.PI_PROJECTS_LIMITS_FIXTURE = join(dir, 'missing.json');
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
