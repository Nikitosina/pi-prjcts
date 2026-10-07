// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in delegate-defaults-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `delegate-defaults-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `delegate-defaults-${randomUUID()}`);
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
const toolsSeen = {};
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages;
    const names = (input.tools ?? []).map(tool => tool.function?.name);
    const coordinator = names.includes('projects_delegate');
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const userText = String(typeof msgs[lastUser]?.content === 'string' ? msgs[lastUser].content : JSON.stringify(msgs[lastUser]?.content ?? ''));
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
    const stage = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').length;
    const after = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    result.calls.push({ at: Date.now(), coordinator, marker, stage });
    (toolsSeen[`${coordinator ? 'coord' : 'worker'}:${marker}`] ??= []).push(names);
    const reply = text => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
    if (coordinator && userText.startsWith('[Durable work')) return reply(say('Noted.'));
    if (coordinator) {
      const delegate = { 'MARK-W1': { role: 'worker', task: 'MARK-W1TASK edit' }, 'MARK-S1': { role: 'scout', task: 'MARK-S1TASK read' } }[marker];
      if (delegate && stage === 0) return reply(call('projects_delegate', delegate));
      if (marker === 'MARK-ASK' && stage === 0) return reply(call('projects_question', { question: 'MARK-QTITLE Pick a colour\nWhich colour should the button use?', choices: ['MARK-RED', 'MARK-BLUE'] }));
      return reply(say(`Answer ${marker} RESULT: ${after.slice(0, 600)}`));
    }
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
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
try {
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
  git(workspace, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  writeFileSync(join(workspace, 'README.md'), 'demo\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'c1');
  const create = async name => {
    const project = await rpc({ action: 'create', requestId: randomUUID(), name, cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' });
    const settings = await rpc({ action: 'settings-snapshot', id: project.id });
    await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    return project.id;
  };
  const askIn = id => async text => { const job = await rpc({ action: 'message', id, text }); const done = await settle(id, job); if (done.state !== 'done') throw Error(`${text} failed: ${done.error}`); return lastReply(id); };
  const receipts = async id => (await rpc({ action: 'show', id })).messages.filter(m => m.kind === 'tool' && m.name === 'projects_delegate').map(m => JSON.parse(JSON.parse(m.resultPreview)[0].text));
  const workerTools = marker => (toolsSeen[`worker:${marker}`] ?? []);
  const workIn = async (id, task) => eventually(async () => (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.text.startsWith(task)), `work ${task} missing`);

  // No grant yet: worker admits unscoped, as before (7).
  const id = await create('Defaults');
  const ask = askIn(id);
  await ask('MARK-W1 first');
  await eventually(async () => ['completed', 'failed'].includes((await workIn(id, 'MARK-W1TASK')).status), 'first worker settled');
  const firstReceipt = (await receipts(id)).at(-1);
  if (firstReceipt.workspaceScopeId !== null || workerTools('MARK-W1TASK').flat().some(name => ['write', 'edit', 'bash'].includes(name))) throw Error('Ungranted worker gained a scope: ' + JSON.stringify({ firstReceipt, tools: workerTools('MARK-W1TASK') }));
  result.checks.push('D7 without a grant, worker delegation stays unscoped');

  // One whole-repository grant: unscoped worker defaults to it (1, 6).
  const snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  const scopeId = (await rpc({ action: 'show', id })).project.workspaceAuthorization.scopes[0].id;
  await ask('MARK-W1 second');
  const receipt = (await receipts(id)).at(-1);
  if (receipt.workspaceScopeId !== scopeId) throw Error('Default scope not applied/shown: ' + JSON.stringify(receipt));
  result.scopedWork = await eventually(async () => { const w = (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.id === receipt.workId); return ['completed', 'failed', 'blocked'].includes(w?.status) && w; }, 'scoped worker settled');
  const scopedTools = workerTools('MARK-W1TASK').at(-1) ?? [];
  if (result.scopedWork.status !== 'completed' || !['read', 'write', 'edit'].every(name => scopedTools.includes(name))) throw Error('Scoped worker lacks edit tools: ' + JSON.stringify({ work: result.scopedWork.status, scopedTools }));
  result.checks.push('D1/D6 single whole-repo grant: unscoped worker gets that scope; receipt names it');

  // Scout stays read-only (2).
  await ask('MARK-S1');
  const scout = await eventually(async () => { const w = await workIn(id, 'MARK-S1TASK'); return ['completed', 'failed'].includes(w.status) && w; }, 'scout settled');
  if ((await receipts(id)).at(-1).workspaceScopeId !== null || scout.status !== 'completed' || workerTools('MARK-S1TASK').flat().some(name => ['write', 'edit', 'bash'].includes(name))) throw Error('Scout got a scope: ' + JSON.stringify(scout.status));
  result.checks.push('D2 scout stays unscoped and read-only');

  // Questions: new project has the tool (8) and it reaches Needs you (11).
  const coordTools = (toolsSeen['coord:MARK-W1'] ?? [])[0] ?? [];
  if (!coordTools.includes('projects_question')) throw Error('New project coordinator lacks projects_question: ' + coordTools);
  if ((await rpc({ action: 'settings-snapshot', id })).values.decisionAccess !== 'coordinator') throw Error('New project decisionAccess not coordinator');
  result.checks.push('D8 new project coordinator has projects_question (decisionAccess coordinator)');
  await ask('MARK-ASK');
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#needs-card')?.offsetParent && document.querySelector('#needs-card').innerText.includes('MARK-QTITLE') && document.querySelector('#needs-card').innerText.includes('MARK-RED') && /1 thing needs your call/i.test(document.querySelector('#eyebrow').innerText)`, s, 'question in Needs you');
  await shot('01-question', s);
  result.checks.push('D11 coordinator question shows in Needs you with choices and header count');

  // Answering wakes the coordinator with the question and the answer (12, 13); the raw note document stays out of the rail (15).
  await evaluate(`[...document.querySelectorAll('#letter .choices button')].find(b => b.innerText === 'MARK-RED').click()`, s);
  const delivered = await eventually(async () => (await rpc({ action: 'show', id })).messages.find(m => m.role === 'user' && m.text.includes('MARK-QTITLE') && m.text.includes('MARK-RED')), 'answer not delivered to coordinator');
  await eventually(async () => (await rpc({ action: 'show', id })).jobs.every(job => ['done', 'failed', 'interrupted'].includes(job.state)), 'answer turn did not settle');
  await waitFor(`!document.querySelector('#needs-card').offsetParent && document.querySelector('#messages').innerText.includes('MARK-RED') && !document.querySelector('#notes').innerText.includes('research/legacy')`, s, 'answer delivered in UI');
  await shot('02-answered', s);
  result.delivered = delivered.text;
  result.checks.push('D12/D13/D15 answering wakes the coordinator with question + answer; Needs you clears; no raw note doc in rail');
  // A paused project still records the answer and does not error (14).
  await ask('MARK-ASK again');
  const pending = await eventually(async () => (await rpc({ action: 'show', id })).inbox.find(item => item.kind === 'question' && !item.result), 'second question missing');
  await rpc({ action: 'pause', id });
  await eventually(async () => (await rpc({ action: 'show', id })).paused, 'not paused');
  const recorded = await rpc({ action: 'answer', id, entry: pending.id, text: 'MARK-BLUE' });
  if (!recorded.result || (await rpc({ action: 'show', id })).inbox.find(item => item.id === pending.id)?.result?.text !== 'MARK-BLUE') throw Error('Paused answer not recorded: ' + JSON.stringify(recorded));
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  result.checks.push('D14 answering while paused records the answer without error');
  // Explicit none is respected (10).
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { decisionAccess: 'none' } });
  await ask('MARK-NOQ');
  if ((toolsSeen['coord:MARK-NOQ'] ?? []).flat().includes('projects_question')) throw Error('decisionAccess none still exposes projects_question');
  result.checks.push('D10 explicit decisionAccess none removes the tool');
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
