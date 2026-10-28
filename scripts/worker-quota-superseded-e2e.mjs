// A quota-failed record superseded by a later quota-waiting follow-up must not be revived next to it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, randomUUID, say, delay } from './lib/e2e-kit.mjs';
const quota = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
const kit = await createKit('worker-quota-superseded', { env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '600000', PI_PROJECTS_QUOTA_SWEEP_MS: '40' }, handler: ({ role, model }) => role !== 'worker' ? say('Noted.') : model === 'fallback-model' ? say('Recovered.') : quota });
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: 'fallback-model', name: 'Fallback' });
  writeFileSync(path, JSON.stringify(config)); kit.initRepo();
  const id = await kit.createProject('Superseded quota record');
  const scope = (await kit.rpc({ action: 'workspace-catalog', id })).find(item => item.wholeRepository).id;
  const threadId = randomUUID(), aId = randomUUID();
  await kit.rpc({ action: 'work-submit', id, threadId, requestId: aId, workspaceScopeId: scope, text: 'First quota work' });
  const rows = async () => (await kit.rpc({ action: 'plan-snapshot', id })).work.filter(work => work.threadId === threadId);
  const waitingRow = work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:');
  await kit.waitFor(async () => (await rows()).some(waitingRow), 'first work in quota wait', { timeout: 15000 });
  // Turn the first record into a legacy quota failure, as a worker would have left it before this feature.
  await kit.stopHost(); Object.assign(process.env, kit.hostEnv);
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  const runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
  try {
    await runtime.withRoot(root => root.commit(async tx => {
      const work = (await tx.doc(DurablePlanning, root.id)).work[aId];
      delete work.attempt.quotaFallback; delete work.quotaRecovery;
      work.status = 'failed'; work.blocker = 'quota_exceeded: fake/fake-model: Quota exceeded';
    }, BACKGROUND_CONTEXT));
  } finally { await runtime.close(); }
  kit.startHost(); await kit.waitHost();
  if ((await kit.rpc({ action: 'plan-snapshot', id })).paused) await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  await kit.rpc({ action: 'thread-send', id, threadId, requestId: randomUUID(), text: 'Follow-up that also hits quota' });
  const bId = (await kit.waitFor(async () => (await rows()).find(work => work.id !== aId && waitingRow(work)), 'follow-up in quota wait', { timeout: 15000 })).id;
  // Restart with both records persisted, then save the same fallback repeatedly.
  await kit.stopHost(); kit.startHost(); await kit.waitHost();
  if ((await kit.rpc({ action: 'plan-snapshot', id })).paused) await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  const count = (await kit.plan(id)).length;
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  const b = await kit.waitFor(async () => (await rows()).find(work => work.id === bId && work.status === 'completed'), 'follow-up recovered on fallback', { timeout: 15000 });
  await delay(400);
  const after = await rows(), a = after.find(work => work.id === aId);
  kit.check('the waiting follow-up recovers once on the fallback and keeps progressing', b.attempt.model === 'fake/fallback-model' && b.attempt.modelTransitions.length === 1 && after.length === 2 && (await kit.plan(id)).length === count, { b, after });
  kit.check('the superseded failed record is not revived', a.status === 'failed' && !a.quotaRecovery && a.attempt.modelTransitions.length === 0 && a.attempt.model === 'fake/fake-model', a);
  kit.check('only one fallback request ran', kit.result.calls.filter(call => call.role === 'worker' && call.model === 'fallback-model').length === 1);
  // Idle sweeps over a large retained history must stay linear: no per-record rescans or settings reads for non-quota records.
  await kit.stopHost();
  const bulk = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
  try {
    await bulk.withRoot(root => root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id), clone = value => JSON.parse(JSON.stringify(value)), template = clone(state.work[bId]), threadTemplate = clone(state.threads[threadId]);
      for (let i = 0; i < 20000; i++) {
        const done = randomUUID();
        state.work[done] = { ...clone(template), id: done, threadId: done, status: 'completed', blocker: null };
        delete state.work[done].quotaRecovery;
        state.threads[done] = { ...clone(threadTemplate), activeWorkId: null };
      }
    }, BACKGROUND_CONTEXT));
    const started = performance.now();
    for (let i = 0; i < 3; i++) await bulk.recoverQuota();
    const elapsed = (performance.now() - started) / 3;
    kit.result.sweepMs = elapsed;
    kit.check('idle quota sweep over 20000 completed records stays bounded', elapsed < 1500, { elapsed });
  } finally { await bulk.close(); }
});
