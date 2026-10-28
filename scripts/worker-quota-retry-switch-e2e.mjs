// A manual retry must not discard a fallback saved while capacity was occupied, and must not use one that was removed.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, randomUUID, say, call, delay } from './lib/e2e-kit.mjs';

const quota = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
let hold = Promise.withResolvers();
const kit = await createKit('worker-quota-retry-switch', {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '600000', PI_PROJECTS_QUOTA_SWEEP_MS: '3600000' },
  handler: ({ role, model, user, results }) => {
    if (role === 'coordinator') {
      if (user.startsWith('[Durable work')) return say('Noted.');
      if (results.length) return say('Control applied.');
      const control = /^CONTROL (\{.*\})$/.exec(user)?.[1];
      return control ? call('projects_worker_control', JSON.parse(control)) : undefined;
    }
    if (user.includes('HOLD')) return (async function* () { await hold.promise; yield say('Finished.'); })();
    return model === 'fake-model' ? quota : say('Recovered.');
  },
});
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json'), models = JSON.parse(readFileSync(path, 'utf8'));
  models.providers.fake.models.push({ ...models.providers.fake.models[0], id: 'fallback-model', name: 'Fallback' });
  writeFileSync(path, JSON.stringify(models));
  kit.initRepo();
  const id = await kit.createProject('Retry switch', { workerCap: 1 });
  const scope = (await kit.rpc({ action: 'workspace-catalog', id })).find(item => item.wholeRepository).id;
  const submit = async text => { const threadId = randomUUID(), workId = randomUUID(); await kit.rpc({ action: 'work-submit', id, threadId, requestId: workId, workspaceScopeId: scope, text }); return { threadId, workId }; };
  const row = async workId => (await kit.plan(id)).find(work => work.id === workId);
  const wait = (workId, predicate) => kit.waitFor(async () => { const work = await row(workId); return work && predicate(work) && work; }, 'work state', { timeout: 15000 });
  const waiting = work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:');
  const save = model => kit.updateSettings(id, { fallbackModels: { worker: model } });
  const retry = async (workId, threadId, requestId = randomUUID()) => {
    const seen = kit.result.calls.filter(call => call.role === 'coordinator' && call.results.length).length;
    await kit.rpc({ action: 'message', id, text: `CONTROL ${JSON.stringify({ action: 'retry', workId, requestId })}` });
    await kit.eventually(() => kit.result.calls.filter(call => call.role === 'coordinator' && call.results.length).length > seen, 'retry control did not run');
  };
  const workerCalls = model => kit.result.calls.filter(call => call.role === 'worker' && !call.user.includes('HOLD') && call.model === model).length;

  // Fallback saved, then manual retry, while the only slot is occupied: the switch must survive until dispatch.
  const first = await submit('SWITCH quota'); await wait(first.workId, waiting);
  const primaryBefore = workerCalls('fake-model');
  const blocker = await submit('HOLD one'); await wait(blocker.workId, work => work.status === 'running');
  await save('fake/fallback-model');
  await retry(first.workId, first.threadId);
  kit.check('retry while capacity is occupied does not run the primary model', workerCalls('fake-model') === primaryBefore && (await row(first.workId)).status === 'queued');
  hold.resolve();
  const switched = await wait(first.workId, work => work.status === 'completed');
  kit.check('released capacity runs the retry on the saved fallback exactly once', switched.attempt.model === 'fake/fallback-model' && switched.attempt.modelTransitions.length === 1 && workerCalls('fake-model') === primaryBefore && workerCalls('fallback-model') === 1, switched);
  await save(null);

  // Fallback saved, retried, then removed before capacity returns: nothing may use the removed fallback.
  hold = Promise.withResolvers();
  const second = await submit('REMOVE quota'); await wait(second.workId, waiting);
  const blocker2 = await submit('HOLD two'); await wait(blocker2.workId, work => work.status === 'running');
  await save('fake/fallback-model');
  await retry(second.workId, second.threadId);
  await save(null);
  hold.resolve(); await wait(blocker2.workId, work => work.status === 'completed');
  const removed = await wait(second.workId, work => work.status === 'queued' && work.attempt.model === 'fake/fake-model');
  await delay(500);
  kit.check('a removed fallback is never used by a retry', workerCalls('fallback-model') === 1 && removed.attempt.modelTransitions.length === 0 && (await row(second.workId)).attempt.modelTransitions.length === 0, removed);
  // Saving a different fallback afterwards recovers it on that model.
  await save('fake/fallback-model');
  const later = await wait(second.workId, work => work.status === 'completed');
  kit.check('a later save recovers the work on the current fallback', later.attempt.model === 'fake/fallback-model' && later.attempt.modelTransitions.length === 1 && workerCalls('fallback-model') === 2, later);
  // Failed-origin recovery: the save revived a quota-failed record behind the occupied slot, then the owner retried and removed the fallback.
  await save(null);
  hold = Promise.withResolvers();
  const third = await submit('FAILED quota'); await wait(third.workId, waiting);
  await kit.stopHost(); Object.assign(process.env, kit.hostEnv);
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  const runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
  try {
    await runtime.withRoot(root => root.commit(async tx => {
      const work = (await tx.doc(DurablePlanning, root.id)).work[third.workId];
      delete work.attempt.quotaFallback; delete work.quotaRecovery;
      work.status = 'failed'; work.blocker = 'quota_exceeded: fake/fake-model: Quota exceeded';
    }, BACKGROUND_CONTEXT));
  } finally { await runtime.close(); }
  kit.startHost(); await kit.waitHost();
  if ((await kit.rpc({ action: 'plan-snapshot', id })).paused) await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  const blocker3 = await submit('HOLD three'); await wait(blocker3.workId, work => work.status === 'running');
  await save('fake/fallback-model');
  await wait(third.workId, work => work.status === 'queued');
  const primaryBeforeFailed = workerCalls('fake-model'), fallbackBeforeFailed = workerCalls('fallback-model');
  const receipt = randomUUID();
  await retry(third.workId, third.threadId, receipt);
  await save(null);
  hold.resolve(); await wait(blocker3.workId, work => work.status === 'completed');
  const ran = await wait(third.workId, work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:') && work.attempt.modelTransitions.length === 0);
  await retry(third.workId, third.threadId, receipt);
  await delay(500);
  kit.check('an accepted retry of a revived failed record runs on the primary after the fallback is removed', workerCalls('fake-model') === primaryBeforeFailed + 1 && workerCalls('fallback-model') === fallbackBeforeFailed && ran.attempt.model === 'fake/fake-model', ran);
  kit.check('replaying the retry request neither duplicates the attempt nor restores the failure', workerCalls('fake-model') === primaryBeforeFailed + 1 && (await row(third.workId)).status === 'queued');
});
