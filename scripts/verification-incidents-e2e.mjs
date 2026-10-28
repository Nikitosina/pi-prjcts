// Regressions for two verifier incidents, on an owned host with the deterministic fake model:
// A: a steered worker was judged against the steer nudge instead of its brief, and the verifier was not told where the worker's evidence is.
// B: verification could be turned on for a project whose workspace provider verifiers cannot use, and nothing said so until every worker ended NOT VERIFIED.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';

// The first worker turn of each task waits here until the test steered it; release() lets the stopped turn's request end.
const holds = new Map();
const hold = marker => { if (!holds.has(marker)) { let release; holds.set(marker, { wait: new Promise(ok => { release = ok; }), release: () => release() }); } return holds.get(marker); };
const criteria = ['proof.txt exists in the repository and says done', 'the worker saved proof-shot.txt in its artifacts folder'];
const kit = await createKit('verification-incidents', { handler: async ({ role, user, results, tools }) => {
  if (role === 'coordinator' && user === 'DELEGATE-STEERED' && !results.length) return call('projects_delegate', { task: 'STEERED-TASK write proof.txt', acceptance: criteria });
  if (role === 'coordinator' && user === 'DELEGATE-REBRIEF' && !results.length) return call('projects_delegate', { task: 'REBRIEF-TASK write proof.txt', acceptance: criteria });
  if (role === 'worker' && /^(STEERED|REBRIEF)-TASK/.test(user)) { await hold(user.slice(0, 7)).wait; return say('Superseded turn.'); }
  if (role === 'worker' && user.startsWith('Rebrief')) return results.length === 0 ? call('bash', { command: 'echo done > proof.txt' }) : results.length === 1 ? call('projects_request_verification', {}) : say('Finished the new brief.');
  if (role === 'worker' && user.startsWith('Concrete next step')) return results.length === 0 ? call('bash', { command: 'echo done > proof.txt; mkdir -p "$PI_ARTIFACTS_DIR"; echo shot > "$PI_ARTIFACTS_DIR/proof-shot.txt"' }) : results.length === 1 ? call('projects_request_verification', {}) : say('Finished after the steer.');
  if (tools.includes('projects_verify_run')) return results.length ? say('Recorded.') : call('projects_verification_verdict', { summary: 'Probe only.', criteria: [] });
} });
kit.initRepo(); kit.git(kit.workspace, 'remote', 'add', 'origin', 'git@github.com:acme/incident-fixture.git');
mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Verify that proof.txt says done.\n---\nRun cat proof.txt.\n');

// Every regression is reported, not only the first, so a baseline run shows each defect.
const failures = [];
const expect = (label, ok, detail) => { try { kit.check(label, ok, detail); } catch (error) { failures.push(error.message); } };
await kit.run(async () => {
  // Incident A: a steered worker keeps its original criteria, and its verifier is told where the worker's evidence is.
  const id = await kit.createProject('Steered verification', { workerCap: 1 });
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  await kit.rpc({ action: 'message', id, text: 'DELEGATE-STEERED' });
  const worker = await kit.eventually(async () => (await kit.plan(id)).find(w => w.role === 'worker' && w.status === 'running' && w.text.startsWith('STEERED-TASK')), 'steered worker running');
  await kit.eventually(() => kit.result.calls.some(c => c.role === 'worker' && c.user.startsWith('STEERED-TASK')), 'worker turn reached the model');
  await kit.rpc({ action: 'thread-steer', id, threadId: worker.threadId, requestId: randomUUID(), text: 'Concrete next step: stop polling and finish proof.txt.' });
  const cycle = await kit.eventually(async () => { const snapshot = await kit.rpc({ action: 'plan-snapshot', id }); const value = snapshot.verification?.[worker.threadId]; return value && !value.open && value; }, 'verification cycle settled', 1200);
  hold('STEERED').release();
  expect('A steer does not replace the frozen acceptance criteria', JSON.stringify(cycle.criteria.map(c => c.text)) === JSON.stringify(criteria), cycle.criteria);
  const brief = kit.result.calls.find(c => c.tools.includes('projects_verify_run'))?.user ?? '';
  expect('A the verifier brief keeps the original task as authoritative', brief.includes('STEERED-TASK write proof.txt') && !/Original task[^\n]*\n[^\n]*Concrete next step/.test(brief), brief.slice(0, 1500));
  const listing = await kit.rpc({ action: 'artifacts-list', id, threadId: worker.threadId }), folder = join(kit.home, id, 'artifacts', worker.threadId);
  expect('A the verifier brief names the worker artifacts folder and its files', listing.files.some(f => f.path === 'proof-shot.txt') && brief.includes(`${folder}\n- proof-shot.txt`), { folder, brief: brief.slice(0, 2500) });

  // A steer that carries its own acceptance list is a new brief, and its criteria are the ones judged.
  await kit.rpc({ action: 'message', id, text: 'DELEGATE-REBRIEF' });
  const rebriefed = await kit.eventually(async () => (await kit.plan(id)).find(w => w.role === 'worker' && w.status === 'running' && w.text.startsWith('REBRIEF-TASK')), 'rebriefed worker running');
  await kit.eventually(() => kit.result.calls.some(c => c.role === 'worker' && c.user.startsWith('REBRIEF-TASK')), 'rebrief turn reached the model');
  await kit.rpc({ action: 'thread-steer', id, threadId: rebriefed.threadId, requestId: randomUUID(), text: 'Rebrief: write proof.txt only.\n\nAcceptance criteria:\n- proof.txt says done\n- nothing else changes' });
  const rebriefCycle = await kit.eventually(async () => { const value = (await kit.rpc({ action: 'plan-snapshot', id })).verification?.[rebriefed.threadId]; return value && !value.open && value; }, 'rebrief cycle settled', 1200);
  hold('REBRIEF').release();
  expect('A a steer with its own acceptance list replaces the criteria', JSON.stringify(rebriefCycle.criteria.map(c => c.text)) === JSON.stringify(['proof.txt says done', 'nothing else changes']), rebriefCycle.criteria);

  // Incident B: a workspace provider other than git cannot be verified, so turning verification on is refused with the reason, and an existing setting is flagged.
  const arc = await kit.createProject('Plugin provider', { workerCap: 1 });
  await kit.stopHost();
  const file = join(kit.home, arc, 'project.json'), project = JSON.parse(readFileSync(file, 'utf8'));
  kit.check('B fixture starts from a whole-repository grant', project.workspaceAuthorization?.scopes.some(s => s.wholeRepository), project.workspaceAuthorization);
  project.workspaceAuthorization.provider = 'arc';
  for (const repository of project.workspaceAuthorization.repositories) repository.provider = 'arc';
  project.models = { ...project.models, verifier: 'fake/fake-model' };
  writeFileSync(file, JSON.stringify(project, null, 2));
  kit.startHost(); await kit.waitHost();
  const refusal = await kit.rejects({ action: 'settings-update', id: arc, confirm: arc, expectedRevision: (await kit.rpc({ action: 'settings-snapshot', id: arc })).revision, changes: { verification: { enabled: true, skill: 'mini-verify' } } });
  expect('B turning verification on for an "arc" workspace is refused with the reason', /"arc" workspace provider/.test(refusal ?? ''), refusal);
  expect('B the refused setting is not stored', (await kit.rpc({ action: 'settings-snapshot', id: arc })).values.verification === null);
  await kit.stopHost();
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), verification: { enabled: true, skill: 'mini-verify' } }, null, 2));
  kit.startHost(); await kit.waitHost();
  const flagged = await kit.rpc({ action: 'settings-snapshot', id: arc });
  expect('B an already enabled setting on such a project is flagged in the settings snapshot', /"arc" workspace provider/.test(flagged.verificationProblem ?? ''), flagged);
  expect('B a git project carries no such flag', (await kit.rpc({ action: 'settings-snapshot', id })).verificationProblem === null);
  await kit.updateSettings(arc, { workerCap: 2 });
  expect('B unrelated changes to a flagged project still save', (await kit.rpc({ action: 'settings-snapshot', id: arc })).values.workerCap === 2);

  const page = await kit.openPage(await kit.webUrl(arc));
  await page.waitFor(`document.querySelector('#settings-button')?.hidden === false`, 'settings button');
  await page.evaluate(`document.querySelector('#settings-button').click()`);
  await page.waitFor(`!!document.querySelector('[data-settings-form]')`, 'settings form');
  const warning = await page.evaluate('document.querySelector("[data-verify-problem]")?.textContent ?? ""');
  await page.evaluate(`document.querySelector('[data-field="verifyEnabled"]').scrollIntoView({ block: 'center' })`);
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 1000, scale: 1 } });
  writeFileSync(join(kit.artifacts, 'arc-settings-warning.png'), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
  expect('B the settings form shows the problem next to the verification switch', /"arc" workspace provider/.test(warning), warning);
  if (failures.length) throw Error(`${failures.length} regression(s):\n${failures.join('\n')}`);
});
