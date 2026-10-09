// Shared harness for the fake-model E2Es (private HOME, owned host on a private socket, local fake model, raw-CDP Chrome).
// Used by the MCP and Arc suites; older suites keep their inline copies. Never reaches real providers, Arcadia, Arcanum, CI or Tracker.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
export const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
export const say = value => chunk({ role: 'assistant', content: value }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
export { delay, randomUUID };

/** `handler({ role, user, results, tools, system, msgs })` returns a response string (say/call) or nothing (default: "DONE <role>"). */
export async function createKit(name, { env: extraEnv = {}, handler = () => undefined } = {}) {
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
  const repo = process.cwd();
  const artifacts = join(repo, 'artifacts', `${name}-${new Date().toISOString().replaceAll(':', '-')}`);
  const root = join(realpathSync(tmpdir()), `${name}-${randomUUID()}`);
  const dirs = { home: join(root, 'home'), workspace: join(root, 'workspace'), agentDir: join(root, 'agent'), userHome: join(root, 'userhome') };
  for (const dir of [artifacts, root, ...Object.values(dirs)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
  const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
  const kit = { repo, artifacts, root, ...dirs, result, delay, call, say, redact };
  kit.save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  kit.check = (label, ok, detail) => { if (!ok) throw Error(`${label}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(label); };
  kit.git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  kit.initRepo = (dir = dirs.workspace) => { kit.git(dir, 'init', '-b', 'main'); kit.git(dir, 'config', 'user.email', 'e2e@example.invalid'); kit.git(dir, 'config', 'user.name', 'E2E'); writeFileSync(join(dir, 'README.md'), 'base\n'); kit.git(dir, 'add', '.'); kit.git(dir, 'commit', '-qm', 'c1'); };
  kit.eventually = async (fn, description, tries = 600) => { for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error(description); };

  const model = createServer((req, res) => {
    req.setEncoding('utf8');
    let body = ''; req.on('data', part => { body += part; });
    req.on('end', async () => {
      const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
      const role = tools.includes('projects_delegate') ? 'coordinator' : tools.includes('code_read') ? 'scout' : tools.includes('bash') ? 'worker' : 'other';
      const lastUser = msgs.findLastIndex(m => m.role === 'user'), user = contentText(msgs[lastUser]?.content);
      const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
      const system = contentText(msgs.find(m => m.role === 'system' || m.role === 'developer')?.content);
      result.calls.push({ at: Date.now(), role, user: user.slice(0, 3000), results: results.map(r => r.slice(0, 4000)), resultLengths: results.map(r => r.length), tools, system });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const out = await handler({ role, user, results, tools, system, msgs });
      if (out !== undefined) return res.end(out);
      res.end(say(role === 'coordinator' && user.startsWith('[Durable work') ? 'Noted report.' : `DONE ${role}`));
    });
  });
  await new Promise(ok => model.listen(0, '127.0.0.1', ok));
  writeFileSync(join(dirs.agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
  kit.lastCall = (role, marker) => result.calls.findLast(c => c.role === role && c.user.includes(marker));
  kit.toolResult = (role, marker) => result.calls.findLast(c => c.role === role && c.user.includes(marker) && c.results.length >= 1)?.results.at(-1) ?? '';

  const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(dirs.home).digest('hex').slice(0, 12)}.sock`);
  kit.hostEnv = { ...process.env, HOME: dirs.userHome, PI_PROJECTS_HOME: dirs.home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: dirs.agentDir, PI_OFFLINE: '1', ...extraEnv };
  for (const key of Object.keys(kit.hostEnv)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete kit.hostEnv[key];
  let host, hostEnded = false, hostExit, hostRun = 0;
  kit.startHost = () => {
    const log = createWriteStream(join(artifacts, `host-${++hostRun}.log`), { flags: 'wx', mode: 0o600 });
    host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env: kit.hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout.pipe(log); host.stderr.pipe(log);
    hostEnded = false; hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
  };
  kit.rpc = input => new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 90000 }, res => {
      res.setEncoding('utf8');
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
  kit.rejects = async input => { try { await kit.rpc(input); return null; } catch (error) { return String(error.message ?? error); } };
  kit.waitHost = () => kit.eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await kit.rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  kit.stopHost = async () => { if (!hostEnded) { try { await kit.rpc({ action: 'shutdown' }); } catch {} await Promise.race([hostExit, delay(15000)]); } if (!hostEnded && host) host.kill('SIGKILL'); };
  kit.restartHost = async () => { await kit.stopHost(); kit.startHost(); await kit.waitHost(); };

  // Project helpers.
  kit.createProject = async (title, { workerCap = 3, grant = true, cwd = dirs.workspace } = {}) => {
    const project = await kit.rpc({ action: 'create', requestId: randomUUID(), name: title, cwd, objective: `Disposable ${name} fixture`, model: 'fake/fake-model' });
    const id = project.id, settings = await kit.rpc({ action: 'settings-snapshot', id });
    await kit.rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { workerCap, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    if (grant) { const first = await kit.rpc({ action: 'owner-setup-snapshot', id }); await kit.rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision }); }
    return id;
  };
  kit.plan = async id => (await kit.rpc({ action: 'plan-snapshot', id })).work;
  kit.settle = id => kit.eventually(async () => { const view = await kit.rpc({ action: 'show', id }); return !view.chats.some(c => c.busy) && !(await kit.plan(id)).some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 1200);
  kit.ask = async (id, text) => { await kit.rpc({ action: 'message', id, text }); await delay(300); await kit.settle(id); };
  kit.updateSettings = async (id, changes) => { const settings = await kit.rpc({ action: 'settings-snapshot', id }); return kit.rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes }); };

  // Chrome over a pipe (CDP).
  let chrome, cdpEnded = false, cdpId = 0, buffer = ''; const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++cdpId; const timer = setTimeout(() => { pending.delete(key); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  kit.openPage = async url => {
    const clog = createWriteStream(join(artifacts, 'chrome.log'), { flags: 'a', mode: 0o600 });
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
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
    await send('Page.navigate', { url }, s);
    const page = {
      evaluate: async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; },
      shot: async label => { const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s); writeFileSync(join(artifacts, `${label}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); },
      navigate: next => send('Page.navigate', { url: next }, s),
      reload: () => send('Page.reload', {}, s),
      viewport: (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }, s),
    };
    page.waitFor = async (expression, label, tries = 240) => { for (let i = 0; i < tries; i++) { if (await page.evaluate(expression)) return; await delay(250); } throw Error(`Timed out waiting for ${label}`); };
    return page;
  };
  /** Settings tab URL of a project in the owned host's browser UI. */
  kit.webUrl = async (id, tab = 'settings') => { const web = await kit.rpc({ action: 'web' }); const url = new URL(web.url); url.searchParams.set('project', id); url.searchParams.set('tab', tab); return url.toString(); };

  kit.run = async body => {
    kit.startHost();
    try { await kit.waitHost(); await body(kit); result.errors = result.errors.filter(e => !/Failed to load resource/.test(e)); result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api')); kit.check('no browser errors', !result.errors.length && !result.httpErrors.length, result.errors.concat(result.httpErrors)); result.status = 'passed'; }
    catch (error) { result.status = 'failed'; result.failure = redact(error?.stack ?? error); }
    finally {
      if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
      await kit.stopHost().catch(() => host?.kill('SIGKILL'));
      model.closeAllConnections(); model.close(); kit.save();
    }
    console.log(JSON.stringify({ status: result.status, checks: result.checks.length, failure: result.failure, artifact: artifacts }, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  };
  return kit;
}
