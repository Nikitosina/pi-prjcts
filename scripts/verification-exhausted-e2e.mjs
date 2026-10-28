// An exhausted verification cycle stays exhausted: after three failed attempts, a follow-up, steer or retry on the same worker
// never starts a fourth verifier, never replaces the frozen criteria, model, skill or attempts, and ends blocked, also after a
// settings toggle and a host restart. Owned host, deterministic fake model.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';

const criteria = ['proof.txt says done'];
const kit = await createKit('verification-exhausted', { handler: async ({ role, user, results, tools }) => {
  if (role === 'coordinator' && user === 'DELEGATE' && !results.length) return call('projects_delegate', { task: 'EXHAUST-TASK write proof.txt', acceptance: criteria });
  if (role === 'coordinator' && user.startsWith('RETRY ') && !results.length) return call('projects_worker_control', { action: 'retry', workId: user.slice(6), requestId: randomUUID() });
  if (tools.includes('projects_verify_run')) {
    if (!results.length) return call('projects_verify_run', { command: 'cat proof.txt' });
    if (results.length === 1) {
      const n = /Attempt (\d) of 3/.exec(user)?.[1] ?? '?', run = JSON.parse(results[0]);
      // A different reason on every attempt is visible progress, so the cycle runs to its third attempt.
      return call('projects_verification_verdict', { summary: `Attempt ${n} fails.`, criteria: [{ id: 'c1', status: 'fail', reason: `proof.txt is not accepted on attempt ${n}`, evidence: [{ runId: run.runId }] }] });
    }
    return say('Recorded.');
  }
  if (role === 'worker') return results.length ? say('Finished.') : call('bash', { command: 'echo done > proof.txt' });
} });
kit.initRepo(); kit.git(kit.workspace, 'remote', 'add', 'origin', 'git@github.com:acme/exhausted-fixture.git');
mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Verify that proof.txt says done.\n---\nRun cat proof.txt.\n');

// Every regression is reported, not only the first, so a baseline run shows each defect.
const failures = [];
const expect = (label, ok, detail) => { try { kit.check(label, ok, detail); } catch (error) { failures.push(error.message); } };
const verifierTurns = () => kit.result.calls.filter(c => c.tools.includes('projects_verify_run') && !c.results.length).length;
const frozen = cycle => JSON.stringify({ model: cycle.model, skill: cycle.skill, criteria: cycle.criteria, attempts: cycle.attempts.map(a => [a.n, a.verifierThreadId, a.state, a.revision]) });
await kit.run(async () => {
  const id = await kit.createProject('Exhausted verification', { workerCap: 1 });
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  await kit.rpc({ action: 'message', id, text: 'DELEGATE' });
  const worker = await kit.eventually(async () => (await kit.plan(id)).find(w => w.role === 'worker' && w.text.startsWith('EXHAUST-TASK')), 'worker admitted');
  const cycleOf = async () => (await kit.rpc({ action: 'plan-snapshot', id })).verification?.[worker.threadId];
  const exhausted = await kit.eventually(async () => { const value = await cycleOf(); return value && !value.open && value; }, 'first cycle settled', 2400);
  kit.check('three failed attempts exhaust the cycle', exhausted.outcome === 'escalated' && exhausted.attempts.length === 3 && exhausted.attempts.every(a => a.state === 'fail') && verifierTurns() === 3, exhausted);
  const original = frozen(exhausted);
  // A reopened cycle freezes the worker until its verifier ends; waiting for that keeps the baseline run reporting every defect.
  const idle = () => kit.eventually(async () => { const work = await kit.plan(id), cycle = await cycleOf(); return !cycle.open && !work.some(w => w.role === 'verifier' && ['queued', 'running'].includes(w.status)); }, 'verifiers settled', 2400);
  await idle();

  // Each continuation must end without a verifier and with the exhausted record untouched.
  const settled = async (label, admitted) => {
    const work = await kit.eventually(async () => { const value = (await kit.plan(id)).find(w => w.id === admitted); return value && !['queued', 'running'].includes(value.status) && value; }, `${label} settled`, 2400);
    await idle();
    const cycle = await cycleOf();
    expect(`${label}: no fourth verifier starts`, verifierTurns() === 3, verifierTurns());
    expect(`${label}: the original criteria, model, skill and three attempts are kept`, frozen(cycle) === original && cycle.outcome === 'escalated' && !cycle.open, { original: JSON.parse(original), now: cycle });
    expect(`${label}: the continuation ends blocked, not completed`, work.status === 'blocked' && /exhausted/i.test(work.blocker ?? ''), { status: work.status, blocker: work.blocker });
    return work;
  };
  const sent = await kit.rpc({ action: 'thread-send', id, threadId: worker.threadId, requestId: randomUUID(), text: 'Try once more.\n\nAcceptance criteria:\n- anything at all' });
  await settled('follow-up with its own acceptance list', sent.attemptId ?? sent);
  const steered = await kit.rpc({ action: 'thread-steer', id, threadId: worker.threadId, requestId: randomUUID(), text: 'Concrete next step: finish proof.txt.' });
  const steerWork = await settled('steer', steered.attemptId);

  // Turning verification off and on, and a restart, do not reopen the cycle.
  await kit.updateSettings(id, { verification: null });
  await kit.updateSettings(id, { verification: { enabled: true, skill: 'mini-verify' } });
  await kit.stopHost(); kit.startHost(); await kit.waitHost();
  expect('the exhausted record survives a restart', frozen(await cycleOf()) === original);
  const before = new Set((await kit.plan(id)).map(w => w.id));
  await kit.rpc({ action: 'message', id, text: `RETRY ${steerWork.id}` });
  const retried = await kit.eventually(async () => (await kit.plan(id)).find(w => !before.has(w.id) && w.threadId === worker.threadId), 'retry admitted', 2400);
  await settled('retry after a settings toggle and a restart', retried.id);

  // With verification off, an ordinary continuation still cannot finish as plain completion.
  await kit.updateSettings(id, { verification: null });
  const off = await kit.rpc({ action: 'thread-send', id, threadId: worker.threadId, requestId: randomUUID(), text: 'Finish without verification.' });
  await settled('follow-up with verification turned off', off.attemptId ?? off);

  // A new worker thread is new work and gets its own cycle.
  await kit.updateSettings(id, { verification: { enabled: true, skill: 'mini-verify' } });
  await kit.rpc({ action: 'message', id, text: 'DELEGATE' });
  const fresh = await kit.eventually(async () => (await kit.plan(id)).find(w => w.role === 'worker' && w.threadId !== worker.threadId), 'new worker admitted');
  await kit.eventually(async () => (await kit.rpc({ action: 'plan-snapshot', id })).verification?.[fresh.threadId]?.attempts.length >= 1, 'new worker verified', 2400);
  expect('a new worker thread still gets a verifier', verifierTurns() >= 4, verifierTurns());
  if (failures.length) throw Error(`${failures.length} regression(s):\n${failures.join('\n')}`);
});
