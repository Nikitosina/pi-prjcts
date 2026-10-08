// Shared harness for the notification E2Es (browser notifications, Telegram): private HOME, fake model scripted per marker, owned host, headless Chrome over CDP.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

export { delay, randomUUID };
// `respond(ctx)` (optional, may be async) scripts the fake model first: return SSE text, { error } for an HTTP 400, 'HOLD' to never answer, or undefined for the default script.
export async function kit(name, extraEnv = {}, respond) {
  const repo = process.cwd();
  const artifacts = join(repo, 'artifacts', `${name}-${new Date().toISOString().replaceAll(':', '-')}`);
  const root = join(realpathSync(tmpdir()), `${name}-${randomUUID()}`);
  const home = join(root, 'home'), workspace = join(root, 'workspace'), gitRepo = join(root, 'Demo'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
  for (const dir of [artifacts, root, home, workspace, gitRepo, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', gitRepo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E'); git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  writeFileSync(join(gitRepo, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-m', 'c1');
  const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
  const secrets = [];
  const redact = text => { let value = String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]'); for (const secret of secrets) value = value.split(secret).join('[secret]'); return value; };
  const save = () => writeFileSync(join(artifacts, 'report.json'), redact(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });

  const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const call = (tool, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
  const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
  const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
  const scripts = { 'MARK-ASK': [['projects_question', { question: 'MARK-Q Pick a colour\nWhich colour should the button use?', choices: ['red', 'blue'] }]] };
  const model = createServer((req, res) => {
    req.setEncoding('utf8');
    let body = ''; req.on('data', part => { body += part; });
    req.on('end', async () => {
      const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
      const coordinator = tools.includes('projects_delegate'), lastUser = msgs.findLastIndex(m => m.role === 'user');
      const userText = contentText(msgs[lastUser]?.content), marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
      const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
      result.calls.push({ at: Date.now(), coordinator, marker, stage: results.length, user: userText.slice(0, 400) });
      const reply = text => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
      const custom = await respond?.({ coordinator, marker, userText, results, tools, say, call, msgs });
      if (custom === 'HOLD') return;
      if (custom?.error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: custom.error } })); return; }
      if (typeof custom === 'string') return reply(custom);
      if (!coordinator) return reply(say(`Worker ${marker}`));
      if (userText.startsWith('Owner answered your question')) return reply(say(`ANSWER-ACK ${/\n(.*)$/.exec(userText)?.[1] ?? ''}`));
      if (marker === 'MARK-FAIL') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fake invalid request MARK-FAIL' } })); return; }
      if (marker === 'MARK-LONG') return reply(say('LONG-START ' + 'x'.repeat(6000) + ' LONG-END'));
      const steps = scripts[marker] ?? [];
      if (results.length < steps.length) return reply(call(...steps[results.length]));
      return reply(say(steps.length ? '' : `Done ${marker}.`));
    });
  });
  await new Promise(ok => model.listen(0, '127.0.0.1', ok));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
  const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
  const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_PROJECTS_NOTIFY_TICK_MS: '400', ...extraEnv };
  for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
  let host, hostEnded = true, hostExit = Promise.resolve(), hostRun = 0;
  const logs = [];
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
  async function startHost() {
    const path = join(artifacts, `host-${++hostRun}.log`); logs.push(path);
    const log = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout.pipe(log); host.stderr.pipe(log);
    hostEnded = false; hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
    await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  }
  async function stopHost() { if (hostEnded) return 0; const at = Date.now(); try { await rpc({ action: 'shutdown' }); } catch {} await Promise.race([hostExit, delay(15000)]); if (!hostEnded) { host.kill('SIGKILL'); throw Error('Host did not stop'); } return Date.now() - at; }

  let chrome, cdpEnded = false, cdpId = 0, buffer = ''; const pending = new Map(); const apiBodies = [];
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
        else if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.endsWith('/api')) apiBodies.push({ at: Date.now(), body: msg.params.request.postData ?? '' });
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
  async function shot(file, session) { const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, session); writeFileSync(join(artifacts, `${file}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); }
  async function waitFor(expression, session, label, tries = 240) {
    for (let i = 0; i < tries; i++) { if (await evaluate(expression, session)) return; await delay(250); }
    throw Error(`Timed out waiting for ${label}`);
  }
  async function openPage(url, init = '') {
    if (!chrome) startChrome();
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, sessionId);
    if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init }, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId); // fixed light unless a test overrides it (System theme follows the OS)
    await send('Page.navigate', { url }, sessionId);
    return sessionId;
  }
  async function closeChrome() { if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); } }

  const setup = async (projectName, cwd = workspace) => {
    const project = await rpc({ action: 'create', requestId: randomUUID(), name: projectName, cwd, objective: 'Disposable notification fixture', model: 'fake/fake-model' });
    const settings = await rpc({ action: 'settings-snapshot', id: project.id });
    await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    return project.id;
  };
  // A pending merge approval needs a granted workspace scope; the one-click grant on the git fixture gives one.
  const approval = async id => {
    const snap = await rpc({ action: 'owner-setup-snapshot', id });
    const scope = await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
    return rpc({ action: 'operation-request', id, requestId: randomUUID(), operation: { provider: 'github', kind: 'merge', repositoryId: 'acme/demo', scopeId: scope.id, pullRequest: 7, expectedHead: 'a'.repeat(40) } });
  };
  const settle = async (id, chatId, job) => eventually(async () => { const view = await rpc({ action: 'show', id, ...(chatId && chatId !== 'main' ? { chatId } : {}) }); const found = view.jobs.find(j => j.id === job.id); return ['done', 'failed', 'interrupted'].includes(found?.state) && found; }, 'Job did not settle');
  const ask = async (id, chatId, text) => settle(id, chatId, await rpc({ action: 'message', id, text, ...(chatId && chatId !== 'main' ? { chatId } : {}) }));
  const finish = async status => {
    result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
    result.httpErrors = result.httpErrors.filter(e => !(e.url.endsWith('/api') && e.status === 400)); // 400 = refused request (expected in tests); 401 = stale browser token
    if (status === 'passed' && (result.errors.length || result.httpErrors.length)) { result.status = 'failed'; result.failure = 'Browser errors captured: ' + JSON.stringify(result.errors.concat(result.httpErrors)); }
    await closeChrome();
    await stopHost().catch(() => host?.kill('SIGKILL'));
    model.closeAllConnections(); model.close(); save();
    console.log(redact(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2)));
    process.exit(result.status === 'passed' ? 0 : 1);
  };
  return { repo, artifacts, root, home, workspace, gitRepo, result, secrets, redact, save, rpc, eventually, startHost, stopHost, startChrome, send, evaluate, shot, waitFor, openPage, setup, approval, settle, ask, finish, apiBodies, logs, host: () => host };
}
