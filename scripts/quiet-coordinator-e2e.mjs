// Browser E2E: quiet coordinator (batched reports, held parent reports, final-only notifications), coordinator AGENTS.md,
// child fan-out cap 2 and plan-first prompting. Isolated host, local fake model; no real providers, no network.
// Failure cases recorded in quiet-coordinator-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `quiet-coordinator-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `quiet-coordinator-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); };


const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = value => chunk({ role: 'assistant', content: value }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
// Gates the script opens: the owner turn waits for both scouts to settle (so their reports queue while the coordinator is busy); children wait for the first report turn.
const gates = { ownerTurn: null, children: null };
let releaseChildren; const childrenGate = new Promise(ok => { releaseChildren = ok; });
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
    const role = tools.includes('projects_delegate') ? 'coordinator' : tools.includes('projects_delegate_child') ? 'parent' : tools.includes('projects_review_verdict') ? 'reviewer' : tools.includes('code_read') ? 'scout' : tools.includes('bash') ? 'worker' : 'other';
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), userText = contentText(msgs[lastUser]?.content);
    const lastAssistant = msgs.findLastIndex((m, i) => m.role === 'assistant' && i < lastUser);
    const newUsers = msgs.slice(lastAssistant + 1).filter(m => m.role === 'user').map(m => contentText(m.content));
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    const system = contentText(msgs.find(m => m.role === 'system' || m.role === 'developer')?.content);
    const descriptions = Object.fromEntries((input.tools ?? []).map(t => [t.function?.name, t.function?.description ?? '']));
    result.calls.push({ at: Date.now(), role, user: userText.slice(0, 3000), newUsers: newUsers.map(u => u.slice(0, 3000)), results: results.map(r => r.slice(0, 200000)), tools, system: role === 'coordinator' ? system : undefined, delegateChildDescription: descriptions.projects_delegate_child });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (role === 'coordinator') {
      const report = userText.startsWith('[Durable work');
      if (!report && /MARK-PLAN/.test(userText)) {
        if (results.length === 0) return res.end(call('projects_delegate', { role: 'worker', task: 'PARENT-TASK implement the feature; use children for the independent parts' }));
        if (results.length === 1) return res.end(call('projects_delegate', { role: 'scout', task: `SCOUT-ONE-TASK map the module ${'x'.repeat(900)}` }));
        if (results.length === 2) return res.end(call('projects_delegate', { role: 'scout', task: 'SCOUT-TWO-TASK read the tests' }));
        await gates.ownerTurn?.();
        return res.end(say('PLAN-LINE parent implements, two scouts map the code.'));
      }
      if (!report && /MARK-WORKERS/.test(userText) && results.length === 0) return res.end(call('projects_workers', { limit: 100 }));
      if (report) {
        const final = newUsers.some(u => u.includes('Nothing else for this chat is queued or running'));
        if (!final) { await gates.children?.(); releaseChildren(); }
        return res.end(say(final ? 'FINAL-SUMMARY all done.' : 'STATUS-LINE waiting for the parent.'));
      }
      return res.end(say('Noted.'));
    }
    if (role === 'parent') {
      const child = /^\[Child work ([0-9a-f-]+)/.exec(userText);
      if (child) return res.end(say(`PARENT-CONCLUSION ${child[1]}`));
      if (results.length === 0) return res.end(call('projects_delegate_child', { role: 'scout', task: 'CHILD-SCOUT read the README' }));
      if (results.length === 1) return res.end(call('projects_delegate_child', { role: 'worker', task: 'CHILD-WORKER write child.txt' }));
      if (results.length === 2) return res.end(call('projects_delegate_child', { role: 'reviewer', task: 'CHILD-THIRD review' }));
      return res.end(say('PARENT-WAITING for children.'));
    }
    if (/CHILD-/.test(userText)) await childrenGate;
    if (role === 'worker' && /CHILD-WORKER/.test(userText) && results.length === 0) return res.end(call('bash', { command: 'printf child > child.txt && echo wrote' }));
    res.end(say(`RESULT ${/(?:CHILD|SCOUT)-[A-Z-]+/.exec(userText)?.[0] ?? role}`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
writeFileSync(join(workspace, 'README.md'), 'base\n'); writeFileSync(join(workspace, 'AGENTS.md'), '# Rules\nREPO-RULE-ALPHA: run lint before reporting.\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'c1');

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

startHost();
try {
  await waitHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Quiet', cwd: workspace, objective: 'Disposable quiet-coordinator fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { workerCap: 3, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const plan = async () => (await rpc({ action: 'plan-snapshot', id })).work;
  const settleAll = () => eventually(async () => { const view = await rpc({ action: 'show', id }); return !view.chats.some(c => c.busy) && !(await plan()).some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 1200);
  const byText = (work, marker) => work.filter(w => w.text.includes(marker));
  const settled = w => w && !['queued', 'running'].includes(w.status);
  // The owner turn ends only after both scouts settled; the first report turn ends only after the parent's children were admitted.
  gates.ownerTurn = () => eventually(async () => { const work = await plan(); return settled(byText(work, 'SCOUT-ONE-TASK')[0]) && settled(byText(work, 'SCOUT-TWO-TASK')[0]) && byText(work, 'CHILD-WORKER').length === 1 && byText(work, 'PARENT-TASK').every(settled); }, 'scouts and parent turn did not settle', 900).then(() => delay(800));
  gates.children = async () => {};
  const feedBefore = (await rpc({ action: 'notify-feed', after: 0 })).items.filter(item => item.projectId === id).length;

  await rpc({ action: 'message', id, text: 'MARK-PLAN build the feature' });
  await delay(500); await settleAll(); await delay(2500);
  const work = await plan();
  const [parent] = byText(work, 'PARENT-TASK'), [scoutOne] = byText(work, 'SCOUT-ONE-TASK'), [scoutTwo] = byText(work, 'SCOUT-TWO-TASK'), [childScout] = byText(work, 'CHILD-SCOUT'), [childWorker] = byText(work, 'CHILD-WORKER');
  check('setup: parent, two scouts and two children completed', [parent, scoutOne, scoutTwo, childScout, childWorker].every(w => w?.status === 'completed'), work);
  const threads = new Set(work.map(w => w.threadId));
  result.threads = threads.size; result.workItems = work.length;
  check('Q17 the scripted request used 5 threads (parent, two scouts, two children) and no third child', threads.size === 5 && byText(work, 'CHILD-THIRD').length === 0, work.map(w => [w.role, w.text.slice(0, 40)]));
  const parentCalls = result.calls.filter(c => c.role === 'parent');
  const third = parentCalls.find(c => c.results.length === 3)?.results[2] ?? '';
  check('Q14 a parent may have at most 2 children queued or running; the third is refused', /already have 2 children/.test(third), third);
  check('Q15 the child-delegation tool tells workers to keep children for independent parallel work and one reviewer per head', parentCalls.every(c => /genuinely independent/.test(c.delegateChildDescription ?? '') && /at most one reviewer per head/i.test(c.delegateChildDescription ?? '')), parentCalls[0]?.delegateChildDescription);

  const coord = result.calls.filter(c => c.role === 'coordinator');
  const reportTurns = coord.filter(c => c.user.startsWith('[Durable work') && c.results.length === 0);
  result.reportTurns = reportTurns.map(c => c.newUsers.map(u => u.slice(0, 120)));
  check('Q1/Q17 five settled work items reached the coordinator in 2 report turns, not 5', reportTurns.length === 2, result.reportTurns);
  check('Q1/Q2 the first report turn carried both scout reports at once (batched while the coordinator was busy)', reportTurns[0].newUsers.filter(u => u.startsWith('[Durable work')).length === 2 && [scoutOne.id, scoutTwo.id].every(wid => reportTurns[0].newUsers.some(u => u.startsWith(`[Durable work ${wid}`))), reportTurns[0].newUsers.map(u => u.slice(0, 80)));
  const parentWork = work.filter(w => w.threadId === parent.threadId);
  const lastParent = parentWork.at(-1);
  check('Q6/Q7 only the parent\'s last answer (after its last child) reached the coordinator', reportTurns[1].newUsers.length === 1 && reportTurns[1].newUsers[0].startsWith(`[Durable work ${lastParent.id}`) && !coord.some(c => c.newUsers.some(u => parentWork.slice(0, -1).some(w => u.startsWith(`[Durable work ${w.id}`)))), { reports: result.reportTurns, parentWork: parentWork.map(w => w.id) });
  check('Q6 children never reported to the coordinator directly', !coord.some(c => c.newUsers.some(u => u.startsWith(`[Durable work ${childScout.id}`) || u.startsWith(`[Durable work ${childWorker.id}`))));
  const childTurns = parentCalls.filter(c => c.user.startsWith('[Child work'));
  check('Q6 the parent is told whether more children are still running, and that only its last answer goes to the coordinator', childTurns.length === 2 && /1 more of your children are still queued or running/.test(childTurns[0].user) && /This was your last running child/.test(childTurns[1].user), childTurns.map(c => c.user.slice(-260)));
  const scoutReport = reportTurns[0].newUsers.find(u => u.startsWith(`[Durable work ${scoutOne.id}`));
  check('Q4 an intermediate report says other work is still running and asks for no owner-facing text', /other work item\(s\) for this chat are still queued or running\. Do not write to the owner yet/.test(scoutReport), scoutReport.slice(-400));
  check('Q4 the last report says nothing else is running and asks for one final summary', /Nothing else for this chat is queued or running\. If the owner's request is done/.test(reportTurns[1].newUsers[0]), reportTurns[1].newUsers[0].slice(-400));
  const echoed = /Task: (SCOUT-ONE-TASK[^\n]*)/.exec(scoutReport)?.[1] ?? '';
  check('Q5 the report echoes at most 500 characters of the task', echoed.length <= 501 && echoed.endsWith('…'), echoed.length);
  check('Q3 the report no longer asks to summarize each result for the user', !coord.some(c => c.newUsers.some(u => /Summarize the result for the user/.test(u))));

  const sys = coord[0].system;
  check('Q11 the coordinator system prompt carries the repository AGENTS.md', sys.includes('REPO-RULE-ALPHA') && sys.includes('Repository instructions'), sys.slice(0, 300));
  check('Q16 plan-first prompting: decompose up front, prefer follow-ups, no micro-delegation, report only at the end', /Plan first/.test(sys) && /Prefer continuing an existing thread/.test(sys) && /Do not micro-delegate/.test(sys) && /Report to the owner only at the end/.test(sys) && !/Summarize each result for the user/.test(sys));

  const feed = (await rpc({ action: 'notify-feed', after: 0 })).items.filter(item => item.projectId === id).slice(feedBefore);
  const finished = feed.filter(item => item.kind === 'result');
  result.feed = feed.map(item => [item.kind, item.text.slice(0, 60)]);
  check('Q9/Q10 the owner is notified once, with the final summary; the plan line and status line stay quiet', finished.length === 1 && /FINAL-SUMMARY/.test(finished[0].text), result.feed);
  const view = await rpc({ action: 'show', id });
  check('Q9 the transcript keeps the short status line and the final summary', view.messages.some(m => /STATUS-LINE/.test(m.text ?? '')) && view.messages.some(m => /FINAL-SUMMARY/.test(m.text ?? '')));

  // Q8: projects_workers shows held reports; a restart does not redeliver anything.
  await rpc({ action: 'message', id, text: 'MARK-WORKERS' }); await delay(300); await settleAll();
  const listed = JSON.parse(result.calls.findLast(c => c.role === 'coordinator' && c.results.length === 1 && /MARK-WORKERS/.test(c.user)).results[0]);
  const state = wid => listed.work.find(w => w.id === wid)?.report;
  check('Q8 the parent\'s earlier answers show as held, its last as delivered', parentWork.slice(0, -1).every(w => state(w.id) === 'held until children finish') && state(lastParent.id) === 'delivered', parentWork.map(w => [w.id, state(w.id)]));
  const turnsBefore = result.calls.filter(c => c.role === 'coordinator' && c.user.startsWith('[Durable work')).length;

  // Q12: an edited AGENTS.md reaches the existing coordinator (Main and a chat) after a reopen.
  writeFileSync(join(workspace, 'AGENTS.md'), '# Rules\nREPO-RULE-BETA: run the formatter.\n');
  await stopHost(); startHost(); await waitHost(); await delay(1500);
  const ops = await rpc({ action: 'chat-create', id, title: 'Ops' });
  await rpc({ action: 'message', id, text: 'MARK-HELLO main' }); await delay(300); await settleAll();
  await rpc({ action: 'message', id, chatId: ops.id, text: 'MARK-HELLO ops' }); await delay(300); await settleAll();
  const hello = result.calls.filter(c => c.role === 'coordinator' && /MARK-HELLO/.test(c.user));
  check('Q12 after a restart the coordinator (Main and a new chat) sees the edited AGENTS.md', hello.length === 2 && hello.every(c => c.system.includes('REPO-RULE-BETA') && !c.system.includes('REPO-RULE-ALPHA')), hello.map(c => c.system.slice(-200)));
  check('Q8 the restart redelivered no report', result.calls.filter(c => c.role === 'coordinator' && c.user.startsWith('[Durable work')).length === turnsBefore);

  // UI: Main transcript with the quiet status line and the final summary; Activity with the nested children.
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id);
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#messages')?.innerText.includes('FINAL-SUMMARY')`, s, 'final summary in transcript');
  await delay(400);
  await shot('01-main-transcript', s);
  const activity = new URL(launch); activity.searchParams.set('tab', 'activity');
  await send('Page.navigate', { url: activity.toString() }, s);
  await waitFor(`!!document.querySelector('#work-list .work-children')`, s, 'activity tree');
  await delay(300);
  await shot('02-activity', s);
  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api'));
  check('no browser errors', !result.errors.length && !result.httpErrors.length, result.errors.concat(result.httpErrors));
  result.plan = await plan();
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  releaseChildren();
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  await stopHost().catch(() => host.kill('SIGKILL'));
  model.closeAllConnections(); model.close(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, threads: result.threads, reportTurns: result.reportTurns?.length, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
