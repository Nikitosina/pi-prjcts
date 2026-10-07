// Browser E2E for one-click "Let workers edit this repo". Fresh isolated home and Git fixture. No model, no provider operations.
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp';
const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = process.env.ARTIFACT_DIR || join('/Users/nikitarat/.pi/agent/projects-mvp/artifacts', `workspace-quick-grant-ui-${stamp}`), root = process.env.REVIEW_ROOT ? realpathSync(process.env.REVIEW_ROOT) : join(realpathSync(tmpdir()), `workspace-quick-grant-ui-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace');
const result = { scope: 'one-click workspace grant UI', root, home, checks: [], errors: [], httpErrors: [], modelSubmissions: 0, grantsIssued: 0, providerOperations: 0 };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error('Unsafe runtime override; refused without clearing');
mkdirSync(artifacts, { recursive: true, mode: 0o700 }); mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
result.socket = socket;
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1' };
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
const dialogText = s => evaluate(`document.querySelector('#dialog').innerText`, s);
try {
  git('init', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E'); git('remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  writeFileSync(join(workspace, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-m', 'c1'); writeFileSync(join(workspace, 'README.md'), 'uncommitted\n');
  let health;
  for (let i = 0; i < 150; i++) { if (hostEnded) throw new Error('Host exited before health readiness'); try { health = await rpc(); break; } catch { await delay(200); } }
  if (!health || health.pid !== host.pid || health.home !== home) throw new Error('Owned host health readiness failed');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Quick Grant UI', cwd: workspace, objective: 'Disposable.' });
  result.projectId = project.id;
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', project.id); launch.searchParams.set('tab', 'settings'); launch.searchParams.set('e2e', '1');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }); chromeSession = s;
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#owner-steps [data-action=workspace-quick]')`, s, 'stepper one-click button');
  result.checks.push('Settings stepper offers "Let workers edit this repo" when no workspace is granted');
  await shot('01-stepper-before', s, true);

  await evaluate(`document.querySelector('#owner-steps [data-action=workspace-quick]').click()`, s);
  await waitFor(`!!document.querySelector('#dialog [data-action=workspace-quick-confirm]')`, s, 'confirm dialog');
  const summary = await dialogText(s);
  if (!/acme\/demo/.test(summary) || !/uncommitted changes/.test(summary) || !/worktrees/.test(summary)) throw new Error('Summary missing facts: ' + summary);
  if (await evaluate(`!!document.querySelector('#dialog input[name=confirm]')`, s)) throw new Error('Grant dialog still asks to type the project ID');
  result.checks.push('confirm dialog shows repo, worktree root, dirty warning; no typed project ID');
  await shot('02-confirm-dialog', s);

  await evaluate(`document.querySelector('#dialog [data-action=workspace-quick-confirm]').click()`, s);
  await waitFor(`/Workers can edit this repository/.test(document.querySelector('#dialog').innerText)`, s, 'granted state in owner setup');
  if (await evaluate(`document.querySelector('#dialog details.advanced').open`, s)) throw new Error('Advanced section should start collapsed');
  result.checks.push('Confirm grants access; owner setup shows granted state, Advanced collapsed');
  await shot('03-owner-setup-granted', s);
  const snap = await rpc({ action: 'owner-setup-snapshot', id: project.id });
  if (snap.workspace?.scopes?.length !== 1 || !snap.workspace.scopes[0].wholeRepository) throw new Error('API does not show the whole-repository scope');
  result.checks.push('API confirms exactly one whole-repository scope');

  await evaluate(`document.querySelector('#dialog details.advanced').open = true; document.querySelector('#dialog [data-kind=workspace-revoke]').click()`, s);
  await waitFor(`!!document.querySelector('#dialog form[data-owner-write][data-kind=workspace-revoke]')`, s, 'revoke form');
  if (!await evaluate(`!!document.querySelector('#dialog form[data-kind=workspace-revoke] input[name=confirm][required]')`, s)) throw new Error('Revoke lost its typed confirmation');
  result.checks.push('revoke still requires typing the project ID');
  await evaluate(`document.querySelector('#dialog [data-action=close-dialog]').click()`, s);
  await waitFor(`/Workers can edit this repository/.test(document.querySelector('#owner-steps').innerText) && !document.querySelector('#owner-steps [data-action=workspace-quick]')`, s, 'stepper done');
  result.checks.push('stepper marks workspace done and hides the one-click button');
  await shot('04-stepper-after', s, true);
  if (result.errors.length || result.httpErrors.length) throw new Error('Browser JS errors or HTTP failures captured');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
  try { result.diagnostic = await evaluate(`document.querySelector('#dialog').innerText.slice(0, 2000)`, chromeSession); } catch {}
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(1000); if (!cdpEnded) chrome.kill('SIGTERM'); }
  save();
}
if (!hostEnded) { try { await rpc({ action: 'shutdown' }); } catch (e) { result.shutdownError = String(e); } await Promise.race([hostExit, delay(10000)]); }
if (!hostEnded) host.kill('SIGTERM');
save(); log.end();
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, errors: result.errors, httpErrors: result.httpErrors, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
