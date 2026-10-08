// Browser E2E for the generic webhook: isolated host, local fake model. Deliveries are plain HTTP to the loopback listener. No real providers.
// Failure cases recorded in webhook-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `webhook-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `webhook-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), plain = join(root, 'plain'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, plain, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const say = value => chunk({ role: 'assistant', content: value }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
    const coordinator = tools.includes('projects_delegate');
    const userText = contentText(msgs[msgs.findLastIndex(m => m.role === 'user')]?.content);
    const kind = userText.startsWith('[Owner-local event') ? 'event' : userText.startsWith('[Durable work') ? 'report' : userText.includes('[Follow PRs auto-fix]') ? 'fix' : 'other';
    result.calls.push({ at: Date.now(), coordinator, kind, user: userText.slice(0, 3000), ...(coordinator ? {} : { tools }) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(say(coordinator ? `Noted ${kind}.` : `Fixed it (${kind}).`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
let host, hostEnded = false, hostExit, hostRun = 0;
function startHost() {
  const log = createWriteStream(join(artifacts, `host-${++hostRun}.log`), { flags: 'wx', mode: 0o600 });
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log); host.stderr.pipe(log);
  hostEnded = false; hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
}
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
const waitHost = () => eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
async function stopHost() { if (!hostEnded) { try { await rpc({ action: 'shutdown' }); } catch {} await Promise.race([hostExit, delay(15000)]); } if (!hostEnded) host.kill('SIGKILL'); }

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
async function shot(name, session) { const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, session); writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); }
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expression, session)) return; await delay(250); }
  throw Error(`Timed out waiting for ${label}`);
}

// Raw HTTP to the webhook listener (or any loopback URL); returns status, headers and parsed JSON.
function post(target, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target), data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-length': data.length, ...headers }, timeout: 60000 }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', error => error.code === 'EPIPE' || error.code === 'ECONNRESET' ? resolve({ status: 'reset' }) : reject(error));
    req.end(data);
  });
}
const sign = (secret, body) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

startHost();
try {
  await waitHost();
  const setup = async name => {
    const project = await rpc({ action: 'create', requestId: randomUUID(), name, cwd: workspace, objective: 'Disposable webhook fixture', model: 'fake/fake-model' });
    const settings = await rpc({ action: 'settings-snapshot', id: project.id });
    await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    return project.id;
  };
  const id = await setup('Hooked'), otherId = await setup('Other');
  const hooks = await rpc({ action: 'chat-create', id, title: 'Hooks' });
  const snap = () => rpc({ action: 'automation-snapshot', id });
  const events = async () => (await rpc({ action: 'schedule-history', id, kind: 'intents', limit: 100, textLimit: 4000 })).items.filter(item => item.kind === 'event');
  const idle = () => eventually(async () => !(await rpc({ action: 'show', id, chatId: hooks.id })).chats.some(c => c.busy), 'coordinator did not go idle', 600);
  const initial = await snap(), url = initial.webhook.url;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/hook\/[a-f0-9-]{36}$/.test(url) || !/^[a-f0-9]{64}$/.test(initial.webhook.secret) || initial.webhook.enabled) throw Error('Initial webhook snapshot wrong: ' + JSON.stringify(initial.webhook));

  // W4: disabled and unknown projects look the same.
  const disabled = await post(url, '{}', { authorization: `Bearer ${initial.webhook.secret}` });
  const unknown = await post(url.replace(/[a-f0-9-]{36}$/, randomUUID()), '{}', { authorization: `Bearer ${initial.webhook.secret}` });
  if (disabled.status !== 404 || unknown.status !== 404 || JSON.stringify(disabled.json) !== JSON.stringify(unknown.json)) throw Error('Disabled webhook answered: ' + JSON.stringify({ disabled, unknown }));
  result.checks.push('W4 a disabled webhook answers 404, the same as an unknown project');

  // UI: enable, route to Hooks, reveal the secret (W14).
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'settings');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#webhook-enabled') && [...document.querySelectorAll('#event-chat option')].some(o => o.textContent === 'Hooks')`, s, 'events card');
  const masked = await evaluate(`({ url: document.querySelector('#webhook-url').innerText, secret: document.querySelector('#webhook-secret').innerText })`, s);
  if (masked.url !== url || masked.secret.includes(initial.webhook.secret) || !/^•+$/.test(masked.secret)) throw Error('Secret not masked or URL missing: ' + JSON.stringify(masked));
  await evaluate(`(() => { document.querySelector('#event-chat').value = ${JSON.stringify(hooks.id)}; document.querySelector('#webhook-enabled').checked = true; document.querySelector('[data-action="automation-save"]').click(); })()`, s);
  await eventually(async () => { const v = await snap(); return v.webhook.enabled && v.eventChat === hooks.id; }, 'webhook opt-in not saved');
  await waitFor(`document.querySelector('#webhook-enabled')?.checked === true`, s, 'rerender');
  // Save leaves the card busy for a moment (buttons disabled); click Reveal once it is enabled.
  await waitFor(`!document.querySelector('[data-action="webhook-reveal"]').disabled`, s, 'reveal enabled');
  await evaluate(`document.querySelector('[data-action="webhook-reveal"]').click()`, s);
  await waitFor(`document.querySelector('#webhook-secret').innerText === ${JSON.stringify(initial.webhook.secret)}`, s, 'revealed secret');
  result.checks.push('W14 Settings shows the URL, masks the secret until Reveal, and saves enable + chat');
  await shot('01-settings-webhook', s);
  const secret = initial.webhook.secret;

  // W1/W5: authentication.
  await rpc({ action: 'automation-update', id: otherId, change: { webhook: { enabled: true } } });
  const otherSecret = (await rpc({ action: 'automation-snapshot', id: otherId })).webhook.secret;
  const body1 = JSON.stringify({ service: 'api', status: 'failed', note: 'MARK-HOOK1 deploy failed' });
  const webToken = new URL(web.url).hash.replace('#token=', '');
  const denied = await Promise.all([
    post(url, body1, { 'x-event-id': 'd1' }),
    post(url, body1, { 'x-event-id': 'd1', authorization: 'Bearer ' + 'f'.repeat(64) }),
    post(url, body1, { 'x-event-id': 'd1', 'x-hub-signature-256': sign('0'.repeat(64), body1) }),
    post(url, body1, { 'x-event-id': 'd1', 'x-hub-signature-256': sign(secret, body1 + ' ') }),
    post(url, body1, { 'x-event-id': 'd1', authorization: `Bearer ${otherSecret}` }),
    post(url, body1, { 'x-event-id': 'd1', authorization: `Bearer ${webToken}` }),
  ]);
  if (denied.some(r => r.status !== 401) || (await events()).length) throw Error('Bad credentials accepted: ' + JSON.stringify(denied.map(r => r.status)));
  const apiOnHook = await post(new URL('/api', url).toString(), JSON.stringify({ action: 'list' }), { authorization: `Bearer ${secret}`, 'content-type': 'application/json' });
  const hookOnWeb = await post(new URL(`/hook/${id}`, web.url).toString(), body1, { authorization: `Bearer ${secret}` });
  if (apiOnHook.status !== 404 || hookOnWeb.status === 202) throw Error('Endpoints cross over: ' + JSON.stringify({ apiOnHook: apiOnHook.status, hookOnWeb: hookOnWeb.status }));
  result.checks.push('W1/W2/W5 no secret, wrong bearer, wrong or body-mismatched HMAC, another project\'s secret and the browser token all get 401; the webhook port has no /api and the browser port has no /hook');

  // Bearer delivery into Hooks (W12).
  const first = await post(url, body1, { 'x-event-id': 'd1', 'x-event-type': 'deploy.finished', authorization: `Bearer ${secret}`, 'content-type': 'application/json' });
  if (first.status !== 202 || first.json?.duplicate !== false || first.json?.eventId !== 'd1') throw Error('Bearer delivery failed: ' + JSON.stringify(first));
  const [e1] = await eventually(async () => { const list = await events(); return list.length === 1 && list; }, 'no event');
  if (e1.conversationId !== hooks.conversationId || !e1.text.startsWith('[Owner-local event webhook.deploy.finished]') || !e1.text.includes('MARK-HOOK1') || !e1.text.includes('untrusted')) throw Error('Event wrong: ' + JSON.stringify(e1));
  await idle();
  if (result.calls.filter(c => c.coordinator && c.kind === 'event').length !== 1 || !result.calls.find(c => c.kind === 'event').user.includes('MARK-HOOK1')) throw Error('Coordinator did not get exactly one turn');
  result.checks.push('W12 a bearer delivery becomes one coordinator turn in the chat chosen in Settings, marked untrusted');

  // HMAC delivery with GitHub-style headers.
  const body2 = JSON.stringify({ ref: 'refs/heads/main', head_commit: { message: 'MARK-HOOK2 push' } });
  const signed = await post(url, body2, { 'x-github-event': 'push', 'x-github-delivery': 'd2', 'x-hub-signature-256': sign(secret, body2) });
  if (signed.status !== 202 || !(await eventually(async () => (await events()).find(e => e.text.startsWith('[Owner-local event webhook.push]') && e.text.includes('MARK-HOOK2')), 'HMAC event missing'))) throw Error('HMAC delivery failed: ' + JSON.stringify(signed));
  result.checks.push('W2 an HMAC-SHA256 signature of the raw body (X-Hub-Signature-256) is accepted; kind comes from X-GitHub-Event');
  await idle();

  // W6/W7/W8: duplicates.
  const count = (await events()).length;
  const dup = await post(url, body1, { 'x-event-id': 'd1', 'x-event-type': 'deploy.finished', authorization: `Bearer ${secret}` });
  const clash = await post(url, body1.replace('failed', 'passed'), { 'x-event-id': 'd1', 'x-event-type': 'deploy.finished', authorization: `Bearer ${secret}` });
  const noId1 = await post(url, 'plain MARK-NOID text', { authorization: `Bearer ${secret}` });
  await idle();
  const noId2 = await post(url, 'plain MARK-NOID text', { authorization: `Bearer ${secret}` });
  await idle();
  if (dup.status !== 200 || dup.json?.duplicate !== true || clash.status !== 409 || noId1.status !== 202 || noId2.status !== 200 || noId2.json?.duplicate !== true || (await events()).length !== count + 1) throw Error('Dedupe wrong: ' + JSON.stringify({ dup: dup.status, clash: clash.status, noId1: noId1.status, noId2: noId2.status }));
  result.checks.push('W6/W7/W8 a repeated delivery ID answers 200 duplicate, a reused ID with a new body gets 409, and without an ID the body hash deduplicates');

  // W11: binary body; W9: oversized body.
  const binary = await post(url, Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(' MARK-BIN')]), { authorization: `Bearer ${secret}`, 'content-type': 'application/octet-stream', 'x-event-id': 'bin1' });
  const binEvent = await eventually(async () => (await events()).find(e => e.text.includes('MARK-BIN')), 'binary event missing');
  if (binary.status !== 202 || !binEvent.text.includes('�')) throw Error('Binary body mishandled');
  const huge = await post(url, Buffer.alloc(2 * 1048576, 0x61), { authorization: `Bearer ${secret}`, 'x-event-id': 'huge' });
  if (huge.status !== 413 && huge.status !== 'reset') throw Error('Oversized body not refused: ' + huge.status);
  if ((await rpc()).pid !== host.pid) throw Error('Host died');
  result.checks.push('W9/W11 a binary body arrives as text with replacement characters; a 2 MiB body gets 413 and the host keeps running');
  await idle();

  // W15: event cards in the Hooks chat.
  const chatUrl = new URL(launch); chatUrl.searchParams.set('tab', 'coordinator'); chatUrl.searchParams.set('chat', hooks.id);
  await send('Page.navigate', { url: chatUrl.toString() }, s);
  await waitFor(`document.querySelectorAll('#messages .event-card.webhook').length >= 4`, s, 'webhook cards');
  const cards = await evaluate(`[...document.querySelectorAll('#messages .event-card.webhook summary b')].map(b => b.innerText)`, s);
  const raw = await evaluate(`document.querySelector('#messages').innerText.includes('[Owner-local event')`, s);
  if (!cards.includes('Webhook · deploy.finished') || !cards.includes('Webhook · push') || raw) throw Error('Cards wrong: ' + JSON.stringify(cards));
  await evaluate(`document.querySelector('#messages .event-card.webhook').open = true`, s);
  result.checks.push('W15 deliveries show as "Webhook · <type>" cards, not as owner messages');
  await shot('02-hooks-chat', s);

  // W3: rotate from the UI (two clicks), old secret refused, new accepted.
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('[data-action="webhook-rotate"]')`, s, 'rotate button');
  await evaluate(`document.querySelector('[data-action="webhook-rotate"]').click()`, s);
  await waitFor(`document.querySelector('[data-action="webhook-rotate"]').innerText.startsWith('Confirm')`, s, 'rotate armed');
  if ((await snap()).webhook.secret !== secret) throw Error('One click rotated the secret');
  await evaluate(`document.querySelector('[data-action="webhook-rotate"]').click()`, s);
  const rotated = await eventually(async () => { const v = await snap(); return v.webhook.secret !== secret && v.webhook.secret; }, 'secret not rotated');
  await waitFor(`document.querySelector('#webhook-secret').innerText === ${JSON.stringify(rotated)}`, s, 'new secret shown');
  const oldSecret = await post(url, '{"n":3}', { authorization: `Bearer ${secret}`, 'x-event-id': 'd3' });
  const newSecret = await post(url, '{"n":3}', { authorization: `Bearer ${rotated}`, 'x-event-id': 'd3' });
  if (oldSecret.status !== 401 || newSecret.status !== 202) throw Error('Rotation wrong: ' + JSON.stringify({ old: oldSecret.status, new: newSecret.status }));
  result.checks.push('W3 Rotate needs a confirming second click; afterwards the old secret gets 401 and the new one 202');
  await idle();

  // W13: same URL after a restart.
  await stopHost(); startHost(); await waitHost();
  const restarted = await snap();
  if (restarted.webhook.url !== url || restarted.webhook.secret !== rotated) throw Error('URL or secret changed on restart: ' + JSON.stringify(restarted.webhook));
  const afterRestart = await post(url, '{"n":4,"note":"MARK-RESTART"}', { authorization: `Bearer ${rotated}`, 'x-event-id': 'd4' });
  if (afterRestart.status !== 202) throw Error('Delivery after restart failed: ' + afterRestart.status);
  result.checks.push('W13 after a host restart the webhook URL and secret are unchanged and deliveries work');
  await idle();

  // W10: rate limit.
  const statuses = [];
  for (let i = 0; i < 25 && !statuses.includes(429); i++) statuses.push((await post(url, `{"burst":${i}}`, { authorization: `Bearer ${rotated}`, 'x-event-id': `burst-${i}` })).status);
  const limited = statuses.indexOf(429);
  if (limited < 0 || limited > 19 || statuses.slice(0, limited).some(code => code !== 202)) throw Error('Rate limit wrong: ' + JSON.stringify(statuses));
  result.checks.push(`W10 a burst is cut off with 429 after ${limited + 1} deliveries in a minute (20 per minute, counting the post-restart one)`);
  await idle();

  // Mobile layout of the card.
  const web2 = new URL((await rpc({ action: 'web' })).url); web2.searchParams.set('project', id); web2.searchParams.set('tab', 'settings');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await send('Page.navigate', { url: web2.toString() }, s);
  await waitFor(`!!document.querySelector('#webhook-url')`, s, 'mobile card');
  await evaluate(`document.querySelector('#events-in-card').scrollIntoView()`, s);
  if (!await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s)) throw Error('Webhook card overflows at 390px');
  await shot('03-settings-mobile', s);
  result.checks.push('W14 the webhook card fits a 390 px screen');

  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api'));
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured: ' + JSON.stringify(result.errors.concat(result.httpErrors)));
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  await stopHost().catch(() => host.kill('SIGKILL'));
  model.closeAllConnections(); model.close(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
