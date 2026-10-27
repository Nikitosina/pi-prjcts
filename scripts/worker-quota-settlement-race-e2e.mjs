// Hold an already-failed quota attempt immediately before settlement reads the plan.
// Pause/stop must win even though the attempt's failure has already arrived.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';
const QUOTA = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
const gates = new Map();
const kit = await createKit('worker-quota-settlement-race', { env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '20', PI_PROJECTS_QUOTA_SWEEP_MS: '15' }, handler: ({ role, model, results }) => {
  if (role !== 'worker') return say('Noted.');
  if (model !== 'fallback-model') return QUOTA;
  return results.length ? say('Fallback finished.') : call('bash', { command: 'printf x >> forbidden-race-effect.txt' });
} });
await kit.run(async () => {
  const modelsPath = join(kit.agentDir, 'models.json'), config = JSON.parse(readFileSync(modelsPath, 'utf8'));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: 'fallback-model', name: 'Fallback fake' });
  writeFileSync(modelsPath, JSON.stringify(config));
  kit.initRepo();
  const id = await kit.createProject('Quota settlement races');
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  const scopeId = (await kit.rpc({ action: 'workspace-catalog', id })).find(scope => scope.wholeRepository).id;
  await kit.stopHost();
  Object.assign(process.env, kit.hostEnv);
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  let runtime;
  const open = async () => runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id), testBeforeWorkSettlement: async workId => {
    const gate = gates.get(workId);
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
  } });
  const row = async workId => (await runtime.planSnapshot()).work.find(work => work.id === workId);
  const settlementStatus = workId => runtime.withRoot(root => root.commit(async tx => {
    const work = (await tx.doc(DurablePlanning, root.id)).work[workId];
    return (await tx.task(work.settlementTaskId)).state.status;
  }, BACKGROUND_CONTEXT));
  const cases = [];
  try {
    await open();
    for (const action of ['worker-pause', 'worker-stop', 'project-pause']) {
      const workId = randomUUID(), threadId = randomUUID();
      const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      gates.set(workId, gate);
      await runtime.plan({ work: [{ id: workId, threadId, role: 'worker', workspaceScopeId: scopeId, text: `Quota failure racing ${action}` }] });
      await gate.entered.promise;
      const before = await row(workId), callsBefore = kit.result.calls.filter(call => call.role === 'worker').length;
      assert.equal(before.status, 'running');
      assert.equal(before.attempt.modelTransitions.length, 0);
      let pausing;
      if (action === 'worker-pause') await runtime.pauseWorker(threadId);
      else if (action === 'worker-stop') await runtime.stop(threadId);
      else {
        pausing = runtime.pausePlan();
        await kit.eventually(async () => (await runtime.planSnapshot()).paused, 'project pause did not persist before settlement release');
      }
      const controlled = await row(workId), expected = action === 'worker-stop' ? 'stopped' : 'interrupted';
      assert.equal(controlled.status, expected);
      gate.release.resolve();
      await pausing;
      await kit.eventually(async () => await settlementStatus(workId) === 'terminal', 'held settlement did not finish');
      await delay(200); // Observe many sweep opportunities after the deterministic control-before-settlement ordering.
      const after = await row(workId);
      const callsAfter = kit.result.calls.filter(call => call.role === 'worker').length;
      kit.check(`${action} wins against an already-arrived quota failure`, after.status === expected && after.blocker === controlled.blocker && after.attempt.model === 'fake/fake-model' && after.attempt.modelTransitions.length === 0 && callsAfter === callsBefore && !existsSync(join(after.attempt.cwd, 'forbidden-race-effect.txt')), { before, controlled, after, callsBefore, callsAfter });
      cases.push({ action, workId, threadId, before, controlled, after, callsBefore, callsAfter });
      gates.delete(workId);
    }
    await runtime.close(); await open();
    const beforeResumeCalls = kit.result.calls.filter(call => call.role === 'worker').length;
    assert.equal((await runtime.planSnapshot()).paused, true);
    await delay(200);
    kit.check('restart does not wake any race-interrupted or stopped work', kit.result.calls.filter(call => call.role === 'worker').length === beforeResumeCalls);
    // Stop the project-paused case explicitly, then resume the project. Worker pause must remain separate.
    await runtime.stop(cases[2].threadId);
    await runtime.resumePlan();
    await delay(200);
    const paused = await row(cases[0].workId), stopped = await row(cases[1].workId);
    kit.check('project resume cannot override the worker-pause or stop race winners', paused.status === 'interrupted' && stopped.status === 'stopped' && kit.result.calls.filter(call => call.role === 'worker').length === beforeResumeCalls);
    kit.result.races = cases;
  } finally { for (const gate of gates.values()) gate.release.resolve(); await runtime?.close(); }
});
