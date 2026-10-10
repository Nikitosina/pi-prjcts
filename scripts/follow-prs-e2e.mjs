// Browser E2E for Follow PRs: isolated host, local fake model, fake gh. No real providers, no network.
// Failure cases recorded in follow-prs-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `follow-prs-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `follow-prs-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), plain = join(root, 'plain'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, plain, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
const sha = n => createHash('sha1').update(String(n)).digest('hex');

// Fake GitHub acme/mari: #1 merged long ago. #2 is published by a project worker (receipt), then renamed and given pending CI; #3 open from a person.
const bare = join(root, 'remote.git'), fakeGh = join(root, 'fake-gh'), ghState = join(root, 'fake-gh-state.json'), ghCalls = join(root, 'fake-gh-calls.jsonl');
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`); chmodSync(fakeGh, 0o755);
const A = ['A1', 'A2', 'A3', 'A4', 'A5'].map(sha);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: 'acme/mari', default_branch: 'main' }, issues: [], checks: { [A[0]]: [{ name: 'lint', status: 'in_progress' }] }, pulls: [
  { number: 1, title: 'Old work', head: 'feature/old', base: 'main', sha: sha('S0'), state: 'closed', merged: true, comments: [{ id: 1, user: 'bob', body: 'OLD-COMMENT' }] },
] }));
writeFileSync(ghCalls, '');
const gh$ = () => JSON.parse(readFileSync(ghState, 'utf8'));
const ghSet = change => { const state = gh$(); change(state); writeFileSync(ghState, JSON.stringify(state)); };
const pull = (state, n) => state.pulls.find(item => item.number === n);
const ghLog = () => readFileSync(ghCalls, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = value => chunk({ role: 'assistant', content: value }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
let holdFix = null; // when set, the next auto-fix worker turn waits on it
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
    const results = msgs.slice(msgs.findLastIndex(m => m.role === 'user') + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    if (coordinator && /^MARK-PUBLISH/.test(userText) && results.length === 0) return res.end(call('projects_delegate', { role: 'worker', task: 'MARK-PUBLISH-FIX make the change and open a draft PR' }));
    if (!coordinator && /MARK-PUBLISH-FIX/.test(userText) && results.length === 0) return res.end(call('bash', { command: "printf 'fix\\n' > login.txt && git add -A && git commit -qm 'Fix login copy' && git push -q -u origin HEAD && git rev-parse HEAD" }));
    if (!coordinator && /MARK-PUBLISH-FIX/.test(userText) && results.length === 1) return res.end(call(tools.find(name => name.endsWith('_open_draft_pr')), { expectedHead: /[a-f0-9]{40}/.exec(results[0])?.[0], title: 'Fix login copy', body: 'Fixes the login copy.' }));
    if (!coordinator && kind === 'fix' && holdFix) { const wait = holdFix; holdFix = null; await wait; }
    res.end(say(coordinator ? `Noted ${kind}.` : `Fixed it (${kind}).`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: ghCalls, PI_PROJECTS_FOLLOW_TICK_MS: '300' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
git(workspace, 'remote', 'add', 'origin', 'https://github.com/acme/mari.git'); git(workspace, 'config', 'remote.origin.pushurl', bare);
writeFileSync(join(workspace, 'README.md'), 'base\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'c1'); git(workspace, 'push', '-q', 'origin', 'main');

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
  const setup = async (name, cwd) => {
    const project = await rpc({ action: 'create', requestId: randomUUID(), name, cwd, objective: 'Disposable Follow PRs fixture', model: 'fake/fake-model' });
    const settings = await rpc({ action: 'settings-snapshot', id: project.id });
    await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    return project.id;
  };
  const id = await setup('Mari follow', workspace), plainId = await setup('No GitHub', plain);
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const second = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'github-quick-authorize', id, confirm: id, expectedRevision: second.githubRevision });
  // C5: auto-fix eligibility is a publication receipt, so #2 is opened by a project worker; the fixture then shapes it.
  await rpc({ action: 'message', id, text: 'MARK-PUBLISH open the login fix' });
  await eventually(async () => gh$().pulls.length === 2 && (await rpc({ action: 'plan-snapshot', id })).work.every(w => !['queued', 'running'].includes(w.status)), 'worker did not publish #2', 1200);
  await eventually(async () => !(await rpc({ action: 'show', id })).chats.some(c => c.busy), 'coordinator stayed busy');
  ghSet(state => {
    Object.assign(pull(state, 2), { sha: A[0], user: 'pi-bot', reviews: [{ id: 5, user: 'carol', state: 'COMMENTED', body: 'OLD-REVIEW' }] });
    state.pulls.push({ number: 3, title: 'Docs tweak', head: 'alice/docs', base: 'main', sha: sha('B1'), user: 'alice' });
  });
  const fixBranch = pull(gh$(), 2).head;
  if (!fixBranch.startsWith('pi/') || pull(gh$(), 2).title !== 'Fix login copy') throw Error('Publish fixture wrong: ' + JSON.stringify(pull(gh$(), 2)));
  const alerts = await rpc({ action: 'chat-create', id, title: 'Alerts' });
  const mainConv = (await rpc({ action: 'show', id })).chats?.find(c => c.id === 'main')?.conversationId ?? null;
  const snap = () => rpc({ action: 'automation-snapshot', id });
  const events = async () => (await rpc({ action: 'schedule-history', id, kind: 'intents', limit: 100, textLimit: 4000 })).items.filter(item => item.kind === 'event');
  const fixWork = async () => (await rpc({ action: 'plan-snapshot', id })).work.filter(w => w.text?.includes('[Follow PRs auto-fix]'));
  const followCalls = () => ghLog().filter(c => c.target.includes('pulls?state=all'));
  const poll = () => rpc({ action: 'follow-poll', id });
  const settleAll = () => eventually(async () => { const view = await rpc({ action: 'show', id, chatId: alerts.id }); const plan = await rpc({ action: 'plan-snapshot', id }); return !view.chats.some(c => c.busy) && !plan.work.some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 900);

  // F1: nothing polls before the owner opts in.
  await delay(1200);
  const off = await poll().then(() => null, error => error.message);
  if (!/Follow PRs is off/.test(off ?? '') || followCalls().length) throw Error('Polled without opt-in: ' + JSON.stringify({ off, calls: followCalls().length }));
  result.checks.push('F1 no polling and Check now refused until the owner opts in');

  // F2: a project without a GitHub authorization gets a readable blocker and no gh call.
  await rpc({ action: 'automation-update', id: plainId, change: { follow: { enabled: true } } });
  const blocked = await rpc({ action: 'follow-poll', id: plainId }).then(() => null, error => error.message);
  if (!/needs a GitHub authorization/.test(blocked ?? '')) throw Error('No-GitHub blocker wrong: ' + blocked);
  await rpc({ action: 'automation-update', id: plainId, change: { follow: { enabled: false } } });
  result.checks.push('F2 follow without a GitHub authorization reports "needs a GitHub authorization"');

  // F9/F20 UI: choose the Alerts chat and opt in from Settings.
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'settings');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#events-in #follow-enabled') && [...document.querySelectorAll('#event-chat option')].some(o => o.textContent === 'Alerts')`, s, 'events card');
  await evaluate(`(() => { document.querySelector('#event-chat').value = ${JSON.stringify(alerts.id)}; document.querySelector('#follow-enabled').checked = true; document.querySelector('[data-action="automation-save"]').click(); })()`, s);
  await eventually(async () => { const v = await snap(); return v.follow.enabled && v.eventChat === alerts.id; }, 'opt-in not saved');
  // F4: the first poll is a silent baseline.
  const base = await eventually(async () => { const v = await snap(); return v.follow.polls >= 1 && v.follow.repos[0]?.baselined && v; }, 'baseline poll did not run (timer)');
  await delay(800);
  if ((await events()).length || base.follow.events !== 0 || base.follow.lastError) throw Error('Baseline delivered events: ' + JSON.stringify(base.follow));
  if (ghLog().some(c => !c.target.startsWith('repos/acme/mari') && !c.graphql)) throw Error('gh read outside the authorized repository');
  result.checks.push('F3/F4 the timer runs the first poll after opt-in; it records a silent baseline (old PRs, comments, pending CI) and reads only acme/mari');

  // A burst of changes: #4 opened by the project (CI passes), #3 merged, #2 CI fails + review + bot comment, #5 external with failing CI.
  const C = ['C1', 'C2'].map(sha), E1 = sha('E1'), O1 = sha('O1');
  ghSet(state => {
    state.pulls.push({ number: 4, title: 'Add settings page', head: 'pi/settings', base: 'main', sha: C[0], user: 'pi-bot' });
    state.pulls.push({ number: 5, title: 'Fork change', head: 'mallory/x', base: 'main', sha: E1, user: 'mallory' });
    state.pulls.push({ number: 8, title: 'Orphan branch', head: 'pi/orphan', base: 'main', sha: O1, user: 'pi-bot' });
    state.checks[O1] = [{ name: 'lint', conclusion: 'failure' }];
    Object.assign(pull(state, 3), { state: 'closed', merged: true });
    Object.assign(pull(state, 2), { reviews: [...pull(state, 2).reviews, { id: 11, user: 'alice', state: 'CHANGES_REQUESTED', body: 'MARK-REVIEW please rename the button' }], comments: [{ id: 21, user: 'ci-bot[bot]', body: 'MARK-BOT coverage dropped 2%' }] });
    state.checks[A[0]] = [{ name: 'lint', conclusion: 'failure' }, { name: 'unit', conclusion: 'success' }];
    state.checks[C[0]] = [{ name: 'lint', conclusion: 'success' }];
    state.checks[E1] = [{ name: 'lint', conclusion: 'failure' }];
  });
  await evaluate(`document.querySelector('[data-action="follow-poll"]').click()`, s);
  const [event] = await eventually(async () => { const list = await events(); return list.length === 1 && list; }, 'Check now did not deliver one event');
  const text = event.text;
  for (const want of ['PR #4 “Add settings page” opened by pi-bot', 'PR #3 “Docs tweak” merged', 'PR #2 “Fix login copy” CI failed at', 'lint (failure)', 'PR #4 “Add settings page” CI passed', 'review by alice CHANGES_REQUESTED: MARK-REVIEW', 'comment by ci-bot[bot] (bot): MARK-BOT', 'untrusted', 'PR #5 “Fork change” CI failed', 'not published by this project; no auto-fix', 'auto-fix sent to the thread that opened it', 'attempt 1 of 3']) if (!text.includes(want)) throw Error(`Event lacks "${want}": ${text}`);
  if (/OLD-COMMENT|OLD-REVIEW|Old work/.test(text)) throw Error('Baseline items re-delivered: ' + text);
  result.checks.push('F8 one event lists opened, merged, CI failed/passed, review and bot comment, marked untrusted; baseline items stay out');
  if (event.conversationId !== alerts.conversationId) throw Error('Event not routed to Alerts: ' + JSON.stringify({ event: event.conversationId, alerts: alerts.conversationId }));
  result.checks.push('F9/F10 the batch is one event in the chat chosen in Settings');
  const fixes1 = await fixWork();
  if (fixes1.length !== 1 || !fixes1[0].text.includes('PR #2') || !fixes1[0].text.includes(fixBranch) || fixes1[0].chatConversationId !== alerts.conversationId) throw Error('Fix dispatch wrong: ' + JSON.stringify(fixes1));
  result.checks.push('F12/F16 only the project-published PR (#2) gets a fix worker, scoped to the repository, reporting to Alerts; external #5 does not');
  if (!/PR #8 “Orphan branch” CI failed[\s\S]*not published by this project; no auto-fix/.test(text)) throw Error('Receipt-less pi/ PR not refused: ' + text);
  result.checks.push('Q18/C5 a failing pi/ PR without a publication receipt is not auto-fixed ("not published by this project")');
  await settleAll();
  const fixTools = result.calls.find(c => !c.coordinator && c.kind === 'fix')?.tools ?? [];
  if (!['write', 'edit'].every(name => fixTools.includes(name))) throw Error('Fix worker is not scoped to the repository: ' + JSON.stringify(fixTools));
  const reportCalls = result.calls.filter(c => c.coordinator && c.kind === 'report');
  if (!reportCalls.some(c => c.user.includes('[Follow PRs auto-fix]'))) throw Error('Fix report never reached the coordinator');
  const alertsView = await rpc({ action: 'show', id, chatId: alerts.id }), mainView = await rpc({ action: 'show', id });
  if (!alertsView.messages.some(m => m.text?.startsWith('[Durable work') && m.text.includes('[Follow PRs auto-fix]')) || mainView.messages.some(m => m.text?.includes('[Owner-local event') || m.text?.includes('[Follow PRs auto-fix]'))) throw Error('Report or event in the wrong chat');
  if (result.calls.filter(c => c.coordinator && c.kind === 'event').length !== 1) throw Error('More than one coordinator turn for one batch');
  result.checks.push('F16 the fix worker report lands in Alerts; Main sees neither the event nor the report');

  // F11: the transcript renders an event card.
  const chatUrl = new URL(launch); chatUrl.searchParams.set('tab', 'coordinator'); chatUrl.searchParams.set('chat', alerts.id);
  await send('Page.navigate', { url: chatUrl.toString() }, s);
  await waitFor(`!!document.querySelector('#messages .event-card.github')`, s, 'event card');
  const card = await evaluate(`(() => { const c = document.querySelector('#messages .event-card.github'); c.open = true; return { title: c.querySelector('summary b').innerText, summary: c.querySelector('.report-task').innerText, raw: document.querySelector('#messages').innerText.includes('[Owner-local event') }; })()`, s);
  if (card.title !== 'GitHub activity' || !/changes · auto-fix sent/.test(card.summary) || card.raw) throw Error('Event card wrong: ' + JSON.stringify(card));
  result.checks.push('F11 the event shows as a "GitHub activity" card, not as an owner message');
  await shot('01-alerts-event-card', s);

  // F5/F7/F13: nothing new, no repeat.
  const again = await poll();
  if (again.result.events !== 0 || (await events()).length !== 1 || (await fixWork()).length !== 1) throw Error('Second poll repeated something: ' + JSON.stringify(again.result));
  result.checks.push('F5/F7/F13 a second poll with no changes sends nothing and dispatches nothing');

  // F15: a new failing head while the previous fix still runs.
  let release; holdFix = new Promise(ok => { release = ok; });
  ghSet(state => { pull(state, 2).sha = A[1]; state.checks[A[1]] = [{ name: 'lint', conclusion: 'failure' }]; });
  await poll();
  const running = await eventually(async () => { const list = await fixWork(); return list.length === 2 && list[1].status === 'running' && list; }, 'second fix not running');
  ghSet(state => { pull(state, 2).sha = A[2]; state.checks[A[2]] = [{ name: 'lint', conclusion: 'timed_out' }]; });
  await poll();
  const third = (await events()).at(-1).text;
  if ((await fixWork()).length !== 2 || !/is still running; not dispatching another/.test(third)) throw Error('Dispatched while a fix was running: ' + third);
  result.checks.push('F15 no second dispatch while the previous fix for the PR is running; the event says so');
  release(); await settleAll();
  // F14: attempt 3, then the cap.
  ghSet(state => { pull(state, 2).sha = A[3]; state.checks[A[3]] = [{ name: 'lint', conclusion: 'failure' }]; });
  await poll(); await settleAll();
  ghSet(state => { pull(state, 2).sha = A[4]; state.checks[A[4]] = [{ name: 'lint', conclusion: 'failure' }]; });
  await poll();
  const capped = (await events()).at(-1).text, fixes = await fixWork();
  if (fixes.length !== 3 || !/auto-fix cap reached \(3 of 3 attempts\); needs you/.test(capped) || !fixes[2].text.includes('Attempt 3 of 3')) throw Error('Cap not enforced: ' + JSON.stringify({ n: fixes.length, capped }));
  result.checks.push('F14 at most 3 fix attempts per PR; the next failure tells the coordinator the cap is reached');
  await settleAll();

  // F17: auto-fix off.
  await rpc({ action: 'automation-update', id, change: { follow: { autoFix: false } } });
  const A6 = sha('A6');
  ghSet(state => { pull(state, 2).sha = A6; state.checks[A6] = [{ name: 'lint', conclusion: 'failure' }]; });
  await poll();
  if ((await fixWork()).length !== 3 || !/PR #2 .*CI failed.*auto-fix is off/.test((await events()).at(-1).text)) throw Error('Auto-fix off not respected');
  result.checks.push('F17 auto-fix can be turned off while following continues');
  await settleAll();

  // F18: gh failure keeps the change for the next poll.
  const before = (await events()).length;
  ghSet(state => { state.failPaths = ['pulls?state=all']; pull(state, 4).comments = [{ id: 31, user: 'dave', body: 'MARK-AFTER-OUTAGE looks good' }]; });
  const outage = await poll().then(() => null, error => error.message);
  const failedSnap = await snap();
  if (!/502|Bad Gateway/.test(outage ?? '') || !/Bad Gateway/.test(failedSnap.follow.lastError ?? '') || (await events()).length !== before) throw Error('Outage handling wrong: ' + JSON.stringify({ outage, err: failedSnap.follow.lastError }));
  ghSet(state => { delete state.failPaths; });
  await poll();
  if (!(await events()).at(-1).text.includes('MARK-AFTER-OUTAGE') || (await snap()).follow.lastError) throw Error('Change lost after outage');
  result.checks.push('F18 a gh 502 is shown as the follow problem, the host keeps running, and the change arrives on the next poll');
  await settleAll();

  // F9 fallback: archived chosen chat → Main.
  await rpc({ action: 'chat-update', id, chatId: alerts.id, archived: true });
  ghSet(state => { state.pulls.push({ number: 6, title: 'Bump deps', head: 'renovate/deps', base: 'main', sha: sha('D1'), user: 'renovate[bot]' }); });
  await poll();
  const fallback = (await events()).at(-1);
  if (!fallback.text.includes('PR #6') || fallback.conversationId !== undefined) throw Error('Archived chat did not fall back to Main: ' + JSON.stringify(fallback));
  await rpc({ action: 'chat-update', id, chatId: alerts.id, archived: false });
  result.checks.push('F9 with the chosen chat archived, events go to Main');
  await settleAll();

  // F19: paused project does not poll.
  await rpc({ action: 'pause', id });
  const callsPaused = followCalls().length;
  const paused = await poll().then(() => null, error => error.message);
  await delay(1000);
  if (!/paused/.test(paused ?? '') || followCalls().length !== callsPaused) throw Error('Paused project polled');
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  result.checks.push('F19 a paused project neither polls nor dispatches');

  // F3/F5 restart: a change made while the host is down arrives once, nothing old repeats.
  await settleAll();
  const beforeRestart = (await events()).length;
  ghSet(state => { state.pulls.push({ number: 7, title: 'Restart PR', head: 'erin/restart', base: 'main', sha: sha('R1'), user: 'erin' }); });
  await stopHost(); startHost(); await waitHost();
  const afterRestart = await eventually(async () => { try { const list = await events(); return list.length > beforeRestart && list; } catch { return false; } }, 'no event after restart', 900);
  await delay(1500);
  const finalEvents = await events();
  if (finalEvents.length !== beforeRestart + 1 || !afterRestart.at(-1).text.includes('PR #7 “Restart PR” opened') || afterRestart.at(-1).text.includes('PR #6')) throw Error('Restart delivery wrong: ' + JSON.stringify(finalEvents.slice(beforeRestart).map(e => e.text)));
  result.checks.push('F3/F5 after a host restart the timer polls again; the change made while down arrives once and nothing earlier repeats');
  await settleAll();

  // F20: Settings shows status and fix attempts.
  const settingsUrl = new URL((await rpc({ action: 'web' })).url); settingsUrl.searchParams.set('project', id); settingsUrl.searchParams.set('tab', 'settings');
  await send('Page.navigate', { url: settingsUrl.toString() }, s);
  await waitFor(`!!document.querySelector('#follow-fixes')`, s, 'fix list');
  const ui = await evaluate(`({ last: document.querySelector('#follow-last').innerText, sent: document.querySelector('#follow-events').innerText, fixes: document.querySelectorAll('#follow-fixes .fix-attempt').length, pr: document.querySelector('#follow-fixes b').innerText, chat: document.querySelector('#event-chat').selectedOptions[0].textContent })`, s);
  if (ui.last === 'never' || Number(ui.sent) < 8 || ui.fixes !== 3 || ui.pr !== 'acme/mari#2' || ui.chat !== 'Alerts') throw Error('Settings status wrong: ' + JSON.stringify(ui));
  result.checks.push('F20 Settings shows last check, events sent, the chosen chat and each fix attempt with its status');
  await evaluate(`document.querySelector('#events-in-card').scrollIntoView()`, s);
  await shot('02-settings-events-in', s);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(300);
  const narrow = await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s);
  if (!narrow) throw Error('Events card overflows at 390px');
  await shot('03-settings-mobile', s);
  result.checks.push('F20 the Events card fits a 390 px screen');

  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api'));
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured: ' + JSON.stringify(result.errors.concat(result.httpErrors)));
  result.ghCalls = ghLog().length;
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
