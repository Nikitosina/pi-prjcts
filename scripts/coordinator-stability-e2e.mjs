// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in coordinator-stability-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `coordinator-stability-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `coordinator-stability-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');

const dropped = new Set();
let failing = true;
const PROMPT_TOKENS = 32000, WINDOW = 128000;
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [], usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: 10, total_tokens: PROMPT_TOKENS + 10 } })}\n\n`;
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body), msgs = input.messages;
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const text = String(msgs[lastUser]?.content ?? '');
    const marker = /MARK-[A-Z]+/.exec(text)?.[0] ?? 'none';
    const stage = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').length;
    const key = `${marker}:${stage}`;
    result.calls.push({ at: Date.now(), marker, stage });
    // Drop the connection once per (marker, stage) to emulate a transport failure.
    if ((marker === 'MARK-DROP' && stage === 0) || (marker === 'MARK-TOOLDROP' && stage === 1)) {
      if (!dropped.has(key)) { dropped.add(key); req.socket.destroy(); return; }
    }
    if (marker === 'MARK-FAIL' && failing) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fake upstream overloaded for stability test' } })); return; }
    const tool = marker === 'MARK-TOOLDROP' && stage === 0 ? { name: 'projects_note', arguments: { text: 'NOTE-ONCE' } } : undefined;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(tool
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null) + chunk({}, 'tool_calls') + usage + 'data: [DONE]\n\n'
      : chunk({ role: 'assistant', content: `Answer ${marker}` }, null) + chunk({}, 'stop') + usage + 'data: [DONE]\n\n');
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: WINDOW, maxTokens: 4096 }] } } }));
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

let project;
const settle = async job => eventually(async () => { const view = await rpc({ action: 'show', id: project.id }); const found = view.jobs.find(j => j.id === job.id); return ['done', 'failed', 'interrupted'].includes(found?.state) && { job: found, view }; }, 'Job did not settle');
try {
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Coordinator stability', cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' });
  const settings = await rpc({ action: 'settings-snapshot', id: project.id });
  await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });

  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', project.id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#compose .context-meter')`, s, 'context meter before first response');
  const empty = await evaluate(`(() => { const m = document.querySelector('#compose .context-meter'); return { text: m.innerText + ' ' + m.getAttribute('aria-label'), sendSibling: m.closest('.row') === document.querySelector('#compose button[type="submit"]').closest('.row') }; })()`, s);
  if (/NaN|undefined/.test(empty.text) || !empty.sendSibling) throw Error('Empty context meter invalid: ' + JSON.stringify(empty));
  result.checks.push('S8 context meter renders next to Send before any usage without NaN');

  const drop = await settle(await rpc({ action: 'message', id: project.id, text: 'MARK-DROP transient' }));
  if (drop.job.state !== 'done') throw Error('Dropped request was not retried: ' + JSON.stringify(drop.job));
  if (result.calls.filter(c => c.marker === 'MARK-DROP').length !== 2) throw Error('Unexpected DROP attempts');
  result.checks.push('S1 transient connection drop retried; turn completes');

  const toolDrop = await settle(await rpc({ action: 'message', id: project.id, text: 'MARK-TOOLDROP note then drop' }));
  if (toolDrop.job.state !== 'done') throw Error('Post-tool drop not retried');
  const notesDir = join(home, project.id, 'notes');
  const noteCount = readdirSync(notesDir).filter(name => readFileSync(join(notesDir, name), 'utf8').includes('NOTE-ONCE')).length;
  if (noteCount !== 1) throw Error(`Tool replayed: ${noteCount} notes`);
  result.checks.push('S2 retry after executed tool does not repeat the tool');

  const fail = await settle(await rpc({ action: 'message', id: project.id, text: 'MARK-FAIL persistent' }));
  const failAttempts = result.calls.filter(c => c.marker === 'MARK-FAIL').length;
  if (fail.job.state !== 'failed' || failAttempts < 2 || failAttempts > 4) throw Error(`Persistent failure: ${fail.job.state}, ${failAttempts} attempts`);
  result.checks.push(`S3 persistent error stops after ${failAttempts} attempts`);
  if (!/overloaded|503/i.test(fail.job.error ?? '') || !/overloaded|503/i.test(fail.view.project.problem ?? '')) throw Error('Error text lost: ' + JSON.stringify(fail.job));
  await waitFor(`/overloaded|503/i.test(document.querySelector('#warning').innerText) && !!document.querySelector('#warning [data-action="retry-message"]')`, s, 'warning with error text and Retry');
  result.checks.push('S4 failed turn shows provider error text and a Retry button');
  await shot('01-failed-with-retry', s);

  // Dismiss: ✕ hides the warning across polls and reload; Retry untouched (D1-D4, D6).
  const rows = await evaluate(`[...document.querySelectorAll('#warning .notice-row')].map(r => ({ text: r.innerText, close: !!r.querySelector('button.notice-close[aria-label="Dismiss"]') }))`, s);
  if (!rows.length || rows.some(r => !r.close)) throw Error('Warning rows without ✕: ' + JSON.stringify(rows));
  await evaluate(`document.querySelector('#warning .notice-row:has([data-action="retry-message"]) .notice-close').click()`, s);
  await waitFor(`![...document.querySelectorAll('#warning .notice-row')].some(r => /overloaded|503/i.test(r.innerText))`, s, 'failed row dismissed');
  if ((await rpc({ action: 'show', id: project.id })).jobs.length !== (fail.view.jobs.length)) throw Error('✕ triggered Retry');
  await evaluate(`document.querySelector('#refresh').click()`, s); await delay(1500);
  if (await evaluate(`/overloaded|503/i.test(document.querySelector('#warning').innerText) && !document.querySelector('#warning').hidden`, s)) throw Error('Dismissed warning came back after poll');
  await send('Page.reload', {}, s);
  await waitFor(`!!document.querySelector('#compose .context-meter') && document.querySelector('#title').textContent === 'Coordinator stability'`, s, 'reloaded'); await delay(1500);
  if (await evaluate(`!document.querySelector('#warning').hidden && /overloaded|503/i.test(document.querySelector('#warning').innerText)`, s)) throw Error('Dismissed warning came back after reload');
  result.checks.push('S9 ✕ dismisses a warning row; stays hidden after poll and reload; does not Retry');
  // A new failure with different text shows again (D5).
  await rpc({ action: 'message', id: project.id, text: 'MARK-FAIL second' }).then(settle);
  await waitFor(`!document.querySelector('#warning').hidden && /overloaded|503/i.test(document.querySelector('#warning').innerText)`, s, 'new failure shown again (not hidden by old dismissal)');
  result.checks.push('S10 a later failure is shown despite an earlier dismissal');
  // Error box ✕ (D7).
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = '/skill:nope-missing do it'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#compose').requestSubmit(); })()`, s);
  await waitFor(`!document.querySelector('#error').hidden && /Unknown skill/.test(document.querySelector('#error').innerText)`, s, 'error shown');
  await shot('01b-error-with-close', s);
  await evaluate(`document.querySelector('#error .notice-close').click()`, s);
  await waitFor(`document.querySelector('#error').hidden`, s, 'error dismissed');
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = '/skill:other-missing do it'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#compose').requestSubmit(); })()`, s);
  await waitFor(`!document.querySelector('#error').hidden && /other-missing/.test(document.querySelector('#error').innerText)`, s, 'different error shown again');
  await evaluate(`(() => { document.querySelector('#error .notice-close').click(); const t = document.querySelector('#compose textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
  // The two refusals are expected 400s; anything else stays an error.
  const expected400 = e => / 400 /.test(e); if (result.errors.filter(expected400).length !== 2 || result.httpErrors.filter(h => h.status === 400).length !== 2) throw Error('Unexpected refusal errors');
  result.errors = result.errors.filter(e => !expected400(e)); result.httpErrors = result.httpErrors.filter(h => h.status !== 400);
  result.checks.push('S11 ✕ closes the error box; a different later error shows again');

  failing = false;
  const beforeJobs = (await rpc({ action: 'show', id: project.id })).jobs.length;
  await evaluate(`(() => { const b = document.querySelector('#warning [data-action="retry-message"]'); b.click(); b.click(); })()`, s);
  const retried = await eventually(async () => { const view = await rpc({ action: 'show', id: project.id }); const last = view.jobs.at(-1); return view.jobs.length > beforeJobs && last.state === 'done' && view; }, 'Retry did not complete');
  const added = retried.jobs.slice(beforeJobs);
  if (added.length !== 1 || added[0].text !== 'MARK-FAIL second') throw Error('Retry sent wrong/duplicate messages: ' + JSON.stringify(added));
  result.checks.push('S5 Retry resends the same text exactly once');
  if (retried.project.phase === 'attention' || retried.project.problem) throw Error('Attention stuck after success: ' + JSON.stringify({ phase: retried.project.phase, problem: retried.project.problem }));
  await waitFor(`document.querySelector('#warning').hidden || !/overloaded|503/i.test(document.querySelector('#warning').innerText)`, s, 'warning cleared');
  result.checks.push('S6 later success clears attention and the failure warning');

  const expected = Math.round(((PROMPT_TOKENS + 10) / WINDOW) * 100);
  await waitFor(`document.querySelector('#compose .context-meter').getAttribute('aria-label').includes('${expected}%')`, s, 'context percentage');
  const meter = await evaluate(`(() => { const m = document.querySelector('#compose .context-meter'); m.scrollIntoView({ block: 'center' }); const r = m.getBoundingClientRect(); return { label: m.getAttribute('aria-label'), x: r.x + r.width / 2, y: r.y + r.height / 2, stroke: !!m.querySelector('svg circle[stroke-dasharray]') }; })()`, s);
  if (!meter.stroke) throw Error('Meter is not a stroked circle');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: meter.x, y: meter.y }, s);
  await waitFor(`(() => { const t = document.querySelector('#compose .context-meter .context-popup'); return t && getComputedStyle(t).visibility === 'visible' && t.innerText.includes('${expected}%'); })()`, s, 'hover popup');
  result.checks.push(`S7 stroked context meter next to Send; hover popup shows ${expected}%`);
  result.meter = meter;
  await shot('02-context-popup', s);
  if (await evaluate(`!document.querySelector('#error').hidden && document.querySelector('#error').innerText`, s)) throw Error('Error banner shown: ' + await evaluate(`document.querySelector('#error').innerText`, s));
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { if (!hostEnded) { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(10000)]); } } catch { host.kill('SIGKILL'); }
  if (!hostEnded) host.kill('SIGKILL');
  model.closeAllConnections(); model.close(); log.end(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
