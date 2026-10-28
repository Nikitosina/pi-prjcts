// A settings save that mixes the fallback with a non-live setting (the name) must recover quota-failed work too.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, randomUUID, say, delay } from './lib/e2e-kit.mjs';

const quota = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
const auth = { status: 401, body: { error: { message: 'Invalid API key', code: 'invalid_api_key' } } };
const kit = await createKit('worker-quota-mixed-save', {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '600000', PI_PROJECTS_QUOTA_SWEEP_MS: '3600000' },
  handler: ({ role, model, user }) => role !== 'worker' ? say('Noted.') : model === 'fallback-model' ? say('Recovered.') : user.includes('AUTH') ? auth : user.includes('HEALTHY') ? say('Healthy done.') : quota,
});
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json'), models = JSON.parse(readFileSync(path, 'utf8'));
  models.providers.fake.models.push({ ...models.providers.fake.models[0], id: 'fallback-model', name: 'Fallback' });
  writeFileSync(path, JSON.stringify(models)); kit.initRepo();
  const id = await kit.createProject('Mixed save', { workerCap: 3 });
  const scope = (await kit.rpc({ action: 'workspace-catalog', id })).find(item => item.wholeRepository).id;
  const submit = async text => { const threadId = randomUUID(), workId = randomUUID(); await kit.rpc({ action: 'work-submit', id, threadId, requestId: workId, workspaceScopeId: scope, text }); return workId; };
  const row = async workId => (await kit.plan(id)).find(work => work.id === workId);
  const wait = (workId, predicate) => kit.waitFor(async () => { const work = await row(workId); return work && predicate(work) && work; }, 'work state', { timeout: 30000 });
  const calls = model => kit.result.calls.filter(call => call.role === 'worker' && call.model === model).length;
  const names = () => kit.rpc({ action: 'settings-snapshot', id }).then(snapshot => snapshot.values.name);
  const mixed = async name => { const snapshot = await kit.rpc({ action: 'settings-snapshot', id }); return kit.rpc({ action: 'settings-update', id, confirm: id, expectedRevision: snapshot.revision, changes: { name, fallbackModels: { worker: 'fake/fallback-model' } } }); };

  const markFailed = async workIds => {
    await kit.stopHost(); Object.assign(process.env, kit.hostEnv);
    const { openDurableProject } = await import('../src/durable-runtime.ts');
    const { DurablePlanning } = await import('../src/durable-planning.ts');
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    const { loadProject, projectDir } = await import('../src/state.ts');
    const runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
    try {
      await runtime.withRoot(root => root.commit(async tx => {
        const state = await tx.doc(DurablePlanning, root.id);
        for (const workId of workIds) { const work = state.work[workId]; delete work.attempt.quotaFallback; delete work.quotaRecovery; work.status = 'failed'; work.blocker = 'quota_exceeded: fake/fake-model: Quota exceeded'; }
      }, BACKGROUND_CONTEXT));
    } finally { await runtime.close(); }
    kit.startHost(); await kit.waitHost();
    if ((await kit.rpc({ action: 'plan-snapshot', id })).paused) await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  };
  const waiting = work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:');
  const failed = await submit('QUOTA work'), authFailed = await submit('AUTH work'), healthy = await submit('HEALTHY work');
  await wait(failed, waiting); await wait(authFailed, work => work.status === 'failed'); await wait(healthy, work => work.status === 'completed');
  await markFailed([failed]);
  const beforeAuth = await row(authFailed), beforeHealthy = await row(healthy);

  // A paused project keeps control: the mixed save lands, but nothing resumes.
  await kit.rpc({ action: 'pause', id });
  await mixed('Renamed while paused');
  await delay(600);
  kit.check('a mixed save in a paused project saves settings but recovers nothing', (await names()) === 'Renamed while paused' && (await row(failed)).status === 'failed' && calls('fallback-model') === 0);
  await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });

  // An unpaused project: the mixed save itself recovers the failed work.
  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  const second = await submit('QUOTA second'); await wait(second, waiting); await markFailed([second]);
  const beforeCalls = calls('fallback-model');
  await mixed('Renamed live');
  const recovered = await wait(second, work => work.status === 'completed');
  const earlier = await wait(failed, work => work.status === 'completed');
  await delay(300);
  kit.check('a mixed save recovers quota-failed work on its same thread exactly once, including work left failed by the paused save', (await names()) === 'Renamed live' && earlier.attempt.modelTransitions.length === 1 && recovered.attempt.model === 'fake/fallback-model' && recovered.attempt.modelTransitions.length === 1 && calls('fallback-model') === beforeCalls + 2, recovered);
  const authAfter = await row(authFailed), healthyAfter = await row(healthy);
  kit.check('unrelated failed and healthy work are untouched by mixed saves', authAfter.status === 'failed' && JSON.stringify(authAfter.attempt) === JSON.stringify(beforeAuth.attempt) && healthyAfter.status === 'completed' && JSON.stringify(healthyAfter.attempt) === JSON.stringify(beforeHealthy.attempt));
});
