// Persisted quota-wait records, a real settings save, and the actual recovery dispatcher.
// The project and provider are disposable; no owner host is contacted.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, say, randomUUID } from './lib/e2e-kit.mjs';

const kit = await createKit('worker-quota-verification-save', { env: { PI_PROJECTS_QUOTA_SWEEP_MS: '3600000' }, handler: () => say('Unexpected execution') });
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json');
  const models = JSON.parse(readFileSync(path, 'utf8'));
  models.providers.fake.models.push({ ...models.providers.fake.models[0], id: 'fallback-model', name: 'Fallback' });
  writeFileSync(path, JSON.stringify(models));
  kit.initRepo();
  const id = await kit.createProject('Quota save verification');
  await kit.stopHost();
  Object.assign(process.env, kit.hostEnv);
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning, planningRuntime } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { defineExtension } = await import('@earendil-works/pi-durable');
  const { loadProject, saveProject, projectDir } = await import('../src/state.ts');
  const { projectSettings, updateProjectSettings } = await import('../src/project-settings.ts');
  let runtime;
  try {
    runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
    const cases = ['exhausted-worker', 'verifier', 'paused-worker'];
    const ids = Object.fromEntries(cases.map(name => [name, { work: randomUUID(), thread: randomUUID() }]));
    const verifierParent = randomUUID();
    const cycle = { model: 'fake/fake-model', skill: 'verify', scopeId: 'scope', criteria: [{ id: 'c1', text: 'preserve evidence' }], workIds: [ids['exhausted-worker'].work], open: false, outcome: 'escalated', reason: 'budget exhausted', attempts: [1, 2, 3].map(n => ({ n, verifierWorkId: randomUUID(), verifierThreadId: randomUUID(), key: `key-${n}`, revision: `revision-${n}`, head: null, branch: null, sourcePath: '/fixture', state: 'fail', runs: [], startedAt: n, endedAt: n + 1 })) };
    await runtime.withRoot(root => root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      state.paused = true; state.workerCap = 3;
      state.threads[verifierParent] = { conversationId: root.id, activeWorkId: null, workspaceScopeId: null, workspaceBindingRevision: null, workspaceConfigured: true, verification: { ...structuredClone(cycle), open: true, attempts: [{ ...structuredClone(cycle.attempts[0]), verifierWorkId: ids.verifier.work, verifierThreadId: ids.verifier.thread, state: 'running' }] } };
      for (const name of cases) {
        const { work, thread } = ids[name];
        state.threads[thread] = { conversationId: root.id, activeWorkId: null, workspaceScopeId: null, workspaceBindingRevision: null, workspaceConfigured: true, ...(name === 'paused-worker' ? { paused: true } : {}), ...(name === 'exhausted-worker' ? { verification: structuredClone(cycle) } : {}), ...(name === 'verifier' ? { parentThreadId: verifierParent } : {}) };
        state.work[work] = { id: work, threadId: thread, role: name === 'verifier' ? 'verifier' : 'worker', text: name, dependsOn: [], requestId: work, requiredTools: [], workspaceScopeId: null, workspaceBindingRevision: null, workspaceConfigured: true, status: 'queued', blocker: 'quota_reset_wait: fixture', conversationId: root.id, taskId: null, quotaRecovery: { retryAt: 0, attempts: 1, lastError: 'quota exceeded' }, attempt: { id: randomUUID(), projectId: id, model: 'fake/fake-model', modelTransitions: [], quotaFallback: null, thinking: 'medium', instructions: '', cwd: kit.workspace, toolNames: [], bindingRevision: 'fixture', standingRevision: 'fixture', startedAt: 1, endedAt: null, usage: { baseline: {}, final: {}, delta: {} } } };
      }
    }, BACKGROUND_CONTEXT));
    // Close and reopen to prove the fixture is persisted before saving settings.
    await runtime.close(); runtime = undefined;
    const before = loadProject(id);
    saveProject(updateProjectSettings(before, { action: 'settings-update', id, confirm: id, expectedRevision: projectSettings(before).revision, changes: { fallbackModels: { worker: 'fake/fallback-model' } } }));
    assert.equal(projectSettings(loadProject(id)).values.fallbackModels.worker, 'fake/fallback-model');
    runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
    const planning = planningRuntime({ projectId: id, models: {}, fallbackModels: { worker: 'fake/fallback-model' }, cwd: kit.workspace, instructions: {}, standingRevision: 'fixture', knowledgeTools: [], workerPolicy: defineExtension({ name: 'fixture-policy' }), workerCap: 3 });
    const read = () => runtime.withRoot(root => root.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(DurablePlanning, root.id))), BACKGROUND_CONTEXT));
    await runtime.withRoot(root => root.commit(async tx => { (await tx.doc(DurablePlanning, root.id)).paused = false; }, BACKGROUND_CONTEXT));
    const initial = await read();
    await runtime.withRoot(root => planning.recoverQuota(root));
    const after = await read();
    assert.deepEqual(after.threads[ids['exhausted-worker'].thread].verification, initial.threads[ids['exhausted-worker'].thread].verification, 'verification cycle changed');
    assert.deepEqual(after.threads[verifierParent].verification, initial.threads[verifierParent].verification, 'verifier cycle changed');
    const failures = [];
    for (const name of cases) {
      const beforeWork = initial.work[ids[name].work], afterWork = after.work[ids[name].work];
      for (const [label, check] of [['status', () => assert.equal(afterWork.status, beforeWork.status)], ['task', () => assert.equal(afterWork.taskId, beforeWork.taskId)], ['attempt', () => assert.deepEqual(afterWork.attempt, beforeWork.attempt)]]) {
        try { check(); } catch { failures.push(`${name}: ${label} changed`); }
      }
    }
    assert.deepEqual(failures, [], `quota recovery changed protected work: ${failures.join(', ')}`);
    kit.check('settings save and quota recovery preserve exhausted verification, verifier and paused work', true);
  } finally { await runtime?.close(); }
});
