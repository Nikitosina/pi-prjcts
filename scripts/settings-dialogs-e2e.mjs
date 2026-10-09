// Browser E2E: Settings dialogs + model picker. Isolated host, fake model, fake Pi settings.json (enabledModels), fake gh, no real providers.
// Failure cases: settings-dialogs-failures.md. Artifacts: artifacts/settings-dialogs-*/ (light + dark screenshots, report.json).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createKit } from './lib/e2e-kit.mjs';
import { contrastLib } from './lib/contrast-scan.mjs';

const kit = await createKit('settings-dialogs');
const { check, rpc, root, repo } = kit;

// Fake Pi config: custom providers on top of the fake model, and the owner's scoped list (globs, thinking suffix, a miss).
const modelsPath = join(kit.agentDir, 'models.json'), models = JSON.parse(readFileSync(modelsPath, 'utf8'));
const entry = (id, name, contextWindow, reasoning = false) => ({ id, name, reasoning, input: ['text'], contextWindow, maxTokens: 4096 });
const provider = list => ({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fake', api: 'openai-completions', models: list });
models.providers.alpha = provider([entry('a-one', 'Alpha One', 272000, true), entry('a-two', 'Alpha Two', 1000000), entry('a-three', 'Claude Opus Bridge', 200000, true)]);
models.providers.bulk = provider(Array.from({ length: 60 }, (_, i) => entry(`bulk-${String(i).padStart(2, '0')}`, `Bulk Model ${i}`, 128000)));
writeFileSync(modelsPath, JSON.stringify(models));
const settingsFile = join(kit.agentDir, 'settings.json');
writeFileSync(settingsFile, JSON.stringify({ enabledModels: ['fake/fake-model', 'alpha/*', 'bulk/bulk-01:high', 'zzz/none', 'bulk/bulk-01'] }));
for (const key of Object.keys(kit.hostEnv)) if (/(API_KEY|_TOKEN|SECRET)/i.test(key)) delete kit.hostEnv[key]; // built-in providers stay unconfigured

// GitHub: fake gh + bare remote so the known-PR form is reachable.
const bare = join(root, 'remote.git'), fakeGh = join(root, 'fake-gh'), ghState = join(root, 'fake-gh-state.json');
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`); chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: 'acme/mari', default_branch: 'main' }, issues: [], checks: {}, pulls: [] })); writeFileSync(join(root, 'gh-calls.jsonl'), '');
execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
Object.assign(kit.hostEnv, { PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: join(root, 'gh-calls.jsonl') });
kit.initRepo();
kit.git(kit.workspace, 'remote', 'add', 'origin', 'https://github.com/acme/mari.git'); kit.git(kit.workspace, 'config', 'remote.origin.pushurl', bare); kit.git(kit.workspace, 'push', '-q', 'origin', 'main');
mkdirSync(join(kit.artifacts, 'shots'), { recursive: true });

await kit.run(async () => {
  const id = await kit.createProject('Mari');
  const snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'github-quick-authorize', id, confirm: id, expectedRevision: snap.githubRevision });
  const bare2 = await kit.createProject('Fresh', { grant: false });

  // Host: scoped list = Pi enabledModels resolved by Pi, configured only, deduped; missing/corrupt settings.json degrades to no scope.
  const picker = await rpc({ action: 'model-picker-snapshot' });
  const expectedScoped = ['fake/fake-model', 'alpha/a-one', 'alpha/a-two', 'alpha/a-three', 'bulk/bulk-01'];
  check('scoped models resolve globs, :thinking suffix, drop misses, dedupe', JSON.stringify(picker.scoped) === JSON.stringify(expectedScoped), picker.scoped);
  check('offline: networkChecked false, unconfigured models listed but flagged', picker.networkChecked === false && picker.items.some(m => !m.configured) && picker.scoped.every(r => picker.items.find(m => m.reference === r)?.configured));
  writeFileSync(settingsFile, '{not json'); check('corrupt settings.json -> empty scope, picker still works', (await rpc({ action: 'model-picker-snapshot' })).scoped.length === 0);
  writeFileSync(settingsFile, JSON.stringify({ enabledModels: ['fake/fake-model', 'alpha/*', 'bulk/bulk-01:high', 'zzz/none', 'bulk/bulk-01'] }));

  const page = await kit.openPage(await kit.webUrl(id, 'settings'));
  const ev = page.evaluate, delay = kit.delay;
  await page.waitFor(`document.querySelector('#settings-button')?.hidden === false && document.querySelector('#routines-button')?.hidden === false`, 'settings ready');
  await ev(contrastLib);
  const dlg = expr => ev(`(() => { const d = document.querySelector('#dialog'); return ${expr}; })()`);
  const open = async (click, ready, label) => { await ev(click); await page.waitFor(ready, label); await delay(200); };
  const theme = value => ev(`piTheme.set('${value}')`);
  // Every dialog: sticky/visible footer, no overflow at 1440 and 420, contrast in both themes, light + dark screenshots.
  const capture = async (name, { footer = true } = {}) => {
    for (const [t, dark] of [['light', false], ['dark', true]]) {
      await theme(t); await delay(250);
      const scan = await ev(`window.__scan(${dark}, document.querySelector('#dialog'))`);
      check(`${name} ${t}: contrast >= 4.5${dark ? ', no light surfaces' : ''}`, scan.low.length === 0 && (!dark || scan.bright.length === 0), scan);
      await page.shot(`shots/${name}-${t}`);
    }
    const shape = await dlg(`({ title: !!d.querySelector('.dialog-head h2'), x: !!d.querySelector('.dialog-head [data-action=close-dialog]'), open: d.open, raw: [...d.querySelectorAll('pre')].filter(p => !p.closest('details') && !p.classList.contains('excerpt') && !p.closest('.dialog-body') === false && !p.closest('details')).length, footerInside: ${footer} ? (() => { const f = d.querySelector('.dialog-actions'); if (!f) return false; const a = f.getBoundingClientRect(), b = d.getBoundingClientRect(); return a.bottom <= b.bottom + 1 && a.top >= b.top; })() : true })`);
    check(`${name}: title, X close, footer inside the dialog`, shape.title && shape.x && shape.open && shape.footerInside, shape);
    await page.viewport(420, 900, true); await delay(300);
    check(`${name}: no horizontal overflow at 420 px`, await dlg(`d.scrollWidth <= d.clientWidth + 1 && (d.querySelector('.dialog-body')?.scrollWidth ?? 0) <= (d.querySelector('.dialog-body')?.clientWidth ?? 0) + 1`));
    await page.shot(`shots/${name}-420-dark`);
    await page.viewport(1440, 1000, false); await theme('light'); await delay(250);
  };
  const jargon = /offline catalog|Review this single change|Explicit grants|Retained Durable|knowledgeAccess|workerCap|Exact operation binding/;

  // ---- Project settings + model picker ----
  await open(`document.querySelector('#settings-button').click()`, `!!document.querySelector('#dialog [data-settings-form]') && document.querySelectorAll('#dialog .mp').length === 4`, 'settings form');
  check('settings: plain title + subtitle, inline current values, no jargon, Review disabled', await dlg(`d.querySelector('h2').textContent === 'Project settings' && d.querySelector('.dialog-sub').textContent.length > 10 && d.querySelector('[name=name]').value === 'Mari' && d.querySelector('[name=workerCap]').value === '3' && !${jargon}.test(d.innerText) && d.querySelector('[type=submit]').disabled`));
  check('settings: current model names are shown on the picker buttons', (await dlg(`[...d.querySelectorAll('.mp-current')].map(b => b.innerText).join('|')`)).includes('fake/fake-model'));
  await capture('settings-form');
  const pickerOf = role => `#dialog .mp[data-role=${role}]`;
  await ev(`document.querySelector('${pickerOf('worker')} .mp-current').click()`);
  await page.waitFor(`!document.querySelector('${pickerOf('worker')} .mp-pop').hidden && document.activeElement.classList.contains('mp-search')`, 'picker open + search focused');
  const rows = () => ev(`[...document.querySelectorAll('${pickerOf('worker')} .mp-row')].map(r => r.dataset.ref + (r.getAttribute('aria-disabled') ? '!' : ''))`);
  const groups = () => ev(`[...document.querySelectorAll('${pickerOf('worker')} .mp-group')].map(g => g.textContent)`);
  check('picker: Scoped models first, exactly the scoped list, hint to search all', JSON.stringify(await rows()) === JSON.stringify(expectedScoped) && (await groups())[0] === 'Scoped models' && /search all \d+ configured/.test(await ev(`document.querySelector('${pickerOf('worker')} .mp-list').innerText`)));
  check('picker: compact context windows (272k, 1M) and current marked', await ev(`(() => { const t = document.querySelector('${pickerOf('worker')} .mp-list').innerText; return /272k/.test(t) && /1M/.test(t) && document.querySelector('${pickerOf('worker')} .mp-row[aria-selected=true]')?.dataset.ref === 'fake/fake-model'; })()`));
  await capture('model-picker-scoped', { footer: false });
  const type = async text => { await ev(`(() => { const i = document.querySelector('${pickerOf('worker')} .mp-search'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); };
  await type('claude opus'); check('picker: multi-term, separator-insensitive search over name', (await rows())[0] === 'alpha/a-three');
  await type('BULK-0'); const bulk = await rows();
  check('picker: case-insensitive, scoped match first then other configured models, capped with "more" note', bulk[0] === 'bulk/bulk-01' && (await groups()).includes('Other configured models') && /\+\d+ more/.test(await ev(`document.querySelector('${pickerOf('worker')} .mp-list').innerText`)) || bulk.length <= 40, bulk.slice(0, 3));
  await type('anthropic'); const anth = await rows();
  check('picker: unconfigured models are shown disabled at the bottom and cannot be picked', anth.length > 0 && anth.length <= 5 && anth.every(r => r.endsWith('!')) && (await groups()).includes('No credentials configured'), anth);
  await ev(`document.querySelector('${pickerOf('worker')} .mp-row[aria-disabled]').click()`); await delay(150);
  check('picker: clicking a disabled row changes nothing', await ev(`document.querySelector('${pickerOf('worker')}').dataset.value === 'fake/fake-model'`));
  await type('alpha');
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  check('picker: ArrowDown moves the active row and aria-activedescendant', await ev(`(() => { const a = document.querySelector('${pickerOf('worker')} .mp-row.active'); return a?.dataset.ref === 'alpha/a-two' && document.activeElement.getAttribute('aria-activedescendant') === a.id; })()`));
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`); await delay(150);
  check('picker: Esc closes only the list, dialog stays open, focus back on the button', await ev(`document.querySelector('${pickerOf('worker')} .mp-pop').hidden && document.querySelector('#dialog').open && document.activeElement.classList.contains('mp-current')`));
  await ev(`document.querySelector('${pickerOf('worker')} .mp-current').click()`); await type('alpha');
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`); await delay(150);
  check('picker: Enter selects, button shows the new model, field marked changed, Review enabled, dirty hint', await dlg(`d.querySelector('${pickerOf('worker')}').dataset.value === 'alpha/a-two' && /Alpha Two/.test(d.querySelector('${pickerOf('worker')} .mp-current').innerText) && d.querySelector('.field[data-field=worker]').classList.contains('changed') && !d.querySelector('[type=submit]').disabled && /1 unsaved change/.test(d.querySelector('.hint').textContent)`));
  // Reasoning model by mouse in the scout picker; searching an unscoped model by id.
  await ev(`document.querySelector('${pickerOf('scout')} .mp-current').click()`);
  await ev(`(() => { const i = document.querySelector('${pickerOf('scout')} .mp-search'); i.value = 'a-one'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ev(`document.querySelector('${pickerOf('scout')} .mp-row[data-ref="alpha/a-one"]').click()`);
  await ev(`(() => { const f = document.querySelector('[data-settings-form]'); f.elements.name.value = 'Mari 2'; f.elements.name.dispatchEvent(new Event('input', { bubbles: true })); f.elements.workerCap.value = '5'; f.elements.workerCap.dispatchEvent(new Event('input', { bubbles: true })); f.elements.knowledgeAccess.value = 'maintain'; f.elements.knowledgeAccess.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('form: 5 changes counted live', await dlg(`/5 unsaved changes/.test(d.querySelector('.hint').textContent)`));
  await capture('settings-form-edited');
  await ev(`document.querySelector('#dialog [data-settings-form] [type=submit]').click()`);
  await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Save these changes?'`, 'review dialog');
  check('review: one before -> after item per changed field, plain labels, no JSON, hidden project confirm', await dlg(`d.querySelectorAll('.diff-item').length === 5 && /Workers at once/.test(d.innerText) && d.querySelector('.diff-item .diff-side.before') && d.querySelector('.diff-item .diff-side.after') && !d.querySelector('pre') && d.querySelector('form[data-settings-confirm] input[type=hidden][name=confirm]') && !${jargon}.test(d.innerText)`));
  await capture('settings-review');
  await ev(`document.querySelector('#dialog [data-action=settings-back]').click()`);
  await page.waitFor(`!!document.querySelector('#dialog [data-settings-form]')`, 'back to editing');
  check('back to editing keeps every edit (name, cap, picks)', await dlg(`d.querySelector('[name=name]').value === 'Mari 2' && d.querySelector('[name=workerCap]').value === '5' && d.querySelector('${pickerOf('worker')}').dataset.value === 'alpha/a-two' && d.querySelector('${pickerOf('scout')}').dataset.value === 'alpha/a-one'`));
  await ev(`document.querySelector('#dialog [data-settings-form] [type=submit]').click()`); await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Save these changes?'`, 'review again');
  await ev(`document.querySelector('#dialog').dispatchEvent(new Event('cancel', { cancelable: true })); document.querySelector('#dialog').close()`); await delay(300);
  check('Esc/close on the review clears the pending proposal', await ev(`settingsConfirmation === null`));
  await open(`document.querySelector('#settings-button').click()`, `!!document.querySelector('#dialog [data-settings-form]')`, 'reopen');
  check('unsent text edit is retained across close (draft) and offered for discard', await dlg(`d.querySelector('[name=name]').value === 'Mari 2' && !!d.querySelector('[data-action=settings-discard][data-field=name]')`));
  await ev(`document.querySelector('#dialog [data-action=settings-discard][data-field=name]').click()`); await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Discard your unsent edit?'`, 'discard dialog');
  check('discard dialog shows the text being discarded', await dlg(`/Mari 2/.test(d.innerText)`));
  await capture('settings-discard');
  await ev(`document.querySelector('#dialog [data-action=settings-confirm-discard]').click()`); await page.waitFor(`!!document.querySelector('#dialog [data-settings-form]')`, 'editor after discard');
  check('discard resets the field to the saved value', await dlg(`d.querySelector('[name=name]').value === 'Mari' && !d.querySelector('[data-action=settings-discard]')`));
  // Stale revision: edit name, change settings elsewhere, save -> host rejects, draft kept, no rebase.
  await ev(`(() => { const f = document.querySelector('[data-settings-form]'); f.elements.name.value = 'Stale'; f.elements.name.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await kit.updateSettings(id, { objective: 'changed elsewhere' });
  await ev(`document.querySelector('#dialog [data-settings-form] [type=submit]').click()`); await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Save these changes?'`, 'stale review');
  await ev(`document.querySelector('#dialog form[data-settings-confirm] [type=submit]').click()`);
  await page.waitFor(`!!document.querySelector('#dialog .dialog-error')`, 'conflict shown in the dialog');
  const after = await rpc({ action: 'settings-snapshot', id });
  check('stale save is rejected by the host, error shown inside the dialog, draft kept', after.values.name === 'Mari' && await ev(`settingsDrafts.has('${id}:name')`));
  await ev(`document.querySelector('#dialog [data-action=settings-back]').click()`); await page.waitFor(`!!document.querySelector('#dialog [data-settings-form]')`, 'editor');
  check('stale draft is flagged as from an older version', await dlg(`/older version/.test(d.innerText)`));
  await ev(`document.querySelector('#dialog [data-action=settings-discard][data-field=name]').click()`); await delay(300); await ev(`document.querySelector('#dialog [data-action=settings-confirm-discard]').click()`);
  await page.waitFor(`!!document.querySelector('#dialog [data-settings-form]') && !document.querySelector('#dialog [data-action=settings-discard]')`, 'clean editor');
  // Real save of picks + cap + access, only changed fields.
  await ev(`(() => { const f = document.querySelector('[data-settings-form]'); f.querySelector('.mp[data-role=worker] .mp-current').click(); const i = f.querySelector('.mp[data-role=worker] .mp-search'); i.value = 'a-two'; i.dispatchEvent(new Event('input', { bubbles: true })); f.querySelector('.mp[data-role=worker] .mp-row[data-ref="alpha/a-two"]').click(); f.elements.workerCap.value = '5'; f.elements.workerCap.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ev(`document.querySelector('#dialog [data-settings-form] [type=submit]').click()`); await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Save these changes?'`, 'final review');
  await ev(`document.querySelector('#dialog form[data-settings-confirm] [type=submit]').click()`);
  await page.waitFor(`!document.querySelector('#dialog').open`, 'dialog closes after save');
  const saved = await rpc({ action: 'settings-snapshot', id });
  check('save sends only changed fields: worker model + cap changed, others intact', saved.values.models.worker === 'alpha/a-two' && saved.values.workerCap === 5 && saved.values.model === 'fake/fake-model' && saved.values.name === 'Mari' && saved.values.objective === 'changed elsewhere', saved.values);
  // Unconfigured models are rejected by the host as well (defence in depth).
  check('host still rejects an unconfigured model', (await kit.rejects({ action: 'settings-update', id, confirm: id, expectedRevision: saved.revision, changes: { models: { worker: picker.items.find(m => !m.configured).reference } } })) !== null);

  // ---- Owner setup (fresh project: quick grant) ----
  await page.navigate(await kit.webUrl(bare2, 'settings')); await page.waitFor(`document.querySelector('#owner-setup-button')?.hidden === false`, 'fresh project'); await ev(contrastLib);
  await open(`document.querySelector('#owner-setup-button').click()`, `!!document.querySelector('#dialog [data-action=workspace-quick]')`, 'owner setup');
  check('owner setup: title, subtitle, advanced collapsed', await dlg(`d.querySelector('h2').textContent === 'Owner setup' && d.querySelector('.dialog-sub') && !d.querySelector('details.advanced').open`));
  await capture('owner-setup');
  await open(`document.querySelector('#dialog [data-action=workspace-quick]').click()`, `!!document.querySelector('#dialog [data-action=workspace-quick-confirm]')`, 'workspace dialog');
  check('workspace dialog: facts, no typed project id', await dlg(`/uncommitted|Checkout/.test(d.innerText) && !d.querySelector('input[name=confirm]')`));
  await capture('workspace-quick');
  await ev(`document.querySelector('#dialog [data-action=workspace-quick-confirm]').click()`); await page.waitFor(`/Workers can edit this repository/.test(document.querySelector('#dialog').innerText)`, 'granted');
  await ev(`document.querySelector('#dialog details.advanced').open = true`);
  await capture('owner-setup-advanced');
  await ev(`document.querySelector('#dialog [data-kind=workspace-revoke]').click()`); await page.waitFor(`!!document.querySelector('#dialog form[data-owner-write][data-kind=workspace-revoke]')`, 'revoke form');
  check('revoke: plain title, summary, hidden confirm only', await dlg(`/Revoke this folder scope/.test(d.querySelector('h2').textContent) && !d.querySelector('input[name=confirm]:not([type=hidden])') && !d.querySelector('textarea')`));
  await capture('owner-revoke');
  await ev(`document.querySelector('#dialog [data-action=owner-setup]').click()`); await page.waitFor(`!!document.querySelector('#dialog details.advanced')`, 'back');
  await ev(`document.querySelector('#dialog details.advanced').open = true; document.querySelector('#dialog [data-kind=github-authorize]').click()`); await page.waitFor(`!!document.querySelector('#dialog form[data-owner-write][data-kind=github-authorize]')`, 'authorize form');
  check('github-authorize: labelled fields rebuild the exact typed payload', await dlg(`!d.querySelector('textarea[name=payload]') && d.querySelectorAll('.field input').length === 3`) && await ev(`(() => { const f = document.querySelector('#dialog form[data-owner-write]'); f.querySelector('[data-path=repositoryId]').value = 'acme/mari'; f.querySelector('[data-path=expectedRepositoryId]').value = '4242'; const v = ownerFieldsValue(f); return typeof v.expectedRepositoryId === 'number' && v.repositoryId === 'acme/mari' && typeof v.expectedRevision === 'string'; })()`));
  await capture('owner-authorize');
  await ev(`document.querySelector('#dialog').close()`);

  // ---- Routines + history ----
  await page.navigate(await kit.webUrl(id, 'settings')); await page.waitFor(`document.querySelector('#routines-button')?.hidden === false`, 'project'); await ev(contrastLib);
  for (const text of ['Daily summary of open PRs for the team', 'Nightly dependency check']) await rpc({ action: 'schedule-create', id, atMs: Date.now() + 3_600_000, text });
  const soon = await rpc({ action: 'schedule-create', id, atMs: Date.now() + 1500, text: 'Reply exactly HISTORY_SAMPLE' }); await rpc({ action: 'schedule-enable', id, scheduleId: soon.id, enabled: true });
  await kit.eventually(async () => (await rpc({ action: 'schedule-snapshot', id })).intents.length > 0 || (await rpc({ action: 'schedule-snapshot', id, includeHistory: true })).intents.length > 0, 'a history intent');
  await open(`document.querySelector('#routines-button').click()`, `!!document.querySelector('#dialog .list-row')`, 'routines');
  check('routines: plain title, tabs with counts, rows with On/Off chips, JSON only in Details', await dlg(`d.querySelector('h2').textContent === 'Schedules and monitors' && d.querySelectorAll('.skill-tabs button').length === 3 && d.querySelectorAll('.list-row').length >= 3 && d.querySelector('.state-chip') && ![...d.querySelectorAll('pre')].some(p => !p.closest('details')) && !${jargon}.test(d.innerText)`));
  await capture('routines');
  await ev(`document.querySelector('#dialog [data-action=routine-confirm][data-kind=schedule][data-enabled=true]').click()`); await page.waitFor(`/^Turn on/.test(document.querySelector('#dialog h2')?.textContent ?? '')`, 'routine confirm');
  check('routine confirm: Off -> On diff, hidden project confirm', await dlg(`/Off/.test(d.querySelector('.diff-side.before').innerText) && /On/.test(d.querySelector('.diff-side.after').innerText) && d.querySelector('form[data-routine-change] input[type=hidden][name=confirm]')`));
  await capture('routine-confirm');
  await ev(`document.querySelector('#dialog form[data-routine-change] [type=submit]').click()`); await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Schedules and monitors' || !document.querySelector('#dialog').open`, 'after toggle');
  const enabledCount = (await rpc({ action: 'schedule-snapshot', id })).schedules.filter(s => s.enabled && /Daily summary|Nightly/.test(s.text)).length;
  check('routine toggle applied only after confirmation', enabledCount === 1, enabledCount);
  await open(`(document.querySelector('#dialog').open ? 0 : document.querySelector('#routines-button').click()); document.querySelector('#dialog [data-lens=history]').click()`, `document.querySelector('#dialog h2')?.textContent === 'Automation history'`, 'history');
  check('history: runs/events tabs, readable rows, raw JSON collapsed', await dlg(`d.querySelectorAll('.skill-tabs button').length === 2 && ![...d.querySelectorAll('pre')].some(p => !p.closest('details') && !p.classList.contains('excerpt'))`));
  await capture('routine-history');
  await ev(`document.querySelector('#dialog').close()`);

  // ---- Lifecycle ----
  await open(`document.querySelector('[data-action=lifecycle-more]').click()`, `!!document.querySelector('#dialog [data-action=lifecycle-confirm]')`, 'lifecycle');
  check('lifecycle: plain choices with one-line consequences', await dlg(`d.querySelectorAll('.choice-card').length === 2 && /Archive/.test(d.innerText) && /Nothing in the repository/.test(d.innerText)`));
  await capture('lifecycle');
  await ev(`document.querySelector('#dialog [data-operation=archive]').click()`); await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Archive this project?'`, 'archive confirm');
  await capture('lifecycle-confirm');
  await ev(`document.querySelector('#dialog [data-action=lifecycle-more]').click()`); await page.waitFor(`!!document.querySelector('#dialog .choice-card')`, 'back to choices');
  check('lifecycle: Back keeps the project untouched', (await rpc({ action: 'show', id })).project.archived !== true);
  await ev(`document.querySelector('#dialog').close()`);

  // ---- Usage, approvals, provider receipts, known PR ----
  await page.navigate(await kit.webUrl(id, 'observability')); await page.waitFor(`!!document.querySelector('#usage-button')`, 'usage button'); await ev(contrastLib); await delay(1500);
  await open(`document.querySelector('#usage-button').click()`, `document.querySelector('#dialog h2')?.textContent === 'Usage' && !!document.querySelector('#dialog .stats')`, 'usage');
  check('usage: stat tiles, page-only note, raw breakdown collapsed', await dlg(`d.querySelectorAll('.stat').length >= 6 && /this page only/.test(d.innerText) && ![...d.querySelectorAll('pre')].some(p => !p.closest('details'))`));
  await capture('usage');
  await ev(`document.querySelector('#dialog').close()`);
  await page.navigate(await kit.webUrl(id, 'settings')); await page.waitFor(`!!document.querySelector('#approvals-button')`, 'settings'); await delay(1200); await ev(contrastLib);
  await open(`operationsDialog()`, `document.querySelector('#dialog h2')?.textContent === 'Approvals'`, 'approvals');
  await capture('approvals-empty');
  // A synthetic owned record (fake-only) exercises the detail and decision dialogs.
  const fp = 'a'.repeat(64), opId = '11111111-1111-4111-8111-111111111111';
  await ev(`operationCache.set('${opId}', { id: '${opId}', projectId, fingerprint: '${fp}', status: 'pending', scopeCurrent: true, operation: { provider: 'github', kind: 'merge', repositoryId: 'acme/mari', pullRequest: 7, head: '${'b'.repeat(40)}' } }); operationView('${opId}', '${fp}')`); await delay(300);
  check('approval detail: facts + identity under Exact binding, decision buttons keep fingerprint', await dlg(`/acme\\/mari/.test(d.innerText) && !!d.querySelector('details.raw') && d.querySelectorAll('[data-action=operation-decision][data-fingerprint="${fp}"]').length === 3`));
  await capture('approval-detail');
  await ev(`document.querySelector('#dialog [data-decision=execution]').click()`); await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Allow this exact executor?'`, 'decision confirm');
  await capture('approval-decision');
  const key = 'rec-1';
  await ev(`providerCache.set('${key}', { projectId, kind: 'reads', record: { scopeId: '22222222-2222-4222-8222-222222222222', conversationId: 1, taskId: 1, callId: 'c1', operation: 'ci', repositoryId: 'acme/mari', pullRequest: 7, head: '${'b'.repeat(40)}', ci: { statusState: 'success', page: 1 } } }); providerRecord('${key}')`); await delay(300);
  await capture('provider-record');
  await open(`document.querySelector('#provider-button').click()`, `document.querySelector('#dialog h2')?.textContent === 'GitHub receipts'`, 'provider list');
  check('provider list: tabs with selected state, plain empty copy', await dlg(`d.querySelectorAll('.skill-tabs button[aria-pressed=true]').length === 1 && /Nothing recorded yet/.test(d.innerText)`));
  await capture('provider-list');
  await ev(`document.querySelector('#dialog [data-action=provider-known]').click()`); await page.waitFor(`!!document.querySelector('#dialog form[data-provider-known]')`, 'known PR form');
  check('known PR form: labelled fields, SHA pattern enforced', await dlg(`d.querySelector('h2').textContent === 'Check a specific pull request' && d.querySelector('[name=head]').pattern.length > 10`));
  await capture('provider-known');
  await ev(`document.querySelector('#dialog').close()`);
  await delay(200);
  check('no leaked proposals after closing everything', await ev(`settingsConfirmation === null && routineConfirmation === null && providerInspection === null`));
});
