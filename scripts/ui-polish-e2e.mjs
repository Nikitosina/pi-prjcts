// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in ui-polish-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `ui-polish-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `ui-polish-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
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
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
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
const lastReply = async id => (await rpc({ action: 'show', id })).messages.findLast(m => m.role === 'assistant')?.text ?? '';
const workFor = async (id, task) => eventually(async () => (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.text.startsWith(task)), `work ${task} missing`);
const terminal = async (id, task, status) => eventually(async () => { const w = (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.text.startsWith(task)); return w?.status === status && w; }, `work ${task} not ${status}`);
const scrollInfo = s => evaluate(`(() => { const t = document.querySelector('#transcript'); return { top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight, height: t.scrollHeight }; })()`, s);
const box = (sel, s) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, visible: !!(r.width || r.height) && getComputedStyle(n).visibility !== 'hidden' }; })()`, s);
try {
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Polish UI', cwd: workspace, objective: 'Disposable polish fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const ask = async text => { const job = await rpc({ action: 'message', id, text }); const done = await settle(id, job); if (done.state !== 'done') throw Error(`${text} failed: ${done.error}`); return lastReply(id); };

  await ask('MARK-SCOUT');
  const scout = await terminal(id, 'MARK-SCOUTTASK', 'completed');
  await eventually(async () => (await rpc({ action: 'show', id })).messages.some(m => m.role === 'assistant' && m.text.includes('Scout finished')), 'coordinator summary missing');
  await ask('MARK-FAIL');
  await terminal(id, 'MARK-FAILTASK', 'failed');
  await ask('MARK-BADTOOL');
  // A user message that merely looks like a report must stay a plain message (failure 3).
  await ask('[Durable work but not really] MARK-FAKE');
  await ask('MARK-HOLD');
  await eventually(async () => (await workFor(id, 'MARK-HOLDTASK')).status === 'running', 'hold not running');

  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#title')?.innerText === 'Polish UI' && document.querySelector('#messages').innerText.includes('MARK-FAKE')`, s, 'project loaded');
  await delay(500);
  await shot('01-coordinator', s);

  // Conversation
  const reports = await evaluate(`[...document.querySelectorAll('#messages .report')].map(n => ({ text: n.innerText, thread: n.querySelector('[data-action="thread"]')?.dataset.thread ?? null, open: n.open }))`, s);
  const youText = await evaluate(`[...document.querySelectorAll('#messages .msg.you')].map(n => n.innerText).join('\\n')`, s);
  if (reports.length !== 2 || /\\[Durable work [0-9a-f-]{36}/.test(youText) || /Summarize the result for the user/.test(await evaluate(`document.querySelector('#messages').innerText`, s))) throw Error('Report not rendered as a card: ' + JSON.stringify({ reports, youText: youText.slice(0, 400) }));
  const scoutCard = reports.find(r => r.text.includes('MARK-SCOUTTASK'));
  if (!/scout report/i.test(scoutCard?.text) || !/completed/i.test(scoutCard.text) || scoutCard.thread !== scout.threadId || !reports.some(r => /worker report/i.test(r.text) && /failed/.test(r.text))) throw Error('Report card header/link wrong: ' + JSON.stringify(reports));
  result.checks.push('C1 worker report renders as a scout report card linked to its thread, no raw UUID header or coordinator instructions');
  await evaluate(`document.querySelector('#messages .report summary').click()`, s);
  await waitFor(`document.querySelector('#messages .report').open && document.querySelector('#messages .report').innerText.includes('REPORT-BODY') && !!document.querySelector('#messages .report strong')`, s, 'report expands with markdown result');
  result.checks.push('C2 report card expands to the markdown-rendered result');
  if (!/MARK-FAKE/.test(youText)) throw Error('Look-alike user message vanished');
  result.checks.push('C3 a message that only looks like a report stays a plain user message');
  const tools = await evaluate(`[...document.querySelectorAll('#messages .tool-call')].map(n => ({ label: n.querySelector('summary').innerText, status: n.dataset.status }))`, s);
  const delegate = tools.find(t => t.label.includes('MARK-SCOUTTASK'));
  if (!delegate || !/delegated to scout/i.test(delegate.label) || /projects_delegate/.test(delegate.label)) throw Error('Delegate tool call not humanised: ' + JSON.stringify(tools));
  const bad = tools.find(t => t.status === 'error');
  if (!bad || await evaluate(`getComputedStyle(document.querySelector('#messages .tool-call[data-status="error"]')).color === getComputedStyle(document.querySelector('#messages .tool-call[data-status="ok"]')).color`, s)) throw Error('Errored tool call indistinguishable: ' + JSON.stringify(tools));
  result.checks.push('C4 tool calls are one-line human labels ("Delegated to scout: …"); errors look different');
  const stamps = await evaluate(`[...document.querySelectorAll('#messages .who small')].map(n => n.innerText)`, s);
  if (!stamps.length || stamps.some(t => /[A-Z][a-z]{2} \\d/.test(t))) throw Error('Today timestamps still carry a date: ' + stamps);
  result.checks.push('C5 messages from today show time only');

  // Layout
  const page = await evaluate(`({ scroll: document.scrollingElement.scrollHeight, inner: innerHeight, width: document.scrollingElement.scrollWidth })`, s);
  const head = await box('#title', s), composer = await box('#compose', s);
  if (page.scroll > page.inner + 1 || head.top < 0 || composer.bottom > 900) throw Error('Page overflows/clips: ' + JSON.stringify({ page, head, composer }));
  const transcriptScrolls = await evaluate(`(() => { const t = document.querySelector('#transcript'); return t.scrollHeight > t.clientHeight && ['auto','scroll'].includes(getComputedStyle(t).overflowY); })()`, s);
  if (!transcriptScrolls) throw Error('Transcript does not scroll on its own');
  result.checks.push('L1 1440x900: no page scroll, header visible, composer in viewport, transcript scrolls on its own');

  // Header and composer
  const life = await evaluate(`({ pause: !!document.querySelector('#project-pause')?.offsetParent, resume: !!document.querySelector('#project-resume')?.offsetParent, eyebrow: document.querySelector('#eyebrow').offsetParent ? document.querySelector('#eyebrow').innerText : '' })`, s);
  if (!life.pause || life.resume || /nothing needs/i.test(life.eyebrow)) throw Error('Header controls wrong: ' + JSON.stringify(life));
  result.checks.push('H1 only Pause shows while ready; no "Nothing needs your call" eyebrow');
  const comp = await evaluate(`({ placeholder: document.querySelector('#compose textarea').placeholder, hint: document.querySelector('#compose-hint').innerText, resize: getComputedStyle(document.querySelector('#compose textarea')).resize })`, s);
  if (/enter/i.test(comp.placeholder) || !comp.hint.includes('fake-model') || comp.resize !== 'none') throw Error('Composer copy wrong: ' + JSON.stringify(comp));
  const grow = await evaluate(`(async () => { const t = document.querySelector('#compose textarea'); const before = t.offsetHeight; t.focus(); t.value = 'line\\n'.repeat(6); t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => requestAnimationFrame(r)); const mid = t.offsetHeight; t.value = 'line\\n'.repeat(200); t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => requestAnimationFrame(r)); const big = t.offsetHeight; t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); return { before, mid, big, after: t.offsetHeight }; })()`, s);
  if (!(grow.mid > grow.before) || grow.big > 260 || grow.after > grow.before + 2) throw Error('Composer auto-grow wrong: ' + JSON.stringify(grow));
  result.checks.push('H2 composer: short placeholder, model in hint, no resize grip, grows with content up to a cap and shrinks back');

  // Side rail
  if (await evaluate(`!!document.querySelector('#needs-card')?.offsetParent`, s)) throw Error('Empty Needs-you card shown');
  result.checks.push('R1 empty Needs-you card hidden');
  const rail = await evaluate(`({ workers: document.querySelector('#activity').innerText, results: document.querySelector('#outcomes').innerText })`, s);
  if (!rail.results.includes('MARK-SCOUTTASK') || !/scout/i.test(rail.results) || !rail.results.includes('MARK-FAILTASK') || !rail.workers.includes('MARK-HOLDTASK') || /work items/.test(rail.workers)) throw Error('Rail content wrong: ' + JSON.stringify(rail));
  result.checks.push('R2 Recent results lists completed and failed durable work; Workers shows running; no "work items" grammar');
  await evaluate(`[...document.querySelectorAll('#outcomes [data-action="thread"]')].find(n => n.innerText.includes('MARK-SCOUTTASK')).click()`, s);
  await waitFor(`!document.querySelector('[data-panel="activity"]').hidden && !document.querySelector('#inline-thread').hidden && document.querySelector('#inline-thread').innerText.includes('REPORT-BODY')`, s, 'result opens thread');
  result.checks.push('R3 clicking a recent result opens its worker thread');
  await shot('02-thread', s);
  await evaluate(`document.querySelector('[data-tab="coordinator"]').click()`, s);
  await evaluate(`document.querySelector('#activity [data-action="all-work"]').click()`, s);
  await waitFor(`!document.querySelector('[data-panel="activity"]').hidden && !document.querySelector('#dialog').open`, s, 'view all goes to Activity');
  result.checks.push('R4 "View all work" switches to Activity instead of a dialog');

  // Round 2
  const list = await evaluate(`(() => { const ol = [...document.querySelectorAll('#messages .report ol')]; return ol.map(n => n.children.length); })()`, s);
  if (!list.includes(3)) throw Error('Blank-line separated numbered list split: ' + JSON.stringify(list));
  result.checks.push('M1 numbered list with blank lines stays one list');
  await evaluate(`document.querySelector('[data-tab="activity"]').click()`, s);
  await evaluate(`document.querySelector('#work-list [data-action="thread"]').click()`, s);
  await waitFor(`!document.querySelector('#inline-thread').hidden && !!document.querySelector('#worker-messages')`, s, 'thread pane');
  const panes = await evaluate(`(() => { const a = document.querySelector('.work-pane').getBoundingClientRect(), b = document.querySelector('#inline-thread').getBoundingClientRect(); return { side: b.left >= a.right - 1 && Math.abs(a.top - b.top) < 4, page: document.scrollingElement.scrollHeight <= innerHeight + 1, selected: !!document.querySelector('#work-list .work.on'), bottom: b.bottom <= innerHeight + 1 }; })()`, s);
  if (!panes.side || !panes.page || !panes.selected || !panes.bottom) throw Error('Activity is not master-detail: ' + JSON.stringify(panes));
  result.checks.push('A1 Activity: work list and thread side by side, selected row marked, no page scroll');
  await shot('04-activity', s);
  await evaluate(`document.querySelector('[data-tab="knowledge"]').click()`, s);
  await waitFor(`document.querySelectorAll('#knowledge-inline .tree-file').length >= 2`, s, 'doc rows');
  const knowledge = await evaluate(`({ tiles: document.querySelectorAll('[data-panel="knowledge"] .tile').length, text: document.querySelector('#knowledge-inline').innerText })`, s);
  if (knowledge.tiles || /bytes|\d{1,2}\/\d{1,2}\/\d{4}/.test(knowledge.text) || !/updated .*ago|just now/.test(knowledge.text)) throw Error('Knowledge list not tidy: ' + JSON.stringify(knowledge));
  result.checks.push('K1 Knowledge: tree file rows with relative time, no tiles or raw bytes/dates');
  await evaluate(`document.querySelector('#knowledge-inline .tree-file').click()`, s);
  await waitFor(`!!document.querySelector('#dialog [data-action="knowledge-edit"]')`, s, 'doc dialog');
  await evaluate(`document.querySelector('#dialog [data-action="knowledge-edit"]').click()`, s);
  await waitFor(`!!document.querySelector('#dialog form[data-knowledge-write]')`, s, 'edit form');
  if (await evaluate(`!!document.querySelector('#dialog input[name="confirm"]:not([type="hidden"])')`, s)) throw Error('Knowledge edit asks to type the project ID');
  await evaluate(`document.querySelector('#dialog [data-action="close-dialog"]').click()`, s);
  result.checks.push('K2 knowledge edit needs no typed project ID');
  await evaluate(`document.querySelector('[data-tab="coordinator"]').click()`, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, s);
  await delay(400);
  const narrow = await evaluate(`(() => { const a = document.querySelector('#avatar').getBoundingClientRect(), t = document.querySelector('#title').getBoundingClientRect(), more = document.querySelector('[data-action="lifecycle-more"]').getBoundingClientRect(), pause = document.querySelector('#project-pause').getBoundingClientRect(), hint = document.querySelector('#compose-hint').getBoundingClientRect(), send = document.querySelector('#compose [type="submit"]').getBoundingClientRect(); return { avatarRow: Math.abs((a.top + a.bottom) / 2 - (t.top + t.bottom) / 2) < 30, moreRow: Math.abs(more.top - pause.top) < 12, footerRow: Math.abs((hint.top + hint.bottom) / 2 - (send.top + send.bottom) / 2) < 12 }; })()`, s);
  if (!Object.values(narrow).every(Boolean)) throw Error('1100px header/composer wraps: ' + JSON.stringify(narrow));
  const ring = await evaluate(`document.querySelector('.context-pct').innerText`, s);
  if (!/^\d+%$/.test(ring)) throw Error('Context ring has no number: ' + ring);
  result.checks.push('L3 1100px: header and composer footer stay on one row; context ring shows a percentage');
  // Mobile
  await evaluate(`document.querySelector('[data-tab="coordinator"]').click()`, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(500);
  const mobile = await evaluate(`document.scrollingElement.scrollWidth`, s);
  if (mobile > 391) throw Error('Mobile overflows horizontally: ' + mobile);
  const compact = await evaluate(`({ list: !!document.querySelector('#project-list').offsetParent, select: !!document.querySelector('#projects').offsetParent, title: document.querySelector('#title').getBoundingClientRect().top })`, s);
  if (compact.list || !compact.select || compact.title > 200) throw Error('Mobile sidebar not compact: ' + JSON.stringify(compact));
  await shot('03-mobile', s);
  result.checks.push('L2 390px: no horizontal overflow; sidebar collapses to a project picker');
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  releaseHold?.();
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { if (!hostEnded) { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(10000)]); } } catch { host.kill('SIGKILL'); }
  if (!hostEnded) host.kill('SIGKILL');
  model.closeAllConnections(); model.close(); log.end(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
