import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';

const mode = process.env.RECOVERY_CASE;
const initial = new Set(), entered = new Set(), gates = new Map();
function gate(name) { if (!gates.has(name)) { let release; const wait = new Promise(resolve => { release = resolve; }); gates.set(name, { wait, release }); } return gates.get(name); }
const kit = await createKit('verification-recovery-lifecycle', { handler: async ({ user, results, tools }) => {
  if (user === 'CHILD HOLD') { entered.add('child'); await gate('child').wait; return say('Child done.'); }
  if (tools.includes('projects_verify_run')) {
    if (!results.length) return call('projects_verify_run', { command: 'cat proof.txt' });
    if (results.length === 1) return call('projects_verification_verdict', { summary: 'Checked.', criteria: [{ id: 'c1', status: 'pass', reason: 'proof', evidence: [{ runId: JSON.parse(results[0]).runId }] }] });
    return say('Recorded.');
  }
  if (tools.includes('projects_request_verification')) {
    if (!results.length && user.startsWith('ORIGINAL ') && !initial.has(user)) { initial.add(user); return say('No request yet.'); }
    if (!results.length && user === 'STEER HOLD') { entered.add('steer'); await gate('steer').wait; return say('Interrupted.'); }
    if (user === 'CHILD REPAIR') {
      if (!results.length) return call('projects_delegate_child', { role: 'scout', task: 'CHILD HOLD' });
      return say('Waiting for child.');
    }
    if (!results.length) return call('bash', { command: 'echo done > proof.txt' });
    if (results.length === 1) return call('projects_request_verification', {});
    return say('Done.');
  }
  return say('Done.');
} });
Object.assign(process.env, kit.hostEnv); kit.initRepo();
mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Check proof.\n---\nRead proof.txt.\n');
kit.git(kit.workspace, 'add', '.'); kit.git(kit.workspace, 'commit', '-qm', 'fixture');
await kit.run(async () => {
  const id = await kit.createProject('Recovery transitions', { workerCap: 2 });
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  await kit.stopHost();
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { captureTarget } = await import('../src/verification-target.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
  const project = loadProject(id), loader = await loadProjectResourceLoader(project), scope = project.workspaceAuthorization.scopes[0].id;
  const runtime = await openDurableProject({ project, dir: projectDir(id), configuredSkillLoader: loader, discoverSkills: () => loadProjectResourceLoader(loadProject(id)) });
  const snapshot = () => runtime.planSnapshot();
  const raw = () => runtime.withRoot(root => root.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(DurablePlanning, root.id))), BACKGROUND_CONTEXT));
  const find = (p, id) => p.work.find(w => w.id === id), summaries = [];
  try {
    for (const name of ['header', 'retry', 'steer', 'child'].filter(x => !mode || x === mode)) {
      const original = randomUUID(), thread = randomUUID(), dependent = randomUUID();
      const brief = `ORIGINAL ${name} full source task\n\nAcceptance criteria:\n- exact original proof`;
      await runtime.plan({ work: [{ id: original, threadId: thread, role: 'worker', workspaceScopeId: scope, text: brief }, { id: dependent, threadId: randomUUID(), role: 'scout', text: `DEPENDENT ${name}`, dependsOn: [original] }] });
      const before = await kit.eventually(async () => { const p = await snapshot(); return find(p, original)?.status === 'blocked' && find(p, dependent)?.status === 'blocked' && p; }, `${name} initial blocker`, 120);
      kit.check(`${name} zero-attempt history`, before.verification[thread].attempts.length === 0, before.verification[thread]);
      let recovery, continuation;
      if (name === 'header') recovery = (await runtime.followUp(thread, `REPAIR HEADER\nOriginal task: ${brief}`, { requestId: randomUUID() })).attemptId;
      if (name === 'retry') recovery = (await runtime.retryWorker(original, randomUUID())).attemptId;
      if (name === 'steer') {
        recovery = (await runtime.followUp(thread, 'STEER HOLD', { requestId: randomUUID() })).attemptId;
        await kit.eventually(() => entered.has('steer'), 'steer recovery active', 120);
        const steering = runtime.steerThread(thread, 'Finish the same task and request verification', { requestId: randomUUID() });
        await kit.eventually(async () => find(await snapshot(), recovery)?.status === 'stopped', 'steer recorded', 120);
        gate('steer').release(); continuation = (await steering).attemptId;
      }
      if (name === 'child') {
        recovery = (await runtime.followUp(thread, 'CHILD REPAIR', { requestId: randomUUID() })).attemptId;
        await kit.eventually(() => entered.has('child'), 'child holds the recovery', 120);
        const held = await kit.eventually(async () => { const p = await snapshot(); return find(p, recovery)?.status === 'completed' && p; }, 'parent held on child', 120);
        kit.check('child prevents verifier and dependent admission', !held.verification[thread].attempts.length && find(held, dependent).status === 'blocked', held.verification[thread]);
        gate('child').release();
      }
      const completed = await kit.eventually(async () => { const p = await snapshot(); return p.verification[thread]?.outcome === 'verified' && p; }, `${name} verified`, 120);
      const state = await raw(), cycle = completed.verification[thread];
      kit.check(`${name} preserves original criteria and provenance`, cycle.attempts.length === 1 && cycle.criteria[0].text === 'exact original proof' && state.work[original].recoveredBy && state.work[original].result.includes('NOT VERIFIED') && kit.result.calls.some(c => c.tools.includes('projects_verify_run') && c.user.includes(brief)), { cycle, original: state.work[original].recoveredBy });
      await kit.eventually(async () => find(await snapshot(), dependent)?.status === 'completed', `${name} dependent releases`, 120);
      const end = await raw();
      const target = await captureTarget(end.work[end.work[original].recoveredBy].attempt.cwd);
      kit.check(`${name} verifier checked the settled target`, cycle.attempts[0].revision === target.revision, { attempt: cycle.attempts[0].revision, target: target.revision });
      kit.check(`${name} dependent runs exactly once`, kit.result.calls.filter(c => c.user === `DEPENDENT ${name}`).length === 1 && end.work[original].status === 'blocked', { original: end.work[original].status, dependent: end.work[dependent].status });
      summaries.push({ name, original, recovery, continuation: continuation ?? end.work[original].recoveredBy, dependent, thread, recoveredBy: end.work[original].recoveredBy, originalTaskId: end.work[original].taskId, recoveryTaskId: end.work[recovery].taskId, resultTaskId: end.work[end.work[original].recoveredBy].taskId, before: before.verification[thread], cycle, originalStatus: end.work[original].status, dependentStatus: end.work[dependent].status, targetRevision: target.revision });
    }
    writeFileSync(join(kit.artifacts, 'lifecycle-summary.json'), JSON.stringify(summaries, null, 2));
  } finally { for (const value of gates.values()) value.release(); await runtime.close(); }
});
