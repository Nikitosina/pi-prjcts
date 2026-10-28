import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { workerDigest } from '../src/durable-watchdog.ts';
const now = 100000, since = 90000, id = 'bg-12345678';
const work = { id: 'w', threadId: 't', role: 'worker', text: 'suite', startedAt: 80000, attempt: {} };
function message(name, args, result, at, error = false) {
  const callId = String(at);
  return { id: at, model: [{ role: 'assistant', timestamp: at, content: [{ type: 'toolCall', id: callId, name, arguments: args }] }, { role: 'toolResult', toolCallId: callId, isError: error, content: [{ type: 'text', text: JSON.stringify(result) }] }] };
}
const start = message('projects_bg_start', {}, { id, state: 'running', startedAt: 80000, pid: 42, lstart: 'start' }, 81000);
const sample = (count, at, extra = {}) => message('projects_bg_status', { id, waitSeconds: 1 }, { id, state: 'running', startedAt: 80000, pid: 42, lstart: 'start', tail: `[${count}/166] PASS test-e2e (1s)`, ...extra }, at);
const verdict = async entries => (await workerDigest(work, entries, since, now, null, 6000)).actionable;
assert.equal(await verdict([start, sample(90, 91000), sample(91, 92000), sample(92, 93000)]), false, 'advancing owned job');
assert.equal(await verdict([start, sample(90, 91000), sample(90, 92000), sample(90, 93000)]), true, 'stalled job');
assert.equal(await verdict([sample(90, 91000), sample(91, 92000), sample(92, 93000)]), true, 'unowned job');
assert.equal(await verdict([start, sample(90, 91000), sample(91, 92000), sample(92, 93000, {state:'exited'})]), true, 'settled job');
assert.equal(await verdict([start, sample(90, 91000), sample(91, 92000), sample(92, 93000, {pid: 99})]), true, 'changed identity');
assert.equal(await verdict([start, sample(92, 91000), sample(91, 92000), sample(90, 93000)]), true, 'decreasing count');
assert.equal(await verdict([start, sample(90, 91000), sample(91, 92000), sample(92, 93000), message('projects_bg_status', {id,waitSeconds:1}, {}, 94000, true)]), true, 'status error');
const oldStart = message('projects_bg_start', {}, { id, state: 'running', startedAt: -1900000, pid: 42, lstart: 'start' }, 1000);
assert.equal(await verdict([oldStart, ...[90,91,92].map((n,i) => sample(n, 91000 + i*1000, {startedAt:-1900000}))]), true, 'bounded exemption');
assert.equal(await verdict([start, sample(90, 91000), sample(90, 92000, { logBytes: 50 }), sample(90, 93000, { logBytes: 100 })]), true, 'log growth is not progress');
assert.equal(await verdict([start, sample(90, 91000), sample(91, 92000), sample(92, 93000), message('bash', {command:'true'}, {}, 94000)]), true, 'unrelated calls do not excuse polling');
const root = mkdtempSync(join(tmpdir(), 'watchdog-clean-'));
try {
  execFileSync('git', ['init', '-q', root]);
  const entries = [start, sample(90, 91000), sample(91, 92000)];
  entries[1].model[0].usage = { totalTokens: 1 };
  const result = await workerDigest({ ...work, attempt: { cwd: root } }, entries, since, now, null, 6000);
  assert.equal(result.actionable, false, 'two progressing polls are not a token-only stall');
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('watchdog progress controls passed');
