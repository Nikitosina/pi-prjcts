import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';
import { DEFAULT_ROLE_PROMPTS, SHARED_ROLE_RULES } from '../src/role-prompts.ts';

let release, parentHeld = false, readProof, verificationCriteriaCount = 1;
const structuredCases = [
  { name: 'leading-newline', input: ['Save record', '\nPreserve permissions', 'Keep audit history'], expected: ['Save record', 'Preserve permissions', 'Keep audit history'] },
  { name: 'whitespace-multiline', input: [' \t Save record\nwithout changing content', '\t \n  Preserve permissions\n  across resets', 'Keep audit history\nwith original actor'], expected: ['Save record\n  without changing content', 'Preserve permissions\n    across resets', 'Keep audit history\n  with original actor'] },
  { name: 'twenty', input: ['Save record', '\nPreserve permissions', ...Array.from({ length: 18 }, (_, i) => `Keep audit history ${i}`)], expected: ['Save record', 'Preserve permissions', ...Array.from({ length: 18 }, (_, i) => `Keep audit history ${i}`)] },
];
const textualCases = [
  { name: 'empty-last', count: 21, position: 21 },
  { name: 'empty-first', count: 21, position: 0 },
  { name: 'empty-middle', count: 21, position: 10 },
  { name: 'malformed-below-limit', count: 3, position: 1 },
].map(fixture => {
  const lines = Array.from({ length: fixture.count }, (_, i) => `- Requirement ${i + 1}`);
  lines.splice(fixture.position, 0, '- ');
  return { ...fixture, task: `TEXTUAL-${fixture.name}\nAcceptance criteria:\n${lines.join('\n')}` };
});
const hold = new Promise(ok => { release = ok; });
const axes = ['Standards', 'Spec', 'Bugs/performance'];
const kit = await createKit('role-prompts', { handler: async ({ role, user, results, tools }) => {
  if (role === 'coordinator' && user === 'SKILL-READ' && results.length < 3) return call('projects_skill_file', results.length === 1 ? { skill: 'code-review' } : { skill: 'pr-review', ...(results.length === 2 ? { path: 'references/bugs-performance.md' } : {}) });
  if (role === 'coordinator' && user === 'ROUND' && !results.length) return call('projects_delegate', { task: 'ROUND-PARENT' });
  if (role === 'coordinator' && user === 'SCOUT' && !results.length) return call('projects_delegate', { role: 'scout', task: 'SCOUT-PROBE' });
  if (role === 'coordinator' && user === 'VERIFY' && !results.length) return call('projects_delegate', { task: 'VERIFY-PROBE', acceptance: ['node exits zero\nwithout changing source files'] });
  if (role === 'coordinator' && user.startsWith('PREFIX-') && !results.length) return call('projects_delegate', { task: user, acceptance: user === 'PREFIX-overlimit' ? Array.from({ length: 21 }, (_, i) => `Requirement ${i}`) : structuredCases.find(c => user === `PREFIX-${c.name}`).input });
  if (role === 'coordinator' && user.startsWith('TEXTUAL-') && !results.length) return call('projects_delegate', { task: textualCases.find(c => user === `TEXTUAL-${c.name}`).task });
  if (role === 'worker' && user === 'ROUND-PARENT') {
    if (results.length < 3) return call('projects_delegate_child', { role: 'reviewer', task: `Pinned review axis ${axes[results.length]}` });
    if (results.length === 3) return call('projects_delegate_child', { role: 'reviewer', task: 'FOURTH-MUST-BLOCK' });
    parentHeld = true; await hold; return say('Candidate ready for static review.');
  }
  if (tools.includes('projects_verify_run')) {
    if (!results.length) return call('projects_skill_file', { skill: 'mini-verify' });
    if (results.length === 1) return call('projects_verify_run', { command: 'node -e "process.exit(0)"' });
    if (results.length === 2) return call('projects_verification_verdict', { summary: 'Observed zero exit.', criteria: Array.from({ length: verificationCriteriaCount }, (_, i) => ({ id: `c${i + 1}`, status: 'pass', reason: 'Observed fixture command', evidence: [{ runId: JSON.parse(results[1]).runId }] })) });
    return say('Recorded.');
  }
  if (user === 'SKILL-READ' && results.length === 3) readProof = results.map(r => JSON.parse(r));
  return say(`Static result ${role}: ${user}`);
} });
for (const name of ['pr-review', 'code-review', 'ask-user']) cpSync(join(kit.repo, '.agents/skills', name), join(kit.workspace, '.agents/skills', name), { recursive: true });
kit.initRepo(); kit.git(kit.workspace, 'remote', 'add', 'origin', 'git@github.com:acme/prompt-fixture.git');
writeFileSync(join(kit.workspace, 'AGENTS.md'), 'FROZEN-STANDING: preserve source identity.\n');
mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Verify a zero exit.\n---\nRun node -e "process.exit(0)" and cite the run.\n');
await kit.run(async () => {
  const id = await kit.createProject('Role defaults', { workerCap: 1 });
  const snapshot = await kit.rpc({ action: 'prompts-snapshot', id });
  assert.deepEqual(snapshot.roles.map(r => r.role), Object.keys(DEFAULT_ROLE_PROMPTS));
  for (const item of snapshot.roles) assert.equal(item.effective, DEFAULT_ROLE_PROMPTS[item.role]);
  kit.check('all five distinct defaults are exposed by the host', new Set(snapshot.roles.map(r => r.effective)).size === 5);
  await kit.ask(id, 'SKILL-READ');
  kit.check('coordinator receives terminal lifecycle rules', /archive handled and superseded/.test(kit.lastCall('coordinator', 'SKILL-READ').system) && /unknown failures/.test(kit.lastCall('coordinator', 'SKILL-READ').system));
  kit.check('coordinator distinguishes a successful command from host-confirmed verification', kit.lastCall('coordinator', 'SKILL-READ').system.includes("Use the host's VERIFIED completion report to claim verification"));
  kit.check('coordinator preserves explicit criteria in repair handoffs', kit.lastCall('coordinator', 'SKILL-READ').system.includes('every acceptance criterion verbatim'));
  kit.check('coordinator keeps the verifier verdict out of acceptance criteria', kit.lastCall('coordinator', 'SKILL-READ').system.includes("never the verifier's own verdict or the host's VERIFIED report"));
  kit.check('coordinator uses the structured acceptance field and supported repair list format', kit.lastCall('coordinator', 'SKILL-READ').system.includes('projects_delegate.acceptance') && kit.lastCall('coordinator', 'SKILL-READ').system.includes('Acceptance criteria: bulleted list'));
  writeFileSync(join(kit.artifacts, 'skill-read-proof.json'), JSON.stringify(readProof, null, 2));
  kit.check('live skill graph reads local review skills and Bugs/performance reference through authorized names', readProof?.length === 3 && readProof.every(r => r.nextOffset === null) && readProof[0].text.includes('Use these reviewers in independent fresh contexts') && readProof[1].text.includes('Mysterious Name') && readProof[2].text.includes('Bugs and performance review'));
  await kit.ask(id, '/skill:pr-review explicit review trigger');
  kit.check('explicit pr-review invocation expands repository-local body in live runtime', kit.result.calls.some(c => c.user.startsWith('<skill name="pr-review"') && c.user.includes(kit.workspace + '/.agents/skills/pr-review/SKILL.md')));
  await kit.rpc({ action: 'message', id, text: 'ROUND' });
  await kit.waitFor(() => parentHeld, 'three axes admitted before parent awaits');
  const held = await kit.plan(id), parent = held.find(w => w.text === 'ROUND-PARENT');
  const children = held.filter(w => w.parentThreadId === parent.threadId);
  kit.check('all three independent axes are queued before awaiting at cap one', children.length === 3 && children.every(w => w.status === 'queued'));
  const fourth = kit.lastCall('worker', 'ROUND-PARENT').results.at(-1);
  kit.check('child bound still refuses a fourth admission', /3 children queued or running/.test(fourth), fourth);
  writeFileSync(join(kit.artifacts, 'round-held-plan.json'), JSON.stringify(held, null, 2));
  release(); await kit.settle(id);
  const complete = await kit.plan(id);
  kit.check('cap-one queue drains all review axes without deadlock', children.every(c => complete.find(w => w.id === c.id)?.status === 'completed'));
  await kit.ask(id, 'SCOUT');
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  await kit.ask(id, 'VERIFY');
  const verified = Object.values((await kit.rpc({ action: 'plan-snapshot', id })).verification ?? {});
  kit.check('structured multiline acceptance keeps its constraint in one frozen criterion', verified.some(cycle => cycle.criteria.length === 1 && cycle.criteria[0].text === 'node exits zero\n  without changing source files'));
  for (const fixture of structuredCases) {
    verificationCriteriaCount = fixture.expected.length;
    await kit.ask(id, `PREFIX-${fixture.name}`);
    const plan = await kit.rpc({ action: 'plan-snapshot', id });
    const work = plan.work.find(w => w.role === 'worker' && w.text.startsWith(`PREFIX-${fixture.name}\n`));
    const cycle = plan.verification[work.threadId];
    writeFileSync(join(kit.artifacts, `structured-${fixture.name}.json`), JSON.stringify({ input: fixture.input, expected: fixture.expected, cycle }, null, 2));
    kit.check(`host freezes every structured requirement: ${fixture.name}`, JSON.stringify(cycle.criteria.map(c => c.text)) === JSON.stringify(fixture.expected), cycle.criteria);
    kit.check(`host settles all structured criterion IDs: ${fixture.name}`, cycle.outcome === 'verified' && cycle.attempts[0].criteria.length === fixture.expected.length);
  }
  verificationCriteriaCount = 1;
  const beforeLimit = (await kit.plan(id)).length;
  await kit.ask(id, 'PREFIX-overlimit');
  kit.check('structured 21-item input is refused, never truncated', (await kit.plan(id)).length === beforeLimit && kit.lastCall('coordinator', 'PREFIX-overlimit').results.some(r => /20/.test(r)));
  const followupThread = (await kit.plan(id)).find(w => w.role === 'worker' && w.text.startsWith('VERIFY-PROBE\n')).threadId;
  for (const fixture of textualCases) {
    for (const route of ['task', 'followup']) {
      const verifierCount = (await kit.plan(id)).filter(w => w.role === 'verifier').length;
      if (route === 'task') await kit.ask(id, `TEXTUAL-${fixture.name}`);
      else {
        await kit.rpc({ action: 'thread-send', id, threadId: followupThread, requestId: randomUUID(), text: fixture.task });
        await kit.settle(id);
      }
      const plan = await kit.rpc({ action: 'plan-snapshot', id });
      const work = plan.work.find(w => w.role === 'worker' && w.text === fixture.task && (route === 'followup' ? w.threadId === followupThread : w.threadId !== followupThread));
      const cycle = plan.verification[work.threadId];
      writeFileSync(join(kit.artifacts, `textual-${route}-${fixture.name}.json`), JSON.stringify({ input: fixture.task, work, cycle }, null, 2));
      kit.check(`textual ${route} refuses ${fixture.name} without a verifier or placeholder criteria`, work.status === 'blocked' && cycle.outcome === 'escalated' && cycle.attempts.length === 0 && cycle.criteria.length === 0 && plan.work.filter(w => w.role === 'verifier').length === verifierCount, { work, cycle });
      kit.check(`textual ${route} explains ${fixture.name} refusal`, fixture.count > 20 ? /21 acceptance criteria/.test(cycle.reason) : /empty.*item/i.test(cycle.reason), cycle.reason);
    }
  }
  const live = Object.fromEntries(Object.keys(DEFAULT_ROLE_PROMPTS).map(role => [role, kit.result.calls.find(c => role === 'verifier' ? c.tools.includes('projects_verify_run') : c.role === role)]));
  for (const [role, request] of Object.entries(live)) {
    assert.ok(request, `missing live ${role}`); assert.ok(request.system.includes(DEFAULT_ROLE_PROMPTS[role]), `default not assembled for ${role}`);
    assert.ok(request.system.includes(SHARED_ROLE_RULES), `shared rules absent for ${role}`);
    assert.match(request.system, /FROZEN-STANDING/);
    writeFileSync(join(kit.artifacts, `effective-${role}.txt`), request.system);
  }
  kit.check('actual provider requests contain all five defaults, shared rules and standing context', true);
  kit.check('review handoffs name source evidence available to fresh contexts', live.coordinator.system.includes('Reviewers do not inherit this conversation: include the source spec itself or its exact repository document path.'));
  const reviewer = live.reviewer;
  kit.check('reviewers retain generated read-only tools and no execution tools', reviewer.tools.includes('code_read') && !reviewer.tools.some(t => ['bash', 'write', 'edit', 'projects_verify_run'].includes(t)));
  kit.check('verifier receives journey and evidence routing rules', /missing feature-map entry/.test(live.verifier.system) && /author proof/.test(live.verifier.system) && /diagnostic/.test(live.verifier.system));
  kit.check('verifier retains structured verdict tools without implementation or delegation tools', live.verifier.tools.includes('projects_verification_verdict') && !live.verifier.tools.includes('projects_delegate_child'));
  await kit.updateSettings(id, { prompts: { coordinator: 'OWNER-CUSTOM-COORDINATOR', worker: 'OWNER-CUSTOM-WORKER', verifier: 'OWNER-CUSTOM-VERIFIER' } });
  await kit.updateSettings(id, { prompts: { scout: 'OWNER-CUSTOM-SCOUT' } });
  const custom = await kit.rpc({ action: 'prompts-snapshot', id });
  assert.equal(custom.roles.find(r => r.role === 'coordinator').effective, 'OWNER-CUSTOM-COORDINATOR');
  assert.equal(custom.roles.find(r => r.role === 'worker').effective, 'OWNER-CUSTOM-WORKER');
  assert.equal(custom.roles.find(r => r.role === 'verifier').effective, 'OWNER-CUSTOM-VERIFIER');
  await kit.ask(id, 'CUSTOM-COORDINATOR');
  const customCoordinator = kit.lastCall('coordinator', 'CUSTOM-COORDINATOR');
  kit.check('custom coordinator retains owner text and shared lifecycle', customCoordinator.system.includes('OWNER-CUSTOM-COORDINATOR') && customCoordinator.system.includes('archive handled and superseded'));
  const chat = await kit.rpc({ action: 'chat-create', id, title: 'Lifecycle chat' });
  await kit.rpc({ action: 'message', id, chatId: chat.id, text: 'CUSTOM-CHAT' });
  await kit.settle(id);
  kit.check('new coordinator chat retains owner text and lifecycle rules', kit.lastCall('coordinator', 'CUSTOM-CHAT')?.system.includes('OWNER-CUSTOM-COORDINATOR') && kit.lastCall('coordinator', 'CUSTOM-CHAT')?.system.includes('archive handled and superseded'));
  await kit.restartHost();
  await kit.ask(id, 'CUSTOM-REOPEN');
  kit.check('reopened coordinator retains owner text and lifecycle rules', kit.lastCall('coordinator', 'CUSTOM-REOPEN')?.system.includes('OWNER-CUSTOM-COORDINATOR') && kit.lastCall('coordinator', 'CUSTOM-REOPEN')?.system.includes('archive handled and superseded'));
  await kit.ask(id, 'VERIFY');
  const customVerifier = kit.result.calls.findLast(c => c.tools.includes('projects_verify_run'));
  kit.check('custom verifier persists and keeps host protocol and shared guardrails', customVerifier.system.includes('OWNER-CUSTOM-VERIFIER') && customVerifier.system.includes(SHARED_ROLE_RULES) && customVerifier.system.includes('projects_verification_verdict once'));
  await kit.updateSettings(id, { prompts: { verifier: null } });
  const reset = await kit.rpc({ action: 'prompts-snapshot', id });
  kit.check('resetting verifier preserves other owner customizations', reset.roles.find(r => r.role === 'verifier').effective === DEFAULT_ROLE_PROMPTS.verifier && reset.roles.find(r => r.role === 'worker').effective === 'OWNER-CUSTOM-WORKER');
});
if (process.env.PI_ARTIFACTS_DIR) cpSync(kit.artifacts, join(process.env.PI_ARTIFACTS_DIR, 'role-prompts'), { recursive: true });
