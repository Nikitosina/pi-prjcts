// Local fake provider supplies an exhausted-window reset. No real provider or credentials.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, randomUUID, say, call, delay } from './lib/e2e-kit.mjs';
let resetAt, requests = 0;
const kit = await createKit('worker-quota-known-reset', {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '100', PI_PROJECTS_QUOTA_SWEEP_MS: '30' },
  handler: ({ role }) => {
    if (role !== 'worker') return say('Noted.');
    requests++;
    if (requests > 2) return say('Recovered after reset.');
    if (requests === 2) return { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
    resetAt = Date.now() + 5000;
    return { status: 200, stream: call('bash', { command: ':' }), headers: {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(resetAt / 1000),
    } };
  },
});
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.providers.anthropic = { ...config.providers.fake, models: [{ ...config.providers.fake.models[0], id: 'local-reset-model' }] };
  writeFileSync(path, JSON.stringify(config));
  kit.initRepo();
  const id = await kit.createProject('Known quota reset');
  await kit.updateSettings(id, { models: { worker: 'anthropic/local-reset-model' } });
  const scope = (await kit.rpc({ action: 'workspace-catalog', id })).find(scope => scope.wholeRepository);
  const threadId = randomUUID();
  await kit.rpc({ action: 'work-submit', id, threadId, requestId: randomUUID(), workspaceScopeId: scope.id, text: 'Recover only after provider reset' });
  const row = () => kit.plan(id).then(rows => rows.find(row => row.threadId === threadId));
  const waiting = await kit.eventually(async () => { const work = await row(); return work?.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:') ? work : false; }, 'quota wait missing');
  kit.check('deadline uses provider reset instead of short test backoff', waiting.blocker.includes(new Date(resetAt).toISOString()), waiting);
  const followupId = randomUUID();
  await kit.rpc({ action: 'work-submit', id, threadId, requestId: followupId, workspaceScopeId: scope.id, text: 'Queued followup must not bypass the quota wait' });
  await delay(300);
  kit.check('no request before reset despite repeated sweeps', requests === 2 && (await row()).status === 'queued');
  await kit.restartHost();
  await delay(100);
  kit.check('host restart never resumes interrupted work automatically', requests === 2 && (await row()).status === 'interrupted');
  await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  const done = await kit.eventually(async () => { const work = await row(); return work?.status === 'completed' ? work : false; }, 'work did not recover');
  await kit.eventually(async () => (await kit.plan(id)).every(work => work.status === 'completed'), 'queued followup did not finish');
  const calls = kit.result.calls.filter(call => call.role === 'worker');
  kit.check('persisted reset recovers exactly once on the same model and thread', requests === 4 && calls[2].at >= resetAt && done.attempt.model === 'anthropic/local-reset-model' && done.attempt.modelTransitions.length === 0, { done, calls });
});
