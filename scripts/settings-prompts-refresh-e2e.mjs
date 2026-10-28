// Browser E2E: a Settings tab left open across a host restart shows and uses the new host's built-in role prompts.
// The host first runs from a private core copy whose five defaults carry a LEGACY marker, then restarts on the real defaults while the page stays open.
// Fakes only (fake model, private HOME, temp repo). Covers: no override is persisted for defaults, a genuine override and an unsaved edit survive,
// Reset removes the override, new threads use the current text and a thread started before the restart keeps its frozen prompt.
// A page-level fetch gate then fails or holds one prompts-snapshot response: a failed refresh keeps the editors and drafts (F7), and a snapshot read
// before Save (F9) or Reset (F8) cannot bring the old text back. It also fails one Save and one Reset request: the drafts survive (F11).
// Cases are listed in settings-prompts-refresh-failures.md.
// E2E_SKIP_CASES=F7 skips a case, so a negative-control run against an older web/app.js can still reach the later cases.
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
const CUSTOM_COORDINATOR = 'CUSTOM-COORDINATOR: answer in one sentence.';
const DRAFTS = { coordinator: 'DRAFT-COORDINATOR unsaved', worker: 'DRAFT-WORKER unsaved' };
const skipped = new Set((process.env.E2E_SKIP_CASES ?? '').split(',').filter(Boolean));

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

    // The gate fails or holds exactly one prompts-snapshot response, after the host has answered it, or fails one request of the action in failAction.
    await page.evaluate(`(() => {
      const real = window.fetch.bind(window), gate = window.__gate = { mode: null, failAction: null, held: [], log: [] };
      window.fetch = async (url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (gate.failAction && body.includes('"action":"' + gate.failAction + '"')) { gate.log.push(gate.failAction + ' failed'); gate.failAction = null; throw new TypeError('Failed to fetch'); }
        if (body.includes('"action":"settings-update"')) gate.log.push('settings-update sent');
        if (!gate.mode || typeof init?.body !== 'string' || !init.body.includes('"prompts-snapshot"')) return real(url, init);
        const mode = gate.mode; gate.mode = null;
        if (mode === 'fail') { gate.log.push('snapshot failed'); throw new TypeError('Failed to fetch'); }
        const response = await real(url, init), text = await response.text();
        gate.log.push('snapshot read, overrides: ' + JSON.parse(text).data.roles.filter(item => item.override).map(item => item.role).join(','));
        await new Promise(release => gate.held.push(release));
        gate.log.push('snapshot released');
        return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
      };
    })()`);
    const gate = mode => page.evaluate(`window.__gate.mode = ${JSON.stringify(mode)}`);
    const note = text => page.evaluate(`window.__gate.log.push(${JSON.stringify(text)})`);
    const reopen = async () => { await page.evaluate(`document.querySelector('.tabs [data-tab="coordinator"]').click()`); await page.evaluate(`document.querySelector('.tabs [data-tab="settings"]').click()`); };
    const release = () => page.evaluate(`(async () => { window.__gate.held.shift()(); await new Promise(done => setTimeout(done, 300)); })()`);
    const editors = () => page.evaluate(`Object.fromEntries([...document.querySelectorAll('#prompts fieldset')].map(f => [f.dataset.role, { text: f.querySelector('textarea').value, custom: !!f.querySelector('.prompt-custom') }]))`);

    if (!skipped.has('F7')) {
      await gate('fail'); await reopen();
      await page.waitFor(`window.__gate.log.includes('snapshot failed')`, 'failed refresh');
      await delay(300);
      const failed = await editors();
      await page.evaluate(`(document.querySelector('#prompts .note.bad') ?? document.querySelector('#prompts')).scrollIntoView({ block: 'center' })`); await page.shot('03-refresh-failed', { force: true });
      check('F7 a failed refresh keeps all five editors', Object.keys(failed).length === 5, { roles: Object.keys(failed), html: await page.evaluate(`document.querySelector('#prompts').innerText.slice(0, 200)`) });
      check('F7 a failed refresh keeps the unsaved reviewer edit and the override', failed.reviewer?.text === UNSAVED && failed.scout?.text === CUSTOM_SCOUT && failed.scout.custom, failed);
      check('F7 the failure is shown next to the editors', /Prompts not refreshed/.test(await page.evaluate(`document.querySelector('#prompts .note.bad')?.textContent ?? ''`)));
      await reopen();
      await page.waitFor(`!document.querySelector('#prompts .note.bad') && document.querySelectorAll('#prompts [data-prompt]').length === 5`, 'retried refresh');
      const retried = await editors();
      check('F7 the next opening retries and keeps the unsaved edit', retried.reviewer.text === UNSAVED && retried.coordinator.text === expected.coordinator && retried.scout.custom, retried);
    }

    // F11: a Save whose settings-snapshot preflight fails and a Reset whose settings-update fails keep every draft and store nothing.
    for (const [role, text] of Object.entries(DRAFTS)) await page.evaluate(`(() => { const t = document.querySelector('[data-prompt="${role}"]'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const drafted = await editors();
    const updates = () => page.evaluate(`window.__gate.log.filter(entry => entry === 'settings-update sent').length`);
    const failedAttempts = [['settings-snapshot', 'prompt-save', 'coordinator'], ['settings-update', 'prompt-reset', 'scout']];
    for (const [action, button, role] of failedAttempts) {
      const sent = await updates();
      await page.evaluate(`window.__gate.failAction = ${JSON.stringify(action)}`);
      await page.evaluate(`document.querySelector('[data-action="${button}"][data-role="${role}"]').click()`);
      await page.waitFor(`window.__gate.log.includes('${action} failed') && !!document.querySelector('#prompts .note.bad')`, `${action} failure note`);
      await delay(300);
      const after = await editors();
      check(`F11 a failed ${action} during ${button} keeps all five editors and every draft`, JSON.stringify(after) === JSON.stringify(drafted), { drafted, after });
      check(`F11 the ${action} failure is shown`, /Failed to fetch/.test(await page.evaluate(`document.querySelector('#prompts .note.bad').textContent`)));
      check(`F11 the failed ${button} stores nothing`, JSON.stringify(stored().prompts) === JSON.stringify({ scout: CUSTOM_SCOUT }) && await updates() === sent, { stored: stored().prompts, log: await page.evaluate('window.__gate.log') });
    }
    await page.evaluate(`document.querySelector('#prompts .note.bad').scrollIntoView({ block: 'center' })`); await page.shot('05-save-and-reset-failed', { force: true });
    // A later Save and Reset still work, so no save stays counted as in flight.
    await page.evaluate(`document.querySelector('[data-action="prompt-save"][data-role="coordinator"]').click()`);
    await kit.eventually(() => stored().prompts?.coordinator === DRAFTS.coordinator, 'coordinator draft not saved after the failures', 100);
    await page.waitFor(`!!document.querySelector('[data-prompt="coordinator"]').closest('fieldset').querySelector('.prompt-custom') && !document.querySelector('#prompts .note.bad')`, 'coordinator Customized after a successful save');
    await page.evaluate(`document.querySelector('[data-action="prompt-reset"][data-role="coordinator"]').click()`);
    await kit.eventually(() => !stored().prompts?.coordinator, 'coordinator not reset after the failures', 100);
    await page.waitFor(`document.querySelector('[data-prompt="coordinator"]').value === ${JSON.stringify(expected.coordinator)}`, 'coordinator default after reset');
    check('F11 a later Save and Reset work after the failures', JSON.stringify(stored().prompts) === JSON.stringify({ scout: CUSTOM_SCOUT }), stored().prompts);

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

    // F9: a snapshot read before a Save arrives after it.
    if (!skipped.has('F9')) {
      await gate('hold'); await reopen();
      await page.waitFor(`window.__gate.held.length === 1`, 'held snapshot before save');
      await note('save clicked');
      await page.evaluate(`(() => { const t = document.querySelector('[data-prompt="coordinator"]'); t.value = ${JSON.stringify(CUSTOM_COORDINATOR)}; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-action="prompt-save"][data-role="coordinator"]').click(); })()`);
      await kit.eventually(() => stored().prompts?.coordinator === CUSTOM_COORDINATOR, 'coordinator override not saved', 100);
      await page.waitFor(`!!document.querySelector('[data-prompt="coordinator"]').closest('fieldset').querySelector('.prompt-custom')`, 'coordinator Customized');
      await note('save done'); await release();
      const saved = await editors();
      check('F9 a late pre-save snapshot does not replace the saved text', saved.coordinator.text === CUSTOM_COORDINATOR && saved.coordinator.custom, saved.coordinator);
      await page.evaluate(`document.querySelector('[data-action="prompt-reset"][data-role="coordinator"]').click()`);
      await kit.eventually(() => !stored().prompts?.coordinator, 'coordinator override not reset', 100);
      await page.waitFor(`document.querySelector('[data-prompt="coordinator"]').value === ${JSON.stringify(expected.coordinator)}`, 'coordinator default after reset');
    }

    // F8 with S8: Reset completes while a snapshot read before it (still showing the override) is held, then that snapshot arrives.
    if (!skipped.has('F8')) { await gate('hold'); await reopen(); await page.waitFor(`window.__gate.held.length === 1`, 'held snapshot before reset'); await note('reset clicked'); }
    await page.evaluate(`document.querySelector('[data-action="prompt-reset"][data-role="scout"]').click()`);
    await kit.eventually(() => !('prompts' in stored()), 'scout override not removed', 100);
    await page.waitFor(`!document.querySelector('#prompts .prompt-custom') && document.querySelector('[data-prompt="scout"]').value === ${JSON.stringify(expected.scout)}`, 'scout reset in the editor');
    check('S8 Reset removes the override and shows the current default', !('prompts' in stored()));
    if (!skipped.has('F8')) {
      await note('reset done'); await release();
      const late = await editors();
      await delay(300); await page.evaluate(`document.querySelector('[data-prompt="scout"]').scrollIntoView({ block: 'center' })`); await page.shot('04-after-late-pre-reset-snapshot', { force: true });
      check('F8 a late pre-reset snapshot does not bring the override back', late.scout.text === expected.scout && !late.scout.custom, late.scout);
      await page.evaluate(`document.querySelector('[data-action="prompt-save"][data-role="scout"]').click()`);
      await page.waitFor(`/Scout prompt saved/.test(document.querySelector('#toast').textContent)`, 'scout save toast');
      check('F8 saving afterwards stores no override', !('prompts' in stored()), stored().prompts);
      writeFileSync(join(kit.artifacts, 'request-order.json'), JSON.stringify(await page.evaluate('window.__gate.log'), null, 2));
    }
    writeFileSync(join(kit.artifacts, 'storage-second-view.json'), JSON.stringify({ projectJsonHasPrompts: 'prompts' in stored(), settingsPrompts: (await rpc({ action: 'settings-snapshot', id })).values.prompts, roles: (await rpc({ action: 'prompts-snapshot', id })).roles.map(item => ({ role: item.role, override: item.override, legacy: item.effective.includes('LEGACY-DEFAULT') })) }, null, 2));
  });
} finally {
  if (existsSync(core)) rmSync(core, { recursive: true, force: true });
}
