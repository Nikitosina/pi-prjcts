// Save-path regression: a waiting worker adopts a newly configured fallback without a manual retry.
// The provider, host, home and workspace are disposable and local to this test.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, randomUUID, say, waitFor } from './lib/e2e-kit.mjs';

const quota = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
const kit = await createKit('worker-quota-live-save', {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '600000', PI_PROJECTS_QUOTA_SWEEP_MS: '50' },
  handler: ({ role, model }) => role === 'worker' ? model === 'fallback-model' ? say('Recovered on fallback.') : quota : undefined,
});

await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: 'fallback-model', name: 'Fallback' });
  writeFileSync(path, JSON.stringify(config));
  kit.initRepo();
  const id = await kit.createProject('Live quota fallback');
  const scope = (await kit.rpc({ action: 'workspace-catalog', id })).find(item => item.wholeRepository);
  const threadId = randomUUID();
  await kit.rpc({ action: 'work-submit', id, threadId, requestId: randomUUID(), workspaceScopeId: scope.id, text: 'Recover after settings save' });
  const row = async () => (await kit.plan(id)).find(item => item.threadId === threadId);
  const waiting = await waitFor(async () => { const work = await row(); return work?.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:') && work; }, 'worker quota wait', { timeout: 15000 });
  const originalCalls = kit.result.calls.filter(item => item.role === 'worker');
  kit.check('worker is waiting on its original model', waiting.attempt.model === 'fake/fake-model' && originalCalls.length === 1, waiting);
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  const done = await waitFor(async () => { const work = await row(); return work?.status === 'completed' && work; }, 'settings save should recover the waiting worker', { timeout: 10000 });
  const calls = kit.result.calls.filter(item => item.role === 'worker');
  kit.check('save resumes the same thread exactly once with an audited transition', done.threadId === threadId && done.attempt.model === 'fake/fallback-model' && done.attempt.modelTransitions.length === 1 && done.attempt.modelTransitions[0].from === 'fake/fake-model' && done.attempt.modelTransitions[0].reason === 'quota_exceeded' && calls.length === 2 && calls[1].model === 'fallback-model', { done, calls });
  kit.check('fallback preserves frozen instructions and tools', calls[0].system === calls[1].system && calls[0].tools.join() === calls[1].tools.join(), calls);
});
