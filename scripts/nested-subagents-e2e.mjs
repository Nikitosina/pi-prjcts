// Browser E2E for nested subagents (one level): isolated host, local fake model. No real providers, no network.
// Failure cases recorded in nested-subagents-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `nested-subagents-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `nested-subagents-${randomUUID()}`);
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
const held = [];
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
    const role = tools.includes('projects_delegate') ? 'coordinator' : tools.includes('projects_delegate_child') ? 'parent' : tools.includes('projects_review_verdict') ? 'reviewer' : tools.includes('code_read') ? 'scout' : tools.includes('bash') ? 'worker' : 'other';
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), userText = contentText(msgs[lastUser]?.content);
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    result.calls.push({ at: Date.now(), role, user: userText.slice(0, 1500), results: results.map(r => r.slice(0, 4000)), tools });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (role === 'coordinator') {
      const owner = !userText.startsWith('[Durable work') && !userText.startsWith('[Owner-local event'), tag = owner && /MARK-NEST-(\w+)/.exec(userText)?.[1];
      if (tag && results.length === 0) return res.end(call('projects_delegate', { role: 'worker', task: `PARENT-TASK-${tag} do the job, use children` }));
      if (owner && /MARK-WORKERS/.test(userText) && results.length === 0) return res.end(call('projects_workers', { limit: 100 }));
      return res.end(say(userText.startsWith('[Durable work') ? `COORD-NOTED ${/PARENT-CONCLUSION \S+/.exec(userText)?.[0] ?? 'other'}` : 'Noted.'));
    }
    if (role === 'parent') {
      const child = /^\[Child work ([0-9a-f-]+)/.exec(userText);
      if (child) return res.end(say(`PARENT-CONCLUSION ${child[1]}`));
      const tag = /PARENT-TASK-(\w+)/.exec(userText)?.[1];
      if (tag === 'A' && results.length === 0) return res.end(call('projects_delegate_child', { role: 'scout', task: 'CHILD-SCOUT-A read the README' }));
      if (tag === 'A' && results.length === 1) return res.end(call('projects_delegate_child', { role: 'worker', task: 'CHILD-WORKER-A write child.txt' }));
      if (tag === 'STOP' && results.length === 0) return res.end(call('projects_delegate_child', { role: 'worker', task: 'CHILD-SLOW-STOP long job' }));
      if (tag === 'CAP' && results.length < 5) return res.end(call('projects_delegate_child', { role: 'scout', task: `CHILD-CAP-${results.length + 1} look` }));
      return res.end(say(`Delegated; waiting for children (${tag}).`));
    }
    if (role === 'worker') {
      if (/CHILD-SLOW/.test(userText) && results.length === 0) { held.push(res); return; }
      if (/CHILD-WORKER-A/.test(userText) && results.length === 0) return res.end(call('bash', { command: "printf child > child.txt && pwd" }));
      return res.end(say(`CHILD-RESULT worker ${results[0]?.trim().split('\n').at(-1) ?? ''}`));
    }
    if (role === 'scout') return res.end(say(`CHILD-RESULT scout ${/CHILD-[\w-]+/.exec(userText)?.[0] ?? ''}`));
    res.end(say('Done.'));
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
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Nested', cwd: workspace, objective: 'Disposable nested-subagents fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const ops = await rpc({ action: 'chat-create', id, title: 'Ops' });
  const plan = async () => (await rpc({ action: 'plan-snapshot', id })).work;
  const settleAll = () => eventually(async () => { const view = await rpc({ action: 'show', id, chatId: ops.id }); return !view.chats.some(c => c.busy) && !(await plan()).some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 900);
  const ask = async (text, chatId) => { await rpc({ action: 'message', id, text, ...(chatId ? { chatId } : {}) }); await delay(300); await settleAll(); };
  const byText = (work, marker) => work.filter(w => w.text.includes(marker));

  // Scenario A, from the non-Main chat Ops: the parent delegates a scout child and a worker child.
  await ask('MARK-NEST-A please', ops.id);
  let work = await plan();
  const [parentA] = byText(work, 'PARENT-TASK-A'), [scoutA] = byText(work, 'CHILD-SCOUT-A'), [workerA] = byText(work, 'CHILD-WORKER-A');
  check('setup: the coordinator delegated parent A, which delegated a scout child and a worker child', parentA && scoutA && workerA && parentA.status === 'completed' && scoutA.status === 'completed' && workerA.status === 'completed', work);
  check('N5/N13 children carry the parent link; the parent and its follow-ups carry none', scoutA.parentThreadId === parentA.threadId && workerA.parentThreadId === parentA.threadId && work.filter(w => w.threadId === parentA.threadId).every(w => w.parentThreadId === null), work);
  const parentCalls = result.calls.filter(c => c.role === 'parent'), childCalls = result.calls.filter(c => (c.role === 'worker' || c.role === 'scout') && /CHILD-/.test(c.user));
  check('N2 only the top-level worker gets projects_delegate_child; the coordinator, scouts and children do not', parentCalls.length > 0 && parentCalls.every(c => c.tools.includes('projects_delegate_child') && !c.tools.includes('projects_delegate')) && !result.calls.some(c => c.role !== 'parent' && c.tools.includes('projects_delegate_child')), result.calls.map(c => [c.role, c.tools.filter(t => t.startsWith('projects_'))]));
  check('N1/N3 the child worker (scoped like its parent) has no delegation tool but has bash; the scoped parent has both', childCalls.some(c => c.role === 'worker' && c.tools.includes('bash') && !c.tools.includes('projects_delegate_child')) && parentCalls.every(c => c.tools.includes('bash')), childCalls.map(c => [c.role, c.tools]));
  check('N5 the child worker ran bash in a scoped checkout', childCalls.some(c => c.role === 'worker' && c.results.some(r => r.includes('/'))), childCalls.map(c => c.results));
  const followUps = work.filter(w => w.threadId === parentA.threadId && w.text.startsWith('[Child work'));
  check('N6/N7 each child result came back to the parent thread as a work item, which completed', followUps.length === 2 && followUps.every(w => w.status === 'completed') && followUps.some(w => w.text.includes(scoutA.id)) && followUps.some(w => w.text.includes(workerA.id)) && result.calls.filter(c => c.role === 'parent' && c.user.startsWith('[Child work')).length === 2, followUps);
  const coordReports = result.calls.filter(c => c.role === 'coordinator' && c.user.startsWith('[Durable work'));
  check('N6 the coordinator never receives a child report directly', !coordReports.some(c => c.user.startsWith(`[Durable work ${scoutA.id}`) || c.user.startsWith(`[Durable work ${workerA.id}`)), coordReports.map(c => c.user.slice(0, 120)));
  check('N7 the coordinator receives the parent\'s conclusions about both children', [scoutA.id, workerA.id].every(childId => coordReports.some(c => c.user.includes(`PARENT-CONCLUSION ${childId}`))), coordReports.map(c => c.user.slice(0, 200)));
  check('N8 the parent, its children and its follow-ups all report via the Ops chat', [parentA, scoutA, workerA, ...followUps].every(w => w.chatConversationId === ops.conversationId), [parentA, scoutA, workerA, ...followUps].map(w => w.chatConversationId));
  const opsView = await rpc({ action: 'show', id, chatId: ops.id });
  check('N8 the parent\'s conclusions are in the Ops transcript, not Main', opsView.messages.some(m => /COORD-NOTED PARENT-CONCLUSION/.test(m.text ?? '')) && !(await rpc({ action: 'show', id })).messages.some(m => /COORD-NOTED PARENT-CONCLUSION/.test(m.text ?? '')));

  // N17: projects_workers exposes the parent link and the child worker's scope equals the parent's.
  await ask('MARK-WORKERS');
  const listed = JSON.parse(result.calls.findLast(c => c.role === 'coordinator' && c.results.length === 1 && /MARK-WORKERS/.test(c.user)).results[0]);
  const lw = listed.work, wParent = lw.find(w => w.id === parentA.id), wScout = lw.find(w => w.id === scoutA.id), wWorker = lw.find(w => w.id === workerA.id);
  check('N5 the child worker shares the parent\'s workspace scope; the scout child has none', wParent.workspaceScopeId && wWorker.workspaceScopeId === wParent.workspaceScopeId && wScout.workspaceScopeId === null, { wParent, wScout, wWorker });
  check('N17 projects_workers shows parentThreadId on child work and threads, and child reports as delivered to parent', wScout.parentThreadId === parentA.threadId && wWorker.report === 'delivered to parent' && listed.threads.find(t => t.threadId === scoutA.threadId)?.parentThreadId === parentA.threadId && wParent.parentThreadId === null, { wScout, wWorker, threads: listed.threads });

  // UI: Activity tree and Observability trace.
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'activity');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  const treeState = `(() => { const group = document.querySelector('#work-list .work-children[data-parent="${parentA.threadId}"]'); const rows = [...document.querySelectorAll('#work-list > .work')]; const parentRows = rows.filter(r => r.querySelector('[data-thread="${parentA.threadId}"]')); return { kids: group ? [...group.querySelectorAll('.work.child')].map(r => ({ thread: r.querySelector('.work-open').dataset.thread, label: !!r.querySelector('.sub-label'), parent: r.dataset.parent })) : [], topChildRows: rows.filter(r => r.classList.contains('child')).length, prevIsParent: !!group && group.previousElementSibling?.querySelector('.work-open')?.dataset.thread === "${parentA.threadId}", parentRows: parentRows.length }; })()`;
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#work-list .work-children')`, s, 'activity tree');
  const tree = await evaluate(treeState, s);
  check('N14 Activity nests both children under the parent\'s newest row, labelled sub-agent; none at top level', tree.kids.length === 2 && tree.kids.every(k => k.label && k.parent === parentA.threadId) && new Set(tree.kids.map(k => k.thread)).size === 2 && tree.kids.some(k => k.thread === workerA.threadId) && tree.topChildRows === 0 && tree.prevIsParent, tree);
  await shot('01-activity-tree', s);
  await evaluate(`document.querySelector('#work-list .work-children [data-thread="${workerA.threadId}"]').click()`, s);
  await waitFor(`!!document.querySelector('#work-list .work.child.on [data-thread="${workerA.threadId}"]')`, s, 'child thread opened');
  await delay(500);
  check('N16 clicking a child row opens that child\'s thread', await evaluate(`!!document.querySelector('#work-list .work.child.on [data-thread="${workerA.threadId}"]')`, s));
  await shot('02-child-thread-open', s);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#work-list .work-children')`, s, 'mobile tree');
  await delay(300);
  check('N16 the tree fits a 390 px screen', await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s));
  await shot('03-activity-tree-mobile', s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  const obs = new URL(launch); obs.searchParams.set('tab', 'observability');
  await send('Page.navigate', { url: obs.toString() }, s);
  await waitFor(`!!document.querySelector('#obs-trace .trace-child')`, s, 'trace tree');
  const trace = await evaluate(`(() => { const parent = document.querySelector('#obs-trace li[data-thread="${parentA.threadId}"]'); const chat = parent?.closest('.trace-chat')?.dataset.chat; const kids = parent ? [...parent.querySelectorAll('.trace-child')].map(li => li.dataset.thread) : []; const direct = [...document.querySelectorAll('#obs-trace .trace-chat > details > ul > li')].map(li => li.dataset.thread); for (const d of document.querySelectorAll('#obs-trace details')) d.open = true; return { chat, kids, direct }; })()`, s);
  check('N15 the trace nests child threads under the parent thread, under the Ops chat', trace.chat === ops.id && trace.kids.length === 2 && trace.kids.includes(scoutA.threadId) && !trace.direct.includes(scoutA.threadId) && !trace.direct.includes(workerA.threadId) && trace.direct.includes(parentA.threadId), trace);
  await evaluate(`document.querySelector('#obs-trace li[data-thread="${parentA.threadId}"]').scrollIntoView()`, s);
  await shot('04-observability-trace', s);

  // N13/N10: pause/resume and a restart keep the links and do not redeliver reports.
  await rpc({ action: 'pause', id });
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  await stopHost(); startHost(); await waitHost();
  await delay(1500);
  work = await plan();
  check('N13/N10 after pause/resume and a restart, links survive and no child report is delivered twice', [scoutA.id, workerA.id].every(childId => work.find(w => w.id === childId).parentThreadId === parentA.threadId) && work.filter(w => w.threadId === parentA.threadId && w.text.startsWith('[Child work')).length === 2 && result.calls.filter(c => c.role === 'parent' && c.user.startsWith('[Child work')).length === 2, work);
  const relaunch = new URL((await rpc({ action: 'web' })).url); relaunch.searchParams.set('project', id); relaunch.searchParams.set('tab', 'activity');
  await send('Page.navigate', { url: relaunch.toString() }, s);
  await waitFor(`!!document.querySelector('#work-list .work-children')`, s, 'tree after restart');
  check('N13 the Activity tree is the same after the restart', (await evaluate(treeState, s)).kids.length === 2);

  // N11/N9: stopping a parent stops its running child; nothing wakes the parent.
  await rpc({ action: 'message', id, text: 'MARK-NEST-STOP please' });
  await eventually(() => held.length === 1, 'slow child did not start', 900);
  work = await plan();
  const [parentS] = byText(work, 'PARENT-TASK-STOP'), [slow] = byText(work, 'CHILD-SLOW-STOP');
  check('setup: the slow child is running and the parent finished its turn', slow.status === 'running' && slow.parentThreadId === parentS.threadId && parentS.status === 'completed', { parentS, slow });
  await rpc({ action: 'thread-stop', id, threadId: parentS.threadId });
  held.splice(0).forEach(res => { try { res.end(say('late')); } catch {} });
  await settleAll(); await delay(1000);
  work = await plan();
  const slowAfter = work.find(w => w.id === slow.id);
  check('N11 stopping the parent stopped its running child', slowAfter.status === 'stopped' && /parent/.test(slowAfter.blocker ?? ''), slowAfter);
  check('N9 the stopped child does not wake the parent or reach the coordinator', !work.some(w => w.threadId === parentS.threadId && w.text.startsWith('[Child work')) && !result.calls.some(c => c.role === 'coordinator' && c.user.startsWith(`[Durable work ${slow.id}`)));
  const listedStop = await rpc({ action: 'plan-snapshot', id });
  check('N11 the stop drained: the parent can take a new follow-up', !listedStop.paused);
  await rpc({ action: 'thread-send', id, threadId: parentS.threadId, text: 'PARENT-TASK-STOPPED-AGAIN say hi', requestId: randomUUID() });
  await settleAll();
  check('N11 the parent thread accepts work again after the cascade drained', (await plan()).some(w => w.threadId === parentS.threadId && w.text.includes('STOPPED-AGAIN') && w.status === 'completed'));

  // N4/N12: at most 4 active children; at worker cap 1 the parent's children run after it ends its turn (no deadlock).
  await ask('MARK-NEST-CAP please');
  work = await plan();
  const [parentC] = byText(work, 'PARENT-TASK-CAP'), capKids = work.filter(w => w.parentThreadId === parentC.threadId);
  const capCall = result.calls.findLast(c => c.role === 'parent' && /PARENT-TASK-CAP/.test(c.user) && c.results.length === 5);
  check('N4 the fifth active child is refused', capKids.length === 4 && /already have 4 children/.test(capCall?.results[4] ?? ''), { capKids: capKids.length, results: capCall?.results });
  check('N12 at worker cap 1 all four children ran after the parent and reported back to it', (await rpc({ action: 'plan-snapshot', id })).workerCap === 1 && capKids.every(w => w.status === 'completed') && work.filter(w => w.threadId === parentC.threadId && w.text.startsWith('[Child work')).length === 4);

  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api'));
  check('no browser errors', !result.errors.length && !result.httpErrors.length, result.errors.concat(result.httpErrors));
  result.plan = await plan();
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  held.splice(0).forEach(res => { try { res.end(say('late')); } catch {} });
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  await stopHost().catch(() => host.kill('SIGKILL'));
  model.closeAllConnections(); model.close(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
