// Browser E2E for the sidebar "Workers" card and the paused hint near the coordinator composer. Fresh isolated home and Git fixture,
// local fake OpenAI-compatible model (no real model, no GitHub).
// Failure list (before implementation): W1 the card omits completed/running items or shows no role/status; W2 a running line has no elapsed time;
// W3 long task text is not shortened to one line; W4 a pause-interrupted line hides its reason; W5 the composer is disabled while paused with no
// "Paused" hint or Resume control; W6 the hint's Resume does not open the resume flow, or resume leaves interrupted work interrupted;
// W7 the card does not live-update to completed after resume; W8 the hint stays visible after resume.
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp';
const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = join(repo, 'artifacts', `workers-card-ui-${stamp}`), root = join(realpathSync(tmpdir()), `workers-card-ui-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
const result = { scope: 'Workers card + paused hint UI', root, home, checks: [], errors: [], httpErrors: [], modelCalls: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error('Unsafe runtime override; refused without clearing');
mkdirSync(artifacts, { recursive: true, mode: 0o700 }); mkdirSync(root, { recursive: true, mode: 0o700 }); for (const dir of [home, workspace, agentDir]) mkdirSync(dir, { mode: 0o700 });

// Fake model: answers "done" unless the request is for MARK-HOLD while holding.
let hold = true;
const held = new Set();
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const model = createServer((req, res) => {
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const marker = /MARK-[A-Z]+/.exec(body)?.[0] ?? 'none';
    result.modelCalls.push({ at: Date.now(), marker, held: hold && marker === 'MARK-HOLD' });
    if (hold && marker === 'MARK-HOLD') { held.add(res); res.on('close', () => held.delete(res)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: 'done' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
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
const card = s => evaluate(`document.querySelector('#activity').innerText`, s);
const lines = s => evaluate(`[...document.querySelectorAll('#activity .worker-line')].map(node => node.innerText.replace(/\\s+/g, ' ').trim())`, s);
try {
  git('init', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E');
  writeFileSync(join(workspace, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-m', 'c1');
  let health;
  for (let i = 0; i < 150; i++) { if (hostEnded) throw new Error('Host exited before health readiness'); try { health = await rpc(); break; } catch { await delay(200); } }
  if (!health || health.pid !== host.pid || health.home !== home) throw new Error('Owned host health readiness failed');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Workers Card UI', cwd: workspace, objective: 'Disposable.', model: 'fake/fake-model' });
  result.projectId = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id: project.id });
  await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' }, workerCap: 2 } });
  const setup = await rpc({ action: 'owner-setup-snapshot', id: project.id });
  await rpc({ action: 'workspace-quick-grant', id: project.id, confirm: project.id, expectedRevision: setup.workspaceRevision });
  const scope = (await rpc({ action: 'workspace-catalog', id: project.id })).find(item => item.wholeRepository).id;
  const longText = 'MARK-HOLD Rewrite the onboarding guide so that every section explains the setup steps for new contributors in plain words and adds examples';
  await rpc({ action: 'work-submit', id: project.id, threadId: randomUUID(), requestId: randomUUID(), workspaceScopeId: scope, text: 'MARK-OK Fix the typo in README' });
  await rpc({ action: 'work-submit', id: project.id, threadId: randomUUID(), requestId: randomUUID(), workspaceScopeId: scope, text: longText });
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', project.id); launch.searchParams.set('e2e', '1');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }); chromeSession = s;
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`[...document.querySelectorAll('#activity .worker-line')].some(n => /^completed/.test(n.innerText)) && [...document.querySelectorAll('#activity .worker-line')].some(n => /^running/.test(n.innerText))`, s, 'completed + running lines');
  let shown = await lines(s);
  result.linesRunning = shown;
  if (!shown.some(line => /^completed worker MARK-OK Fix the typo in README$/.test(line))) throw new Error('Completed line wrong: ' + JSON.stringify(shown));
  result.checks.push('W1 one line per item with status, role and title');
  await delay(2500);
  shown = await lines(s);
  const running = shown.find(line => line.startsWith('running'));
  if (!/^running worker MARK-HOLD .+ \d+s$/.test(running ?? '')) throw new Error('Running line lacks elapsed time: ' + running);
  result.checks.push('W2 running line shows elapsed time and live-updates');
  const title = await evaluate(`document.querySelector('#activity .worker-line.running .worker-title').innerText`, s);
  if (title.length > 60 || !title.endsWith('…')) throw new Error('Title not shortened: ' + title);
  result.checks.push('W3 long task text is clipped to 60 characters');
  await shot('01-workers-running', s, true);

  await rpc({ action: 'pause', id: project.id });
  await waitFor(`!document.querySelector('#paused-hint').hidden && [...document.querySelectorAll('#activity .worker-line')].some(n => /^interrupted/.test(n.innerText))`, s, 'paused hint + interrupted line');
  shown = await lines(s);
  if (!shown.some(line => /^interrupted worker MARK-HOLD .+ Interrupted by project pause$/.test(line))) throw new Error('Interrupted line lacks reason: ' + JSON.stringify(shown));
  result.checks.push('W4 interrupted line shows the pause reason');
  const hint = await evaluate(`document.querySelector('#paused-hint').innerText`, s);
  if (!/Paused/.test(hint) || !(await evaluate(`document.querySelector('#compose textarea').disabled`, s)) || !(await evaluate(`!!document.querySelector('#paused-hint [data-action=resume-project]')`, s))) throw new Error('Paused hint missing: ' + hint);
  result.checks.push('W5 paused hint with Resume next to the disabled composer');
  await shot('02-paused-hint', s, true);

  hold = false;
  await evaluate(`document.querySelector('#paused-hint [data-action=resume-project]').click()`, s);
  await waitFor(`!!document.querySelector('#dialog form[data-resume-project]')`, s, 'resume dialog');
  const dialog = await evaluate(`document.querySelector('#dialog').innerText`, s);
  if (!/restarts work the pause interrupted/.test(dialog)) throw new Error('Resume dialog copy: ' + dialog);
  await shot('03-resume-dialog', s);
  await evaluate(`(() => { const form = document.querySelector('#dialog form[data-resume-project]'); form.elements.confirm.value = ${JSON.stringify(project.id)}; form.requestSubmit(); })()`, s);
  result.checks.push('W6 hint Resume opens the resume flow');
  await waitFor(`document.querySelector('#paused-hint').hidden`, s, 'hint hidden after resume');
  result.checks.push('W8 hint hides after resume');
  await waitFor(`[...document.querySelectorAll('#activity .worker-line')].filter(n => /^completed/.test(n.innerText)).length === 2`, s, 'both completed after resume');
  result.linesDone = await lines(s);
  result.checks.push('W7 resumed work completes and the card live-updates');
  await shot('04-workers-done', s, true);
  if (result.errors.length || result.httpErrors.length) throw new Error('Browser JS errors or HTTP failures captured');
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
