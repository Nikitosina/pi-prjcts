// Opt-in verification loop on an isolated host, with a deterministic fake provider at the model seam and real everything else: git worktrees,
// trusted command execution, revision drift checks, artifacts and the durable plan. No real providers, no owner state.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = process.env.VERIFY_LOOP_EVIDENCE ?? join(repo, 'artifacts', `workers-conversation-tree-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `workers-conversation-tree-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], requests: [], reports: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const gates = new Map(); // marker -> { open, wait }
const gate = marker => { if (!gates.has(marker)) { let open; const wait = new Promise(ok => { open = ok; }); gates.set(marker, { open, wait }); } return gates.get(marker); };
const text = content => typeof content === 'string' ? content : JSON.stringify(content ?? '');

// One provider plays every role; the tools a request offers say who is asking. Worker behavior depends on the task marker and on whether a verification failure was handed back.
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, names = (input.tools ?? []).map(tool => tool.function?.name);
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), user = text(msgs[lastUser]?.content);
    const all = msgs.map(m => text(m.content)).join('\n'), marker = /MARK-[A-Z0-9]+/.exec(all)?.[0] ?? 'none';
    const turn = msgs.slice(lastUser + 1).filter(m => m.role === 'tool'), stage = turn.length, last = text(turn.at(-1)?.content);
    const role = names.includes('projects_delegate') ? 'coordinator' : names.includes('projects_verify_run') ? 'verifier' : names.includes('bash') ? 'worker' : 'other';
    result.requests.push({ at: Date.now(), role, model: input.model, marker, stage, tools: names, messages: msgs.length, user: user.slice(0, 160), last: last.slice(0, 500) });
    const reply = out => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(out); };
    try {
      if (role === 'coordinator') {
        if (user.startsWith('[Durable work')) { result.reports.push(user); return reply(say('Noted.')); }
        const task = user.match(/MARK-[A-Z0-9]+/)?.[0];
        if (task && stage === 0) return reply(call('projects_delegate', { task: `${task} write feature.txt`, acceptance: ['feature.txt exists in the repository and contains the word done', 'node check.mjs exits 0'] }));
        return reply(say('Delegated.'));
      }
      if (role === 'worker') {
        if (marker === 'MARK-NOCHANGE' && stage === 0) return reply(call('bash', { command: 'echo nope > feature.txt' }));
        if (/^\[Automatic verification failed\]/.test(user) && marker !== 'MARK-NOCHANGE' && stage === 0) { return reply(call('bash', { command: 'echo done > feature.txt' })); }
        if (marker === 'MARK-FREEZEPASS' && !user.startsWith('Frozen follow-up') && stage > 0) await gate('worker-ready').wait;
        if (stage === 0) return reply(call('bash', { command: marker === 'MARK-GOOD' || marker === 'MARK-BG' || marker === 'MARK-FREEZEPASS' ? 'echo done > feature.txt' : 'echo nope > feature.txt' }));
        return reply(say(`Worker finished ${marker}`));
      }
      if (role === 'verifier') {
        if (stage === 0) return reply(call('projects_skill_file', { skill: 'mini-verify' }));
        if (marker === 'MARK-BLOCKED') return stage === 1 ? reply(call('projects_verification_verdict', { summary: 'Cannot exercise the feature.', criteria: ['c1', 'c2'].map(id => ({ id, status: 'blocked', reason: 'no browser available' })) })) : reply(say('Recorded.'));
        if (marker === 'MARK-LEASE' && stage === 1) return reply(call('projects_lease_acquire', { resource: 'verification-loop-browser', ttlMinutes: 5 }));
        if (marker === 'MARK-BG' && stage === 1) return reply(call('projects_bg_start', { command: 'sleep 1; echo tampered > feature.txt', label: 'late verifier drift' }));
        if (stage === 1 || (marker === 'MARK-LEASE' || marker === 'MARK-BG') && stage === 2) {
          if (marker === 'MARK-LEASE') { const acquired = JSON.parse(last); (result.leases ??= []).push(acquired); if (!acquired.acquired) throw Error(`fresh verifier could not take released lease: ${last}`); }
          return reply(call('projects_verify_run', { command: marker === 'MARK-ESCAPE' ? 'echo tampered > feature.txt; node check.mjs' : 'node check.mjs; echo "exit-code-now=$?"; mkdir -p "$PI_ARTIFACTS_DIR"; cp feature.txt "$PI_ARTIFACTS_DIR/feature-seen.txt"; node check.mjs' }));
        }
        if (stage === 2 || (marker === 'MARK-LEASE' || marker === 'MARK-BG') && stage === 3) {
          if (marker === 'MARK-DRIFT') await gate('drift').wait;
          const run = JSON.parse(last), pass = run.exitCode === 0;
          const evidence = [{ runId: run.runId }, ...(existsSync(join(home, '..', 'unused')) ? [] : [])];
          return reply(call('projects_verification_verdict', { summary: pass ? 'check.mjs exits 0 on the worktree.' : 'check.mjs fails on the worktree.', criteria: [{ id: 'c1', status: pass ? 'pass' : 'fail', reason: pass ? 'feature.txt says done' : 'feature.txt does not say done', evidence }, { id: 'c2', status: pass ? 'pass' : 'fail', reason: pass ? 'exit 0' : `exit ${run.exitCode}`, evidence }] }));
        }
        if (marker === 'MARK-FREEZEPASS' || marker === 'MARK-FREEZEFAIL') await gate(`${marker}-verdict`).wait;
        return reply(say('Verdict recorded.'));
      }
      return reply(say('ok'));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
const modelEntry = id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 });
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [modelEntry('fake-model'), modelEntry('fake-judge')] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'a', mode: 0o600 });
let host, hostExit;
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 60000 }, res => {
      res.setEncoding('utf8');
      let data = ''; res.on('data', part => { data += part; }); res.on('end', () => { try { const reply = JSON.parse(data); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = Number(process.env.E2E_TRIES ?? 1200)) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await delay(50); }
  throw Error(`Timed out: ${description}`);
}
async function startHost() {
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
  hostExit = new Promise(ok => host.once('exit', ok));
  await eventually(async () => { try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'owned host did not start');
}
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const plan = id => rpc({ action: 'plan-snapshot', id });
const settingsUpdate = async (id, changes) => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: (await rpc({ action: 'settings-snapshot', id })).revision, changes });
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const cycleOf = (snapshot, work) => snapshot.verification?.[work.threadId];
const delegateTask = async (id, marker) => { const job = await rpc({ action: 'message', id, text: `${marker} please do the task` }); await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(j => j.id === job.id)?.state === 'done', `coordinator turn for ${marker}`); return eventually(async () => (await plan(id)).work.find(w => w.role === 'worker' && w.text.includes(marker)), `worker for ${marker}`); };
const settled = (snapshot, work) => { const cycle = cycleOf(snapshot, work); return cycle && !cycle.open && cycle; };
const waitCycle = async (id, marker) => { const worker = await delegateTask(id, marker); const cycle = await eventually(async () => settled(await plan(id), worker), `${marker} cycle did not end`); return { worker, cycle, snapshot: await plan(id) }; };
const reportFor = (marker, needle) => result.reports.find(report => report.includes(marker) && report.includes(needle));
let peak = 0; const watcher = (id) => { let stop = false; (async () => { while (!stop) { try { peak = Math.max(peak, (await plan(id)).work.filter(w => w.status === 'running').length); } catch { /* host restarting */ } await delay(25); } })(); return () => { stop = true; }; };

result.errors = []; result.httpErrors = [];
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
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
async function shot(name, session) { if (process.env.E2E_SHOTS !== '1') return; const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, session); writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); }
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries * 2.5; i++) { if (await evaluate(expression, session).catch(error => { if (i > 100) throw error; return false; })) return; await delay(100); }
  throw Error(`Timed out waiting for ${label}`);
}

async function click(selector, session) {
  const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; node.scrollIntoView({block: 'center'}); const r = node.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, hit: node.contains(document.elementFromPoint(x, y)) }; })()`, session);
  if (!point?.hit) throw Error(`Click target is not visible: ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, session);
}
try {
  git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
  git(workspace, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  mkdirSync(join(workspace, '.agents/skills/mini-verify'), { recursive: true });
  writeFileSync(join(workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Verify feature.txt with node check.mjs.\n---\nRun node check.mjs.\n');
  writeFileSync(join(workspace, 'check.mjs'), "import { readFileSync } from 'node:fs'; process.exit(readFileSync('feature.txt','utf8').trim() === 'done' ? 0 : 1);\n");
  writeFileSync(join(workspace, 'README.md'), 'demo\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'base');
  await startHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Conversation tree', cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' });
  const id = project.id;
  await settingsUpdate(id, { workerCap: 1, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model', verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'mini-verify' } });
  const loop = await waitCycle(id, 'MARK-LOOP');
  const worker = await delegateTask(id, 'MARK-FREEZEPASS');
  await eventually(async () => result.requests.some(r => r.role === 'worker' && r.marker === 'MARK-FREEZEPASS' && r.stage > 0), 'held worker');
  const initial = await plan(id);
  const verifiers = initial.work.filter(w => w.role === 'verifier' && w.parentThreadId === loop.worker.threadId);
  check('fixture has two real verifier conversations and a running second worker', verifiers.length === 2 && initial.work.find(w => w.id === worker.id)?.status === 'running', initial.work);
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#activity [data-conversation="${worker.threadId}"] .worker-line')`, s, 'running conversation');
  await click(`#activity [data-conversation="${worker.threadId}"] .worker-line`, s);
  await waitFor(`!document.querySelector('#inline-thread').hidden && !!document.querySelector('[data-inline-thread-send] textarea')`, s, 'worker view');
  for (const value of ['Frozen follow-up one', 'Frozen follow-up two']) {
    await click('[data-inline-thread-send] textarea', s);
    await send('Input.insertText', { text: value }, s);
    await click('[data-inline-thread-send] button[type=submit]', s);
    await eventually(async () => (await plan(id)).work.some(w => w.threadId === worker.threadId && w.text === value && w.status === 'queued'), `queued ${value}`);
    await waitFor(`!document.querySelector('[data-inline-thread-send] textarea').value`, s, 'composer clears');
  }
  await click('[data-action=thread-close]', s);
  await waitFor(`document.querySelector('#inline-thread').hidden`, s, 'return to tree');
  await click('#activity [data-action=all-work]', s);
  await waitFor(`!!document.querySelector('#activity [data-conversation="${loop.worker.threadId}"] .work-children')`, s, 'verifier children');
  const snapshot = await plan(id);
  const state = await evaluate(`(() => { const parent = document.querySelector('#activity [data-conversation="${loop.worker.threadId}"]'); const running = document.querySelector('#activity [data-conversation="${worker.threadId}"]'); return { children: [...parent.querySelectorAll(':scope > .work-children > [data-conversation]')].map(n => n.dataset.conversation), queue: [...running.querySelectorAll(':scope > .conversation-section .conversation-task')].map(n => n.innerText), nodes: [...document.querySelectorAll('#activity [data-conversation]')].map(n => n.dataset.conversation), html: document.querySelector('#activity').innerText }; })()`, s);
  writeFileSync(join(artifacts, 'plan.json'), JSON.stringify(snapshot, null, 2));
  writeFileSync(join(artifacts, 'dom.json'), JSON.stringify(state, null, 2));
  check('DOM matches stored verifier parent links', verifiers.every(w => state.children.includes(w.threadId)), { state, verifiers });
  check('each conversation appears once', new Set(state.nodes).size === state.nodes.length, state.nodes);
  const queue = snapshot.work.filter(w => w.threadId === worker.threadId && w.status === 'queued');
  check('UI follow-ups and persisted queue agree in order', queue.length === 2 && state.queue.join('\n').indexOf(queue[0].text) < state.queue.join('\n').indexOf(queue[1].text) && state.queue.join('\n').includes(queue[0].text) && state.queue.join('\n').includes(queue[1].text), { queue, state: state.queue });
  const summary = `#activity [data-conversation="${loop.worker.threadId}"] > details > summary`;
  await click(summary, s);
  await waitFor(`document.querySelector(${JSON.stringify(summary)}).parentElement.open`, s, 'history opens');
  await delay(5000);
  check('history and focus survive polling', await evaluate(`document.querySelector(${JSON.stringify(summary)}).parentElement.open && document.activeElement === document.querySelector(${JSON.stringify(summary)})`, s));
  check('context appears at most once per conversation, never on work rows', await evaluate(`([...document.querySelectorAll('#activity [data-conversation]')].every(n => n.querySelectorAll(':scope > .conversation-header .ctx-ring').length <= 1 && !n.querySelector(':scope > .conversation-section .ctx-ring, :scope > details .ctx-ring')))` , s));
  await shot('tree-light', s);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, s); await delay(300); await shot('tree-dark', s);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s); await delay(300);
  check('tree does not overflow narrow viewport', await evaluate('document.documentElement.scrollWidth <= innerWidth + 1', s)); await shot('tree-narrow', s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await click(`#activity [data-conversation="${verifiers[0].threadId}"] .worker-line`, s);
  await waitFor(`new URL(location.href).searchParams.get('worker') === '${verifiers[0].threadId}' && !!document.querySelector('#worker-messages')`, s, 'verifier conversation navigation');
  check('verifier header opens its real conversation', await evaluate(`new URL(location.href).searchParams.get('worker') === '${verifiers[0].threadId}'`, s));
  check('no browser errors', !result.errors.length && !result.httpErrors.length, { errors: result.errors, httpErrors: result.httpErrors });
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = String(error?.stack ?? error); process.exitCode = 1; }
finally {
  gate('worker-ready').open(); gate('MARK-FREEZEPASS-verdict').open();
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(10000)]); } catch { host?.kill('SIGKILL'); }
  model.closeAllConnections(); model.close(); save(); log.end();
  if (!process.exitCode) rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, error: result.error, artifacts }, null, 2));
