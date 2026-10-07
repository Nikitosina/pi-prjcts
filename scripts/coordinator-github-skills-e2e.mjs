// Browser E2E with an isolated host, a local fake model and a fake gh. No real providers, no network.
// Failure cases recorded in coordinator-github-skills-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `coordinator-github-skills-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `gh-skills-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), plain = join(root, 'plain'), agentDir = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, plain, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');

// Fake GitHub: acme/mari (id 4242) with issue #95 and one comment.
const bare = join(root, 'remote.git'), fakeGh = join(root, 'fake-gh'), ghState = join(root, 'fake-gh-state.json'), ghCalls = join(root, 'fake-gh-calls.jsonl');
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`); chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: 'acme/mari', default_branch: 'main' }, pulls: [], issues: [{ number: 95, title: '[Chat] Generic flow for free-form first message', body: 'ISSUE-BODY-95 classify the first message', state: 'open', labels: ['chat'], assignees: [], comments: [{ body: 'COMMENT-95 please keep it simple' }] }] }));
writeFileSync(ghCalls, '');
const ghState$ = () => JSON.parse(readFileSync(ghState, 'utf8'));

// Skills: one in the repository (with a reference file) and 70 global ones, so the list must pass pi's 64-skill catalog cap.
const skillDir = join(workspace, '.agents', 'skills', 'e2e-grill');
mkdirSync(join(skillDir, 'references'), { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: e2e-grill\ndescription: Grill the owner about a plan until every branch is resolved.\n---\n\n# E2E grill\n\nSKILL-BODY-MARK. Read references/guide.md first.\n');
writeFileSync(join(skillDir, 'references', 'guide.md'), 'GUIDE-REFERENCE-MARK\n');
for (let i = 0; i < 70; i++) { const dir = join(agentDir, 'skills', `zz-global-${String(i).padStart(2, '0')}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: zz-global-${String(i).padStart(2, '0')}\ndescription: Generated global skill number ${i}.\n---\n\nGlobal ${i}\n`); }

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const text = value => chunk({ role: 'assistant', content: value }, null);
const tool = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null);
const end = reason => chunk({}, reason) + 'data: [DONE]\n\n';
function stream(res, parts) { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const part of parts) res.write(part); res.end(); }
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
// Scripted coordinator turns; each step sees the previous tool results.
const scripts = {
  'MARK-GHREAD': [['projects_github_issue_read', { number: 95 }], ['projects_github_issues', { query: 'generic' }]],
  'MARK-GHWRITE': [
    ['projects_github_issue_write', { action: 'create', title: 'Expand generic flow sources', body: 'Follow-up to #95.', labels: ['follow-up'] }],
    ['projects_github_issue_write', { action: 'comment', number: 95, body: 'Tracked in a follow-up.' }],
    ['projects_github_issue_write', { action: 'update', number: 95, labels: ['chat', 'decided'] }],
    ['projects_github_issue_write', { action: 'close', number: 95, reason: 'not_planned', comment: 'Closing as decided.' }],
    ['projects_github_issue_write', { action: 'reopen', number: 95 }],
  ],
  'MARK-GHDENY': [['projects_github_issue_read', { repository: 'evil/other', number: 1 }], ['projects_github_issue_read', { number: 999 }]],
  'MARK-SKILL': [['projects_skill_file', { skill: 'e2e-grill', path: 'references/guide.md' }], ['projects_skill_file', { skill: 'e2e-grill', path: '../../../../../../etc/hosts' }]],
};
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body), msgs = input.messages;
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const userText = contentText(msgs[lastUser]?.content);
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    result.calls.push({ marker, stage: results.length, tools: (input.tools ?? []).map(t => t.function?.name).filter(Boolean), user: userText.slice(0, 2000), results });
    const steps = scripts[marker] ?? [];
    if (results.length < steps.length) return stream(res, [tool(...steps[results.length]), end('tool_calls')]);
    return stream(res, [text(`Done ${marker}.`), end('stop')]);
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
// A private HOME keeps the owner's own ~/.agents skills out of the list.
const userHome = join(root, 'userhome'); mkdirSync(userHome, { mode: 0o700 });
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: ghCalls };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
git(workspace, 'remote', 'add', 'origin', 'https://github.com/acme/mari.git'); git(workspace, 'config', 'remote.origin.pushurl', bare);
writeFileSync(join(workspace, 'README.md'), 'base\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'c1'); git(workspace, 'push', '-q', 'origin', 'main');
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'wx', mode: 0o600 });
const host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
let hostEnded = false;
const hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 60000 }, res => {
      res.setEncoding('utf8');
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = 600) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error(description);
}

let chrome, cdpEnded = false, cdpId = 0, buffer = ''; const pending = new Map();
function startChrome() {
  const clog = createWriteStream(join(artifacts, 'chrome.log'), { flags: 'wx', mode: 0o600 });
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${join(root, 'chrome-profile')}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  chrome.stdout.pipe(clog); chrome.stderr.pipe(clog);
  chrome.once('exit', () => { cdpEnded = true; });
  chrome.stdio[4].on('data', part => {
    buffer += part.toString(); let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!text) continue;
      const msg = JSON.parse(text);
      if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } }
      else if (msg.method === 'Runtime.exceptionThrown') result.errors.push(redact(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
      else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') result.errors.push(redact(msg.params.entry.text));
      else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) { const u = new URL(msg.params.response.url); result.httpErrors.push({ url: u.origin + u.pathname, status: msg.params.response.status }); }
    }
  });
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const key = ++cdpId; const timer = setTimeout(() => { pending.delete(key); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression, session) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; }
async function shot(name, session) { const image = await send('Page.captureScreenshot', { format: 'png' }, session); writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); }
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expression, session)) return; await delay(250); }
  throw Error(`Timed out waiting for ${label}`);
}

const settle = async (id, job) => eventually(async () => { const view = await rpc({ action: 'show', id }); const found = view.jobs.find(j => j.id === job.id); return ['done', 'failed', 'interrupted'].includes(found?.state) && found; }, 'Job did not settle');
const turn = marker => result.calls.filter(call => call.marker === marker);
const key = async (s, key, code, vk, extra = {}) => { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, ...extra }, s); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }, s); };
const typeText = (s, value) => send('Input.insertText', { text: value }, s);
const menu = s => evaluate(`(() => { const m = document.querySelector('#skill-menu'); return { open: !!m && !m.hidden, names: [...m.querySelectorAll('.skill-option .skill-name')].map(n => n.innerText), active: m.querySelector('.skill-option.active .skill-name')?.innerText ?? null, value: document.querySelector('#compose textarea').value }; })()`, s);
try {
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  const setup = async (name, cwd) => {
    const project = await rpc({ action: 'create', requestId: randomUUID(), name, cwd, objective: 'Disposable GitHub and skills fixture', model: 'fake/fake-model' });
    const settings = await rpc({ action: 'settings-snapshot', id: project.id });
    await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    return project.id;
  };
  const id = await setup('Mari GH', workspace), plainId = await setup('No GitHub', plain);
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const second = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'github-quick-authorize', id, confirm: id, expectedRevision: second.githubRevision });
  const ask = async (project, value) => { const job = await rpc({ action: 'message', id: project, text: value }); const done = await settle(project, job); if (done.state !== 'done') throw Error(`${value} failed: ${done.error}`); };

  // Tools are offered only with a GitHub authorization (failure 5).
  await ask(plainId, 'MARK-NOGH hello');
  await ask(id, 'MARK-GHREAD read #95');
  const offered = turn('MARK-GHREAD')[0].tools, plainTools = turn('MARK-NOGH')[0].tools;
  const ghNames = ['projects_github_issue_read', 'projects_github_issues', 'projects_github_issue_write'];
  if (!ghNames.every(n => offered.includes(n)) || plainTools.some(n => n.startsWith('projects_github')) || !offered.includes('projects_skill_file') || !plainTools.includes('projects_skill_file')) throw Error('Tool offer wrong: ' + JSON.stringify({ offered, plainTools }));
  result.checks.push('G5 GitHub tools are offered only to a coordinator whose project has a GitHub authorization; skill file reads always');

  // Reads (failures 1, 2).
  const [issueRead, search] = turn('MARK-GHREAD').at(-1).results;
  const issue = JSON.parse(JSON.parse(issueRead)?.[0]?.text ?? issueRead);
  if (issue.title !== '[Chat] Generic flow for free-form first message' || !issue.body.includes('ISSUE-BODY-95') || issue.labels[0] !== 'chat' || issue.commentItems?.[0]?.body !== 'COMMENT-95 please keep it simple' || issue.kind !== 'issue') throw Error('Issue read wrong: ' + issueRead.slice(0, 600));
  result.checks.push('G1 coordinator reads an issue with body, labels and comments');
  const found = JSON.parse(search);
  if (found.total !== 1 || found.items[0].number !== 95) throw Error('Search wrong: ' + search.slice(0, 400));
  const searchCall = readFileSync(ghCalls, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(c => c.target.startsWith('search/issues'));
  if (!decodeURIComponent(searchCall.target).includes('repo:acme/mari')) throw Error('Search not scoped to the repository');
  result.checks.push('G2 coordinator searches issues, scoped to the authorized repository');

  // Writes (failure 3).
  await ask(id, 'MARK-GHWRITE file the follow-up');
  const writes = turn('MARK-GHWRITE').at(-1).results.map(r => JSON.parse(r));
  const state = ghState$(), created = state.issues.find(i => i.title === 'Expand generic flow sources'), ninetyFive = state.issues.find(i => i.number === 95);
  if (!created || created.labels[0] !== 'follow-up' || writes[0].action !== 'created' || !writes[0].url?.includes('/issues/' + created.number)) throw Error('Create wrong: ' + JSON.stringify({ created, w: writes[0] }));
  if (ninetyFive.comments.map(c => c.body).join('|') !== 'COMMENT-95 please keep it simple|Tracked in a follow-up.|Closing as decided.') throw Error('Comments wrong: ' + JSON.stringify(ninetyFive.comments));
  if (JSON.stringify(ninetyFive.labels) !== '["chat","decided"]' || writes[3].state !== 'closed' || writes[3].stateReason !== 'not_planned' || writes[4].state !== 'open' || ninetyFive.state !== 'open') throw Error('Update/close/reopen wrong: ' + JSON.stringify({ ninetyFive, writes }));
  result.checks.push('G3 coordinator creates an issue (URL returned), comments, edits labels, closes as not planned with a comment, and reopens');

  // Denials and readable errors (failures 4, 6).
  await ask(id, 'MARK-GHDENY try other repo');
  const [deny, missing] = turn('MARK-GHDENY').at(-1).results;
  if (!/evil\/other is not an authorized repository; authorized: acme\/mari/.test(deny)) throw Error('Unauthorized repo not refused: ' + deny);
  if (readFileSync(ghCalls, 'utf8').includes('evil/other')) throw Error('gh was called for an unauthorized repository');
  if (!/Not Found \(HTTP 404\)/.test(missing)) throw Error('404 not readable: ' + missing);
  result.checks.push('G4/G6 an unauthorized repository is refused before gh runs; a gh 404 reaches the coordinator readably');

  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#title')?.innerText === 'Mari GH' && document.querySelector('#messages').innerText.includes('Done MARK-GHDENY')`, s, 'project loaded');

  // Tool rows read as actions (failure 7).
  const labels = await evaluate(`[...document.querySelectorAll('#messages .tool-label')].map(n => n.innerText)`, s);
  for (const want of ['Read GitHub #95', 'Searched GitHub for “generic”', 'Created GitHub issue “Expand generic flow sources”', 'Commented on GitHub #95', 'Updated GitHub #95', 'Closed GitHub #95', 'Reopened GitHub #95']) if (!labels.includes(want)) throw Error(`Missing tool label ${want}: ` + JSON.stringify(labels));
  if (labels.some(l => /projects_/.test(l))) throw Error('Raw tool name shown');
  result.checks.push('G7 GitHub tool rows show human labels with issue numbers');
  await shot('01-github-chain', s);

  // Global "/" shortcut still focuses the composer without opening the picker (failure 10).
  await evaluate(`document.activeElement?.blur()`, s);
  await key(s, '/', 'Slash', 191, { text: '/' });
  const shortcut = await evaluate(`({ focused: document.activeElement === document.querySelector('#compose textarea'), value: document.querySelector('#compose textarea').value })`, s);
  if (!shortcut.focused || shortcut.value !== '' || (await menu(s)).open) throw Error('Global / shortcut changed: ' + JSON.stringify(shortcut));
  result.checks.push('S10 the global / shortcut still focuses an empty composer');

  // "/" opens the picker with every skill, repository first (failures 8, 15).
  await typeText(s, '/');
  await waitFor(`!document.querySelector('#skill-menu').hidden && document.querySelectorAll('#skill-menu .skill-option').length > 0`, s, 'skill menu');
  const all = await menu(s);
  if (all.names[0] !== '/e2e-grill' || all.names.filter(n => n.startsWith('/zz-global-')).length !== 59 || all.active !== '/e2e-grill') throw Error('Skill list wrong: ' + JSON.stringify({ count: all.names.length, first: all.names.slice(0, 3), active: all.active }));
  const catalog = await rpc({ action: 'coordinator-skills', id });
  if (catalog.skills.filter(k => k.name.startsWith('zz-global-')).length !== 70 || catalog.skills[0].source !== 'repo') throw Error('Catalog wrong');
  result.checks.push('S8/S15 typing / lists skills (repository first); the catalog holds all 71 test skills past the 64 cap');
  await shot('02-skill-menu', s);

  // Filter, arrow keys, Esc; Enter picks instead of sending (failures 8, 9).
  await typeText(s, 'zz-global-0');
  await waitFor(`document.querySelectorAll('#skill-menu .skill-option').length === 10`, s, 'filtered menu');
  await key(s, 'ArrowDown', 'ArrowDown', 40); await key(s, 'ArrowDown', 'ArrowDown', 40); await key(s, 'ArrowUp', 'ArrowUp', 38);
  if ((await menu(s)).active !== '/zz-global-01') throw Error('Arrow keys do not move the selection: ' + JSON.stringify(await menu(s)));
  await key(s, 'Escape', 'Escape', 27);
  if ((await menu(s)).open) throw Error('Esc does not close the picker');
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
  await typeText(s, '/grill');
  await waitFor(`document.querySelector('#skill-menu .skill-option.active .skill-name')?.innerText === '/e2e-grill'`, s, 'grill filtered by name');
  const jobsBefore = (await rpc({ action: 'show', id })).jobs.length;
  await key(s, 'Enter', 'Enter', 13);
  const picked = await menu(s);
  if (picked.value !== '/skill:e2e-grill ' || picked.open) throw Error('Enter did not pick: ' + JSON.stringify(picked));
  await delay(300);
  if ((await rpc({ action: 'show', id })).jobs.length !== jobsBefore) throw Error('Enter in the picker sent a message');
  result.checks.push('S8/S9 the picker filters, ↑/↓ move, Esc closes, Enter inserts /skill:<name> without sending');

  // "/" mid-text does not open the picker (failure 10).
  await typeText(s, 'and then /');
  if ((await menu(s)).open) throw Error('Picker opened mid-text');
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = '/skill:e2e-grill MARK-SKILL focus on flows'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
  if ((await menu(s)).open) throw Error('Picker open after the command has args');
  result.checks.push('S10 a slash after other text never opens the picker');

  // Send: the model gets the expanded skill; the transcript shows a chip (failures 11, 13, 14).
  await key(s, 'Enter', 'Enter', 13, { text: '\r' });
  await waitFor(`document.querySelector('#messages').innerText.includes('Done MARK-SKILL')`, s, 'skill turn done');
  const skillCall = turn('MARK-SKILL')[0];
  if (!skillCall.user.startsWith('<skill name="e2e-grill" location="') || !skillCall.user.includes('SKILL-BODY-MARK') || skillCall.user.includes('description: Grill') || !skillCall.user.endsWith('</skill>\n\nMARK-SKILL focus on flows')) throw Error('Skill not expanded: ' + skillCall.user);
  const [guide, escape] = turn('MARK-SKILL').at(-1).results;
  if (!guide.includes('GUIDE-REFERENCE-MARK') || !/escapes the skill directory/.test(escape)) throw Error('Skill file reads wrong: ' + JSON.stringify({ guide, escape }));
  result.checks.push('S11/S14 the model receives the pi skill block (no frontmatter) plus args, and reads a reference file but nothing outside the skill');
  const chip = await evaluate(`(() => { const you = [...document.querySelectorAll('#messages .msg.you')].at(-1); return { chip: you.querySelector('.skill-chip')?.innerText, text: you.querySelector('.text').innerText }; })()`, s);
  if (chip.chip !== 'e2e-grill' || !chip.text.includes('MARK-SKILL focus on flows') || chip.text.includes('SKILL-BODY-MARK')) throw Error('Skill chip wrong: ' + JSON.stringify(chip));
  const job = (await rpc({ action: 'show', id })).jobs.at(-1);
  if (job.text !== '/skill:e2e-grill MARK-SKILL focus on flows') throw Error('Job text is not what the owner typed');
  result.checks.push('S13 the transcript shows a skill chip and the args, not the skill body');
  await shot('03-skill-chip', s);

  // Unknown skill is refused and the draft kept (failure 12).
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = '/skill:nope-missing do it'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#compose').requestSubmit(); })()`, s);
  await waitFor(`/Unknown skill \\/skill:nope-missing/.test(document.querySelector('#error')?.innerText ?? '')`, s, 'unknown skill error');
  if (await evaluate(`document.querySelector('#compose textarea').value`, s) !== '/skill:nope-missing do it') throw Error('Draft lost after unknown skill');
  result.checks.push('S12 an unknown /skill: is refused with a clear error and the draft is kept');
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
  await typeText(s, '/e2e');
  await waitFor(`!document.querySelector('#skill-menu').hidden`, s, 'menu for screenshot');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(300);
  const narrow = await evaluate(`(() => { const m = document.querySelector('#skill-menu').getBoundingClientRect(); return { left: m.left, right: m.right, width: innerWidth, scroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`, s);
  if (narrow.left < 0 || narrow.right > narrow.width || narrow.scroll) throw Error('Picker overflows on mobile: ' + JSON.stringify(narrow));
  await shot('04-skill-menu-mobile', s);
  result.checks.push('S8 the picker fits a 390 px screen');
  // The host error from the unknown skill is expected; nothing else may be.
  result.httpErrors = result.httpErrors.filter(e => e.status !== 400 && e.status !== 500 || !e.url.endsWith('/api'));
  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { if (!hostEnded) { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(10000)]); } } catch { host.kill('SIGKILL'); }
  if (!hostEnded) host.kill('SIGKILL');
  model.closeAllConnections(); model.close(); log.end(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
