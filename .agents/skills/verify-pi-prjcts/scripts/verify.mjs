#!/usr/bin/env node
// Verification helper for pi-prjcts. Run from the repo root (or any checkout root):
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch   [--evidence <dir>]
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs doctor   --run <scratch>
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive    --run <scratch> <feature>
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs cleanup  --run <scratch>
// Features: message-coordinator
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, openSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.VERIFY_REPO ?? execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const CHROME = process.env.VERIFY_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROJECT_NAME = 'Verify seed';

const [command, ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const out = value => console.log(JSON.stringify(value, null, 2));
const fail = message => { console.error(`FAIL: ${message}`); process.exit(1); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const redact = value => String(value).replace(/token=[^&#\s"']+/gi, 'token=[redacted]');
const socketFor = home => join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);

function rpc(run, input) {
  return new Promise((ok, bad) => {
    const req = request({ socketPath: run.socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 60000 }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw Error(reply.error); ok(reply.data); } catch (error) { bad(error); } });
    });
    req.on('error', bad); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) { const value = await Promise.resolve().then(fn).catch(() => false); if (value) return value; if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(100); }
}
const loadRun = () => {
  const dir = flag('run') ?? fail('--run <scratch> is required (printed by launch)');
  const file = join(resolve(dir), 'run.json');
  if (!existsSync(file)) fail(`no run.json in ${dir}`);
  return JSON.parse(readFileSync(file, 'utf8'));
};

async function launch() {
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) fail('clear NODE_OPTIONS / PI_PACKAGE_DIR first');
  if (!existsSync(join(repo, 'node_modules'))) fail('node_modules missing: run `npm ci` in the checkout first');
  if (!existsSync(CHROME)) fail(`Chrome not found at ${CHROME}; set VERIFY_CHROME`);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const scratch = join(realpathSync(tmpdir()), `pi-verify-${id}`);
  const evidence = resolve(flag('evidence') ?? join(repo, 'artifacts', 'verify-pi-prjcts', id));
  const run = { id, scratch, evidence, repo, home: join(scratch, 'home'), workspace: join(scratch, 'workspace'), agentDir: join(scratch, 'agent'), userHome: join(scratch, 'userhome'), pids: {}, revision: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  run.socket = socketFor(run.home);
  for (const dir of [scratch, evidence, run.home, run.workspace, run.agentDir, run.userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const save = () => writeFileSync(join(scratch, 'run.json'), JSON.stringify(run, null, 2), { mode: 0o600 });
  save();
  try {
    // Seed workspace: a git repo with one commit (the New project dialog wants a real folder).
    const git = (...args) => execFileSync('/usr/bin/git', ['-C', run.workspace, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'verify@example.invalid'); git('config', 'user.name', 'Verify');
    writeFileSync(join(run.workspace, 'README.md'), 'verification workspace\n'); git('add', '.'); git('commit', '-qm', 'seed');
    // Fake model provider (the only external-model seam): its own detached process.
    run.requestLog = join(scratch, 'model-requests.jsonl'); const portFile = join(scratch, 'fake-provider.port');
    const fake = spawn(process.execPath, [join(here, 'fake-provider.mjs'), portFile, run.requestLog], { detached: true, stdio: 'ignore' });
    fake.unref(); run.pids.fakeProvider = fake.pid; save();
    run.fakePort = Number(await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8'), 'fake provider port'));
    writeFileSync(join(run.agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${run.fakePort}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
    // Host: private HOME, private project home (hence a private socket), offline, fake provider only.
    const env = { ...process.env, HOME: run.userHome, PI_PROJECTS_HOME: run.home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: run.agentDir, PI_OFFLINE: '1' };
    for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
    run.hostLog = join(scratch, 'host.log'); const logFd = openSync(run.hostLog, 'a');
    const host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, detached: true, stdio: ['ignore', logFd, logFd] });
    host.unref(); run.pids.host = host.pid; save();
    await until(async () => (await rpc(run)).pid === host.pid, 'host health answers with our pid');
    // Seed one project, pinned to the fake model, then wait until the browser URL is served.
    const project = await rpc(run, { action: 'create', requestId: randomUUID(), name: PROJECT_NAME, cwd: run.workspace, objective: 'Disposable verification project', model: 'fake/fake-model' });
    const settings = await rpc(run, { action: 'settings-snapshot', id: project.id });
    await rpc(run, { action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    run.projectId = project.id;
    run.webUrl = (await rpc(run, { action: 'web' })).url; save();
    await until(async () => (await fetch(new URL(run.webUrl).origin + '/')).ok, 'web page served');
    await until(async () => (await rpc(run, { action: 'list' })).some(p => p.id === run.projectId), 'seeded project listed');
    out({ ready: true, scratch, evidence, projectId: run.projectId, origin: new URL(run.webUrl).origin, hostPid: host.pid, fakeProvider: `127.0.0.1:${run.fakePort}` });
  } catch (error) {
    console.error(`launch failed: ${error.message}\nrunning cleanup on ${scratch}`);
    await cleanup(run, { quiet: true }); process.exit(1);
  }
}

async function doctor() {
  const run = loadRun(), checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), ...(ok ? {} : { detail }) });
  check('host process alive', alive(run.pids.host), run.pids.host);
  check('fake provider process alive', alive(run.pids.fakeProvider), run.pids.fakeProvider);
  const health = await rpc(run).catch(error => ({ error: error.message }));
  check('private socket answers with the pid we started', health.pid === run.pids.host, health);
  check('host home is our scratch home', health.home === run.home, { reported: health.home, expected: run.home });
  check('not the owner home', ![join(homedir(), '.pi/agent/projects'), join(homedir(), '.pi/agent/projects-mvp')].includes(run.home) && run.home.startsWith(run.scratch), run.home);
  check('revision matches checkout HEAD', execFileSync('git', ['-C', run.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === run.revision, run.revision);
  const url = new URL(run.webUrl);
  check('web listener is loopback', url.hostname === '127.0.0.1', url.hostname);
  check('web page serves', await fetch(url.origin + '/').then(r => r.ok, () => false), url.origin);
  const hostWeb = await rpc(run, { action: 'web' }).catch(() => ({}));
  check('web URL belongs to this host (same origin)', hostWeb.url && new URL(hostWeb.url).origin === url.origin, { expected: url.origin });
  check('seeded project listed', (await rpc(run, { action: 'list' }).catch(() => [])).some(p => p.id === run.projectId), run.projectId);
  const bad = checks.filter(item => !item.ok);
  out({ ok: bad.length === 0, checks });
  process.exit(bad.length ? 1 : 0);
}

// Raw CDP over a pipe, as scripts/lib/e2e-kit.mjs does.
async function openBrowser(run, sinks) {
  const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${join(run.scratch, 'chrome-profile')}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0, buffer = ''; const pending = new Map();
  chrome.stdio[4].on('data', part => {
    buffer += part.toString(); let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!text) continue;
      const msg = JSON.parse(text);
      if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.bad(Error(JSON.stringify(msg.error))) : p.ok(msg.result); } }
      else if (msg.method === 'Runtime.exceptionThrown') sinks.errors.push(redact(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
      else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') sinks.errors.push(redact(msg.params.entry.text));
      else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) sinks.httpErrors.push({ url: redact(msg.params.response.url), status: msg.params.response.status });
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
    const key = ++id; const timer = setTimeout(() => { pending.delete(key); bad(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { ok: v => { clearTimeout(timer); ok(v); }, bad: e => { clearTimeout(timer); bad(e); } });
    chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const page = {
    chrome,
    evaluate: async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; },
    navigate: url => send('Page.navigate', { url }, sessionId),
    cdp: (method, params) => send(method, params, sessionId),
    shot: async name => { const image = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(join(run.evidence, `${name}.png`), Buffer.from(image.data, 'base64')); },
    waitFor: (expression, label, ms = 30000) => until(() => page.evaluate(expression), label, ms),
    close: () => { try { chrome.kill('SIGTERM'); } catch {} },
  };
  return page;
}

const journeys = {
  // Feature: features/message-coordinator.md
  async 'message-coordinator'(run, page, record) {
    const prompt = `VERIFY-PING ${run.id}`;
    const origin = new URL(run.webUrl).origin;
    await page.navigate(run.webUrl);
    await page.waitFor(`document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, 'seeded project title shown');
    await page.waitFor(`!!document.querySelector('textarea[aria-label="Message coordinator"]')`, 'composer visible');
    await page.waitFor(`!document.querySelector('#sign-in')?.open`, 'sign-in dialog closed');
    record('entry', `opened ${origin} through the launch link; project "${PROJECT_NAME}" selected`);
    await page.shot('01-before-send');
    // Real user input: focus the composer, insert text through the browser input pipeline, click Send.
    await page.evaluate(`document.querySelector('textarea[aria-label="Message coordinator"]').focus()`);
    await page.cdp('Input.insertText', { text: prompt });
    await page.waitFor(`document.querySelector('textarea[aria-label="Message coordinator"]').value === ${JSON.stringify(prompt)}`, 'typed text in composer');
    await page.shot('02-typed');
    const before = existsSync(run.requestLog) ? readFileSync(run.requestLog, 'utf8').split('\n').filter(Boolean).length : 0;
    await page.evaluate(`document.querySelector('#compose button[type=submit]').click()`);
    record('action', `clicked "Send ↵" with message ${JSON.stringify(prompt)}`);
    await page.waitFor(`document.querySelector('#messages')?.innerText.includes('VERIFY-FAKE-REPLY: ${prompt}')`, 'coordinator reply rendered', 60000);
    await page.shot('03-reply');
    const messages = await page.evaluate(`document.querySelector('#messages').innerText`);
    writeFileSync(join(run.evidence, 'messages-dom.txt'), messages);
    record('visible', 'reply bubble contains VERIFY-FAKE-REPLY echo of the prompt');
    // Side effects: the model seam received the prompt, and the host's own stored transcript has both turns.
    const calls = readFileSync(run.requestLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (calls.length <= before || !calls.some(call => call.user.includes(prompt))) throw Error('fake provider never received the prompt');
    const view = await rpc(run, { action: 'show', id: run.projectId });
    const texts = (view.messages ?? []).map(m => `${m.role ?? m.from ?? '?'}: ${m.text}`);
    writeFileSync(join(run.evidence, 'host-show-messages.json'), JSON.stringify(texts, null, 2));
    if (!texts.some(t => t.includes(prompt)) || !texts.some(t => t.includes(`VERIFY-FAKE-REPLY: ${prompt}`))) throw Error(`host transcript lacks both turns: ${JSON.stringify(texts).slice(0, 500)}`);
    writeFileSync(join(run.evidence, 'model-requests.jsonl'), calls.map(c => JSON.stringify(c)).join('\n') + '\n');
    record('side-effect', `host \`show\` lists both turns; fake provider logged ${calls.length - before} new call(s) containing the prompt`);
  },
};

async function drive() {
  const run = loadRun(), name = positional[0], journey = journeys[name];
  if (!journey) fail(`unknown feature ${JSON.stringify(name)}; known: ${Object.keys(journeys).join(', ')}`);
  const sinks = { errors: [], httpErrors: [] }, steps = [];
  const record = (kind, detail) => { steps.push({ kind, detail, at: new Date().toISOString() }); console.log(`${kind}: ${detail}`); };
  const page = await openBrowser(run, sinks);
  let failure;
  try { await journey(run, page, record); } catch (error) { failure = error; try { await page.shot('99-failure'); } catch {} }
  page.close();
  writeFileSync(join(run.evidence, 'report.json'), JSON.stringify({ feature: name, entry: 'browser launch link', ok: !failure, error: failure?.message, steps, consoleErrors: sinks.errors, httpErrors: sinks.httpErrors, revision: run.revision }, null, 2));
  if (failure) fail(failure.message);
  if (sinks.errors.length || sinks.httpErrors.length) fail(`browser reported errors: ${JSON.stringify({ errors: sinks.errors, http: sinks.httpErrors }).slice(0, 800)}`);
  out({ ok: true, feature: name, evidence: run.evidence });
}

async function cleanup(run = loadRun(), { quiet = false } = {}) {
  const killed = [];
  try { if (alive(run.pids.host)) await rpc(run, { action: 'shutdown' }).catch(() => {}); } catch {}
  for (let i = 0; i < 100 && run.pids.host && alive(run.pids.host); i++) await delay(100);
  for (const [label, pid] of Object.entries(run.pids)) if (pid && alive(pid)) { process.kill(pid, 'SIGKILL'); killed.push(label); }
  // Scratch removal is limited to the directory this run created; evidence lives elsewhere and stays.
  if (run.scratch.includes('/pi-verify-') && existsSync(run.scratch)) { try { if (existsSync(run.socket)) rmSync(run.socket); } catch {} rmSync(run.scratch, { recursive: true, force: true }); }
  await delay(300);
  const left = Object.values(run.pids).filter(pid => pid && alive(pid));
  if (left.length) fail(`processes still alive: ${left}`);
  if (!quiet) out({ cleaned: run.scratch, forceKilled: killed, evidenceKept: run.evidence, evidenceFiles: existsSync(run.evidence) ? readdirSync(run.evidence) : [] });
}

if (command === 'launch') await launch();
else if (command === 'doctor') await doctor();
else if (command === 'drive') await drive();
else if (command === 'cleanup') await cleanup();
else fail('usage: verify.mjs <launch [--evidence dir] | doctor --run dir | drive --run dir <feature> | cleanup --run dir>');
