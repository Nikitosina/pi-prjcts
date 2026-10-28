import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';

let releasePrerequisite, prereqEntered = false, releaseVerifier, verifierEntered = false;
const prerequisite = new Promise(resolve => { releasePrerequisite = resolve; });
const verifier = new Promise(resolve => { releaseVerifier = resolve; });
const kit = await createKit('verification-recovered-dependency', { handler: async ({ user, results, tools }) => {
  if (user === 'OTHER PREREQUISITE') { prereqEntered = true; await prerequisite; return say('Prerequisite done.'); }
  if (tools.includes('projects_verify_run')) {
    if (!results.length) { if (user.includes('ZERO ORIGINAL')) { verifierEntered = true; await verifier; } return call('projects_verify_run', { command: 'cat proof.txt' }); }
    if (results.length === 1) return call('projects_verification_verdict', { summary: 'Checked', criteria: [{ id: 'c1', status: 'pass', reason: 'proof exists', evidence: [{ runId: JSON.parse(results[0]).runId }] }] });
    return say('Verdict recorded.');
  }
  if (tools.includes('projects_request_verification')) {
    if (user.startsWith('ZERO ORIGINAL')) return say('Progress without request.');
    if (!results.length) return call('bash', { command: 'echo done > proof.txt' });
    if (results.length === 1) return call('projects_request_verification', {});
    return say('Done.');
  }
  return say('Done.');
} });
Object.assign(process.env, kit.hostEnv);
kit.initRepo(); mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Check proof.\n---\nRead proof.txt.\n');
kit.git(kit.workspace, 'add', '.'); kit.git(kit.workspace, 'commit', '-qm', 'fixture');
await kit.run(async () => {
  const id = await kit.createProject('Recovered dependencies', { workerCap: 2 });
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  await kit.stopHost();
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
  const project = loadProject(id), loader = await loadProjectResourceLoader(project), scope = project.workspaceAuthorization.scopes[0].id;
  let runtime;
  const open = () => openDurableProject({ project, dir: projectDir(id), configuredSkillLoader: loader, discoverSkills: () => loadProjectResourceLoader(loadProject(id)) });
  const snap = () => runtime.planSnapshot();
  const raw = () => runtime.withRoot(root => root.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(DurablePlanning, root.id))), BACKGROUND_CONTEXT));
  const item = (p, id) => p.work.find(w => w.id === id);
  try {
    runtime = await open();
    const threadId = randomUUID(), original = randomUUID(), dep = randomUUID(), immediate = randomUUID(), other = randomUUID();
    await runtime.plan({ work: [{ id: original, threadId, role: 'worker', workspaceScopeId: scope, text: 'ZERO ORIGINAL\n\nAcceptance criteria:\n- proof exists' }, { id: other, threadId: randomUUID(), role: 'scout', text: 'OTHER PREREQUISITE' }, { id: immediate, threadId: randomUUID(), role: 'scout', text: 'IMMEDIATE', dependsOn: [original] }, { id: dep, threadId: randomUUID(), role: 'scout', text: 'DEPENDENT', dependsOn: [original, other] }] });
    const blocked = await kit.eventually(async () => { const p = await snap(); return item(p, original)?.status === 'blocked' && item(p, dep)?.status === 'blocked' && p; }, 'zero-attempt blocker and dependent');
    kit.check('zero request creates no attempt and keeps dependent blocked', blocked.verification[threadId].attempts.length === 0 && prereqEntered, blocked.verification[threadId]);
    const repair = (await runtime.followUp(threadId, 'ZERO-RECOVERY: finish original work and request verification', { requestId: randomUUID() })).attemptId;
    await kit.eventually(() => verifierEntered, 'repair verifier is held');
    const held = await snap();
    kit.check('dependent remains blocked while verification is open', held.verification[threadId].open && item(held, dep).status === 'blocked', held.verification[threadId]);
    releaseVerifier();
    const recovered = await kit.eventually(async () => { const p = await snap(); return p.verification[threadId]?.outcome === 'verified' && p; }, 'recovery passes');
    kit.check('recovery passes once and preserves the blocked original', recovered.verification[threadId].attempts.length === 1 && item(recovered, original).status === 'blocked' && item(recovered, repair).status === 'completed' && item(recovered, dep).status !== 'completed' && recovered.verification[threadId].criteria[0].text === 'proof exists' && recovered.verification[threadId].model === 'fake/fake-model' && recovered.verification[threadId].skill === 'mini-verify', recovered.verification[threadId]);
    await kit.eventually(async () => item(await snap(), immediate)?.status === 'completed', 'zero-attempt recovered predecessor releases immediate dependent', 120);
    await runtime.archiveWork({ workIds: [original] });
    kit.check('successful historical blocker can be archived without changing status', item(await snap(), original).archived && item(await snap(), original).status === 'blocked');
    // Replace the verified cycle with a distinct task before the other prerequisite finishes.
    const later = (await runtime.followUp(threadId, 'LATER DISTINCT\n\nAcceptance criteria:\n- another proof exists', { requestId: randomUUID() })).attemptId;
    const replaced = await kit.eventually(async () => { const p = await snap(); return item(p, later)?.status === 'completed' && p.verification[threadId]?.outcome === 'verified' && p.verification[threadId].attempts[0].verifierThreadId !== recovered.verification[threadId].attempts[0].verifierThreadId && p; }, 'later distinct cycle settles');
    kit.check('later cycle settles while dependent still waits', item(replaced, dep).status !== 'completed' && replaced.verification[threadId].attempts.length === 1, replaced.verification[threadId]);
    await Promise.race([runtime.close(), new Promise((_, reject) => setTimeout(() => reject(Error('runtime close timed out')), 10000))]);
    runtime = await open();
    const reopened = await snap(), persisted = await raw();
    kit.check('reopen retains the original blocked record and later cycle', item(reopened, original).status === 'blocked' && persisted.work[original].result.includes('NOT VERIFIED') && persisted.work[original].recoveredBy === repair && reopened.verification[threadId].attempts[0].verifierThreadId === replaced.verification[threadId].attempts[0].verifierThreadId, reopened);
    if (reopened.paused) await runtime.resumePlan();
    releasePrerequisite();
    const done = await kit.eventually(async () => { const p = await snap(); return item(p, dep)?.status === 'completed' && p; }, 'dependent runs after both predecessors', 120);
    kit.check('dependent runs exactly once and original blocker remains historical', item(done, original).status === 'blocked' && kit.result.calls.filter(c => c.user === 'DEPENDENT').length === 1, done.work);
    const negatives = [];
    for (const control of ["distinct", "same-criteria", "archived"]) {
      const archive = control === "archived";
      const t = randomUUID(), w = randomUUID(), d = randomUUID();
      await runtime.plan({ work: [{ id: w, threadId: t, role: 'worker', workspaceScopeId: scope, text: 'ZERO ORIGINAL CONTROL\n\nAcceptance criteria:\n- proof exists' }, { id: d, threadId: randomUUID(), role: 'scout', text: `CONTROL ${archive}`, dependsOn: [w] }] });
      await kit.eventually(async () => { const p = await snap(); return item(p, w)?.status === 'blocked' && item(p, d)?.status === 'blocked'; }, 'control blocker');
      if (archive) await runtime.archiveWork({ workIds: [w] });
      const continuation = (await runtime.followUp(t, archive ? 'Repair archived task' : control === 'same-criteria' ? 'A DIFFERENT GOAL\n\nAcceptance criteria:\n- proof exists' : 'A DIFFERENT GOAL\n\nAcceptance criteria:\n- unrelated proof', { requestId: randomUUID() })).attemptId;
      const completed = await kit.eventually(async () => { const p = await snap(); return p.verification[t]?.outcome === 'verified' && item(p, continuation)?.status === 'completed' && p; }, 'control continuation verifies');
      kit.check(archive ? 'archived blocker stays blocked and does not release its dependent' : 'a new goal does not recover an unrelated blocker', item(completed, w).status === 'blocked' && item(completed, d).status === 'blocked' && !((await raw()).work[w].recoveredBy), { archive, work: item(completed, w), dependent: item(completed, d) });
      negatives.push({ control, archive, original: w, dependent: d, continuation, status: item(completed, d).status });
    }
    const ids = [original, repair, later, dep, immediate, other];
    writeFileSync(join(kit.artifacts, 'recovery-summary.json'), JSON.stringify({ original, repair, later, dep, immediate, other, threadId, association: persisted.work[original].recoveredBy, archivedBeforeRecovery: item(blocked, original).archived, archivedAfterRecovery: item(reopened, original).archived, tasks: ids.map(id => ({ id, taskId: persisted.work[id].taskId, status: item(done, id).status, blocker: item(done, id).blocker })), initialCycle: blocked.verification[threadId], recoveredCycle: recovered.verification[threadId], laterCycle: replaced.verification[threadId], dependencyTiming: { beforePass: item(held, dep).status, afterPass: item(recovered, dep).status, afterReplacement: item(replaced, dep).status, afterOther: item(done, dep).status }, negatives }, null, 2));
  } finally { releaseVerifier(); releasePrerequisite(); await runtime?.close(); }
});
