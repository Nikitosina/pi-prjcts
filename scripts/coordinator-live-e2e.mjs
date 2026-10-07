// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in coordinator-live-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `coordinator-live-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `coordinator-live-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');

const failedOnce = new Set();
const finished = {};
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const msgs = JSON.parse(body).messages;
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const marker = /MARK-[A-Z]+/.exec(String(msgs[lastUser]?.content ?? ''))?.[0] ?? 'none';
    const stage = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').length;
    result.calls.push({ at: Date.now(), marker, stage });
    if (marker === 'MARK-RETRY' && !failedOnce.has(marker)) { failedOnce.add(marker); res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fake overloaded once' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (marker === 'MARK-KNOW' && stage === 0) {
      res.end(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'projects_knowledge_write', arguments: JSON.stringify({ path: 'research/live-test.md', text: '# Live test\n\nKNOW-BODY', expectedRevision: null }) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
      return;
    }
    if (marker === 'MARK-SLOW') {
      await delay(3000); // silent "thinking" before the first token
      res.write(chunk({ role: 'assistant', content: 'LIVE-PART-ONE ' }, null));
      await delay(3000);
      res.write(chunk({ content: 'LIVE-PART-TWO' }, null));
      await delay(500);
      finished[marker] = Date.now();
      res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    res.end(chunk({ role: 'assistant', content: `Answer ${marker}` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
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
const liveText = s => evaluate(`(() => { const n = document.querySelector('#live-reply'); return n && !n.hidden ? n.innerText : ''; })()`, s);
try {
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  const create = async name => {
    const created = await rpc({ action: 'create', requestId: randomUUID(), name, cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' });
    const settings = await rpc({ action: 'settings-snapshot', id: created.id });
    await rpc({ action: 'settings-update', id: created.id, confirm: created.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    return created;
  };
  const a = await create('Live A'), b = await create('Live B');
  const web = await rpc({ action: 'web' });
  const origin = new URL(web.url).origin, token = new URL(web.url).hash.slice('#token='.length);

  const anonymous = await fetch(`${origin}/live?project=${a.id}`);
  const unknown = await fetch(`${origin}/live?project=${randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
  if (anonymous.status !== 401 || unknown.ok) throw Error(`Live auth: anonymous ${anonymous.status}, unknown ${unknown.status}`);
  await anonymous.body?.cancel(); await unknown.body?.cancel();
  result.checks.push('L1 /live rejects missing token and unknown project');

  const launch = new URL(web.url); launch.searchParams.set('project', a.id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#compose textarea') && !document.querySelector('#compose textarea').disabled && document.querySelector('#title').innerText === 'Live A'`, s, 'project A loaded');

  const slow = await rpc({ action: 'message', id: a.id, text: 'MARK-SLOW stream please' });
  await waitFor(`/thinking|working/i.test(document.querySelector('#live-reply')?.innerText ?? '') && !document.querySelector('#live-reply').hidden`, s, 'thinking indicator', 40);
  if (result.calls.filter(c => c.marker === 'MARK-SLOW').length !== 1 || /LIVE-PART/.test(await liveText(s))) throw Error('Thinking check raced the first token');
  result.checks.push('L2 waiting for first token shows a live thinking indicator');
  await shot('01-thinking', s);
  await waitFor(`(document.querySelector('#live-reply')?.innerText ?? '').includes('LIVE-PART-ONE')`, s, 'partial text', 40);
  const partial = await liveText(s), slowState = (await rpc({ action: 'show', id: a.id })).jobs.find(j => j.id === slow.id).state;
  if (partial.includes('LIVE-PART-TWO') || slowState === 'done') throw Error('Partial text was not partial: ' + JSON.stringify({ partial, slowState }));
  result.checks.push('L3 partial answer text streams before the turn commits');
  await shot('02-partial', s);

  await settle(a.id, slow);
  await waitFor(`(document.querySelector('#messages').innerText.includes('LIVE-PART-TWO')) && document.querySelector('#live-reply').hidden`, s, 'final message replaces live bubble', 40);
  const lag = Date.now() - finished['MARK-SLOW'];
  const copies = await evaluate(`document.querySelector('#messages').innerText.split('LIVE-PART-TWO').length - 1`, s);
  if (copies !== 1) throw Error(`Final text shown ${copies} times`);
  result.checks.push(`L4 final message replaces live bubble once (${lag} ms after stream end)`);
  result.finalLagMs = lag;

  const retry = await rpc({ action: 'message', id: a.id, text: 'MARK-RETRY once' });
  await waitFor(`/retry/i.test(document.querySelector('#live-reply')?.innerText ?? '') && /overloaded/i.test(document.querySelector('#live-reply').innerText)`, s, 'retry indicator', 40);
  await shot('03-retrying', s);
  if ((await settle(a.id, retry)).state !== 'done') throw Error('Retry turn failed');
  result.checks.push('L5 model retry backoff is shown with its error');

  const know = await rpc({ action: 'message', id: a.id, text: 'MARK-KNOW save it' });
  if ((await settle(a.id, know)).state !== 'done') throw Error('Knowledge turn failed');
  await waitFor(`document.querySelector('#notes').innerText.includes('research/live-test.md')`, s, 'memory card lists knowledge doc', 40);
  result.checks.push('L6 Project memory card lists coordinator-written doc without reload');
  await evaluate(`document.querySelector('[data-tab="knowledge"]').click()`, s);
  await waitFor(`(document.querySelector('#knowledge-inline')?.innerText ?? '').includes('research/live-test.md')`, s, 'inline knowledge list', 40);
  await evaluate(`document.querySelector('#knowledge-inline [data-path="research/live-test.md"]').click()`, s);
  await waitFor(`document.querySelector('dialog')?.open && document.querySelector('dialog').innerText.includes('KNOW-BODY')`, s, 'doc opens', 40);
  result.checks.push('L7 Knowledge tab lists docs inline; click opens the doc');
  await shot('04-knowledge', s);
  await evaluate(`document.querySelector('dialog').close(); document.querySelector('[data-tab="coordinator"]').click()`, s);

  const leak = await rpc({ action: 'message', id: a.id, text: 'MARK-SLOW second stream' });
  await waitFor(`/thinking|working|LIVE-PART/i.test(document.querySelector('#live-reply')?.innerText ?? '')`, s, 'A live again', 40);
  await evaluate(`document.querySelector('[data-select-project="${b.id}"]').click()`, s);
  await waitFor(`document.querySelector('#title').innerText === 'Live B'`, s, 'switched to B', 40);
  for (let i = 0; i < 16; i++) { if (await liveText(s)) throw Error('Project A stream leaked into B: ' + await liveText(s)); await delay(250); }
  result.checks.push('L8 switching projects drops the other project stream');
  await evaluate(`document.querySelector('[data-select-project="${a.id}"]').click()`, s);
  await settle(a.id, leak);
  await waitFor(`document.querySelector('#messages').innerText.split('LIVE-PART-TWO').length - 1 === 2 && document.querySelector('#live-reply').hidden`, s, 'A settled after switching back', 60);
  result.checks.push('L9 stream resumes after switching back');
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
