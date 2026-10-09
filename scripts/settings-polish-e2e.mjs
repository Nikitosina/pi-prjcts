// Browser E2E: Settings polish (Track U). Isolated host, fake model, fake MCP servers, fake gh, fake Arcadia; ~90 skills. Failure cases: settings-polish-failures.md.
// ROUND=<n> only captures design-iteration screenshots into round-<n>/ (no assertions). No ROUND: asserts everything and writes final/ screenshots.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createKit } from './lib/e2e-kit.mjs';
import { fakeArcadia } from './lib/fake-arc-kit.mjs';
import { contrastLib } from './lib/contrast-scan.mjs';

const ROUND = process.env.ROUND, folder = ROUND ? `round-${ROUND}` : 'final';
const kit = await createKit('settings-polish');
const { check, rpc, root, repo } = kit;
mkdirSync(join(kit.artifacts, folder), { recursive: true });

// Skills: 12 repository, 78 global, with varied name and description lengths.
const skill = (dir, name, description) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`); };
const topics = ['ios', 'swift', 'android', 'review', 'release', 'docs', 'sql', 'infra', 'design', 'test', 'perf', 'secure', 'git'];
for (let i = 0; i < 12; i++) skill(join(kit.workspace, '.pi', 'skills'), `repo-${topics[i]}`, `Repository convention for ${topics[i]} work in this project; read it before touching those files.`);
for (let i = 0; i < 78; i++) skill(join(kit.agentDir, 'skills'), `${topics[i % topics.length]}-${String(i).padStart(2, '0')}`, i % 5 === 0 ? `Long description for ${topics[i % topics.length]} number ${i}: ${'covers many cases and edge conditions of the owner workflow, '.repeat(3)}` : `Owner skill ${i} about ${topics[i % topics.length]}.`);

// MCP servers: ready, disabled, needs sign-in.
const calls = join(root, 'mcp-calls.jsonl'); writeFileSync(calls, '');
const server = tag => ({ command: process.execPath, args: [join(repo, 'scripts/fake-mcp-server.mjs')], env: { FAKE_MCP_TAG: tag, FAKE_MCP_CALLS: calls }, timeout: 2, description: `Fake ${tag} server with a description long enough to wrap on a narrow screen` });
const mcpConfig = join(root, 'fake-mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'fake-ci': server('ci'), 'fake-tracker': server('tracker'), 'fake-xcode': server('xcode'), 'fake-docs': server('docs'), 'fake-off': { ...server('off'), enabled: false }, 'fake-oauth': { url: 'http://127.0.0.1:9/mcp', oauth: {}, description: 'Needs a browser sign-in' } } }));

// GitHub: fake gh + bare remote. Arc: fake Arcadia mount.
const bare = join(root, 'remote.git'), fakeGh = join(root, 'fake-gh'), ghState = join(root, 'fake-gh-state.json');
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`); chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: 'acme/mari', default_branch: 'main' }, issues: [], checks: {}, pulls: [] })); writeFileSync(join(root, 'gh-calls.jsonl'), '');
execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
const fake = fakeArcadia(root);
Object.assign(kit.hostEnv, fake.env, { PI_PROJECTS_MCP_CONFIG: mcpConfig, PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: join(root, 'gh-calls.jsonl') });
kit.initRepo();
kit.git(kit.workspace, 'remote', 'add', 'origin', 'https://github.com/acme/mari.git'); kit.git(kit.workspace, 'config', 'remote.origin.pushurl', bare); kit.git(kit.workspace, 'push', '-q', 'origin', 'main');

await kit.run(async () => {
  const gh = await kit.createProject('Mari (GitHub)'), arc = await kit.createProject('Keyboard (Arcadia)', { grant: false, cwd: fake.subdir });
  const second = await rpc({ action: 'owner-setup-snapshot', id: gh });
  await rpc({ action: 'github-quick-authorize', id: gh, confirm: gh, expectedRevision: second.githubRevision });
  const first = await rpc({ action: 'owner-setup-snapshot', id: arc });
  await rpc({ action: 'workspace-quick-grant', id: arc, confirm: arc, expectedRevision: first.workspaceRevision });
  const arcSnap = await rpc({ action: 'owner-setup-snapshot', id: arc });
  await rpc({ action: 'arc-quick-authorize', id: arc, confirm: arc, expectedRevision: arcSnap.arcRevision });
  // Some skills and MCP servers already picked so the pickers show real state.
  await kit.updateSettings(gh, { skills: { all: ['repo-ios', 'repo-swift', 'ios-00'], coordinator: ['review-03'], worker: ['test-09', 'git-12'], scout: [], reviewer: ['review-03'] }, mcp: { all: ['fake-ci'], coordinator: [], worker: ['fake-tracker'], scout: [], reviewer: [], writes: ['fake-tracker'] } });

  const page = await kit.openPage(await kit.webUrl(gh, 'settings'));
  const loaded = `document.querySelectorAll('#skills-picker [data-skill-pick]').length === 90 && document.querySelectorAll('#mcp-picker [data-mcp-pick]').length === 6 && !/Reading/.test(document.querySelector('#worktrees').innerText + document.querySelector('#context-settings').innerText + document.querySelector('#events-in').innerText)`;
  await page.waitFor(loaded, 'settings loaded').catch(async error => { throw Error(error.message + ' ' + await page.evaluate(`JSON.stringify({ skills: document.querySelectorAll('#skills-picker [data-skill-pick]').length, mcp: document.querySelectorAll('#mcp-picker [data-mcp-pick]').length, wt: document.querySelector('#worktrees')?.innerText, ctx: document.querySelector('#context-settings')?.innerText.slice(0, 80), ev: document.querySelector('#events-in')?.innerText.slice(0, 80), sk: document.querySelector('#skills-picker')?.innerText.slice(0, 120), err: document.querySelector('#error')?.innerText })`)); });
  await page.evaluate(contrastLib);
  const ev = page.evaluate, setTheme = value => ev(`piTheme.set('${value}')`);
  const view = async (width, theme) => { await page.viewport(width, 1000, width < 600); await setTheme(theme); await kit.delay(600); };
  // The page scrolls inside .body, so capture with a viewport as tall as the content (capped), then restore.
  const shot = async name => { const width = await ev('innerWidth'), tall = await ev(`Math.min(9000, Math.ceil(document.querySelector('.body').scrollHeight + document.querySelector('.body').getBoundingClientRect().top))`); await page.viewport(width, Math.max(tall, 1000), width < 600); await kit.delay(300); await page.shot(`${folder}/${name}`); await page.viewport(width, 1000, width < 600); await kit.delay(200); };
  const gotoProject = async id => { await page.navigate(await kit.webUrl(id, 'settings')); await kit.delay(1500); await page.waitFor(`document.querySelectorAll('#skills-picker [data-skill-pick]').length > 0 && !/Reading/.test(document.querySelector('#worktrees').innerText + document.querySelector('#events-in').innerText)`, 'project settings'); await page.evaluate(contrastLib); };

  // Design-iteration screenshots: desktop and 420 px, light and dark; GitHub and Arc variants.
  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [420, 'light'], [420, 'dark']]) { await view(width, theme); await shot(`github-${width}-${theme}`); }
  await gotoProject(arc);
  for (const [width, theme] of [[1440, 'light'], [420, 'dark']]) { await view(width, theme); await shot(`arc-${width}-${theme}`); }
  await gotoProject(gh); await view(1440, 'light');
  if (ROUND) { check(`round ${ROUND} screenshots captured`, true); return; }

  // 1. Toggling never moves anything: scroll, order, focus, DOM nodes.
  const probe = (picker, attr) => `(() => { const list = document.querySelector('${picker} .skill-groups'); const names = [...list.querySelectorAll('[${attr}]')].map(i => i.getAttribute('${attr}')); return { top: list.scrollTop, page: [scrollY, document.querySelector('.body')?.scrollTop ?? 0].join(), names: names.join(), active: document.activeElement?.getAttribute('${attr}'), marked: names.filter(n => list.querySelector('[${attr}="' + n + '"]').__m).length, boxes: list.querySelectorAll('[${attr}]').length }; })()`;
  const stable = async (label, picker, attr, target, needsScroll = true) => {
    await ev(`(() => { const list = document.querySelector('${picker} .skill-groups'); list.querySelectorAll('[${attr}]').forEach(i => { i.__m = true; }); const box = list.querySelector('[${attr}="${target}"]'); box.scrollIntoView({ block: 'center' }); box.focus(); })()`);
    const before = await ev(probe(picker, attr)), saveWasOff = await ev(`document.querySelector('${picker} [data-action$="-save"]').disabled`);
    await ev(`document.querySelector('${picker} [${attr}="${target}"]').click()`); await kit.delay(150);
    const after = await ev(probe(picker, attr));
    check(`${label}: toggle keeps scroll, page position, order, focus and DOM nodes`, before.top === after.top && before.page === after.page && before.names === after.names && after.active === target && after.marked === after.boxes && (!needsScroll || before.top > 0), { before: { ...before, names: '…' }, after: { ...after, names: '…' } });
    check(`${label}: toggle marks the draft dirty (Save enabled, hint shown)`, saveWasOff === true && await ev(`!document.querySelector('${picker} [data-action$="-save"]').disabled && !document.querySelector('${picker} .pick-state').hidden`), await ev(`JSON.stringify([document.querySelector('${picker} [data-action$="-save"]')?.disabled, document.querySelector('${picker} .pick-state')?.hidden])`) + saveWasOff);
    await ev(`document.querySelector('${picker} [${attr}="${target}"]').click()`);
  };
  await stable('skills', '#skills-picker', 'data-skill-pick', 'perf-62');
  await ev(`document.querySelector('[data-action="skills-tab"][data-role="scout"]').click()`);
  await stable('skills (scout tab)', '#skills-picker', 'data-skill-pick', 'sql-06');
  await ev(`document.querySelector('[data-action="skills-tab"][data-role="all"]').click()`);
  await stable('mcp', '#mcp-picker', 'data-mcp-pick', 'fake-docs', false);

  // 2. Search: typing keeps the input (node + focus), filters; select all / clear respect the filter.
  const checked = () => ev(`[...document.querySelectorAll('#skills-picker [data-skill-pick]')].filter(i => i.checked).length`);
  const search = value => ev(`(() => { const i = document.querySelector('#skills-search'); i.focus(); i.value = '${value}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ev(`document.querySelector('#skills-search').__m = true`);
  await search('ios');
  const iosShown = await ev(`document.querySelectorAll('#skills-picker [data-skill-pick]').length`);
  check('search keeps the same focused input node and filters rows', iosShown > 3 && iosShown < 20 && await ev(`document.activeElement === document.querySelector('#skills-search') && document.querySelector('#skills-search').__m === true`), iosShown);
  await ev(`document.querySelector('#skills-picker > .pick-tools [data-action="skills-select"][data-mode="none"]').click()`);
  check('Clear with a filter unchecks the shown rows', await ev(`[...document.querySelectorAll('#skills-picker [data-skill-pick]')].every(i => !i.checked)`));
  await search('');
  check('Clear with a filter kept rows outside the filter (repo-swift still picked)', await ev(`document.querySelector('[data-skill-pick="repo-swift"]').checked && !document.querySelector('[data-skill-pick="repo-ios"]').checked`));
  await search('ios');
  await ev(`document.querySelector('#skills-picker > .pick-tools [data-action="skills-select"][data-mode="all"]').click()`);
  check('Select all with a filter checks every shown row', await checked() === iosShown);
  await search('');
  check('only filtered and previously picked rows are checked', await ev(`[...document.querySelectorAll('#skills-picker [data-skill-pick]')].filter(i => i.checked).every(i => /ios/.test(i.dataset.skillPick) || i.dataset.skillPick === 'repo-swift')`));
  const groups = await ev(`[...document.querySelectorAll('#skills-picker .skill-group')].map(g => g.dataset.source)`);
  check('skills are grouped by source with a count', groups.join() === 'repo,global' && await ev(`document.querySelector('.skill-group[data-source=global] .count').textContent`) === '78', groups);
  await ev(`document.querySelector('#skills-picker .skill-group[data-source="repo"] [data-action="skills-select"][data-mode="none"]').click()`);
  check('group Clear changes only that group', await ev(`[...document.querySelectorAll('#skills-picker .skill-group[data-source="repo"] [data-skill-pick]')].every(i => !i.checked) && [...document.querySelectorAll('#skills-picker .skill-group[data-source="global"] [data-skill-pick]')].some(i => i.checked)`));
  await ev(`document.querySelector('#skills-picker .skill-group[data-source="global"] [data-action="skills-select"][data-mode="none"]').click()`);
  check('Clear leaves no pick and the tab count updates', await checked() === 0 && await ev(`document.querySelector('[data-action="skills-tab"][data-role="all"] .count').textContent`) === '0');
  await ev(`document.querySelector('#skills-picker .skill-group[data-source="global"] [data-action="skills-select"][data-mode="all"]').click()`);
  check('group Select all checks the whole group (78) and tab count follows', await checked() === 78 && await ev(`document.querySelector('[data-action="skills-tab"][data-role="all"] .count').textContent`) === '78');
  await ev(`document.querySelector('[data-action="skills-tab"][data-role="worker"]').click()`);
  await ev(`document.querySelector('#skills-picker > .pick-tools [data-action="skills-select"][data-mode="none"]').click()`);
  check('on a profile tab, Clear leaves inherited (all-profiles) rows checked and locked', await ev(`[...document.querySelectorAll('#skills-picker [data-skill-pick]')].every(i => i.disabled === i.checked) && document.querySelectorAll('#skills-picker [data-skill-pick]:checked').length === 78`));
  await ev(`document.querySelector('[data-action="skills-tab"][data-role="all"]').click()`);
  await ev(`document.querySelector('[data-action="skills-save"]').click()`);
  await page.waitFor(`document.querySelector('[data-action="skills-save"]')?.disabled && document.querySelector('[data-action="skills-tab"][data-role="all"] .count').textContent === '78'`, 'skills saved');
  check('Save persists the bulk selection and clears the dirty hint', (await rpc({ action: 'settings-snapshot', id: gh })).values.skills.all.length === 78 && await ev(`document.querySelector('#skills-picker .pick-state').hidden`));

  // MCP bulk: only usable servers; filter respected.
  await ev(`document.querySelector('#mcp-picker [data-action="mcp-select"][data-mode="all"]').click()`);
  const mcpChecked = await ev(`[...document.querySelectorAll('#mcp-picker [data-mcp-pick]')].filter(i => i.checked).map(i => i.dataset.mcpPick).sort().join()`);
  check('MCP Select all enables only ready servers (not disabled or sign-in)', mcpChecked === 'fake-ci,fake-docs,fake-tracker,fake-xcode', mcpChecked);
  await ev(`(() => { const i = document.querySelector('#mcp-search'); i.focus(); i.value = 'tracker'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await ev(`document.querySelector('#mcp-picker [data-action="mcp-select"][data-mode="none"]').click()`);
  await ev(`(() => { const i = document.querySelector('#mcp-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('MCP Clear respects the search filter', await ev(`[...document.querySelectorAll('#mcp-picker [data-mcp-pick]')].filter(i => i.checked).map(i => i.dataset.mcpPick).sort().join()`) === 'fake-ci,fake-docs,fake-xcode');

  // 3. Every Settings section is reachable from the nav.
  await view(1440, 'light');
  const nav = await ev(`[...document.querySelectorAll('.set-nav a')].map(a => [a.getAttribute('href'), a.textContent.trim(), !!document.querySelector(a.getAttribute('href'))])`);
  check('Settings has a section nav with at least 8 live links', nav.length >= 8 && nav.every(([, , ok]) => ok), nav);
  const cards = await ev(`[...document.querySelectorAll('[data-panel=settings] .set-section')].map(s => s.id)`);
  check('every Settings section is in the nav', cards.length === nav.length && cards.every(id => nav.some(([href]) => href === '#' + id)), { cards, nav });
  for (const width of [1440, 420]) {
    await view(width, 'light');
    for (const [href] of nav) {
      await ev(`document.querySelector('.set-nav a[href="${href}"]').click()`); await kit.delay(450);
      const ok = await ev(`(() => { const r = document.querySelector('${href}').getBoundingClientRect(); return r.top < innerHeight - 40 && r.bottom > 0; })()`);
      check(`${width}px: nav link ${href} brings its section into view`, ok);
    }
  }

  // 4. No horizontal overflow at 420 px, both themes, both projects; long lists scroll inside their card.
  for (const theme of ['light', 'dark']) { await view(420, theme); check(`420px ${theme}: no horizontal overflow (GitHub project)`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1`), await ev(`[document.documentElement.scrollWidth, innerWidth]`)); }
  check('long skill list scrolls inside its card', await ev(`(() => { const l = document.querySelector('#skills-picker .skill-groups'); return l.scrollHeight > l.clientHeight && l.clientHeight < 700; })()`));
  await gotoProject(arc); await view(420, 'dark');
  check('420px dark: no horizontal overflow (Arc project)', await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
  check('Arc project shows Arcadia in setup', /Arcadia/.test(await ev(`document.querySelector('#owner-steps').innerText`)));

  // 5. Contrast >= 4.5 in light and dark across the Settings panel.
  await gotoProject(gh);
  for (const [theme, dark] of [['light', false], ['dark', true]]) {
    await view(1440, theme);
    const scan = await ev(`window.__scan(${dark}, document.querySelector('[data-panel=settings]'))`);
    check(`${theme}: Settings text contrast >= 4.5 (3 for large)${dark ? ' and no light surfaces' : ''}`, scan.low.length === 0 && (!dark || scan.bright.length === 0) && scan.texts > 40, scan);
    kit.result[`mutedColor_${theme}`] = await ev(`getComputedStyle(document.querySelector('#skills-summary')).color`);
  }
  await view(1440, 'light'); await shot('final-desktop-light'); await view(420, 'dark'); await shot('final-narrow-dark');
});
