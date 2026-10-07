// Startup + browser render check for the project-home UI. Fresh isolated home. No model submissions, grants or provider operations.
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp';
const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = process.env.ARTIFACT_DIR || join('/Users/nikitarat/.pi/agent/projects-mvp/artifacts', `projects-chat-md-${stamp}`), root = process.env.REVIEW_ROOT ? realpathSync(process.env.REVIEW_ROOT) : join(realpathSync(tmpdir()), `projects-chat-md-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace');
const result = { scope: 'startup + browser render of project-home UI', root, home, checks: [], errors: [], httpErrors: [], modelSubmissions: 0, grantsIssued: 0, providerOperations: 0 };
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

try {
  result.pid = host.pid; result.node = process.version; save();
  let health;
  for (let i = 0; i < 150; i++) { if (hostEnded) throw new Error('Host exited before health readiness'); try { health = await rpc(); break; } catch { await delay(200); } }
  if (!health || health.pid !== host.pid || health.home !== home) throw new Error('Owned host health readiness failed');
  result.checks.push('owned host health ready');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'UI Review Alpha', cwd: workspace, objective: 'Disposable UI review. No execution grants.' });
  const second = await rpc({ action: 'create', requestId: randomUUID(), name: 'UI Review Beta', cwd: workspace, objective: 'Second disposable project for switching.' });
  result.projectId = project.id; result.secondProjectId = second.id; result.checks.push('two stable-ID projects created'); save();
  await rpc({ action: 'pause', id: project.id });
  await rpc({ action: 'resume', id: project.id });
  const initialEvents = await rpc({ action: 'event-log', id: project.id, offset: 0, limit: 20 });
  const initialHealth = await rpc({ action: 'host-health', id: project.id });
  if (!initialEvents.events.some(event => event.source === 'host-observed' && /paused:|resumed:/.test(JSON.stringify(event)))) throw new Error('Lifecycle events missing from event-log API');
  if (!(initialHealth.uptimeMs > 0)) throw new Error('host-health API did not report positive uptime');
  result.checks.push('event-log API includes pause/resume; host-health reports positive uptime');
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', project.id); launch.searchParams.set('e2e', '1');
  result.browserOrigin = launch.origin;

  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true }); chromeSession = s;
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#title')?.textContent === 'UI Review Alpha' && document.querySelector('#lifecycle') && !document.querySelector('#lifecycle').hidden`, s, 'project render');
  await waitFor(`location.hash === ''`, s, 'token fragment removed');
  result.checks.push('project rendered in headless Chrome; token fragment stripped from address bar');
  // A browser that re-creates the tab (e.g. Arc moving Little Arc into a window) loads the stripped URL in a fresh tab.
  const strippedUrl = await evaluate('location.href', s);
  const { targetId: tab2 } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s2 } = await send('Target.attachToTarget', { targetId: tab2, flatten: true });
  await send('Runtime.enable', {}, s2); await send('Page.navigate', { url: strippedUrl }, s2);
  await waitFor(`document.querySelector('#title')?.textContent === 'UI Review Alpha' && document.querySelector('#error').hidden`, s2, 'fresh tab without #token stays authenticated');
  await send('Target.closeTarget', { targetId: tab2 });
  result.checks.push('fresh tab on the token-less URL stays authenticated (re-created tab case)');
  const sidebar = await evaluate(`[...document.querySelectorAll('#project-list .proj')].map(n => n.textContent.trim())`, s);
  if (!sidebar.some(t => t.includes('UI Review Alpha')) || !sidebar.some(t => t.includes('UI Review Beta'))) throw new Error('Sidebar projects missing: ' + JSON.stringify(sidebar));
  result.checks.push('sidebar lists both projects');
  await waitFor(`[...document.querySelectorAll('[data-panel]')].filter(n => getComputedStyle(n).display !== 'none').map(n => n.dataset.panel).join() === 'coordinator' && !!document.querySelector('#messages .empty-chat') && !document.querySelector('#compose textarea').disabled`, s, 'coordinator default view with enabled composer');
  result.checks.push('coordinator chat is the default tab; composer enabled');
  await shot('01-coordinator', s);

  for (const [n, name] of [['02', 'knowledge'], ['03', 'activity'], ['04', 'observability'], ['05', 'settings']]) {
    await evaluate(`document.querySelector('.tabs [data-tab=${name}]').click()`, s);
    await waitFor(`!document.querySelector('[data-panel=${name}]').hidden && [...document.querySelectorAll('[data-panel]')].filter(n => getComputedStyle(n).display !== 'none').map(n => n.dataset.panel).join() === '${name}' && new URL(location.href).searchParams.get('tab') === '${name}'`, s, `${name} tab`);
    if (name === 'observability') await waitFor(`!document.querySelector('#obs-usage').textContent.includes('Reading')`, s, 'usage counters loaded');
    await delay(400);
    await shot(`${n}-${name}`, s, true);
    result.checks.push(`${name} tab is the only visible panel (computed style); URL tab param updated`);
  }
  result.observabilityText = await evaluate(`document.querySelector('[data-panel=observability]').innerText.slice(0, 3000)`, s);
  if (/Usage unavailable/.test(result.observabilityText)) throw new Error('Usage snapshot failed in observability tab');
  const observabilityViews = await evaluate(`({ events: document.querySelector('#obs-event-log').innerText, health: document.querySelector('#obs-health').innerText, time: document.querySelector('#obs-usage-time').innerText })`, s);
  if (!/host-observed|paused|resumed/i.test(observabilityViews.events) || !/Uptime[\\s\\S]*[1-9]/.test(observabilityViews.health) || /not available yet|unavailable/i.test(observabilityViews.events)) throw new Error('Observability API content did not render: ' + JSON.stringify(observabilityViews));
  result.checks.push('event log and host health render API-backed lifecycle and uptime content');

  await evaluate(`document.querySelector('#owner-setup-button').click()`, s);
  await waitFor(`document.querySelector('#dialog').open && /Advanced/.test(document.querySelector('#dialog').innerText) && /not a Git repository/.test(document.querySelector('#dialog').innerText)`, s, 'owner setup dialog');
  await shot('06-owner-setup-dialog', s);
  await evaluate(`document.querySelector('#dialog [data-action=close-dialog]').click()`, s);
  result.checks.push('existing owner setup dialog opens from Settings and closes');

  await evaluate(`document.querySelector('#project-list [data-select-project="${second.id}"]').click()`, s);
  await waitFor(`document.querySelector('#title').textContent === 'UI Review Beta' && new URL(location.href).searchParams.get('project') === '${second.id}' && document.querySelector('#project-list .proj.on')?.textContent.includes('UI Review Beta')`, s, 'project switch');
  result.checks.push('sidebar switches project; URL + highlighted item follow');

  await evaluate(`document.querySelector('.tabs [data-tab=knowledge]').click()`, s);
  await waitFor(`!document.querySelector('#compose textarea').disabled`, s, 'second project loaded (composer enabled)');
  result.slashPrecondition = await evaluate(`({ dialogOpen: document.querySelector('#dialog').open, active: document.activeElement?.tagName, tab: new URL(location.href).searchParams.get('tab') })`, s);
  await evaluate(`document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))`, s);
  await waitFor(`!document.querySelector('[data-panel=coordinator]').hidden && document.activeElement === document.querySelector('#compose textarea')`, s, '/ shortcut');
  result.checks.push('"/" switches to Coordinator and focuses composer');
  await shot('07-second-project', s);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(600);
  await shot('08-mobile', s);
  result.checks.push('narrow viewport screenshot captured');

  const frontend = await evaluate(`({ activity: !!document.querySelector('#inline-thread'), automation: !!document.querySelector('#automation-history'), stepper: document.querySelectorAll('#owner-steps li').length, timeline: !!document.querySelector('#obs-timeline'), events: !!document.querySelector('#obs-event-log'), usageTime: !!document.querySelector('#obs-usage-time') })`, s);
  if (!frontend.activity || !frontend.automation || frontend.stepper < 3 || !frontend.timeline || !frontend.events || !frontend.usageTime) throw new Error('Second-pass frontend panels are missing: ' + JSON.stringify(frontend));
  await evaluate(`document.querySelector('.tabs [data-tab=observability]').click()`, s);
  await waitFor(`document.querySelector('#obs-timeline').textContent.length > 0`, s, 'timeline placeholder or bars');
  await evaluate(`document.querySelector('.tabs [data-tab=settings]').click()`, s);
  await waitFor(`document.querySelector('#automation-history').dataset.loaded === 'true'`, s, 'automation history strip');
  const keyboard = await evaluate(`(() => { const area = document.querySelector('#compose textarea'); let submits=0; area.form.addEventListener('submit', e => { e.preventDefault(); e.stopImmediatePropagation(); submits++; }, { once:true }); area.value='Enter test'; const enter = new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}); area.dispatchEvent(enter); const shift = new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}); area.dispatchEvent(shift); return {enterSubmitted: submits === 1 && enter.defaultPrevented, shiftNotSubmitted: submits === 1 && !shift.defaultPrevented}; })()`, s);
  if (!keyboard.enterSubmitted || !keyboard.shiftNotSubmitted) throw new Error('Composer keyboard behavior failed: ' + JSON.stringify(keyboard));
  result.checks.push('inline worker, automation history, owner stepper, timeline and future observability placeholders rendered');
  result.checks.push('Enter submits; Shift+Enter remains a newline');
  const markdown = await evaluate(`(() => { const html = window.__projectsRenderMarkdown('# Heading\\n\\n- one\\n- **two**\\n1. ordered\\n2. item\\n> quote\\n> continuation\\n\`*literal*\` [link](https://example.test/?a=1&b=2) <img src=x onerror=alert(1)> [bad](javascript:alert(1))'); const node=document.createElement('div'); node.innerHTML=html; return {html, headings:node.querySelectorAll('h1').length, lists:node.querySelectorAll('ul').length, ordered:node.querySelectorAll('ol').length, quotes:node.querySelectorAll('blockquote').length, literal:node.querySelector('code')?.textContent, img:node.querySelector('img[onerror]') !== null, javascript:node.querySelector('a[href^=javascript]') !== null, href:node.querySelector('a')?.getAttribute('href')}; })()`, s);
  if (!markdown || markdown.headings !== 1 || markdown.lists !== 1 || markdown.ordered !== 1 || markdown.quotes !== 1 || markdown.literal !== '*literal*' || markdown.img || markdown.javascript || markdown.href !== 'https://example.test/?a=1&b=2') throw new Error('Markdown rendering or XSS check failed: ' + JSON.stringify(markdown));
  result.checks.push('Markdown headings, grouped lists, blockquotes, inline code, safe URL escaping and inert XSS payload');
  if (result.errors.length || result.httpErrors.length) throw new Error('Browser JS errors or HTTP failures captured');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
  try { result.diagnostic = await evaluate(`({ title: document.querySelector('#title').textContent, composeDisabled: document.querySelector('#compose textarea').disabled, dialogOpen: document.querySelector('#dialog').open, active: document.activeElement?.tagName, visible: [...document.querySelectorAll('[data-panel]:not([hidden])')].map(n => n.dataset.panel), error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent })`, chromeSession); } catch {}
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(1000); if (!cdpEnded) chrome.kill('SIGTERM'); }
  save();
}
if (result.status === 'passed' && process.env.KEEP_HOST === '1') {
  // Leave the isolated host running for owner review; open the authenticated URL in the default browser.
  const web = await rpc({ action: 'web' }); const url = new URL(web.url); url.searchParams.set('project', result.projectId);
  spawn('/usr/bin/open', [url.toString()], { stdio: 'ignore' });
  result.leftRunningForReview = true; save();
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, artifact: artifacts }));
  await hostExit;
} else {
  if (!hostEnded) { try { await rpc({ action: 'shutdown' }); } catch (e) { result.shutdownError = String(e); } await Promise.race([hostExit, delay(10000)]); }
  if (!hostEnded) host.kill('SIGTERM');
  save(); log.end();
  console.log(JSON.stringify({ status: result.status, failure: result.failure, errors: result.errors, httpErrors: result.httpErrors, artifact: artifacts }));
  if (result.status !== 'passed') process.exitCode = 1;
}
