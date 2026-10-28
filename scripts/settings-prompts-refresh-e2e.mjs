// Browser E2E: a Settings tab left open across a host restart shows and uses the new host's built-in role prompts.
// The host first runs from a private core copy whose five defaults carry a LEGACY marker, then restarts on the real defaults while the page stays open.
// Fakes only (fake model, private HOME, temp repo). Covers: no override is persisted for defaults, a genuine override and an unsaved edit survive,
// Reset removes the override, new threads use the current text and a thread started before the restart keeps its frozen prompt.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const repo = process.cwd(), core = join(realpathSync(tmpdir()), `settings-prompts-core-${randomUUID()}`);
mkdirSync(core, { mode: 0o700 });
for (const entry of ['src', 'web', 'relay', 'package.json', 'tsconfig.json']) cpSync(join(repo, entry), join(core, entry), { recursive: true });
symlinkSync(join(repo, 'node_modules'), join(core, 'node_modules'));
const promptsFile = join(core, 'src/role-prompts.ts'), current = readFileSync(promptsFile, 'utf8');
const ROLES = ['coordinator', 'worker', 'scout', 'reviewer', 'verifier'];
const legacy = ROLES.reduce((text, role) => text.replace(`  ${role}: \``, `  ${role}: \`LEGACY-DEFAULT ${role}. `), current);
if (ROLES.some(role => !legacy.includes(`LEGACY-DEFAULT ${role}.`))) throw Error('could not mark every legacy default');
writeFileSync(promptsFile, legacy);
process.env.PI_PROJECTS_CORE = core;

const { createKit, call, say, delay } = await import('./lib/e2e-kit.mjs');
const handler = ({ role, user, results }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  const mark = /MARK-(WORKER|SCOUT|REVIEWER) (\S+)/.exec(user);
  if (role === 'coordinator' && mark && results.length === 0) return call('projects_delegate', { role: mark[1].toLowerCase(), task: `TASK-${mark[1]} ${mark[2]}` });
  if (role === 'coordinator' && mark) return say('Noted.');
  return undefined;
};
const kit = await createKit('settings-prompts-refresh', { handler });
const { check, rpc } = kit;
kit.initRepo();
const CUSTOM_SCOUT = 'CUSTOM-SCOUT: read only the files you were asked about.';
const UNSAVED = 'UNSAVED-REVIEWER draft text';

try {
  await kit.run(async () => {
    const id = await kit.createProject('Prompt refresh');
    const stored = () => JSON.parse(readFileSync(join(kit.home, id, 'project.json'), 'utf8'));
    check('S0 a new project stores no prompt overrides', !('prompts' in stored()));
    await kit.updateSettings(id, { prompts: { scout: CUSTOM_SCOUT } });
    const before = await rpc({ action: 'prompts-snapshot', id });
    check('S0 the first host serves its own (legacy) built-in text', before.roles.every(item => item.default.startsWith(`LEGACY-DEFAULT ${item.role}.`)));

    // A worker thread that starts before the upgrade freezes the legacy text.
    await kit.ask(id, 'MARK-WORKER frozen');
    const frozen = (await kit.plan(id)).find(work => work.text.includes('TASK-WORKER frozen'));
    check('S1 the pre-upgrade worker runs with the legacy default', kit.lastCall('worker', 'TASK-WORKER frozen')?.system.includes('LEGACY-DEFAULT worker.'));

    const page = await kit.openPage(await kit.webUrl(id));
    await page.waitFor(`document.querySelectorAll('#prompts [data-prompt]').length === 5`, 'prompt editors');
    const editor = role => page.evaluate(`document.querySelector('[data-prompt="${role}"]').value`);
    check('S2 Settings shows the running host\'s built-in coordinator text', (await editor('coordinator')).startsWith('LEGACY-DEFAULT coordinator.'));
    await page.evaluate(`(() => { const t = document.querySelector('[data-prompt="reviewer"]'); t.value = ${JSON.stringify(UNSAVED)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await page.shot('01-settings-before-upgrade', { force: true });
    const origin = await page.evaluate('performance.timeOrigin');

    // Upgrade: the host restarts on the real defaults; the tab stays open on the same address and token.
    await kit.stopHost();
    writeFileSync(promptsFile, current);
    kit.startHost(); await kit.waitHost();
    const after = await rpc({ action: 'prompts-snapshot', id });
    check('S3 the restarted host serves the current built-in text', after.roles.every(item => !item.default.includes('LEGACY-DEFAULT')));

    await page.evaluate(`document.querySelector('.tabs [data-tab="coordinator"]').click()`);
    await page.evaluate(`document.querySelector('.tabs [data-tab="settings"]').click()`);
    const expected = Object.fromEntries(after.roles.map(item => [item.role, item.default]));
    await page.waitFor(`document.querySelector('[data-prompt="coordinator"]')?.value === ${JSON.stringify(expected.coordinator)}`, `current coordinator default in the open tab (shows ${(await editor('coordinator')).slice(0, 40)})`).catch(async error => { await page.evaluate(`document.querySelector('#set-advanced')?.scrollIntoView()`); await page.shot('02-settings-after-upgrade-stale', { force: true }); throw error; });
    check('S4 the tab was not reloaded', await page.evaluate('performance.timeOrigin') === origin);
    const shown = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('#prompts fieldset')].map(f => [f.dataset.role, { text: f.querySelector('textarea').value, custom: !!f.querySelector('.prompt-custom') }]))`);
    for (const role of ['coordinator', 'worker', 'verifier']) check(`S4 ${role} shows the current default, labelled Default`, shown[role].text === expected[role] && !shown[role].custom, shown[role]);
    check('S4 the genuine scout override stays Customized', shown.scout.text === CUSTOM_SCOUT && shown.scout.custom, shown.scout);
    check('S4 the unsaved reviewer edit is kept', shown.reviewer.text === UNSAVED, shown.reviewer);
    await page.evaluate(`document.querySelector('#set-advanced')?.scrollIntoView()`);
    await page.shot('02-settings-after-upgrade', { force: true });

    // Saving an unchanged default stores nothing; Reset removes the override instead of saving a snapshot.
    await page.evaluate(`document.querySelector('[data-action="prompt-save"][data-role="coordinator"]').click()`);
    await page.waitFor(`/Coordinator prompt (saved|reset)/.test(document.querySelector('#toast').textContent)`, 'coordinator save toast');
    check('S5 saving the shown default persists no override', JSON.stringify(stored().prompts) === JSON.stringify({ scout: CUSTOM_SCOUT }), stored().prompts);

    // Fresh roles use the current text; the scout override and the frozen worker are untouched.
    await kit.ask(id, 'MARK-WORKER fresh');
    await kit.ask(id, 'MARK-SCOUT fresh');
    await kit.ask(id, 'MARK-REVIEWER fresh');
    const coordinatorCall = kit.result.calls.findLast(c => c.role === 'coordinator');
    check('S6 the coordinator request uses the current default', coordinatorCall.system.includes(expected.coordinator) && !coordinatorCall.system.includes('LEGACY-DEFAULT'));
    check('S6 a new worker uses the current default', kit.lastCall('worker', 'TASK-WORKER fresh')?.system.includes(expected.worker));
    check('S6 a new reviewer uses the current default', kit.lastCall('reviewer', 'TASK-REVIEWER fresh')?.system.includes(expected.reviewer));
    check('S6 a new scout uses the genuine override', kit.lastCall('scout', 'TASK-SCOUT fresh')?.system.includes(CUSTOM_SCOUT));
    await rpc({ action: 'thread-send', id, threadId: frozen.threadId, text: 'FROZEN-FOLLOW-UP', requestId: randomUUID() });
    await delay(300); await kit.settle(id);
    const followUp = kit.result.calls.findLast(c => c.role === 'worker' && c.user.includes('FROZEN-FOLLOW-UP'));
    check('S7 a follow-up on the pre-upgrade worker keeps its frozen legacy prompt', followUp?.system.includes('LEGACY-DEFAULT worker.'));

    await page.evaluate(`document.querySelector('[data-action="prompt-reset"][data-role="scout"]').click()`);
    await kit.eventually(() => !('prompts' in stored()), 'scout override not removed', 100);
    await page.waitFor(`!document.querySelector('#prompts .prompt-custom') && document.querySelector('[data-prompt="scout"]').value === ${JSON.stringify(expected.scout)}`, 'scout reset in the editor');
    check('S8 Reset removes the override and shows the current default', !('prompts' in stored()));
    writeFileSync(join(kit.artifacts, 'storage-second-view.json'), JSON.stringify({ projectJsonHasPrompts: 'prompts' in stored(), settingsPrompts: (await rpc({ action: 'settings-snapshot', id })).values.prompts, roles: (await rpc({ action: 'prompts-snapshot', id })).roles.map(item => ({ role: item.role, override: item.override, legacy: item.effective.includes('LEGACY-DEFAULT') })) }, null, 2));
  });
} finally {
  if (existsSync(core)) rmSync(core, { recursive: true, force: true });
}
