// Isolated legacy frozen-tool cycle. The fixture edits only its disposable Durable documents.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';

let releaseJudge, judgeSeen = false;
const judgeGate = new Promise(resolve => { releaseJudge = resolve; });
const kit = await createKit('worker-verification-legacy', { handler: async ({ user, results, tools }) => {
  if (tools.includes('projects_verify_run')) {
    if (!results.length) { judgeSeen = true; await judgeGate; return call('projects_verify_run', { command: 'cat proof.txt' }); }
    if (results.length === 1) { const run = JSON.parse(results[0]); return call('projects_verification_verdict', { summary: 'Fixture check', criteria: [{ id: 'c1', status: run.tail.includes('done') ? 'pass' : 'fail', reason: run.tail.includes('done') ? 'done' : 'not done', evidence: [{ runId: run.runId }] }] }); }
    return say('Recorded.');
  }
  if (tools.includes('bash')) return results.length ? say('Finished legacy turn.') : call('bash', { command: user.startsWith('[Automatic verification failed]') ? 'echo done > proof.txt' : 'echo broken > proof.txt' });
  return say('Noted.');
} });
Object.assign(process.env, kit.hostEnv);
kit.initRepo();
mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Read proof.txt.\n---\nRun cat proof.txt.\n');
kit.git(kit.workspace, 'add', '.'); kit.git(kit.workspace, 'commit', '-qm', 'fixture');
await kit.run(async () => {
  const id = await kit.createProject('Legacy fixture', { workerCap: 1 });
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  await kit.stopHost();
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { AgentDoc } = await import('@earendil-works/pi-durable');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, projectDir } = await import('../src/state.ts');
  const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
  const threadId = randomUUID(), workId = randomUUID(); let runtime, frozen = false;
  const open = async () => {
    const project = loadProject(id), loader = await loadProjectResourceLoader(project);
    runtime = await openDurableProject({ project, dir: projectDir(id), configuredSkillLoader: loader, discoverSkills: () => loadProjectResourceLoader(loadProject(id)), beforeScopedSubmit: async () => {
      if (frozen) return; frozen = true;
      await runtime.withRoot(root => root.commit(async tx => {
        const state = await tx.doc(DurablePlanning, root.id), work = state.work[workId], agent = await tx.doc(AgentDoc, work.conversationId);
        if (!Array.isArray(agent.tools) || !work.attempt?.boundTools) throw Error('fixture could not capture frozen tools');
        agent.tools = agent.tools.filter(name => name !== 'projects_request_verification');
        work.attempt.boundTools = work.attempt.boundTools.filter(name => name !== 'projects_request_verification');
        const legacy = work.attempt.instructions.replace(/ When verification is enabled, finish the candidate.*? A response alone does not verify the task\./, '');
        agent.instructions = legacy; work.attempt.instructions = legacy;
      }, BACKGROUND_CONTEXT));
    } });
  };
  try {
    await open(); const scope = loadProject(id).workspaceAuthorization.scopes[0].id;
    await runtime.plan({ work: [{ id: workId, threadId, role: 'worker', workspaceScopeId: scope, text: 'Legacy task\n\nAcceptance criteria:\n- proof.txt says done' }] });
    await kit.eventually(() => judgeSeen, 'legacy automatic verifier starts');
    const before = (await runtime.planSnapshot()).verification[threadId];
    kit.check('legacy frozen worker starts one automatic attempt', before.open && before.attempts.length === 1 && !kit.result.calls.find(c => c.user === 'Legacy task\n\nAcceptance criteria:\n- proof.txt says done').tools.includes('projects_request_verification'), before);
    await runtime.pausePlan(); releaseJudge(); await runtime.close(); await open();
    const reopened = (await runtime.planSnapshot()).verification[threadId];
    kit.check('open legacy cycle and frozen first attempt survive reopen', reopened.open && reopened.attempts.length === 1 && reopened.attempts[0].verifierThreadId === before.attempts[0].verifierThreadId && JSON.stringify(reopened.criteria) === JSON.stringify(before.criteria) && reopened.model === before.model && reopened.skill === before.skill, reopened);
    await runtime.resumePlan();
    const ended = await kit.eventually(async () => { const cycle = (await runtime.planSnapshot()).verification?.[threadId]; return cycle && !cycle.open && cycle; }, 'legacy cycle finishes');
    const feedback = kit.result.calls.find(c => c.user.startsWith('[Automatic verification failed]'));
    kit.check('legacy feedback avoids an unavailable request tool and retains the budget', ended.outcome === 'verified' && ended.attempts.length === 2 && feedback && !feedback.tools.includes('projects_request_verification') && !feedback.user.includes('explicitly request'), { ended, feedback });
  } finally { releaseJudge(); await runtime?.close(); }
});
