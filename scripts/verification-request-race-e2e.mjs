// Request capture interrupted while the revision hook is in flight, on a disposable direct runtime.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';

let releaseCapture, enteredCapture = false, releasedCapture = false, holdCapture = true;
const captureGate = new Promise(resolve => { releaseCapture = resolve; });
const kit = await createKit('verification-request-race', { handler: async ({ user, results, tools }) => {
  if (tools.includes('projects_verify_run')) {
    if (!results.length) return call('projects_verify_run', { command: 'cat proof.txt' });
    if (results.length === 1) return call('projects_verification_verdict', { summary: 'Checked.', criteria: [{ id: 'c1', status: 'pass', reason: 'done', evidence: [{ runId: JSON.parse(results[0]).runId }] }] });
    return say('Recorded.');
  }
  if (tools.includes('projects_request_verification')) {
    if (!results.length) return call('bash', { command: user.startsWith('The project was paused') ? 'echo done > proof.txt' : 'echo original > proof.txt' });
    if (results.length === 1) return call('projects_request_verification', {});
    return say('Finished.');
  }
  return say('Noted.');
} });
Object.assign(process.env, kit.hostEnv);
kit.initRepo(); mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Read proof.\n---\nRead proof.txt.\n');
kit.git(kit.workspace, 'add', '.'); kit.git(kit.workspace, 'commit', '-qm', 'fixture');
await kit.run(async () => {
  const id = await kit.createProject('Capture race', { workerCap: 1 });
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  await kit.stopHost();
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { captureTarget } = await import('../src/verification-target.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
  const project = loadProject(id), loader = await loadProjectResourceLoader(project), threadId = randomUUID(), workId = randomUUID(), depId = randomUUID();
  let runtime;
  const raw = () => runtime.withRoot(root => root.commit(async tx => { const state = await tx.doc(DurablePlanning, root.id); return JSON.parse(JSON.stringify(state.work[workId])); }, BACKGROUND_CONTEXT));
  try {
    runtime = await openDurableProject({ project, dir: projectDir(id), configuredSkillLoader: loader, discoverSkills: () => loadProjectResourceLoader(loadProject(id)), testBeforeVerifierRevision: async () => { if (holdCapture) { holdCapture = false; enteredCapture = true; await captureGate; releasedCapture = true; } } });
    await runtime.plan({ work: [{ id: workId, threadId, role: 'worker', workspaceScopeId: project.workspaceAuthorization.scopes[0].id, text: 'Capture race\n\nAcceptance criteria:\n- proof says done' }, { id: depId, threadId: randomUUID(), role: 'scout', text: 'Dependent', dependsOn: [workId] }] });
    await kit.eventually(() => enteredCapture, 'request capture in flight');
    const before = await raw();
    kit.check('capture is in flight before a receipt exists', before.status === 'running' && before.taskId != null && !before.verificationRequest, before);
    const pause = runtime.pausePlan();
    await kit.eventually(async () => (await runtime.planSnapshot()).paused, 'pause persisted while capture held');
    const changed = await raw();
    kit.check('pause changes authoritative attempt before old capture is released', changed.status === 'interrupted' && !changed.verificationRequest && (await runtime.planSnapshot()).paused, changed);
    releaseCapture(); await pause;
    const interrupted = await raw();
    kit.check('cancellation drains the old capture without a receipt', releasedCapture && interrupted.status === 'interrupted' && !interrupted.verificationRequest && !(await runtime.planSnapshot()).verification?.[threadId]?.attempts.length, interrupted);
    await runtime.resumePlan();
    const ended = await kit.eventually(async () => { const p = await runtime.planSnapshot(), c = p.verification?.[threadId]; return c && !c.open && c; }, 'resumed candidate verifies');
    await kit.eventually(async () => (await runtime.planSnapshot()).work.find(w => w.id === depId)?.status === 'completed', 'dependent released after verification');
    const after = await raw(), plan = await runtime.planSnapshot();
    const current = await captureTarget(after.attempt.cwd);
    kit.check('new task explicitly requests and verifies the current candidate exactly once', after.taskId !== before.taskId && after.verificationRequest?.taskId === after.taskId && after.verificationRequest.revision === current.revision && ended.attempts[0].revision === current.revision && ended.outcome === 'verified' && ended.attempts.length === 1 && plan.work.find(w => w.id === depId)?.status === 'completed', { before, after, ended });
    writeFileSync(join(kit.artifacts, 'request-identity.json'), JSON.stringify({ before: { taskId: before.taskId, receipt: before.verificationRequest ?? null }, interrupted: { taskId: interrupted.taskId, status: interrupted.status, receipt: interrupted.verificationRequest ?? null }, after: { taskId: after.taskId, receipt: after.verificationRequest }, cycle: ended, revision: current.revision }, null, 2));
  } finally { releaseCapture(); await runtime?.close(); }
});
