// Passive reset metadata must delay recovery until every exhausted window resets.
import assert from 'node:assert/strict';
import { observeLimitHeaders, quotaResetAt, resetLimitsForTest, MIN_POLL_MS } from '../src/usage-limits.ts';
const now = Date.now(), five = now + 3600_000, seven = now + 86400_000;
resetLimitsForTest();
assert.equal(quotaResetAt('anthropic/model', now), undefined);
observeLimitHeaders('anthropic', {
  'anthropic-ratelimit-unified-5h-utilization': '1',
  'anthropic-ratelimit-unified-5h-reset': String(five / 1000),
  'anthropic-ratelimit-unified-7d-utilization': '1',
  'anthropic-ratelimit-unified-7d-reset': String(seven / 1000),
}, now);
assert.equal(quotaResetAt('anthropic/model', now), seven);
assert.equal(quotaResetAt('fake/model', now), undefined);
assert.equal(quotaResetAt('anthropic/model', now + MIN_POLL_MS + 1), undefined);
assert.equal(quotaResetAt('anthropic/model', seven + 1), undefined);
resetLimitsForTest();
observeLimitHeaders('openai-codex', {
  'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-at': String(five / 1000),
  'x-codex-secondary-used-percent': '50', 'x-codex-secondary-window-minutes': '10080',
  'x-codex-secondary-reset-at': String(seven / 1000),
}, now);
assert.equal(quotaResetAt('openai-codex/model', now), five);
assert.equal(quotaResetAt('openai/model', now), undefined);
resetLimitsForTest();
observeLimitHeaders('anthropic', {
  'anthropic-ratelimit-unified-5h-utilization': '1',
  'anthropic-ratelimit-unified-5h-reset': '1e99',
}, now);
assert.equal(quotaResetAt('anthropic/model', now), undefined, 'invalid calendar timestamps cannot strand settlement');
resetLimitsForTest();
console.log('worker quota reset: all checks passed');
