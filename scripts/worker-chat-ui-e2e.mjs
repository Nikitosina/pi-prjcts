// Browser E2E with an isolated host, Git fixture and local fake model. No real providers or GitHub.
// Failure cases written before UI implementation:
// C1 successful/error tool calls lack green/red backgrounds or safe expandable arguments/results.
// C2 pending worker tools lack gray backgrounds.
// C3 workers do not use chat bubbles/Markdown, or the composer precedes messages.
// C4 opened conversations do not refresh, or refresh destroys a typed follow-up.
// C5 closing/switching a worker lets stale responses reopen or overwrite it.
// C6 worker follow-ups cannot be sent with Enter, or history/controls disappear.
// C7 the dispatcher cannot run two independently delegated workers with cap 2.
// C8 long histories open at the oldest page, or older messages are inaccessible.
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp';
const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = join(repo, 'artifacts', `worker-chat-ui-${stamp}`), root = join(realpathSync(tmpdir()), `worker-chat-ui-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
const result = { scope: 'Worker chat, tool states and Durable parallel dispatch', root, home, checks: [], errors: [], httpErrors: [], modelCalls: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error('Unsafe runtime override; refused without clearing');
mkdirSync(artifacts, { recursive: true, mode: 0o700 }); mkdirSync(root, { recursive: true, mode: 0o700 }); for (const dir of [home, workspace, agentDir]) mkdirSync(dir, { mode: 0o700 });

let hold = true;
const held = new Set();
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const model = createServer((req, res) => {
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body);
    const coordinator = input.messages.some(m => /persistent coordinator/.test(m.content ?? ''));
    const marker = /MARK-[A-Z]+/.exec(body)?.[0] ?? 'none';
    result.modelCalls.push({ at: Date.now(), marker, coordinator });
    if (hold && marker === 'MARK-HOLD') { held.add(res); res.on('close', () => held.delete(res)); return; }
    const stage = input.messages.filter(m => m.role === 'tool').length;
    let tool;
    if (coordinator && marker === 'MARK-COORD') {
      if (stage === 0) tool = { name: 'projects_workspace_catalog', arguments: {} };
      if (stage === 1) tool = { name: 'projects_delegate', arguments: { role: 'scout', task: 'Must reject invalid scope ID', workspaceScopeId: 'not-a-scope' } };
    } else if (marker === 'MARK-CHAT') {
      if (stage === 0) tool = { name: 'read', arguments: { path: 'README.md' } };
      if (stage === 1) tool = { name: 'read', arguments: { path: 'missing.txt' } };
      if (stage === 2) tool = { name: 'bash', arguments: { command: 'sleep 6' } };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(tool
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + stage, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
      : chunk({ role: 'assistant', content: '**Done** with \`chat\`.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake-key', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));

const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
result.socket = socket;
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'wx', mode: 0o600 });
const host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
let hostEnded = false;
const hostExit = new Promise(resolve => host.once('exit', (code, signal) => { hostEnded = true; result.hostExit = { code, signal }; save(); resolve(); }));
function rpc(input) {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 90000 }, response => {
      let text = ''; response.on('data', part => { text += part; });
      response.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw new Error(reply.error); resolve(reply.data); } catch (e) { reject(e); } });
    });
    call.on('error', reject); call.end(input ? JSON.stringify(input) : undefined);
  });
}

// Minimal CDP over pipe.
let chromeSession, chrome, cdpEnded = false, id = 0, buffer = ''; const pending = new Map();
function startChrome() {
  const clog = createWriteStream(join(artifacts, 'chrome.log'), { flags: 'wx', mode: 0o600 });
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${join(root, 'chrome-profile')}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  chrome.stdout.pipe(clog); chrome.stderr.pipe(clog);
  chrome.once('exit', () => { cdpEnded = true; });
  chrome.stdio[4].on('data', chunk => {
    buffer += chunk.toString(); let end;
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
    const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression, session) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; }
async function shot(name, session, full = false) {
  const params = { format: 'png' };
  if (full) { const m = await send('Page.getLayoutMetrics', {}, session); params.clip = { x: 0, y: 0, width: 1440, height: Math.min(2400, Math.ceil(m.cssContentSize.height)), scale: 1 }; params.captureBeyondViewport = true; }
  const image = await send('Page.captureScreenshot', params, session);
  writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 });
}
async function waitFor(expression, session, label) {
  for (let i = 0; i < 60; i++) { if (await evaluate(expression, session)) return; await delay(250); }
  throw new Error(`Timed out waiting for ${label}`);
}



const git = (...args) => execFileSync('/usr/bin/git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
try {
  git('init', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E');
  writeFileSync(join(workspace, 'README.md'), 'base\\n'); git('add', '.'); git('commit', '-m', 'c1');
  let health;
  for (let i = 0; i < 150; i++) { if (hostEnded) throw Error('Host exited'); try { health = await rpc(); break; } catch { await delay(200); } }
  if (health?.pid !== host.pid || health.home !== home) throw Error('Owned host readiness failed');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Worker chat UI', cwd: workspace, objective: 'Disposable.', model: 'fake/fake-model' });
  result.projectId = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id: project.id });
  await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' }, workerCap: 2 } });
  const setup = await rpc({ action: 'owner-setup-snapshot', id: project.id });
  await rpc({ action: 'workspace-quick-grant', id: project.id, confirm: project.id, expectedRevision: setup.workspaceRevision });
  const scope = (await rpc({ action: 'workspace-catalog', id: project.id })).find(item => item.wholeRepository).id;
  result.scopeId = scope;
  const threadId = randomUUID(), heldThread = randomUUID();
  await rpc({ action: 'work-submit', id: project.id, threadId: heldThread, requestId: randomUUID(), workspaceScopeId: scope, text: 'MARK-HOLD Parallel companion' });
  await rpc({ action: 'work-submit', id: project.id, threadId, requestId: randomUUID(), workspaceScopeId: scope, text: 'MARK-CHAT Inspect README' });
  await rpc({ action: 'message', id: project.id, text: 'MARK-COORD Inspect scope then try an invalid scoped scout.' });
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', project.id);
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }); chromeSession = s;
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelectorAll('#messages .tool-call').length >= 2`, s, 'coordinator tool calls');
  const colors = await evaluate(`[...document.querySelectorAll('#messages .tool-call')].map(n => ({ status: n.dataset.status, color: getComputedStyle(n.querySelector('.tool-icon')).backgroundColor }))`, s);
  result.colors = colors;
  if (!colors.some(c => c.status === 'ok' && c.color === 'rgb(220, 235, 223)') || !colors.some(c => c.status === 'error' && c.color === 'rgb(246, 216, 211)')) throw Error('Coordinator state icon colours wrong: ' + JSON.stringify(colors));
  await evaluate(`document.querySelector('#messages .tool-call summary').click()`, s);
  if (!(await evaluate(`document.querySelector('#messages .tool-call pre').innerText.includes('Result:')`, s))) throw Error('Missing expanded tool result');
  result.checks.push('C1 coordinator tool colors and expandable results');
  await shot('01-coordinator-tools', s);
  const active = await rpc({ action: 'plan-snapshot', id: project.id });
  if (active.work.filter(w => w.status === 'running').length !== 2) throw Error('Workers were not concurrent');
  result.checks.push('C7 two workers execute concurrently at cap 2');
  await evaluate(`document.querySelector('[data-action="thread"][data-thread="${threadId}"]').click()`, s);
  await waitFor(`!!document.querySelector('#worker-messages .tool-call[data-status="pending"]')`, s, 'pending worker tool');
  if (!(await evaluate(`document.querySelector('#worker-messages .tool-call[data-status="pending"] .tool-icon')?.innerText === '…'`, s))) throw Error('Pending tool icon wrong');
  result.checks.push('C2 pending tool background');
  if (!(await evaluate(`!!document.querySelector('#worker-messages .msg.you .text') && document.querySelector('#worker-messages').compareDocumentPosition(document.querySelector('[data-inline-thread-send]')) & Node.DOCUMENT_POSITION_FOLLOWING`, s))) throw Error('Chat bubbles or composer order wrong');
  result.checks.push('C3 worker chat layout');
  await evaluate(`document.querySelector('[data-inline-thread-send] textarea').value = 'Keep this draft'; document.querySelector('[data-inline-thread-send] textarea').dispatchEvent(new Event('input', { bubbles: true }))`, s);
  await waitFor(`!!document.querySelector('#worker-messages .msg.them strong')`, s, 'live worker answer');
  if (await evaluate(`document.querySelector('[data-inline-thread-send] textarea').value`, s) !== 'Keep this draft') throw Error('Refresh lost draft');
  result.checks.push('C4 live refresh preserves draft');
  await shot('02-worker-chat', s);
  await evaluate(`document.querySelector('[data-inline-thread-send] textarea').focus()`, s);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, s);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, s);
  await waitFor(`document.querySelector('#worker-messages').innerText.includes('Keep this draft') && document.querySelector('[data-inline-thread-send] textarea').value === ''`, s, 'follow-up');
  result.checks.push('C6 Enter sends worker follow-up');
  await evaluate(`document.querySelector('[data-action="thread-close"]').click()`, s);
  await delay(2500);
  if (!(await evaluate(`document.querySelector('#inline-thread').hidden`, s))) throw Error('Closed worker reopened');
  result.checks.push('C5 close remains closed after refresh');
  for (let i = 0; i < 14; i++) {
    await rpc({ action: 'thread-send', id: project.id, threadId, requestId: randomUUID(), text: 'History turn ' + i });
    for (let j = 0; j < 100; j++) { const p = await rpc({ action: 'plan-snapshot', id: project.id }); if (!p.work.some(w => w.threadId === threadId && ['running', 'queued'].includes(w.status))) break; await delay(50); }
  }
  await evaluate(`document.querySelector('[data-action="thread"][data-thread="${threadId}"]').click()`, s);
  await waitFor(`document.querySelector('#worker-messages')?.innerText.includes('History turn 13')`, s, 'latest history page');
  await evaluate(`document.querySelector('#worker-history-pages [data-action="thread-history-page"]').click()`, s);
  await waitFor(`document.querySelector('#worker-messages')?.innerText.includes('MARK-CHAT')`, s, 'older history page');
  result.checks.push('C8 opens latest page with older history accessible');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, s);
  await shot('03-worker-mobile', s, true);
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
  try { result.diagnostic = await evaluate(`document.querySelector('#activity').innerText + '\\n---\\n' + document.querySelector('#dialog').innerText.slice(0, 2000)`, chromeSession); } catch {}
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(1000); if (!cdpEnded) chrome.kill('SIGTERM'); }
  save();
}
if (!hostEnded) { try { await rpc({ action: 'shutdown' }); } catch (e) { result.shutdownError = String(e); } await Promise.race([hostExit, delay(10000)]); }
if (!hostEnded) host.kill('SIGTERM');
for (const res of held) res.destroy();
model.close();
save(); log.end();
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, errors: result.errors, httpErrors: result.httpErrors, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
