// Simulate pre-fallback persisted quota records inside a disposable durable project.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, randomUUID, say } from './lib/e2e-kit.mjs';
const quota = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
const kit = await createKit('worker-quota-legacy-save', { env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '20', PI_PROJECTS_QUOTA_SWEEP_MS: '15' }, handler: ({ role, model }) => role !== 'worker' ? say('Noted.') : model === 'fallback-model' ? say('Recovered.') : quota });
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: 'fallback-model', name: 'Fallback' });
  writeFileSync(path, JSON.stringify(config)); kit.initRepo();
  const id = await kit.createProject('Legacy quota recovery');
  const scope = (await kit.rpc({ action: 'workspace-catalog', id })).find(item => item.wholeRepository).id;
  await kit.stopHost(); Object.assign(process.env, kit.hostEnv);
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  let runtime;
  try {
    runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
    const workId = randomUUID(), threadId = randomUUID();
    await runtime.plan({ work: [{ id: workId, threadId, role: 'worker', workspaceScopeId: scope, text: 'Legacy quota failure' }] });
    const row = async () => (await runtime.planSnapshot()).work.find(work => work.id === workId);
    const before = await kit.waitFor(async () => { const work = await row(); return work?.status === 'failed' && work.blocker?.startsWith('quota_recovery_exhausted:') && work; }, 'exhausted quota work', { timeout: 20000 });
    await runtime.withRoot(root => root.commit(async tx => {
      const work = (await tx.doc(DurablePlanning, root.id)).work[workId];
      delete work.attempt.quotaFallback; delete work.quotaRecovery;
      work.blocker = 'quota_exceeded: fake/fake-model: Quota exceeded';
    }, BACKGROUND_CONTEXT));
    await runtime.close(); runtime = undefined;
    kit.startHost(); await kit.waitHost();
    const reopened = await kit.rpc({ action: 'plan-snapshot', id });
    kit.result.reopened = reopened;
    if (reopened.paused) await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
    await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
    const after = await kit.waitFor(async () => { const snapshot = await kit.rpc({ action: 'plan-snapshot', id }); kit.result.afterSave = snapshot; const work = snapshot.work.find(item => item.id === workId); return work?.status === 'completed' && work; }, 'legacy record recovered after save', { timeout: 10000 });
    kit.check('legacy quota failure without fallback metadata recovers on the same thread', after.threadId === threadId && after.attempt.model === 'fake/fallback-model' && after.attempt.modelTransitions.length === 1 && after.attempt.cwd === before.attempt.cwd && after.attempt.instructions === before.attempt.instructions && after.attempt.toolNames.join() === before.attempt.toolNames.join(), { before, after });
  } finally { await runtime?.close(); }
});
