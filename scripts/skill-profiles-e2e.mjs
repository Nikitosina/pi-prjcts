// Browser E2E: skill profiles (Settings picker, per-role index, on-demand reading restricted to the role set). Isolated host, local fake model; no real providers, no network.
// Failure cases recorded in skill-profiles-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `skill-profiles-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `skill-profiles-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); };



const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = value => chunk({ role: 'assistant', content: value }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
// Skills: two repository (.pi/skills), four global (agent dir). Bodies carry BODY-<name> so prompts can be checked for bodies.
const skill = (dir, name, description, extra = '') => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBODY-${name}\n`); if (extra) writeFileSync(join(dir, 'ref.md'), extra); };
skill(join(workspace, '.pi', 'skills', 'repo-one'), 'repo-one', 'Repository skill one for this project.');
skill(join(workspace, '.pi', 'skills', 'repo-two'), 'repo-two', 'Repository skill two for this project.');
for (const name of ['glob-alpha', 'glob-beta', 'glob-gamma', 'glob-delta']) skill(join(agentDir, 'skills', name), name, `Global ${name} skill of the owner.`, `REF-${name}`);
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
    const role = tools.includes('projects_delegate') ? 'coordinator' : tools.includes('code_read') ? 'scout' : tools.includes('bash') ? 'worker' : 'other';
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), userText = contentText(msgs[lastUser]?.content);
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    const system = contentText(msgs.find(m => m.role === 'system' || m.role === 'developer')?.content);
    result.calls.push({ at: Date.now(), role, user: userText.slice(0, 600), results: results.map(r => r.slice(0, 3000)), tools, system });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const read = /SKILL-READ (\S+)(?: (\S+))?/.exec(userText);
    if (role === 'coordinator') {
      if (userText.startsWith('[Durable work')) return res.end(say('Noted report.'));
      const w = /MARK-W (.+)$/m.exec(userText)?.[1], s = /MARK-S (.+)$/m.exec(userText)?.[1];
      if (w && results.length === 0) return res.end(call('projects_delegate', { role: 'worker', task: `W-TASK ${w}` }));
      if (s && results.length === 0) return res.end(call('projects_delegate', { role: 'scout', task: `S-TASK ${s}` }));
      if (read && results.length === 0) return res.end(call('projects_skill_file', { skill: read[1], ...(read[2] ? { path: read[2] } : {}) }));
      return res.end(say('Noted.'));
    }
    if (role === 'worker' && /W-TASK child/.test(userText) && results.length === 0) return res.end(call('projects_delegate_child', { role: 'worker', task: 'CHILD-W SKILL-READ glob-alpha' }));
    if (read && results.length === 0) return res.end(call('projects_skill_file', { skill: read[1], ...(read[2] ? { path: read[2] } : {}) }));
    res.end(say(`DONE ${role}`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
writeFileSync(join(workspace, 'README.md'), 'base\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'c1');

let host, hostEnded = false, hostExit, hostRun = 0;
function startHost() {
  const log = createWriteStream(join(artifacts, `host-${++hostRun}.log`), { flags: 'wx', mode: 0o600 });
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log); host.stderr.pipe(log);
  hostEnded = false; hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
}
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
const waitHost = () => eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
async function stopHost() { if (!hostEnded) { try { await rpc({ action: 'shutdown' }); } catch {} await Promise.race([hostExit, delay(15000)]); } if (!hostEnded) host.kill('SIGKILL'); }

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
async function shot(name, session) { const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, session); writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); }
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expression, session)) return; await delay(250); }
  throw Error(`Timed out waiting for ${label}`);
}

startHost();
try {
  await waitHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Skills', cwd: workspace, objective: 'Disposable skill-profiles fixture', model: 'fake/fake-model' });
  const id = project.id;
  let settings = await rpc({ action: 'settings-snapshot', id });
  check('S3/S1 a project without saved profiles reports skills = null (default)', settings.values.skills === null, settings.values.skills);
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { workerCap: 3, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const plan = async () => (await rpc({ action: 'plan-snapshot', id })).work;
  const settleAll = () => eventually(async () => { const view = await rpc({ action: 'show', id }); return !view.chats.some(c => c.busy) && !(await plan()).some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 1200);
  const ask = async text => { await rpc({ action: 'message', id, text }); await delay(300); await settleAll(); };
  const index = system => [...system.matchAll(/^- ([\w-]+): (?:Repository|Global) /gm)].map(m => m[1]).sort();
  const bodies = system => /BODY-/.test(system);
  const lastCall = (role, marker) => result.calls.findLast(c => c.role === role && c.user.includes(marker));
  const toolResult = (role, marker) => result.calls.findLast(c => c.role === role && c.user.includes(marker) && c.results.length === 1)?.results[0] ?? '';

  // Defaults: repository skills only, names and descriptions only.
  await ask('MARK-W pre');
  await ask('MARK-S pre');
  const coord0 = lastCall('coordinator', 'MARK-W pre'), worker0 = lastCall('worker', 'W-TASK pre'), scout0 = lastCall('scout', 'S-TASK pre');
  for (const [role, call0] of [['coordinator', coord0], ['worker', worker0], ['scout', scout0]]) {
    check(`S1/S2/S8/S9 default ${role} index lists only the repository skills, without bodies`, JSON.stringify(index(call0.system)) === '["repo-one","repo-two"]' && !bodies(call0.system) && /Skills for your role/.test(call0.system), { index: index(call0.system), body: bodies(call0.system) });
  }
  check('S10 no worker prompt carries the old "Configured Pi skills" list', !result.calls.some(c => /Configured Pi skills/.test(c.system)));
  check('S13/S21 workers and scouts get projects_skill_file and no projects_skill_read', [worker0, scout0].every(c => c.tools.includes('projects_skill_file') && !c.tools.includes('projects_skill_read')), [worker0.tools, scout0.tools]);
  const preThread = (await plan()).find(w => w.text.includes('W-TASK pre')).threadId;

  // Settings picker in the browser.
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'settings');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelectorAll('#skills-picker [data-skill-pick]').length === 6`, s, 'skills picker');
  const groups = await evaluate(`[...document.querySelectorAll('#skills-picker fieldset.skill-group')].map(g => [g.dataset.source, [...g.querySelectorAll('[data-skill-pick]')].map(i => [i.dataset.skillPick, i.checked])])`, s);
  result.groups = groups;
  const groupOf = name => groups.find(g => g[1].some(([n]) => n === name))?.[0];
  check('S17 the picker lists all six loaded skills grouped by source (repository vs global)', groupOf('repo-one') === groupOf('repo-two') && groupOf('glob-alpha') === groupOf('glob-delta') && groupOf('repo-one') !== groupOf('glob-alpha') && groups.length === 2, groups);
  check('S1 the default "All profiles" tab has exactly the repository skills checked', groups.flatMap(g => g[1]).filter(([, on]) => on).map(([n]) => n).sort().join() === 'repo-one,repo-two', groups);
  await evaluate(`(() => { const i = document.querySelector('#skills-search'); i.value = 'gamma'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
  await waitFor(`document.querySelectorAll('#skills-picker [data-skill-pick]').length === 1`, s, 'search filter');
  check('S17 search narrows the list', await evaluate(`document.querySelector('#skills-picker [data-skill-pick]').dataset.skillPick`, s) === 'glob-gamma');
  await evaluate(`(() => { const i = document.querySelector('#skills-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
  await waitFor(`document.querySelectorAll('#skills-picker [data-skill-pick]').length === 6`, s, 'search cleared');
  const pick = async (role, name) => {
    await evaluate(`document.querySelector('[data-action="skills-tab"][data-role="${role}"]').click()`, s);
    await waitFor(`document.querySelector('[data-action="skills-tab"][data-role="${role}"]').classList.contains('on')`, s, `${role} tab`);
    await evaluate(`document.querySelector('[data-skill-pick="${name}"]').click()`, s);
  };
  await pick('all', 'repo-two');       // drop repo-two from every profile
  await pick('worker', 'glob-alpha');
  await pick('scout', 'glob-beta');
  await pick('coordinator', 'glob-gamma');
  const inherited = await evaluate(`(() => { const i = document.querySelector('[data-skill-pick="repo-one"]'); return { checked: i.checked, disabled: i.disabled }; })()`, s);
  check('S5 "All profiles" skills show as inherited (checked, locked) in a role tab', inherited.checked && inherited.disabled, inherited);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(300);
  await evaluate(`document.querySelector('#skills-card').scrollIntoView()`, s);
  const narrow = await evaluate(`(() => { const c = document.querySelector('#skills-card').getBoundingClientRect(); return { right: c.right, width: innerWidth, scroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`, s);
  await shot('01-skills-picker-390', s);
  check('S20 the picker fits 390 px without horizontal scroll', !narrow.scroll && narrow.right <= narrow.width + 1, narrow);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await evaluate(`document.querySelector('[data-action="skills-save"]').click()`, s);
  await eventually(async () => (await rpc({ action: 'settings-snapshot', id })).values.skills !== null, 'skills not saved', 100);
  settings = await rpc({ action: 'settings-snapshot', id });
  const want = { all: ['repo-one'], coordinator: ['glob-gamma'], worker: ['glob-alpha'], scout: ['glob-beta'], reviewer: [] };
  check('S18 saving the picker persists the profiles', JSON.stringify(settings.values.skills) === JSON.stringify(want), settings.values.skills);
  await send('Page.reload', {}, s);
  await waitFor(`document.querySelectorAll('#skills-picker [data-skill-pick]').length === 6`, s, 'picker after reload');
  await evaluate(`document.querySelector('[data-action="skills-tab"][data-role="worker"]').click()`, s);
  await delay(200);
  const afterReload = await evaluate(`[...document.querySelectorAll('#skills-picker [data-skill-pick]')].filter(i => i.checked).map(i => i.dataset.skillPick).sort().join()`, s);
  check('S18 after a reload the worker tab shows repo-one (inherited) and glob-alpha', afterReload === 'glob-alpha,repo-one', afterReload);
  await shot('02-skills-picker-worker', s);

  // Effective sets per role, including a child worker.
  await ask('MARK-W child');
  await ask('MARK-S post SKILL-READ glob-alpha');
  await ask('MARK-S post2 SKILL-READ glob-beta');
  await ask('MARK-W post SKILL-READ glob-alpha ../../../etc/hosts');
  const coord1 = lastCall('coordinator', 'MARK-W child'), parent1 = lastCall('worker', 'W-TASK child'), child1 = lastCall('worker', 'CHILD-W'), scout1 = lastCall('scout', 'S-TASK post');
  result.indexes = { coordinator: index(coord1.system), worker: index(parent1.system), child: index(child1?.system ?? ''), scout: index(scout1.system) };
  check('S4/S5/S8 coordinator index = all + coordinator additions', result.indexes.coordinator.join() === 'glob-gamma,repo-one' && !bodies(coord1.system), result.indexes);
  check('S4/S5 worker index = all + worker additions', result.indexes.worker.join() === 'glob-alpha,repo-one' && !bodies(parent1.system), result.indexes);
  check('S6 a child worker gets the worker set', result.indexes.child.join() === 'glob-alpha,repo-one', result.indexes);
  check('S4 scout index = all + scout additions', result.indexes.scout.join() === 'glob-beta,repo-one', result.indexes);
  const childRead = result.calls.findLast(c => c.role === 'worker' && c.user.includes('CHILD-W') && c.results.length === 1)?.results[0] ?? '';
  check('S6/S13 the child worker reads its role skill on demand', childRead.includes('BODY-glob-alpha'), childRead.slice(0, 300));
  const scoutDenied = toolResult('scout', 'S-TASK post SKILL-READ'), scoutAllowed = toolResult('scout', 'S-TASK post2');
  check('S11 a scout cannot read a worker-only skill', /not in your role's skill set/.test(scoutDenied) && !scoutDenied.includes('BODY-'), scoutDenied.slice(0, 300));
  check('S13 a scout reads its own skill', scoutAllowed.includes('BODY-glob-beta'), scoutAllowed.slice(0, 300));
  const escape = toolResult('worker', 'W-TASK post');
  check('S12 a path outside the skill directory is refused', !/localhost/.test(escape) && /outside|escape|not allowed|invalid|within/i.test(escape), escape.slice(0, 300));

  // S15: a worker thread created before the settings change still accepts follow-ups.
  await rpc({ action: 'thread-send', id, threadId: preThread, text: 'FOLLOW SKILL-READ glob-alpha ref.md', requestId: randomUUID() });
  await delay(300); await settleAll();
  const follow = (await plan()).filter(w => w.threadId === preThread).at(-1);
  const followRead = result.calls.findLast(c => c.role === 'worker' && c.user.includes('FOLLOW SKILL-READ') && c.results.length === 1)?.results[0] ?? '';
  check('S15 a thread created before the change takes a follow-up and reads a reference of its role skill', follow.text.includes('FOLLOW') && follow.status === 'completed' && followRead.includes('REF-glob-alpha'), { follow, followRead: followRead.slice(0, 200) });

  // S14: owner-invoked skills stay readable by the coordinator.
  await ask('SKILL-READ glob-delta');
  const before = toolResult('coordinator', 'SKILL-READ glob-delta');
  check('S11 the coordinator cannot read a skill outside its profile', /not in your role's skill set/.test(before), before.slice(0, 200));
  await ask('/skill:glob-delta SKILL-READ glob-delta ref.md');
  const after = result.calls.findLast(c => c.role === 'coordinator' && c.user.includes('BODY-glob-delta') && c.results.length === 1)?.results[0] ?? '';
  check('S14 after the owner invoked /skill:glob-delta the coordinator reads its reference', after.includes('REF-glob-delta'), after.slice(0, 200));

  // S19: the owner / picker still lists everything.
  const catalog = await rpc({ action: 'coordinator-skills', id });
  const names = (catalog.skills ?? catalog).map(skill => skill.name).sort();
  check('S19 the owner skill catalog still lists every loaded skill', names.join() === 'glob-alpha,glob-beta,glob-delta,glob-gamma,repo-one,repo-two', names);
  await send('Page.navigate', { url: new URL(launch.toString().replace('tab=settings', 'tab=coordinator')).toString() }, s);
  await waitFor(`!!document.querySelector('#compose textarea') && document.querySelector('#messages')?.innerText.includes('Noted')`, s, 'composer');
  await delay(500);
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = ''; t.focus(); })()`, s);
  await send('Input.insertText', { text: '/' }, s);
  await waitFor(`!document.querySelector('#skill-menu').hidden && document.querySelectorAll('#skill-menu .skill-option').length > 0`, s, 'skill menu');
  const menuNames = await evaluate(`[...document.querySelectorAll('#skill-menu .skill-option .skill-name')].map(n => n.innerText)`, s);
  check('S19 the composer / menu lists all six skills', ['repo-one', 'repo-two', 'glob-alpha', 'glob-beta', 'glob-gamma', 'glob-delta'].every(n => menuNames.includes(`/${n}`)), menuNames);
  await shot('03-composer-menu', s);

  // S16/S21: validation and the retired grant RPCs.
  settings = await rpc({ action: 'settings-snapshot', id });
  const rejects = async input => { try { await rpc(input); return false; } catch { return true; } };
  check('S16 settings-update rejects an unknown role', await rejects({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { skills: { ...want, admin: [] } } }));
  check('S16 settings-update rejects non-string names', await rejects({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { skills: { ...want, worker: [42] } } }));
  check('S21 the old grant RPC is gone', await rejects({ action: 'worker-skills-grant-set', id, confirm: id }));
  check('S16 a rejected update leaves the saved profiles alone', JSON.stringify((await rpc({ action: 'settings-snapshot', id })).values.skills) === JSON.stringify(want));
  // S7: a saved name that no longer loads is ignored.
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { skills: { ...want, scout: ['glob-beta', 'gone-skill'] } } });
  await ask('MARK-S stale');
  const stale = lastCall('scout', 'S-TASK stale');
  check('S7 a stale saved name is ignored', stale && index(stale.system).join() === 'glob-beta,repo-one', stale && index(stale.system));
  settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { skills: null } });
  check('S18 reset returns to the default', (await rpc({ action: 'settings-snapshot', id })).values.skills === null);
  await ask('MARK-W reset');
  check('S1 after reset the worker index is the repository skills again', index(lastCall('worker', 'W-TASK reset').system).join() === 'repo-one,repo-two');

  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api'));
  check('no browser errors', !result.errors.length && !result.httpErrors.length, result.errors.concat(result.httpErrors));
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  await stopHost().catch(() => host.kill('SIGKILL'));
  model.closeAllConnections(); model.close(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks.length, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
