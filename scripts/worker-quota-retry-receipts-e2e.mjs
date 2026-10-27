// Public runtime retry receipts with a local provider and real scoped file writes.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';
const QUOTA = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
const requests = new Map(), blockerGate = Promise.withResolvers(), recoveryGate = Promise.withResolvers();
const blockerEntered = Promise.withResolvers(), recoveryEntered = Promise.withResolvers();
const kit = await createKit('worker-quota-retry-receipts', { handler: async ({ role, results, msgs }) => {
  if (role !== 'worker') return say('Noted.');
  const marker = ['RECEIPT', 'MULTI', 'BLOCKER'].find(marker => msgs.some(message => message.role === 'user' && JSON.stringify(message).includes(marker)));
  const count = (requests.get(marker) ?? 0) + 1;
  requests.set(marker, count);
  if (marker === 'BLOCKER') { blockerEntered.resolve(); await blockerGate.promise; return say('Blocker finished.'); }
  if (count === 1) return QUOTA;
  if (marker === 'MULTI' && count === 2) { recoveryEntered.resolve(); await recoveryGate.promise; }
  return results.length ? say('Finished.') : call('bash', { command: `printf x >> ${marker.toLowerCase()}-effect.txt` });
} });
await kit.run(async () => {
  kit.initRepo();
  const id = await kit.createProject('Quota retry receipts', { workerCap: 1 });
  const scopeId = (await kit.rpc({ action: 'workspace-catalog', id })).find(scope => scope.wholeRepository).id;
  await kit.stopHost();
  Object.assign(process.env, kit.hostEnv);
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  let runtime;
  const open = async () => runtime = await openDurableProject({ project: loadProject(id), dir: projectDir(id) });
  const row = async workId => (await runtime.planSnapshot()).work.find(work => work.id === workId);
  const completed = workId => kit.eventually(async () => (await row(workId))?.status === 'completed', `work ${workId} did not complete`);
  const waiting = workId => kit.eventually(async () => (await row(workId))?.blocker?.startsWith('quota_reset_wait:'), 'no quota wait');
  const plan = async (marker, requestId) => {
    const workId = randomUUID(), threadId = randomUUID();
    await runtime.plan({ work: [{ id: workId, threadId, requestId, role: 'worker', workspaceScopeId: scopeId, text: `${marker} write one receipt effect after quota` }] });
    return { workId, threadId };
  };
  const effect = async (workId, marker) => join((await row(workId)).attempt.cwd, `${marker.toLowerCase()}-effect.txt`);
  try {
    await open();
    const a = await plan('RECEIPT'), retryId = randomUUID();
    await waiting(a.workId);
    const first = await runtime.retryWorker(a.workId, retryId);
    await completed(a.workId);
    const path = await effect(a.workId, 'RECEIPT');
    kit.check('initial retry writes exactly once', readFileSync(path, 'utf8') === 'x');
    const replay = await runtime.retryWorker(a.workId, retryId);
    await kit.eventually(async () => (await runtime.planSnapshot()).work.every(work => work.status === 'completed'), 'replay did not settle');
    kit.result.receipts = { first, replay };
    kit.check('completed retry replay never repeats a physical side effect', readFileSync(path, 'utf8') === 'x', { effects: readFileSync(path, 'utf8'), first, replay });
    assert.deepEqual(replay, first);
    kit.check('completed retry replay returns the original receipt', replay.attemptId === a.workId);

    const multi = await plan('MULTI');
    await waiting(multi.workId);
    const blockerAdmissionId = randomUUID(), blocker = await plan('BLOCKER', blockerAdmissionId);
    await blockerEntered.promise;
    const r1 = randomUUID(), r2 = randomUUID();
    const receipts = [await runtime.retryWorker(multi.workId, r1), await runtime.retryWorker(multi.workId, r2)];
    assert.deepEqual(receipts[0], { attemptId: multi.workId, threadId: multi.threadId });
    assert.deepEqual(receipts[1], receipts[0]);
    for (const request of [r1, r2]) assert.deepEqual(await runtime.retryWorker(multi.workId, request), receipts[0]);
    kit.check('multiple retry IDs retain their original queued receipts', (await row(multi.workId)).status === 'queued' && requests.get('MULTI') === 1);
    await assert.rejects(runtime.retryWorker(multi.workId, blockerAdmissionId), /Conflicting duplicate retry requestId/);
    await assert.rejects(runtime.retryWorker(blocker.workId, r1), /Conflicting duplicate retry requestId/);
    await assert.rejects(plan('CONFLICT', r1), /Conflicting duplicate requestId/);
    await assert.rejects(runtime.followUp(multi.threadId, 'conflict', { requestId: r1 }), /Conflicting duplicate requestId/);
    await assert.rejects(runtime.steerThread(multi.threadId, 'conflict', { requestId: r1 }), /Conflicting duplicate requestId/);
    kit.check('retry IDs cannot be reused for another work or admission action', (await runtime.planSnapshot()).work.length === 3);
    await runtime.pauseWorker(multi.threadId);
    await runtime.close(); await open(); await runtime.resumePlan();
    for (const request of [r1, r2]) assert.deepEqual(await runtime.retryWorker(multi.workId, request), receipts[0]);
    kit.check('queued receipts survive restart and replay cannot resume a manually paused worker', (await row(multi.workId)).status === 'interrupted' && requests.get('MULTI') === 1);
    await runtime.resumeWorker(multi.threadId);
    blockerGate.resolve();
    await recoveryEntered.promise;
    for (const request of [r1, r2]) assert.deepEqual(await runtime.retryWorker(multi.workId, request), receipts[0]);
    const multiPath = await effect(multi.workId, 'MULTI');
    kit.check('running replay returns receipts without executing another attempt', (await row(multi.workId)).status === 'running' && !existsSync(multiPath) && requests.get('MULTI') === 2);
    recoveryGate.resolve();
    await completed(multi.workId);
    for (const request of [r1, r2]) assert.deepEqual(await runtime.retryWorker(multi.workId, request), receipts[0]);
    kit.check('completed replay of both IDs preserves exactly one write', readFileSync(multiPath, 'utf8') === 'x' && requests.get('MULTI') === 3 && (await runtime.planSnapshot()).work.length === 3);
    await runtime.close(); await open(); await runtime.resumePlan();
    for (const request of [r1, r2]) assert.deepEqual(await runtime.retryWorker(multi.workId, request), receipts[0]);
    await assert.rejects(runtime.retryWorker(a.workId, r2), /Conflicting duplicate retry requestId/);
    kit.check('all retry receipts and conflicts survive reopening storage', readFileSync(multiPath, 'utf8') === 'x' && requests.get('MULTI') === 3 && (await runtime.planSnapshot()).work.length === 3);

    // Upgrade fixture: older storage has no receipt list and keeps only the last quota retry ID.
    const legacyId = randomUUID();
    await runtime.withRoot(root => root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      delete state.retryReceipts;
      state.work[a.workId].manualRetryRequestId = legacyId;
    }, BACKGROUND_CONTEXT));
    await runtime.close(); await open(); await runtime.resumePlan();
    assert.deepEqual(await runtime.retryWorker(a.workId, legacyId), first);
    await assert.rejects(runtime.retryWorker(multi.workId, legacyId), /Conflicting duplicate retry requestId/);
    // An intentional new terminal retry gets its own receipt, not the historical quota receipt.
    const terminalId = randomUUID(), terminal = await runtime.retryWorker(a.workId, terminalId);
    assert.notEqual(terminal.attemptId, a.workId);
    await completed(terminal.attemptId);
    assert.deepEqual(await runtime.retryWorker(a.workId, legacyId), first);
    assert.deepEqual(await runtime.retryWorker(a.workId, terminalId), terminal);
    kit.check('legacy receipt imports before later retries and never repeats its write', readFileSync(path, 'utf8') === 'xx' && requests.get('RECEIPT') === 5);
    // Older ordinary terminal retries already kept their identity on the retry work item.
    await runtime.withRoot(root => root.commit(async tx => { delete (await tx.doc(DurablePlanning, root.id)).retryReceipts; }, BACKGROUND_CONTEXT));
    await runtime.close(); await open(); await runtime.resumePlan();
    assert.deepEqual(await runtime.retryWorker(a.workId, terminalId), terminal);
    assert.deepEqual(await runtime.retryWorker(a.workId, legacyId), first);
    kit.check('legacy terminal retry identity also imports without execution', readFileSync(path, 'utf8') === 'xx' && requests.get('RECEIPT') === 5);
    kit.result.evidence = { requestIds: { retryId, r1, r2, legacyId, terminalId }, receipts, terminal, requests: Object.fromEntries(requests), effects: { receipt: readFileSync(path, 'utf8'), multi: readFileSync(multiPath, 'utf8') } };
  } finally { blockerGate.resolve(); recoveryGate.resolve(); await runtime?.close(); }
});
