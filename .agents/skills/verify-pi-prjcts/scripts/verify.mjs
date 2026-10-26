#!/usr/bin/env node
// Verification helper for pi-prjcts. Run from the repo root (or any checkout root):
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch  [--evidence <dir>]
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs doctor  --run <scratch>
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs rpc     --run <scratch> <action> [json-fields]
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs drive   --run <scratch> <feature>
//   node .agents/skills/verify-pi-prjcts/scripts/verify.mjs cleanup --run <scratch>
// Features: message-coordinator
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, openSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.VERIFY_REPO ?? execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const CHROME = process.env.VERIFY_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_TIMEOUT = Number(process.env.VERIFY_CDP_TIMEOUT_MS ?? 15000);
const PROJECT_NAME = 'Verify seed';
// Read-only host actions the `rpc` command forwards; anything else (including `web`, which returns the auth token) is refused.
const RPC_ALLOWLIST = new Set(['list', 'show', 'plan-snapshot', 'knowledge-list', 'knowledge-read', 'knowledge-history', 'search', 'settings-snapshot']);

const [command, ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const positional = rest.filter((arg, i) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const redact = value => String(value).replace(/token=[^&#\s"']+/gi, 'token=[redacted]').replace(/("?token"?\s*[:=]\s*"?)[A-Za-z0-9._~-]{16,}/gi, '$1[redacted]');
const out = value => console.log(redact(JSON.stringify(value, null, 2)));
const fail = message => { console.error(`FAIL: ${redact(message)}`); process.exit(1); };
const socketFor = home => join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);

// Process identity: a pid is ours only while its start time still matches the one recorded at spawn (pids get reused).
const psField = (pid, field) => { try { return execFileSync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const identityOf = async pid => { for (let i = 0; i < 20; i++) { const lstart = psField(pid, 'lstart'); if (lstart) return { pid, lstart }; await delay(50); } return { pid, lstart: '' }; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
/** 'dead', 'ours' (alive with the recorded start time) or 'foreign' (alive, but a different process reused the pid). */
const ownership = ({ pid, lstart }) => !pid || !alive(pid) ? 'dead' : lstart && psField(pid, 'lstart') === lstart ? 'ours' : 'foreign';
const groupAlive = pgid => { try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

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
  for (;;) { const value = await Promise.resolve().then(fn).catch(error => { if (error.fatal) throw error; return false; }); if (value) return value; if (Date.now() > end) throw Error(`Timed out: ${label}`); await delay(100); }
}
const runFile = run => join(run.scratch, 'run.json');
const saveRun = run => writeFileSync(runFile(run), JSON.stringify(run, null, 2), { mode: 0o600 });
const loadRun = () => {
  const dir = flag('run') ?? fail('--run <scratch> is required (printed by launch)');
  const file = join(resolve(dir), 'run.json');
  if (!existsSync(file)) fail(`no run.json in ${dir} (already cleaned up?)`);
  return JSON.parse(readFileSync(file, 'utf8'));
};

/** Copy logs and run state into <evidence>/diagnostics, redacted. Safe to call repeatedly and when files are missing. */
function collectDiagnostics(run, extra = {}) {
  const dir = join(run.evidence, 'diagnostics'); mkdirSync(dir, { recursive: true });
  for (const [name, file] of [['host.log', run.hostLog], ['fake-provider.log', run.providerLog], ['model-requests.jsonl', run.requestLog], ['run.json', runFile(run)]]) {
    try { if (file && existsSync(file)) writeFileSync(join(dir, name), redact(readFileSync(file, 'utf8'))); } catch {}
  }
  if (Object.keys(extra).length) writeFileSync(join(dir, `notes-${Date.now()}.json`), redact(JSON.stringify(extra, null, 2)));
}

function hostEnv(run) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PI_PROJECTS_') || key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE' || key === 'PI_PACKAGE_DIR' || key === 'PI_CODING_AGENT_DIR' || key === 'PI_OFFLINE') delete env[key];
  return { ...env, HOME: run.userHome, PI_PROJECTS_HOME: run.home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: run.agentDir, PI_OFFLINE: '1' };
}

async function spawnTracked(run, label, file, args, options) {
  const child = spawn(file, args, { detached: true, ...options });
  child.unref();
  const exited = new Promise(ok => child.once('exit', ok));
  run.pids[label] = { ...(await identityOf(child.pid)), pgid: child.pid };
  saveRun(run);
  return { child, exited };
}

async function launch() {
  if (process.env.NODE_OPTIONS) fail('clear NODE_OPTIONS first');
  if (!existsSync(join(repo, 'node_modules'))) fail('node_modules missing: run `npm ci` in the checkout first');
  if (!existsSync(CHROME)) fail(`Chrome not found at ${CHROME}; set VERIFY_CHROME`);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const scratch = join(realpathSync(tmpdir()), `pi-verify-${id}`);
  const evidence = resolve(flag('evidence') ?? join(repo, 'artifacts', 'verify-pi-prjcts', id));
  const run = { id, scratch, evidence, repo, home: join(scratch, 'home'), workspace: join(scratch, 'workspace'), agentDir: join(scratch, 'agent'), userHome: join(scratch, 'userhome'), pids: {}, revision: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  run.socket = socketFor(run.home); run.hostLog = join(scratch, 'host.log'); run.providerLog = join(scratch, 'fake-provider.log'); run.requestLog = join(scratch, 'model-requests.jsonl');
  for (const dir of [scratch, evidence, run.home, run.workspace, run.agentDir, run.userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  saveRun(run);
  try {
    // Seed workspace: a one-commit git repo, with git's global/system config and HOME cut off from the owner's.
    const gitEnv = { ...process.env, HOME: run.userHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null' };
    const git = (...args) => execFileSync('/usr/bin/git', ['-C', run.workspace, '-c', 'commit.gpgsign=false', '-c', 'user.email=verify@example.invalid', '-c', 'user.name=Verify', ...args], { encoding: 'utf8', env: gitEnv });
    git('init', '-q', '-b', 'main'); writeFileSync(join(run.workspace, 'README.md'), 'verification workspace\n');
    // The project's own verification skill is part of the seed, so Settings can name an installed skill.
    cpSync(join(here, '..'), join(run.workspace, '.agents/skills/verify-pi-prjcts'), { recursive: true, filter: source => !source.includes('node_modules') });
    git('add', '.'); git('commit', '-qm', 'seed');
    // Fake model provider (the only external-model seam): its own detached process group.
    const portFile = join(scratch, 'fake-provider.port'), providerFd = openSync(run.providerLog, 'a');
    await spawnTracked(run, 'fakeProvider', process.execPath, [join(here, 'fake-provider.mjs'), portFile, run.requestLog], { stdio: ['ignore', providerFd, providerFd] });
    run.fakePort = Number(await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8'), 'fake provider port'));
    writeFileSync(join(run.agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${run.fakePort}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
    // Host: private HOME, project home (hence a private socket), offline, inherited PI_PROJECTS_* stripped.
    const logFd = openSync(run.hostLog, 'a');
    const { child: host, exited } = await spawnTracked(run, 'host', process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env: hostEnv(run), stdio: ['ignore', logFd, logFd] });
    let hostDied = false; exited.then(() => { hostDied = true; });
    await until(async () => { if (hostDied) throw Object.assign(Error('host exited during start'), { fatal: true }); return (await rpc(run)).pid === host.pid; }, 'host health answers with our pid');
    // Seed one project, pinned to the fake model, then wait until the browser URL is served.
    const project = await rpc(run, { action: 'create', requestId: randomUUID(), name: PROJECT_NAME, cwd: run.workspace, objective: 'Disposable verification project', model: 'fake/fake-model' });
    const settings = await rpc(run, { action: 'settings-snapshot', id: project.id });
    await rpc(run, { action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    run.projectId = project.id;
    run.webUrl = (await rpc(run, { action: 'web' })).url; saveRun(run);
    await until(async () => (await fetch(new URL(run.webUrl).origin + '/')).ok, 'web page served');
    await until(async () => (await rpc(run, { action: 'list' })).some(p => p.id === run.projectId), 'seeded project listed');
    out({ ready: true, scratch, evidence, projectId: run.projectId, origin: new URL(run.webUrl).origin, hostPid: host.pid, fakeProvider: `127.0.0.1:${run.fakePort}` });
  } catch (error) {
    console.error(`launch failed: ${redact(error.message)}\nrunning cleanup on ${scratch}`);
    collectDiagnostics(run, { launchError: error.message });
    const left = await cleanup(run, { quiet: true });
    process.exit(left.length ? 2 : 1);
  }
}

async function doctor() {
  const run = loadRun(), checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), ...(ok ? {} : { detail }) });
  check('host process is ours and alive', ownership(run.pids.host ?? { pid: 0 }) === 'ours', run.pids.host);
  check('fake provider process is ours and alive', ownership(run.pids.fakeProvider ?? { pid: 0 }) === 'ours', run.pids.fakeProvider);
  const health = await rpc(run).catch(error => ({ error: error.message }));
  check('private socket answers with the pid we started', health.pid === run.pids.host?.pid, health);
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

// Read-only second view of host state. `rpc --run <scratch> <action> ['{"path":"research/x.md"}']`; `id` defaults to the seeded project.
async function rpcCommand() {
  const run = loadRun(), [action, json] = positional;
  if (!RPC_ALLOWLIST.has(action)) fail(`rpc action ${JSON.stringify(action)} is not allowed; read-only actions: ${[...RPC_ALLOWLIST].join(', ')}`);
  const fields = json ? JSON.parse(json) : {};
  out(await rpc(run, { action, ...(action === 'list' ? {} : { id: run.projectId }), ...fields }));
}

// Raw CDP over a pipe, as scripts/lib/e2e-kit.mjs does. Chrome is tracked in run.json before any CDP call, so a crash anywhere still leaves it recorded for cleanup.
async function openBrowser(run, sinks) {
  const label = `chrome-${Date.now()}`;
  const { child: chrome, exited } = await spawnTracked(run, label, CHROME, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${join(run.scratch, 'chrome-profile')}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0, buffer = ''; const pending = new Map();
  const page = {
    close: async () => {
      // Stop Chrome's whole process group and wait for the leader to exit; escalate to SIGKILL.
      const pgid = run.pids[label]?.pgid;
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (ownership(run.pids[label]) === 'ours') { try { process.kill(-pgid, signal); } catch {} }
        await Promise.race([exited, delay(3000)]);
        if (ownership(run.pids[label]) !== 'ours' && !groupAlive(pgid)) break;
      }
      if (ownership(run.pids[label]) !== 'ours') { delete run.pids[label]; saveRun(run); } else throw Error(`Chrome ${chrome.pid} would not exit`);
    },
  };
  try {
    chrome.stdio[4].on('data', part => {
      buffer += part.toString(); let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const text = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!text) continue;
        const msg = JSON.parse(text);
        if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.bad(Error(JSON.stringify(msg.error))) : p.ok(msg.result); } }
        else if (msg.method === 'Runtime.exceptionThrown') sinks.errors.push(redact(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
        else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') sinks.errors.push(redact(msg.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ')));
        else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') sinks.errors.push(redact(msg.params.entry.text));
        else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) sinks.httpErrors.push({ url: redact(msg.params.response.url), status: msg.params.response.status });
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
      const key = ++id; const timer = setTimeout(() => { pending.delete(key); bad(Error(`CDP timeout: ${method}`)); }, CDP_TIMEOUT);
      pending.set(key, { ok: v => { clearTimeout(timer); ok(v); }, bad: e => { clearTimeout(timer); bad(e); } });
      chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    Object.assign(page, {
      evaluate: async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; },
      navigate: url => send('Page.navigate', { url }, sessionId),
      reload: () => send('Page.reload', {}, sessionId),
      cdp: (method, params) => send(method, params, sessionId),
      shot: async (dir, name) => { const image = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(join(dir, `${name}.png`), Buffer.from(image.data, 'base64')); },
      waitFor: (expression, what, ms = 30000) => until(() => page.evaluate(expression), what, ms),
      /** A real pointer click at the centre of `selector`, after a hit test proving that point lands on that element. */
      click: async selector => {
        const point = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, hit: !!hit && (hit === el || el.contains(hit)), top: hit?.tagName + '#' + (hit?.id ?? '') }; })()`);
        if (!point) throw Error(`click target not found: ${selector}`);
        if (!point.hit) throw Error(`hit test failed for ${selector}: point is covered by ${point.top}`);
        for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra }, sessionId);
      },
    });
  } catch (error) { await page.close().catch(() => {}); throw error; }
  return page;
}

const journeys = {
  // Feature: features/verification-settings.md
  async 'verification-settings'(run, page, record, dir, sinks) {
    const origin = new URL(run.webUrl).origin, snap = async () => rpc(run, { action: 'settings-snapshot', id: run.projectId });
    await page.navigate(run.webUrl);
    await page.waitFor(`document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)}) && !document.querySelector('#sign-in')?.open`, 'seeded project shown');
    const open = async () => { await page.click('button[data-tab=settings]'); await page.waitFor(`!document.querySelector('#settings-button')?.hidden`, 'settings tab with its edit button'); await page.click('#settings-button'); await page.waitFor(`!!document.querySelector('[data-settings-form]')`, 'settings form'); };
    const review = async () => { await page.click('[data-settings-form] [type=submit]'); await page.waitFor(`!!document.querySelector('[data-settings-confirm]')`, 'review dialog'); };
    record('entry', `opened ${origin}; Project settings dialog`);
    await open();
    if ((await snap()).values.verification !== null) throw Error('verification must be off in a fresh project');
    await page.shot(dir, '01-settings-off');
    // 1. Opting in without a verifier model is refused by the host; nothing is stored.
    await page.click('input[name=verifyEnabled]');
    await page.click('input[name=verifySkill]'); await page.cdp('Input.insertText', { text: 'verify-pi-prjcts' });
    await page.shot(dir, '02-enabled-no-model');
    await review();
    await page.shot(dir, '03-review-diff');
    const diff = await page.evaluate(`document.querySelector('.diff-list').innerText`);
    if (!/Verification/.test(diff) || !/verify-pi-prjcts/.test(diff)) throw Error(`review dialog does not show the verification change: ${diff}`);
    await page.click('[data-settings-confirm] [type=submit]');
    await page.waitFor(`/own verifier model/.test(document.body.innerText)`, 'host refusal visible');
    await page.shot(dir, '04-refused-without-model');
    record('action', 'enabled verification with skill verify-pi-prjcts and no verifier model, reviewed and saved');
    record('visible', 'the host refused: verification needs its own verifier model');
    // The refusal is an HTTP 400 by design: take exactly that one out of the error sinks, so any other error still fails the drive.
    const bad = sinks.httpErrors.findIndex(item => item.status === 400); if (bad < 0) throw Error('expected the refusal to be an HTTP 400'); sinks.httpErrors.splice(bad, 1);
    const log = sinks.errors.findIndex(item => /status of 400/.test(item)); if (log >= 0) sinks.errors.splice(log, 1);
    if ((await snap()).values.verification !== null) throw Error('refused update must not store anything');
    record('side-effect', 'settings-snapshot still reports verification: null');
    // 2. Pick the verifier model, save again.
    await page.navigate(run.webUrl);
    await page.waitFor(`document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, 'project shown again');
    await open();
    await page.click('.mp[data-role=verifier] .mp-current');
    await page.waitFor(`!!document.querySelector('.mp[data-role=verifier] .mp-row[data-ref="fake/fake-model"]')`, 'verifier options');
    await page.click('.mp[data-role=verifier] .mp-row[data-ref="fake/fake-model"]');
    await page.click('input[name=verifyEnabled]');
    await page.click('input[name=verifySkill]'); await page.cdp('Input.insertText', { text: 'verify-pi-prjcts' });
    await page.shot(dir, '05-model-and-skill');
    await review();
    await page.click('[data-settings-confirm] [type=submit]');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'saved');
    const saved = (await snap()).values;
    if (!saved.verification?.enabled || saved.verification.skill !== 'verify-pi-prjcts' || saved.models.verifier !== 'fake/fake-model') throw Error(`not stored: ${JSON.stringify(saved.verification)} ${saved.models.verifier}`);
    writeFileSync(join(dir, 'host-settings-snapshot.json'), JSON.stringify({ verification: saved.verification, models: saved.models }, null, 2));
    record('side-effect', `settings-snapshot: verification ${JSON.stringify(saved.verification)}, verifier model ${saved.models.verifier}`);
    // 3. Persistence: reopen after a reload, and turn it off again.
    await page.reload();
    await page.waitFor(`document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, 'project after reload');
    await open();
    const shown = await page.evaluate(`({ on: document.querySelector('input[name=verifyEnabled]').checked, skill: document.querySelector('input[name=verifySkill]').value })`);
    if (!shown.on || shown.skill !== 'verify-pi-prjcts') throw Error(`settings dialog after reload: ${JSON.stringify(shown)}`);
    await page.shot(dir, '06-after-reload');
    record('persist', 'after reload the dialog shows verification on with the skill');
    await page.click('input[name=verifyEnabled]');
    await review(); await page.click('[data-settings-confirm] [type=submit]');
    await page.waitFor(`!document.querySelector('dialog[open]')`, 'turned off');
    if ((await snap()).values.verification !== null) throw Error('verification did not turn off');
    await page.shot(dir, '07-turned-off');
    record('side-effect', 'turning it off stores verification: null again; the verifier model choice stays');
  },
  // Feature: features/message-coordinator.md
  async 'message-coordinator'(run, page, record, dir) {
    const prompt = `VERIFY-PING ${run.id}`, composer = 'textarea[aria-label="Message coordinator"]';
    const origin = new URL(run.webUrl).origin;
    await page.navigate(run.webUrl);
    await page.waitFor(`document.querySelector('#title')?.textContent.includes(${JSON.stringify(PROJECT_NAME)})`, 'seeded project title shown');
    await page.waitFor(`!!document.querySelector(${JSON.stringify(composer)}) && !document.querySelector('#sign-in')?.open`, 'composer visible, sign-in closed');
    record('entry', `opened ${origin} through the launch link; project "${PROJECT_NAME}" selected`);
    await page.shot(dir, '01-before-send');
    // Real user input: pointer-click the composer, insert text through the browser input pipeline, pointer-click Send.
    await page.click(composer);
    await page.cdp('Input.insertText', { text: prompt });
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ${JSON.stringify(prompt)}`, 'typed text in composer');
    await page.shot(dir, '02-typed');
    const before = existsSync(run.requestLog) ? readFileSync(run.requestLog, 'utf8').split('\n').filter(Boolean).length : 0;
    await page.click('#compose button[type=submit]');
    record('action', `pointer-clicked "Send ↵" with message ${JSON.stringify(prompt)}`);
    // The user's own bubble appears once, and the composer clears.
    const bubbles = role => `[...document.querySelectorAll('#messages article.msg.${role} .text')].map(n => n.innerText)`;
    await page.waitFor(`${bubbles('you')}.some(t => t.includes(${JSON.stringify(prompt)}))`, 'user bubble rendered');
    await page.waitFor(`document.querySelector(${JSON.stringify(composer)}).value === ''`, 'composer cleared');
    record('visible', 'user bubble shows the message and the composer is empty');
    await page.waitFor(`${bubbles('them')}.some(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}'))`, 'coordinator reply rendered', 60000);
    await page.shot(dir, '03-reply');
    const count = await page.evaluate(`({ you: ${bubbles('you')}.filter(t => t.includes(${JSON.stringify(prompt)})).length, them: ${bubbles('them')}.filter(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}')).length })`);
    if (count.you !== 1 || count.them !== 1) throw Error(`expected exactly one user and one reply bubble, got ${JSON.stringify(count)}`);
    record('visible', 'one user bubble and one coordinator bubble with the VERIFY-FAKE-REPLY echo');
    // Persistence: a reload (token kept in localStorage) re-renders both turns from the host.
    await page.reload();
    await page.waitFor(`${bubbles('you')}.some(t => t.includes(${JSON.stringify(prompt)})) && ${bubbles('them')}.some(t => t.includes('VERIFY-FAKE-REPLY: ${prompt}'))`, 'both bubbles after reload');
    await page.shot(dir, '04-after-reload');
    writeFileSync(join(dir, 'messages-dom.txt'), await page.evaluate(`document.querySelector('#messages').innerText`));
    record('persist', 'after reload both bubbles are rendered again');
    // Side effects: the model seam received the prompt, and the host's stored transcript has both turns.
    const calls = readFileSync(run.requestLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (calls.length <= before || !calls.some(call => call.user.includes(prompt))) throw Error('fake provider never received the prompt');
    const view = await rpc(run, { action: 'show', id: run.projectId });
    const texts = (view.messages ?? []).map(m => `${m.role ?? m.from ?? '?'}: ${m.text}`);
    writeFileSync(join(dir, 'host-show-messages.json'), JSON.stringify(texts, null, 2));
    if (!texts.some(t => t.includes(prompt)) || !texts.some(t => t.includes(`VERIFY-FAKE-REPLY: ${prompt}`))) throw Error(`host transcript lacks both turns: ${JSON.stringify(texts).slice(0, 500)}`);
    writeFileSync(join(dir, 'model-requests.jsonl'), calls.map(c => JSON.stringify(c)).join('\n') + '\n');
    record('side-effect', `host \`show\` lists both turns; fake provider logged ${calls.length - before} new call(s) containing the prompt`);
  },
};

async function drive() {
  const run = loadRun(), name = positional[0], journey = journeys[name];
  if (!journey) fail(`unknown feature ${JSON.stringify(name)}; known: ${Object.keys(journeys).join(', ')}`);
  // One fresh directory per drive, so a retry never overwrites an earlier attempt's proof.
  const dir = join(run.evidence, `drive-${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  const sinks = { errors: [], httpErrors: [] }, steps = [];
  const record = (kind, detail) => { steps.push({ kind, detail: redact(detail), at: new Date().toISOString() }); console.log(redact(`${kind}: ${detail}`)); };
  let page, failure;
  try {
    page = await openBrowser(run, sinks);
    await journey(run, page, record, dir, sinks);
  } catch (error) {
    failure = error;
    try { await page?.shot(dir, '99-failure'); } catch {}
  } finally {
    try { await page?.close(); } catch (error) { failure ??= error; }
    // Chrome may exist without a page when openBrowser threw: cleanup reaps anything still recorded.
    collectDiagnostics(run, { drive: name });
    const problems = failure ? [failure.message] : sinks.errors.length || sinks.httpErrors.length ? [`browser reported errors: ${JSON.stringify({ errors: sinks.errors, http: sinks.httpErrors })}`] : [];
    writeFileSync(join(dir, 'report.json'), redact(JSON.stringify({ feature: name, entry: 'browser launch link', ok: problems.length === 0, problems, steps, consoleErrors: sinks.errors, httpErrors: sinks.httpErrors, revision: run.revision }, null, 2)));
    if (problems.length) fail(problems[0]);
  }
  out({ ok: true, feature: name, evidence: dir });
}

/** Stops every process recorded in run.json that still verifies as ours (graceful host shutdown first), then removes scratch. Returns the labels still alive; scratch and run.json stay in that case so a retry works. */
async function cleanup(run = loadRun(), { quiet = false } = {}) {
  collectDiagnostics(run, { phase: 'cleanup' });
  const stillAlive = [], notOurs = [];
  if (ownership(run.pids.host ?? { pid: 0 }) === 'ours') {
    await rpc(run, { action: 'shutdown' }).catch(() => {});
    for (let i = 0; i < 150 && ownership(run.pids.host) === 'ours'; i++) await delay(100);
  }
  for (const [label, who] of Object.entries(run.pids)) {
    const state = ownership(who);
    if (state === 'foreign') { notOurs.push(label); continue; }
    // Leader is ours, or already gone with children possibly left in its group: signal the group, never a bare pid we cannot verify.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (ownership(who) === 'dead' && !groupAlive(who.pgid)) break;
      if (ownership(who) === 'foreign') break;
      try { process.kill(-who.pgid, signal); } catch {}
      for (let i = 0; i < 30 && (ownership(who) === 'ours' || groupAlive(who.pgid)); i++) await delay(100);
    }
    if (ownership(who) === 'ours' || (ownership(who) === 'dead' && groupAlive(who.pgid))) stillAlive.push(label);
  }
  if (stillAlive.length) {
    collectDiagnostics(run, { phase: 'cleanup-incomplete', stillAlive });
    console.error(`FAIL: processes still alive: ${stillAlive}; scratch kept at ${run.scratch}, rerun cleanup`);
    return stillAlive;
  }
  // Scratch removal is limited to the directory this run created; evidence lives elsewhere and stays.
  collectDiagnostics(run, { phase: 'cleanup-done', pidsNotOurs: notOurs });
  if (run.scratch.includes('/pi-verify-')) { try { if (existsSync(run.socket)) rmSync(run.socket); } catch {} rmSync(run.scratch, { recursive: true, force: true }); }
  if (!quiet) out({ cleaned: run.scratch, skippedReusedPids: notOurs, evidenceKept: run.evidence, evidenceFiles: existsSync(run.evidence) ? readdirSync(run.evidence) : [] });
  return [];
}

if (command === 'launch') await launch();
else if (command === 'doctor') await doctor();
else if (command === 'rpc') await rpcCommand();
else if (command === 'drive') await drive();
else if (command === 'cleanup') process.exit((await cleanup()).length ? 1 : 0);
else fail('usage: verify.mjs <launch [--evidence dir] | doctor --run dir | rpc --run dir <action> [json] | drive --run dir <feature> | cleanup --run dir>');
