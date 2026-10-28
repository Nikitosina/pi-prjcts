// Save-path races with a worker slot held on a disposable host and fake provider.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, randomUUID, say, delay } from './lib/e2e-kit.mjs';

const quota = { status: 429, body: { error: { message: 'Quota exceeded', code: 'insufficient_quota' } } };
let hold = Promise.withResolvers();
const kit = await createKit('worker-quota-live-race', {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '600000', PI_PROJECTS_QUOTA_SWEEP_MS: '100' },
  handler: ({ role, model, user }) => role !== 'worker' ? say('Noted.') : user.includes('HOLD') ? (async function* () { await hold.promise; yield say('Finished.'); })() : model === 'fake-model' ? quota : say('Recovered.'),
});
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json'), models = JSON.parse(readFileSync(path, 'utf8'));
  for (const id of ['fallback-a', 'fallback-b']) models.providers.fake.models.push({ ...models.providers.fake.models[0], id, name: id });
  writeFileSync(path, JSON.stringify(models));
  kit.initRepo();
  const id = await kit.createProject('Live fallback race', { workerCap: 1 });
  const scope = (await kit.rpc({ action: 'workspace-catalog', id })).find(item => item.wholeRepository).id;
  const submit = async text => { const threadId = randomUUID(), requestId = randomUUID(); await kit.rpc({ action: 'work-submit', id, threadId, requestId, workspaceScopeId: scope, text }); return threadId; };
  const row = async thread => (await kit.plan(id)).find(work => work.threadId === thread);
  const wait = (thread, predicate) => kit.waitFor(async () => { const work = await row(thread); return work && predicate(work) && work; }, 'work state', { timeout: 15000 });
  const save = model => kit.updateSettings(id, { fallbackModels: { worker: model } });
  const waiting = work => work.status === 'queued' && work.blocker?.startsWith('quota_reset_wait:');

  const first = await submit('CHANGE quota'); await wait(first, waiting);
  const blocker = await submit('HOLD first'); await wait(blocker, work => work.status === 'running');
  await save('fake/fallback-a');
  const snapshot = await kit.rpc({ action: 'settings-snapshot', id });
  const concurrent = await Promise.allSettled([null, 'fake/fallback-b'].map(value => kit.rpc({ action: 'settings-update', id, confirm: id, expectedRevision: snapshot.revision, changes: { fallbackModels: { worker: value } } })));
  kit.check('concurrent saves with the same revision have one winner', concurrent.filter(result => result.status === 'fulfilled').length === 1 && concurrent.filter(result => result.status === 'rejected').length === 1, concurrent);
  await save('fake/fallback-b'); await save('fake/fallback-b'); await save('fake/fallback-b');
  kit.check('queued recovery has not switched while capacity is occupied', (await row(first)).attempt.model === 'fake/fake-model');
  hold.resolve();
  const changed = await wait(first, work => work.status === 'completed');
  kit.check('latest changed fallback is used once at dispatch', changed.attempt.model === 'fake/fallback-b' && changed.attempt.modelTransitions.length === 1 && changed.attempt.modelTransitions[0].to === 'fake/fallback-b', changed);
  await save(null);

  const second = await submit('REMOVE quota'); await wait(second, waiting);
  hold = Promise.withResolvers(); const blocker2 = await submit('HOLD second'); await wait(blocker2, work => work.status === 'running');
  await save('fake/fallback-a'); await save(null); hold.resolve();
  await wait(blocker2, work => work.status === 'completed'); await delay(300);
  const removed = await row(second);
  kit.check('removed fallback is not used when capacity returns', removed.status === 'queued' && removed.attempt.model === 'fake/fake-model' && removed.attempt.modelTransitions.length === 0, removed);
  await save('fake/fallback-b');
  const restored = await wait(second, work => work.status === 'completed');
  kit.check('a later save recovers using the current fallback', restored.attempt.model === 'fake/fallback-b' && restored.attempt.modelTransitions.length === 1, restored);

  await save(null);
  const third = await submit('RESTART quota'); await wait(third, waiting);
  hold = Promise.withResolvers(); const blocker3 = await submit('HOLD restart'); await wait(blocker3, work => work.status === 'running');
  const beforeRestart = kit.result.calls.filter(call => call.role === 'worker' && call.model === 'fallback-b').length;
  await save('fake/fallback-b');
  await kit.stopHost(); hold.resolve(); kit.startHost(); await kit.waitHost();
  const persisted = await row(third);
  kit.check('restart preserves pending recovery without running it', persisted.status === 'interrupted' && persisted.attempt.model === 'fake/fake-model', persisted);
  await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  const restarted = await wait(third, work => work.status === 'completed');
  kit.check('explicit project resume consumes the pending fallback once after restart', restarted.attempt.model === 'fake/fallback-b' && restarted.attempt.modelTransitions.length === 1 && kit.result.calls.filter(call => call.role === 'worker' && call.model === 'fallback-b').length === beforeRestart + 1, restarted);
});
