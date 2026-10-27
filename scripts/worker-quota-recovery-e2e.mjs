// E2E: configured quota fallback, reset retries, pause/stop/restart safety and dependency scheduling.
// Two local fake models, a private host and disposable worktrees. No real provider or credentials.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';

const QUOTA = { status: 429, body: { error: { message: 'Quota exceeded: session limit reached', type: 'insufficient_quota', code: 'insufficient_quota' } } };
const recovered = new Set(), workerRequests = [];
let releasePaused = false;
const handler = ({ role, model, user, results, msgs }) => {
  if (role === 'coordinator') {
    if (user.startsWith('[Durable work')) return say('Noted.');
    if (results.length) return say('Control applied.');
    const control = /^CONTROL (\{.*\})$/.exec(user)?.[1];
    if (control) return call('projects_worker_control', JSON.parse(control));
    const plan = /^PLAN (\{.*\})$/.exec(user)?.[1];
    if (plan) return call('projects_worker_plan', JSON.parse(plan));
    return undefined;
  }
  if (role !== 'worker') return undefined;
  const marker = ['FALLBACK', 'RESET', 'PAUSE', 'STOP', 'DEPEND', 'PROJECT', 'RETRY', 'EXHAUST', 'UNKNOWN', 'CHAIN', 'CONTEXT'].find(value => user.includes(value) || msgs.some(message => JSON.stringify(message).includes(value)));
  workerRequests.push({ marker, model, user, hasPriorToolResult: msgs.some(message => message.role === 'tool' && JSON.stringify(message).includes('BEFORE_QUOTA_CONTEXT')), hasOriginalMarker: msgs.some(message => message.role === 'user' && JSON.stringify(message).includes(marker)) });
  if (marker === 'EXHAUST' || marker === 'UNKNOWN') return QUOTA;
  if (marker === 'CONTEXT') {
    if (model === 'fallback-model') return say('Preserved the completed tool result.');
    return results.length ? QUOTA : call('bash', { command: 'printf x >> before-quota-context.txt; printf BEFORE_QUOTA_CONTEXT' });
  }
  if (marker === 'CHAIN') return model === 'fallback-model' ? say('Chain finished on frozen fallback.') : QUOTA;
  if (model === 'fallback-model') {
    if (results.length) return say('Fallback preserved context and finished.');
    return call('bash', { command: "printf x >> quota-fallback.txt" });
  }
  if (marker === 'FALLBACK' || marker === 'STOP' || marker === 'PAUSE' && !releasePaused || ['RESET', 'DEPEND', 'PROJECT', 'RETRY', 'EXHAUST', 'UNKNOWN', 'CHAIN', 'CONTEXT'].includes(marker) && !recovered.has(marker)) {
    if (['RESET', 'DEPEND', 'PROJECT', 'RETRY', 'EXHAUST', 'UNKNOWN', 'CHAIN', 'CONTEXT'].includes(marker)) recovered.add(marker);
    return QUOTA;
  }
  return say(`Recovered ${marker ?? 'work'}.`);
};
const kit = await createKit('worker-quota-recovery', { env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '120', PI_PROJECTS_QUOTA_SWEEP_MS: '40' }, handler });
const { result, rpc, eventually } = kit;
result.workerRequests = workerRequests;
let projectId;
const work = id => kit.plan(projectId).then(rows => rows.find(row => row.id === id || row.threadId === id));
const settled = id => eventually(async () => { const row = await work(id); return row && ['completed', 'failed', 'stopped'].includes(row.status) ? row : false; }, `work ${id} did not settle`);
const waiting = id => eventually(async () => { const row = await work(id); return row?.status === 'queued' && row.blocker?.startsWith('quota_reset_wait:') ? row : false; }, `work ${id} did not enter quota wait`);
const callsFor = marker => workerRequests.filter(call => call.marker === marker);

await kit.run(async () => {
  const modelPath = join(kit.agentDir, 'models.json');
  const config = JSON.parse(readFileSync(modelPath, 'utf8'));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: 'fallback-model', name: 'Fallback fake' });
  writeFileSync(modelPath, JSON.stringify(config));
  kit.initRepo();
  const id = projectId = await kit.createProject('Worker quota recovery', { workerCap: 4 });
  result.phase = 'created';
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  result.phase = 'fallback-configured';
  const beforeInvalid = await rpc({ action: 'settings-snapshot', id });
  const invalid = await kit.rejects({ action: 'settings-update', id, confirm: id, expectedRevision: beforeInvalid.revision, changes: { fallbackModels: { scout: 'missing/model' } } });
  kit.check('unavailable fallback is rejected without changing compatible settings', invalid !== null && (await rpc({ action: 'settings-snapshot', id })).revision === beforeInvalid.revision, invalid);
  await kit.updateSettings(id, { fallbackModels: { scout: 'fake/fallback-model', reviewer: 'fake/fake-model' } });
  const perRole = (await rpc({ action: 'settings-snapshot', id })).values;
  kit.check('fallback choices are independent of role models and other roles', perRole.fallbackModels.worker === 'fake/fallback-model' && perRole.fallbackModels.scout === 'fake/fallback-model' && perRole.fallbackModels.reviewer === 'fake/fake-model' && perRole.models.scout === 'fake/fake-model');
  await kit.updateSettings(id, { fallbackModels: { scout: null, reviewer: null } });
  const scopeId = (await rpc({ action: 'workspace-catalog', id })).find(scope => scope.wholeRepository).id;
  const submit = async (text, threadId = randomUUID()) => {
    const workId = randomUUID();
    await rpc({ action: 'work-submit', id, threadId, requestId: workId, workspaceScopeId: scopeId, text });
    return { workId, threadId };
  };
  const control = async args => {
    await rpc({ action: 'message', id, text: `CONTROL ${JSON.stringify(args)}` });
    await eventually(() => result.calls.some(call => call.role === 'coordinator' && call.results.some(value => value.includes(args.threadId ?? args.workId))), `control ${args.action} did not run`);
  };

  const fallback = await submit('FALLBACK write one file after quota');
  const fallbackDone = await settled(fallback.workId);
  kit.check('configured fallback completes the same work on the same thread', fallbackDone.status === 'completed' && fallbackDone.threadId === fallback.threadId);
  kit.check('fallback model transition is explicit and effective', fallbackDone.attempt.model === 'fake/fallback-model' && fallbackDone.attempt.modelTransitions.length === 1 && fallbackDone.attempt.modelTransitions[0].from === 'fake/fake-model' && fallbackDone.attempt.modelTransitions[0].reason === 'quota_exceeded', fallbackDone);
  const fallbackCalls = callsFor('FALLBACK');
  const rawFallbackCalls = result.calls.filter(call => call.role === 'worker');
  kit.check('fallback receives original conversation and does not duplicate execution', fallbackCalls.length === 3 && fallbackCalls.every(call => call.hasOriginalMarker) && fallbackCalls[0].model === 'fake-model' && fallbackCalls[1].model === 'fallback-model' && rawFallbackCalls[1].system === rawFallbackCalls[0].system && rawFallbackCalls[1].tools.join() === rawFallbackCalls[0].tools.join() && fallbackCalls[2].model === 'fallback-model', fallbackCalls);
  const history = await rpc({ action: 'thread-history', id, threadId: fallback.threadId, limit: 20 });
  const worktrees = await rpc({ action: 'worktrees-snapshot', id }), fallbackTree = worktrees.items.find(item => item.threadId === fallback.threadId);
  kit.check('conversation and worktree survive fallback', history.items.some(item => item.text.includes('FALLBACK')) && history.items.some(item => item.text.includes('quota was exhausted')) && fallbackTree && existsSync(join(fallbackTree.path, 'quota-fallback.txt')) && readFileSync(join(fallbackTree.path, 'quota-fallback.txt'), 'utf8') === 'x');
  kit.check('fallback executed the preserved scoped work exactly once', result.calls.filter(call => call.role === 'worker' && call.model === 'fallback-model').length === 2);

  const context = await submit('CONTEXT preserve completed primary tools across fallback');
  const contextDone = await settled(context.workId);
  const contextTree = (await rpc({ action: 'worktrees-snapshot', id })).items.find(item => item.threadId === context.threadId);
  const contextCalls = callsFor('CONTEXT');
  kit.check('fallback preserves completed primary tool results without repeating the side effect', contextDone.status === 'completed' && contextCalls.length === 3 && contextCalls[0].model === 'fake-model' && contextCalls[1].model === 'fake-model' && contextCalls[2].model === 'fallback-model' && contextCalls[2].hasPriorToolResult && readFileSync(join(contextTree.path, 'before-quota-context.txt'), 'utf8') === 'x', { contextDone, contextCalls });

  const chainThread = randomUUID(), chainFirst = randomUUID(), chainNext = randomUUID();
  await rpc({ action: 'message', id, text: `PLAN ${JSON.stringify({ work: [
    { id: chainFirst, threadId: chainThread, role: 'worker', text: 'CHAIN first', workspaceScopeId: scopeId },
    { id: chainNext, threadId: chainThread, role: 'worker', text: 'CHAIN queued followup', workspaceScopeId: scopeId },
  ] })}` });
  const firstDone = await settled(chainFirst), nextDone = await settled(chainNext);
  kit.check('already-queued followup shares the audited conversation model', firstDone.status === 'completed' && nextDone.status === 'completed' && nextDone.attempt.model === 'fake/fallback-model' && nextDone.attempt.modelTransitions.length === 1 && callsFor('CHAIN').length === 3 && callsFor('CHAIN').slice(1).every(call => call.model === 'fallback-model'), { firstDone, nextDone, calls: callsFor('CHAIN') });

  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  const reset = await submit('RESET waits for quota');
  const resetWait = await waiting(reset.workId);
  kit.check('no-fallback work waits with visible retry status on its frozen model', resetWait.attempt.model === 'fake/fake-model' && resetWait.attempt.modelTransitions.length === 0 && resetWait.blocker.includes('Automatic retry 1/8'));
  kit.check('reset recovery completes without any fallback', (await settled(reset.workId)).status === 'completed' && callsFor('RESET').length === 2);

  const dependentId = randomUUID(), childId = randomUUID(), dependentThread = randomUUID(), childThread = randomUUID();
  await rpc({ action: 'message', id, text: `PLAN ${JSON.stringify({ work: [
    { id: dependentId, threadId: dependentThread, role: 'worker', text: 'DEPEND parent', workspaceScopeId: scopeId },
    { id: childId, threadId: childThread, role: 'worker', text: 'dependent child', dependsOn: [dependentId], workspaceScopeId: scopeId },
  ] })}` });
  await waiting(dependentId);
  kit.check('dependency stays queued while its predecessor waits for quota', (await work(childId)).status === 'queued');
  kit.check('dependency runs only after automatic predecessor recovery', (await settled(dependentId)).status === 'completed' && (await settled(childId)).status === 'completed');

  const paused = await submit('PAUSE must not restart');
  await waiting(paused.workId);
  await control({ action: 'pause', threadId: paused.threadId });
  await eventually(async () => (await work(paused.workId)).status === 'interrupted', 'worker pause did not persist');
  const pausedCalls = callsFor('PAUSE').length;
  await delay(350);
  kit.check('manually paused worker never retries automatically', (await work(paused.workId)).status === 'interrupted' && callsFor('PAUSE').length === pausedCalls);
  releasePaused = true;
  await control({ action: 'resume', threadId: paused.threadId });
  kit.check('explicit worker resume permits recovery', (await settled(paused.workId)).status === 'completed');

  const projectPaused = await submit('PROJECT pause');
  await waiting(projectPaused.workId);
  await rpc({ action: 'pause', id });
  const projectPauseCalls = callsFor('PROJECT').length;
  await delay(350);
  kit.check('project pause suppresses quota timers', (await work(projectPaused.workId)).status === 'interrupted' && callsFor('PROJECT').length === projectPauseCalls);
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  const projectResumed = await settled(projectPaused.workId);
  kit.check('explicit project resume permits recovery', projectResumed.status === 'completed', projectResumed);

  releasePaused = false;
  const persistentPause = await submit('PAUSE must survive restart');
  await waiting(persistentPause.workId);
  await control({ action: 'pause', threadId: persistentPause.threadId });
  await eventually(async () => (await work(persistentPause.workId)).status === 'interrupted', 'persistent worker pause missing');
  const pauseBeforeRestart = callsFor('PAUSE').length;
  // A later owner setting must not redirect a frozen thread when it resumes.
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  const stopped = await submit('STOP must survive restart');
  await waiting(stopped.workId);
  await control({ action: 'stop', threadId: stopped.threadId });
  const stoppedBefore = callsFor('STOP').length;
  await kit.restartHost();
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  await delay(350);
  const stoppedAfter = await work(stopped.workId);
  kit.check('worker pause survives host restart and explicit project resume', (await work(persistentPause.workId)).status === 'interrupted' && callsFor('PAUSE').length === pauseBeforeRestart);
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  releasePaused = true;
  await control({ action: 'resume', threadId: persistentPause.threadId });
  const frozenResume = await settled(persistentPause.workId);
  kit.check('later fallback settings cannot change an existing frozen thread', frozenResume.status === 'completed' && frozenResume.attempt.model === 'fake/fake-model' && frozenResume.attempt.modelTransitions.length === 0, frozenResume);
  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  kit.check('stopped work never restarts after its deadline or a host restart', stoppedAfter.status === 'stopped' && callsFor('STOP').length === stoppedBefore);
  kit.check('host restart preserves other recovered work and settings', (await work(fallback.workId)).status === 'completed' && (await rpc({ action: 'settings-snapshot', id })).values.fallbackModels.worker === undefined);

  const manual = await submit('RETRY manual');
  await waiting(manual.workId);
  await control({ action: 'retry', workId: manual.workId, requestId: randomUUID() });
  const manualDone = await settled(manual.workId);
  kit.check('manual retry wakes the same waiting work without a duplicate', manualDone.id === manual.workId && manualDone.status === 'completed' && callsFor('RETRY').length === 2, { manualDone, requests: callsFor('RETRY') });

  // Both exhausted fallback and unknown-reset waits have a finite request budget.
  await kit.updateSettings(id, { fallbackModels: { worker: 'fake/fallback-model' } });
  const exhausted = await submit('EXHAUST both configured models');
  await waiting(exhausted.workId);
  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  const unknown = await submit('UNKNOWN reset time');
  const exhaustedDone = await settled(exhausted.workId), unknownDone = await settled(unknown.workId);
  kit.check('fallback exhaustion never cycles back or selects another model', exhaustedDone.status === 'failed' && exhaustedDone.blocker.startsWith('quota_recovery_exhausted:') && exhaustedDone.attempt.modelTransitions.length === 1 && callsFor('EXHAUST').length === 9 && callsFor('EXHAUST').slice(1).every(call => call.model === 'fallback-model'), exhaustedDone);
  kit.check('unknown reset stops after eight retries on the frozen model', unknownDone.status === 'failed' && unknownDone.blocker.startsWith('quota_recovery_exhausted:') && callsFor('UNKNOWN').length === 9 && unknownDone.attempt.modelTransitions.length === 0, unknownDone);
  const exhaustedCalls = workerRequests.length;
  await delay(350);
  kit.check('exhausted recovery stays terminal under repeated timer sweeps', workerRequests.length === exhaustedCalls);

  const { providerFailure } = await import('../src/durable-planning.ts');
  kit.check('only quota exhaustion triggers recovery', providerFailure('model_error: insufficient_quota') === 'quota_exceeded' && providerFailure('model_error: 429 Too many requests') === 'rate_limited' && providerFailure('model_error: authentication failed') === undefined && providerFailure('model_error: 503 quota service unavailable') === undefined);
  result.evidence = { fallbackWork: fallbackDone, resetCalls: callsFor('RESET').length, stoppedCalls: stoppedBefore, historyMessages: history.items.length };
});
