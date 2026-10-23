// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in status-dots-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = process.env.ARTIFACT_DIR || join(repo, 'artifacts', `status-dots-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `status-dots-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, join(root, 'userhome')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const fixtureAt = Date.now();
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
let releaseHold; const hold = new Promise(ok => { releaseHold = ok; });
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages;
    const coordinator = (input.tools ?? []).some(tool => tool.function?.name === 'projects_delegate');
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const userText = String(typeof msgs[lastUser]?.content === 'string' ? msgs[lastUser].content : JSON.stringify(msgs[lastUser]?.content ?? ''));
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
    const stage = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').length;
    result.calls.push({ at: Date.now(), coordinator, marker, stage });
    const reply = text => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
    if (coordinator && userText.startsWith('[Durable work')) return reply(say(`Scout finished. Summary of ${marker}.`));
    if (coordinator && marker === 'MARK-COORDFAIL') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fake coordinator failure' } })); return; }
    if (coordinator) {
      if (marker === 'MARK-SCOUT' && stage === 0) return reply(call('projects_delegate', { role: 'scout', task: 'MARK-SCOUTTASK survey the UI files' }));
      if (marker === 'MARK-FAIL' && stage === 0) return reply(call('projects_delegate', { role: 'worker', task: 'MARK-FAILTASK will fail' }));
      if (marker === 'MARK-HOLD' && stage === 0) return reply(call('projects_delegate', { role: 'worker', task: 'MARK-HOLDTASK waits' }));
      if (marker === 'MARK-BADTOOL' && stage === 0) return reply(call('projects_worker_read', { workId: randomUUID() }));
      return reply(say(`Answer ${marker}.`));
    }
    if (marker === 'MARK-SCOUTTASK') return reply(say('REPORT-BODY finding one\n\n1. **First** issue `web/app.js:1`\n\n2. Second issue\n\n3. Third issue'));
    if (marker === 'MARK-FAILTASK') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fake invalid request' } })); return; }
    if (marker === 'MARK-HOLDTASK') { await hold; return reply(say('Hold done')); }
    return reply(say(`Worker ${marker}`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
// Fake Cursor: the browser-login poll answers 404 once, then hands out a session token; the dashboard serves a usage summary.
const cursorJwt = `x.${Buffer.from(JSON.stringify({ sub: 'auth0|e2e', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.y`;
const cursorSeen = { polls: [], summary: [] };
const cursor = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/auth/poll') { cursorSeen.polls.push(Object.fromEntries(url.searchParams)); if (cursorSeen.polls.length < 2) { res.statusCode = 404; return res.end('{}'); } return res.end(JSON.stringify({ accessToken: cursorJwt, refreshToken: 'refresh-e2e' })); }
  if (url.pathname === '/api/usage-summary') { cursorSeen.summary.push(req.headers.cookie ?? ''); return res.end(JSON.stringify({ billingCycleEnd: new Date(Date.now() + 9 * 86400_000).toISOString(), individualUsage: { plan: { enabled: true, totalPercentUsed: 61.5 } } })); }
  res.statusCode = 404; res.end('{}');
});
await new Promise(ok => cursor.listen(0, '127.0.0.1', ok));
const env = { ...process.env, PI_PROJECTS_CURSOR_DASHBOARD: `http://127.0.0.1:${cursor.address().port}`, PI_PROJECTS_CURSOR_API: `http://127.0.0.1:${cursor.address().port}`, HOME: join(root, 'userhome'), PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_PROJECTS_LIMITS_FIXTURE: join(root, 'limits.json') };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
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
      else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) { const u = new URL(msg.params.response.url); const entry = { url: u.origin + u.pathname, status: msg.params.response.status }; result.httpErrors.push(entry); send('Network.getRequestPostData', { requestId: msg.params.requestId }, msg.sessionId).then(r => { const post = JSON.parse(r.postData); entry.action = post.action; entry.id = post.id; entry.at = Date.now() - fixtureAt; }, () => {}); send('Network.getResponseBody', { requestId: msg.params.requestId }, msg.sessionId).then(r => { entry.body = r.body.slice(0, 200); }, () => {}); }
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
const lastReply = async id => (await rpc({ action: 'show', id })).messages.findLast(m => m.role === 'assistant')?.text ?? '';
const workFor = async (id, task) => eventually(async () => (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.text.startsWith(task)), `work ${task} missing`);
const terminal = async (id, task, status) => eventually(async () => { const w = (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.text.startsWith(task)); return w?.status === status && w; }, `work ${task} not ${status}`);
const scrollInfo = s => evaluate(`(() => { const t = document.querySelector('#transcript'); return { top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight, height: t.scrollHeight }; })()`, s);
const box = (sel, s) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, visible: !!(r.width || r.height) && getComputedStyle(n).visibility !== 'hidden' }; })()`, s);
const states = s => evaluate(`Object.fromEntries([...document.querySelectorAll('#chat-list .chat')].map(n => [n.querySelector('.chat-title').innerText, n.querySelector('.chat-dot').dataset.state]))`, s);
let s;
const click = (sel, s) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`, s);
try {
  writeFileSync(join(root, 'limits.json'), JSON.stringify({
    claude: [{ window: '5h', usedPercent: 42, resetsAt: fixtureAt + 2 * 3600e3 + 17 * 60e3 }, { window: '7d', usedPercent: 24, resetsAt: fixtureAt + 3 * 86400e3 }],
    codex: [{ window: '7d', usedPercent: 3, resetsAt: fixtureAt + 5 * 86400e3 }],
  }));
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Polish UI', cwd: workspace, objective: 'Disposable status fixture', model: 'fake/fake-model' });
  const id = project.id; result.projectId = id;
  const other = await rpc({ action: 'create', requestId: randomUUID(), name: 'Other Project', cwd: workspace, objective: 'Second project for the sidebar', model: 'fake/fake-model' });
  const otherSettings = await rpc({ action: 'settings-snapshot', id: other.id });
  await rpc({ action: 'settings-update', id: other.id, confirm: other.id, expectedRevision: otherSettings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const chatOf = title => rpc({ action: 'chat-create', id, title });
  const scoutChat = await chatOf('Scout'), failChat = await chatOf('Failing'); await chatOf('Idle');
  await rpc({ action: 'message', id, chatId: failChat.id, text: 'MARK-COORDFAIL' });
  await eventually(async () => (await rpc({ action: 'show', id })).chats.find(chat => chat.id === failChat.id)?.attention, 'coordinator failure not flagged');

  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }));
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelectorAll('#chat-list .chat').length === 4`, s, 'chats loaded');
  await waitFor(`document.querySelector('#chat-list .chat .chat-dot[data-state="needs"]')`, s, 'red dot');

  // Scout finishes while this browser is looking at Main: its dot turns green.
  await rpc({ action: 'message', id, chatId: scoutChat.id, text: 'MARK-SCOUT' });
  await waitFor(`document.querySelector('#chat-list .chat[data-chat="${scoutChat.id}"] .chat-dot')?.dataset.state === 'done'`, s, 'green dot after the scout chat finished');
  // Main starts a worker that keeps running (the scout finished first: workers of other roles queue behind it).
  await settle(id, await rpc({ action: 'message', id, text: 'MARK-HOLD' }));
  await eventually(async () => (await workFor(id, 'MARK-HOLDTASK')).status === 'running', 'hold not running');
  await waitFor(`document.querySelector('#chat-list .chat[data-chat="main"] .chat-dot')?.dataset.state === 'working'`, s, 'working dot');
  const dots = await states(s);
  const expected = { Main: 'working', Scout: 'done', Failing: 'needs', Idle: 'idle' };
  if (JSON.stringify(dots) !== JSON.stringify(expected)) throw Error('Chat dot states wrong: ' + JSON.stringify(dots));
  result.checks.push('D1 one dot per chat tab: working (Main), done (Scout), needs you (Failing), idle (Idle)');
  const labels = await evaluate(`[...document.querySelectorAll('#chat-list .chat-dot')].map(n => ({ state: n.dataset.state, label: n.getAttribute('aria-label'), title: n.title, role: n.getAttribute('role') }))`, s);
  const wanted = { working: /^Working: coordinator|^Working: .*worker/, done: /^Done/, needs: /^Needs you: /, idle: /^Idle$/ };
  if (labels.some(item => !item.label || item.label !== item.title || item.role !== 'img' || !wanted[item.state].test(item.label))) throw Error('Dot labels wrong: ' + JSON.stringify(labels));
  result.checks.push('D2 every dot says its state in words (aria-label and title)');
  const bubbles = await evaluate(`({ badges: document.querySelectorAll('.work-badge, #chat-list .count, .proj .count').length, digits: [...document.querySelectorAll('#chat-list .chat, .proj')].some(n => /\\d/.test(n.innerText)) })`, s);
  if (bubbles.badges || bubbles.digits) throw Error('Number bubbles remain: ' + JSON.stringify(bubbles));
  result.checks.push('D3 no number bubbles or check pills on chat tabs or project rows');
  const pulse = await evaluate(`getComputedStyle(document.querySelector('.chat-dot[data-state="working"]')).animationName`, s);
  if (pulse !== 'live-pulse') throw Error('Working dot does not pulse: ' + pulse);
  result.checks.push('D4 the working dot pulses');
  await shot('01-chat-tabs-dots', s);

  // Sidebar: the open project folds its chats (red wins); another project's row comes from the list summary.
  const open = await evaluate(`({ state: document.querySelector('.proj.on .state-dot')?.dataset.state, label: document.querySelector('.proj.on .state-dot')?.getAttribute('aria-label') })`, s);
  if (open.state !== 'needs' || !/^Needs you/.test(open.label)) throw Error('Open project row dot wrong: ' + JSON.stringify(open));
  result.checks.push('S1 the open project row shows red when any chat needs you');
  await shot('02-sidebar-expanded', s);
  await click('.proj:not(.on)', s);
  await waitFor(`document.querySelector('#title').innerText === 'Other Project'`, s, 'switched project');
  await waitFor(`document.querySelector('.proj:not(.on) .state-dot')?.dataset.state === 'needs'`, s, 'list-summary dot on the other project');
  result.checks.push('S2 a project that is not open gets its dot from the list summary (no runtime opened)');
  await click('.proj:not(.on)', s);
  await waitFor(`document.querySelector('#title').innerText === 'Polish UI' && document.querySelectorAll('#chat-list .chat').length === 4`, s, 'back on first project');
  await click('#side-toggle', s); await delay(500);
  const collapsed = await evaluate(`(() => { const d = document.querySelector('.app.side-collapsed .proj.on .state-dot'); if (!d) return null; const r = d.getBoundingClientRect(), p = d.closest('.proj').getBoundingClientRect(); return { position: getComputedStyle(d).position, onAvatar: r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom, state: d.dataset.state }; })()`, s);
  if (!collapsed || collapsed.position !== 'absolute' || !collapsed.onAvatar || collapsed.state !== 'needs') throw Error('Collapsed sidebar dot wrong: ' + JSON.stringify(collapsed));
  result.checks.push('S3 the collapsed sidebar keeps the dot on the project avatar');
  await shot('03-sidebar-collapsed', s);
  await click('#side-toggle', s); await delay(400);

  // Opening a chat clears its green dot.
  await click(`#chat-list .chat[data-chat="${scoutChat.id}"]`, s);
  await waitFor(`document.querySelector('#chat-list .chat.on .chat-title')?.innerText === 'Scout'`, s, 'scout chat open');
  await click(`#chat-list .chat[data-chat="main"]`, s);
  await waitFor(`document.querySelector('#chat-list .chat[data-chat="${scoutChat.id}"] .chat-dot')?.dataset.state === 'idle'`, s, 'green cleared after opening');
  result.checks.push('D5 opening a chat clears its green dot (stays idle after leaving)');

  // Compact worker rows.
  await waitFor(`/^(\\d+%|window unknown)$/.test(document.querySelector('#activity .worker-line .ctx-ring')?.innerText.trim() ?? '')`, s, 'row context ring');
  const row = await evaluate(`(() => { const n = document.querySelector('#activity .worker-line'); const r = n.getBoundingClientRect(); return { height: r.height, text: n.innerText, expanded: !!document.querySelector('#activity .worker-item.on, #activity #worker-messages, #activity form'), activityTab: !!document.querySelector('[data-tab="activity"]') }; })()`, s);
  if (row.height > 56 || row.expanded || row.activityTab || !/worker · running/.test(row.text.replace(/\\s+/g, ' '))) throw Error('Worker row not compact: ' + JSON.stringify(row));
  result.checks.push('W1 a worker row is at most two lines (title; role · status · elapsed) with a context ring; no inline expansion; no Activity tab');
  await shot('04-workers-card-compact', s);

  // Worker view.
  const thread = (await workFor(id, 'MARK-HOLDTASK')).threadId;
  await click('#activity .worker-line', s);
  await waitFor(`!document.querySelector('#inline-thread').hidden && !!document.querySelector('#worker-messages')`, s, 'worker view');
  const view = await evaluate(`(() => { const v = document.querySelector('#inline-thread'); return { chatHidden: document.querySelector('[data-panel="coordinator"]').hidden, link: new URL(location.href).searchParams.get('worker'), project: new URL(location.href).searchParams.get('project'), status: !!v.querySelector('.worker-head .badge'), model: v.querySelector('.worker-head small').innerText, ring: !!v.querySelector('.worker-head .ctx-ring'), back: !!v.querySelector('[data-action="thread-close"]'), steer: !!v.querySelector('[data-action="thread-steer"]'), stop: !!v.querySelector('[data-action="thread-stop"]'), composer: !!v.querySelector('[data-inline-thread-send]'), artifacts: !!v.querySelector('#artifact-pane'), evidence: !!v.querySelector('#worker-evidence') }; })()`, s);
  if (!view.chatHidden || view.link !== thread || view.project !== id || !view.status || !/fake/.test(view.model) || !view.ring || !view.back || !view.steer || !view.stop || !view.composer || !view.artifacts || !view.evidence) throw Error('Worker view incomplete: ' + JSON.stringify(view));
  result.checks.push('V1 clicking a row opens the worker view: status, model, context ring, Back, Steer/Stop, conversation, composer, artifacts, evidence; URL carries ?worker=');
  await shot('05-worker-view', s);
  await click('#inline-thread [data-action="thread-close"]', s);
  await waitFor(`document.querySelector('#inline-thread').hidden && !document.querySelector('[data-panel="coordinator"]').hidden && !new URL(location.href).searchParams.has('worker')`, s, 'Back to the chat');
  result.checks.push('V2 Back returns to the coordinator chat');
  await click('#activity .worker-line', s);
  await waitFor(`!document.querySelector('#inline-thread').hidden`, s, 'reopen worker view');
  await evaluate(`history.back()`, s);
  await waitFor(`document.querySelector('#inline-thread').hidden && !document.querySelector('[data-panel="coordinator"]').hidden && !new URL(location.href).searchParams.has('worker')`, s, 'browser Back to the chat');
  result.checks.push('V2b the browser Back button also returns to the chat');
  const deep = new URL(launch); deep.searchParams.set('worker', thread);
  await send('Page.navigate', { url: deep.toString() }, s);
  await waitFor(`!document.querySelector('#inline-thread')?.hidden && !!document.querySelector('#worker-messages') && new URL(location.href).searchParams.get('worker') === '${thread}'`, s, 'deep link opens the worker view');
  result.checks.push('V3 ?worker=<threadId> deep-links straight to the worker view');
  await click('#inline-thread [data-action="thread-close"]', s);
  await waitFor(`document.querySelector('#inline-thread').hidden`, s, 'deep-link Back');

  // Limits bar (fixture data; the host never contacted a provider).
  await waitFor(`document.querySelectorAll('#limits-bar .lim').length === 3 && /42%/.test(document.querySelector('#limits-bar').innerText)`, s, 'limits bar');
  const bar = await evaluate(`Object.fromEntries([...document.querySelectorAll('#limits-bar .lim')].map(n => [n.dataset.provider, { text: n.innerText.replace(/\\s+/g, ' ').trim(), label: n.getAttribute('aria-label') }]))`, s);
  if (!/5h.*42%.*7d.*24%/.test(bar.claude.text) || !/^Claude: 5h/.test(bar.claude.label) || /5h/.test(bar.codex.text) || !/7d.*3%/.test(bar.codex.text) || !/^Codex: 7d/.test(bar.codex.label) || !/—/.test(bar.cursor.text) || !/^Cursor/.test(bar.cursor.label) || !/not connected/i.test(bar.cursor.label) || /Claude|Codex|Cursor/.test(bar.claude.text + bar.codex.text.replace(/Connect/, '')) ) throw Error('Limits bar content wrong: ' + JSON.stringify(bar));
  result.checks.push('B1 bottom bar: provider icons (names only in aria-label), Claude 5h 42% / 7d 24%, Codex 7d 3% (no invented 5h), Cursor "—" and "Not connected"');
  const at = await box('#limits-bar .lim[data-provider="claude"]', s);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((at.left + at.right) / 2), y: Math.round((at.top + at.bottom) / 2) }, s);
  await waitFor(`getComputedStyle(document.querySelector('.lim[data-provider="claude"] .lim-pop')).visibility === 'visible'`, s, 'hover details');
  const pop = await evaluate(`document.querySelector('.lim[data-provider="claude"] .lim-pop').innerText`, s);
  if (!/resets in 2h \d+m/.test(pop) || !/resets in (2d 2\d|3d)/.test(pop) || !/42% used/.test(pop) || !/observed .* via usage endpoint/.test(pop)) throw Error('Hover details wrong: ' + pop);
  result.checks.push('B2 hover details: used percent, reset countdown and time, observed time and source per window');
  await shot('06-limits-bar-hover', s);
  const cursor = await box('#limits-bar .lim[data-provider="cursor"]', s);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((cursor.left + cursor.right) / 2), y: Math.round((cursor.top + cursor.bottom) / 2) }, s);
  await waitFor(`getComputedStyle(document.querySelector('.lim[data-provider="cursor"] .lim-pop')).visibility === 'visible'`, s, 'cursor details');
  await shot('07-limits-bar-unavailable', s);
  // Refresh button: refetches now (fixture changed on disk), disabled while running, cooldown on repeated clicks.
  const refreshInfo = await evaluate(`(() => { const b = document.querySelector('#limits-bar .lim-refresh'); return { label: b?.getAttribute('aria-label'), title: b?.title, last: b.previousElementSibling?.dataset.provider === 'cursor', margin: getComputedStyle(b).marginLeft }; })()`, s);
  if (refreshInfo.label !== 'Refresh limits' || !refreshInfo.title || !refreshInfo.last || refreshInfo.margin !== '0px') throw Error('Refresh button wrong: ' + JSON.stringify(refreshInfo));
  await shot('06b-limits-bar-refresh-icon', s);
  await waitFor(`document.querySelectorAll('#limits-bar .mach-item').length >= 2`, s, 'machine status');
  const mach = await evaluate(`[...document.querySelectorAll('#limits-bar .mach-item')].map(n => [n.dataset.kind, n.innerText.replace(/\\s+/g, ' ').trim()])`, s);
  const machFormat = { ram: /^\d+\.\d GB \/ \d+\.\d GB|^—/, cpu: /^(\d+%|—)/, ssd: /^(\d+%|—)/, battery: /^(\d+%|—)/ };
  if (!mach.every(([kind, text]) => machFormat[kind].test(text)) || !mach.some(([kind]) => kind === 'cpu')) throw Error('Machine status wrong: ' + JSON.stringify(mach));
  if (!(await evaluate(`document.querySelector('#limits-bar .lim-refresh').nextElementSibling === document.querySelector('#limits-bar .mach')`, s))) throw Error('Machine status is not on the right after the refresh button');
  result.checks.push('B2b machine status renders after the refresh button in the documented formats: ' + JSON.stringify(mach));
  const cpuBox = await box('#limits-bar .mach-item[data-kind="cpu"]', s);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((cpuBox.left + cpuBox.right) / 2), y: Math.round((cpuBox.top + cpuBox.bottom) / 2) }, s);
  await waitFor(`getComputedStyle(document.querySelector('.mach-item[data-kind="cpu"] .mach-tip')).visibility === 'visible'`, s, 'machine tooltip');
  await shot('06c-machine-hover', s);
  const barBox = await box('#limits-bar', s);
  const crop = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: barBox.top, width: 400, height: barBox.bottom - barBox.top, scale: 2 } }, s);
  writeFileSync(join(artifacts, '06d-bar-left-closeup-2x.png'), Buffer.from(crop.data, 'base64'), { mode: 0o600 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, s);
  writeFileSync(join(root, 'limits.json'), JSON.stringify({ claude: [{ window: '5h', usedPercent: 61, resetsAt: fixtureAt + 2 * 3600e3 }, { window: '7d', usedPercent: 24, resetsAt: fixtureAt + 3 * 86400e3 }], codex: [{ window: '7d', usedPercent: 3, resetsAt: fixtureAt + 5 * 86400e3 }] }));
  await click('#limits-bar .lim-refresh', s);
  await waitFor(`/61%/.test(document.querySelector('#limits-bar .lim[data-provider="claude"]').innerText) && !document.querySelector('#limits-bar .lim-refresh').disabled`, s, 'refreshed numbers');
  result.checks.push('B3 refresh icon: aria-label and tooltip, directly after the last provider with no auto margin; clicking refetches now (42% -> 61%) and re-enables the button');
  writeFileSync(join(root, 'limits.json'), JSON.stringify({ claude: [{ window: '5h', usedPercent: 70, resetsAt: fixtureAt + 2 * 3600e3 }], codex: [] }));
  await click('#limits-bar .lim-refresh', s); await new Promise(ok => setTimeout(ok, 800));
  if (!/61%/.test(await evaluate(`document.querySelector('#limits-bar .lim[data-provider="claude"]').innerText`, s))) throw Error('Cooldown did not hold: second refresh inside 15 s refetched');
  result.checks.push('B4 a second refresh click inside the 15 s host cooldown does not refetch');
  // Connect Cursor from the page: the app builds the login link, the host polls Cursor and keeps the tokens.
  await evaluate(`(window.__opened = [], window.open = url => { window.__opened.push(String(url)); return null; })`, s);
  await waitFor(`!!document.querySelector('.lim[data-provider="cursor"] [data-action="cursor-connect"]')`, s, 'Connect Cursor button');
  await shot('07b-cursor-connect', s);
  await click('.lim[data-provider="cursor"] [data-action="cursor-connect"]', s);
  await waitFor(`window.__opened.length === 1`, s, 'login page opened');
  const login = new URL(await evaluate(`window.__opened[0]`, s));
  if (!login.pathname.endsWith('/loginDeepControl') || !login.searchParams.get('challenge') || !login.searchParams.get('uuid') || login.searchParams.get('verifier')) throw Error('Login URL wrong: ' + login);
  await waitFor(`/Waiting/.test(document.querySelector('.lim[data-provider="cursor"]')?.innerText ?? '') || /6\\d%/.test(document.querySelector('.lim[data-provider="cursor"]')?.innerText ?? '')`, s, 'waiting state');
  await waitFor(`/61\.?5?%/.test(document.querySelector('.lim[data-provider="cursor"]').innerText) || /62%/.test(document.querySelector('.lim[data-provider="cursor"]').innerText)`, s, 'Cursor usage after login');
  const poll = cursorSeen.polls.at(-1);
  if (createHash('sha256').update(poll.verifier).digest('base64url') !== login.searchParams.get('challenge') || poll.uuid !== login.searchParams.get('uuid')) throw Error('PKCE verifier does not match the challenge: ' + JSON.stringify(poll));
  const stored = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'));
  if (stored.cursor?.access !== cursorJwt || (statSync(join(agentDir, 'auth.json')).mode & 0o777) !== 0o600) throw Error('Cursor login not stored in auth.json at 0600');
  if (!cursorSeen.summary.at(-1)?.startsWith('WorkosCursorSessionToken=auth0%7Ce2e%3A%3A')) throw Error('Usage request lacked the session cookie');
  const afterBar = await evaluate(`document.querySelector('.lim[data-provider="cursor"]').innerText.replace(/\s+/g, ' ')`, s);
  if (!/month/.test(afterBar) && !/mo/.test(afterBar)) throw Error('Cursor window label missing: ' + afterBar);
  const page = await evaluate(`document.documentElement.outerHTML`, s);
  if (page.includes(cursorJwt) || page.includes('refresh-e2e')) throw Error('A Cursor token reached the page');
  await shot('07c-cursor-connected', s);
  result.checks.push('C1 Connect Cursor: PKCE login link opened, host polled with the matching verifier, tokens stored in auth.json at 0600, usage appears as a monthly percentage, no token reaches the page');
  const raw = JSON.stringify(await rpc({ action: 'limits-snapshot' }));
  if (/token|bearer|access|authorization|cookie/i.test(raw)) throw Error('Limits snapshot leaks credential-like fields: ' + raw);
  result.checks.push('B3 the browser payload is normalized samples only; no tokens or raw provider responses');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, s);

  // Narrow.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelectorAll('#chat-list .chat').length === 4 && document.querySelectorAll('#limits-bar .lim').length === 3`, s, 'narrow load');
  await delay(500);
  const narrow = await evaluate(`({ width: document.scrollingElement.scrollWidth, bar: document.querySelector('#limits-bar').getBoundingClientRect().height > 0, barOverflow: document.querySelector('#limits-bar').scrollWidth > document.querySelector('#limits-bar').clientWidth })`, s);
  if (narrow.width > 391 || !narrow.bar || narrow.barOverflow) throw Error('Narrow view broken: ' + JSON.stringify(narrow));
  result.checks.push('N1 390px: no horizontal overflow, chat dots and the limits bar present');
  await shot('08-narrow-390', s);
  await click('#activity .worker-line', s);
  await waitFor(`!document.querySelector('#inline-thread').hidden && !!document.querySelector('#worker-messages')`, s, 'narrow worker view');
  if (await evaluate(`document.scrollingElement.scrollWidth`, s) > 391) throw Error('Narrow worker view overflows');
  await shot('09-narrow-worker-view', s);
  result.checks.push('N2 390px worker view fits the screen');
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured: ' + JSON.stringify({ errors: result.errors, http: result.httpErrors }));
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
  try { if (s) await shot('failure', s); } catch {}
  try { const state = await rpc({ action: 'show', id: result.projectId }); result.chatsAtFailure = state.chats; result.workAtFailure = (await rpc({ action: 'plan-snapshot', id: result.projectId })).work.map(w => ({ text: w.text.slice(0, 24), status: w.status, chat: w.chatConversationId, endedAt: w.endedAt })); } catch {}
} finally {
  releaseHold?.();
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { if (!hostEnded) { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(10000)]); } } catch { host.kill('SIGKILL'); }
  if (!hostEnded) host.kill('SIGKILL');
  model.closeAllConnections(); model.close(); cursor.closeAllConnections(); cursor.close(); log.end(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
