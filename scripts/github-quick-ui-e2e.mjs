// Browser E2E for one-click "Connect GitHub" (owner setup step 2). Fresh isolated home, Git fixture, local bare remote and fake GitHub CLI. No model; never contacts GitHub.
// Failure list (before implementation): U1 stepper has no Connect GitHub button after step 1; U2 confirm dialog hides repo, numeric id, default branch, pi/ prefix or merge rule;
// U3 confirm still asks to type the project ID; U4 confirm does not store a one-click authorization; U5 Advanced opens by default; U6 stepper keeps the button after connecting;
// U7 the browser flow performs a GitHub write.
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp';
const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = process.env.ARTIFACT_DIR || join('/Users/nikitarat/.pi/agent/projects-mvp/artifacts', `github-quick-ui-${stamp}`), root = process.env.REVIEW_ROOT ? realpathSync(process.env.REVIEW_ROOT) : join(realpathSync(tmpdir()), `github-quick-ui-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace');
const result = { scope: 'one-click GitHub UI', root, home, checks: [], errors: [], httpErrors: [], modelSubmissions: 0, grantsIssued: 0, providerOperations: 0 };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error('Unsafe runtime override; refused without clearing');
mkdirSync(artifacts, { recursive: true, mode: 0o700 }); mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
result.socket = socket;
const bare = join(root, 'remote.git'), fakeGh = join(root, 'fake-gh'), ghState = join(root, 'fake-gh-state.json'), ghCalls = join(root, 'fake-gh-calls.jsonl');
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`); chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: 'acme/quick', default_branch: 'main' }, pulls: [] })); writeFileSync(ghCalls, '');
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: ghCalls };
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
  execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E'); git('remote', 'add', 'origin', 'https://github.com/acme/quick.git'); git('config', 'remote.origin.pushurl', bare);
  writeFileSync(join(workspace, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-m', 'c1'); git('push', '-q', 'origin', 'main');
  let health;
  for (let i = 0; i < 150; i++) { if (hostEnded) throw new Error('Host exited before health readiness'); try { health = await rpc(); break; } catch { await delay(200); } }
  if (!health || health.pid !== host.pid || health.home !== home) throw new Error('Owned host health readiness failed');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'GitHub Quick UI', cwd: workspace, objective: 'Disposable.' });
  result.projectId = project.id;
  const first = await rpc({ action: 'owner-setup-snapshot', id: project.id });
  await rpc({ action: 'workspace-quick-grant', id: project.id, confirm: project.id, expectedRevision: first.workspaceRevision });
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', project.id); launch.searchParams.set('tab', 'settings'); launch.searchParams.set('e2e', '1');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }); chromeSession = s;
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#owner-steps [data-action=github-quick]')`, s, 'stepper Connect GitHub button');
  if (!/Workers cannot open draft PRs yet/.test(await evaluate(`document.querySelector('#owner-steps').innerText`, s))) throw new Error('Step 2 copy missing');
  result.checks.push('U1 stepper offers "Connect GitHub" once workers can edit the repo');
  await shot('01-stepper-before', s, true);

  await evaluate(`document.querySelector('#owner-steps [data-action=github-quick]').click()`, s);
  await waitFor(`!!document.querySelector('#dialog [data-action=github-quick-confirm]')`, s, 'confirm dialog');
  const summary = await dialogText(s);
  for (const fact of [/acme\/quick/, /4242/, /\bmain\b/, /pi\//, /Merges always need your approval/]) if (!fact.test(summary)) throw new Error(`Summary missing ${fact}: ${summary}`);
  result.checks.push('U2 confirm dialog shows repo, numeric id, default branch, pi/ prefix and merge rule');
  if (await evaluate(`!!document.querySelector('#dialog input[name=confirm]')`, s)) throw new Error('GitHub dialog asks to type the project ID');
  result.checks.push('U3 no typed project ID');
  await shot('02-confirm-dialog', s);

  await evaluate(`document.querySelector('#dialog [data-action=github-quick-confirm]').click()`, s);
  await waitFor(`/GitHub connected/.test(document.querySelector('#dialog').innerText)`, s, 'connected state in owner setup');
  const snap = await rpc({ action: 'owner-setup-snapshot', id: project.id });
  const auth = snap.github?.[0];
  if (snap.github?.length !== 1 || auth.oneClick !== true || auth.numericId !== 4242 || auth.baseBranch !== 'main' || auth.branchPrefix !== 'pi/' || !auth.reviewReplies || !auth.localPublication) throw new Error('API lacks the one-click authorization: ' + JSON.stringify(snap.github));
  result.checks.push('U4 confirm stores a one-click authorization (4242, main, pi/, reviewReplies, localPublication)');
  if (await evaluate(`document.querySelector('#dialog details.advanced').open`, s)) throw new Error('Advanced section should start collapsed');
  result.checks.push('U5 owner setup shows GitHub connected with Advanced collapsed');
  await shot('03-owner-setup-connected', s);

  await evaluate(`document.querySelector('#dialog [data-action=close-dialog]').click()`, s);
  await waitFor(`/Draft PRs on acme\\/quick/.test(document.querySelector('#owner-steps').innerText) && !document.querySelector('#owner-steps [data-action=github-quick]')`, s, 'stepper done');
  result.checks.push('U6 stepper marks GitHub done and hides the button');
  await shot('04-stepper-after', s, true);
  const ghLog = readFileSync(ghCalls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  result.githubCalls = ghLog;
  if (!ghLog.length || ghLog.some(call => call.method !== 'GET')) throw new Error('Browser flow made a GitHub write or no fake GitHub read');
  result.checks.push('U7 only fake GitHub GETs were made');
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
