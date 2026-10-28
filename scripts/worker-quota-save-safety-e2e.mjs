// Save-path safety on a private host with a local fake provider and disposable repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';

const quota = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
const auth = { status: 401, body: { error: { message: 'Invalid API key', code: 'invalid_api_key' } } };
const releaseHealthy = Promise.withResolvers();
const kit = await createKit('worker-quota-save-safety', {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '20', PI_PROJECTS_QUOTA_SWEEP_MS: '15' },
  handler: ({ role, model, user, results }) => {
    if (role === 'coordinator') {
      if (results.length) return say('Control applied.');
      const control = /^CONTROL (\{.*\})$/.exec(user)?.[1];
      return control ? call('projects_worker_control', JSON.parse(control)) : say('Noted.');
    }
    if (role !== 'worker') return say('Noted.');
    if (model === 'fallback-model') return say('Fallback completed.');
    if (user.includes('AUTH_FAILURE')) return auth;
    if (user.includes('HEALTHY_RUNNING')) return (async function* () { await releaseHealthy.promise; yield say('Healthy completed.'); })();
    if (user.includes('HEALTHY')) return say('Healthy completed.');
    return quota;
  },
});

await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json'), models = JSON.parse(readFileSync(path, 'utf8'));
  models.providers.fake.models.push({ ...models.providers.fake.models[0], id: 'fallback-model', name: 'Fallback fake' });
  writeFileSync(path, JSON.stringify(models));
  kit.initRepo();
  const id = await kit.createProject('Save safety', { workerCap: 4 });
  const scopeId = (await kit.rpc({ action: 'workspace-catalog', id })).find(scope => scope.wholeRepository).id;
  const submit = async text => {
    const threadId = randomUUID(), workId = randomUUID();
    await kit.rpc({ action: 'work-submit', id, threadId, requestId: workId, workspaceScopeId: scopeId, text });
    return { threadId, workId };
  };
  const row = async item => (await kit.plan(id)).find(work => work.id === item.workId);
  const wait = (item, predicate) => kit.eventually(async () => { const work = await row(item); return work && predicate(work) && work; }, `work ${item.workId} did not reach expected state`, 300);
  const calls = marker => kit.result.calls.filter(entry => entry.role === 'worker' && entry.user.includes(marker));
  const control = async item => {
    await kit.rpc({ action: 'message', id, text: `CONTROL ${JSON.stringify({ action: 'stop', threadId: item.threadId })}` });
    await kit.eventually(() => kit.result.calls.some(entry => entry.role === 'coordinator' && entry.results.some(value => value.includes(item.threadId))), 'stop control not applied');
  };
  const save = () => kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  const clear = () => kit.updateSettings(id, { fallbackModels: { worker: null } });

  const stopped = await submit('STOP_WAIT quota');
  await wait(stopped, work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:'));
  await control(stopped);
  await wait(stopped, work => work.status === 'stopped');
  const stoppedCount = calls('STOP_WAIT').length;
  await save(); await delay(300);
  kit.check('saving fallback does not restart stopped quota-waiting work', (await row(stopped)).status === 'stopped' && calls('STOP_WAIT').length === stoppedCount);
  await clear();

  const idle = await submit('STOP_IDLE quota');
  const failed = await wait(idle, work => work.status === 'failed' && work.blocker?.startsWith('quota_recovery_exhausted:'));
  await control(idle);
  const idleCount = calls('STOP_IDLE').length;
  await save(); await delay(300);
  const idleAfter = await row(idle);
  kit.check('saving fallback does not revive quota-failed work after stopping its idle thread', ['failed', 'stopped'].includes(idleAfter.status) && calls('STOP_IDLE').length === idleCount && idleAfter.attempt.model === failed.attempt.model, { failed, idleAfter });
  await clear();

  const unrelated = await submit('AUTH_FAILURE unrelated');
  const unrelatedBefore = await wait(unrelated, work => work.status === 'failed');
  const healthy = await submit('HEALTHY existing');
  const healthyBefore = await wait(healthy, work => work.status === 'completed');
  const running = await submit('HEALTHY_RUNNING existing');
  await wait(running, work => work.status === 'running');
  await kit.eventually(() => calls('HEALTHY_RUNNING').length === 1, 'healthy request did not start');
  const unrelatedCount = calls('AUTH_FAILURE').length, healthyCount = calls('HEALTHY existing').length;
  await save(); await delay(300);
  kit.check('saving fallback leaves unrelated failures alone', (await row(unrelated)).status === 'failed' && calls('AUTH_FAILURE').length === unrelatedCount && (await row(unrelated)).blocker === unrelatedBefore.blocker);
  kit.check('saving fallback leaves healthy completed work alone', (await row(healthy)).status === 'completed' && calls('HEALTHY existing').length === healthyCount && (await row(healthy)).attempt.model === healthyBefore.attempt.model);
  const runningAfter = await row(running);
  releaseHealthy.resolve();
  const runningDone = await wait(running, work => work.status === 'completed');
  kit.check('saving fallback does not interrupt or redirect healthy running work', runningAfter.status === 'running' && runningDone.attempt.model === 'fake/fake-model' && calls('HEALTHY_RUNNING').length === 1, { runningAfter, runningDone });
  await clear();

  const paused = await submit('PROJECT_PAUSE quota');
  await wait(paused, work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:'));
  await kit.rpc({ action: 'pause', id });
  const pauseBefore = await row(paused), pauseCount = calls('PROJECT_PAUSE').length;
  await save(); await delay(300);
  const pauseAfter = await row(paused);
  kit.check('saving fallback does not run work while the project is paused', pauseAfter.status === pauseBefore.status && calls('PROJECT_PAUSE').length === pauseCount, { pauseBefore, pauseAfter });
  await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  await clear();

  const eligible = await submit('ELIGIBLE quota');
  await wait(eligible, work => work.status === 'failed' && work.blocker?.startsWith('quota_recovery_exhausted:'));
  const fallbackCallsBefore = kit.result.calls.filter(entry => entry.role === 'worker' && entry.model === 'fallback-model').length;
  await save();
  const recovered = await kit.waitFor(async () => { const work = await row(eligible); return work?.status === 'completed' && work; }, 'saving fallback recovers eligible quota-failed work', { timeout: 5000 });
  kit.check('saving fallback recovers eligible quota-failed work on the same thread', recovered.threadId === eligible.threadId && recovered.attempt.model === 'fake/fallback-model' && kit.result.calls.filter(entry => entry.role === 'worker' && entry.model === 'fallback-model').length > fallbackCallsBefore, recovered);
});
