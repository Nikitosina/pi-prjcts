// Browser E2E for per-project auto-merge: isolated host, local fake model, fake gh. No real providers, no network.
// Failure cases recorded in auto-merge-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `auto-merge-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `auto-merge-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome'), clone = join(root, 'clone');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
const sha = n => createHash('sha1').update(String(n)).digest('hex');
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); };

// Fake GitHub acme/mari: #1 is a person's PR. main requires "lint" (check run) and "build" (legacy commit status).
const bare = join(root, 'remote.git'), fakeGh = join(root, 'fake-gh'), ghState = join(root, 'fake-gh-state.json'), ghCalls = join(root, 'fake-gh-calls.jsonl');
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`); chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: 'acme/mari', default_branch: 'main' }, issues: [], checks: {}, protection: { main: { contexts: ['build'], checks: ['lint'] } }, pulls: [
  { number: 1, title: 'Docs tweak', head: 'alice/docs', base: 'main', sha: sha('B1'), user: 'alice' },
] }));
writeFileSync(ghCalls, '');
const gh$ = () => JSON.parse(readFileSync(ghState, 'utf8'));
const ghSet = change => { const state = gh$(); change(state); writeFileSync(ghState, JSON.stringify(state)); };
const pull = (state, n) => state.pulls.find(item => item.number === n);
const ghLog = () => readFileSync(ghCalls, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const mergeCalls = n => ghLog().filter(c => c.method === 'PUT' && c.target.endsWith(`/pulls/${n}/merge`));
const mergeAttempts = n => mergeCalls(n).filter(c => c.status === 'attempt');

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = value => chunk({ role: 'assistant', content: value }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
let verdictPlan = 'approve';
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
    const role = tools.includes('projects_delegate') ? 'coordinator' : tools.includes('projects_review_verdict') ? 'reviewer' : tools.includes('bash') ? 'worker' : 'other';
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), userText = contentText(msgs[lastUser]?.content);
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    result.calls.push({ at: Date.now(), role, user: userText.slice(0, 1500), results: results.map(r => r.slice(0, 600)), tools });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = suffix => tools.find(name => name.endsWith(suffix));
    if (role === 'coordinator') {
      const owner = !userText.startsWith('[Durable work') && !userText.startsWith('[Owner-local event'), ext = owner && /MARK-EXT-REVIEW ([a-f0-9]{40})/.exec(userText);
      if (owner && /MARK-PUBLISH/.test(userText) && results.length === 0) return res.end(call('projects_delegate', { role: 'worker', task: `MARK-PUBLISH-${/MARK-PUBLISH-(\w+)/.exec(userText)?.[1] ?? 'A'} make the change and open a draft PR` }));
      if (ext && results.length === 0) return res.end(call('projects_delegate', { role: 'reviewer', task: `VERDICT-EXT 1 ${ext[1]}` }));
      return res.end(say('Noted.'));
    }
    if (role === 'worker' && /MARK-PUBLISH-(\w+)/.test(userText)) {
      const tag = /MARK-PUBLISH-(\w+)/.exec(userText)[1];
      if (results.length === 0) return res.end(call('bash', { command: `printf '${tag}\\n' > feature-${tag}.txt && git add -A && git commit -qm 'Add feature ${tag}' && git push -q -u origin HEAD && git rev-parse HEAD` }));
      if (results.length === 1) return res.end(call(tool('_open_draft_pr'), { expectedHead: /[a-f0-9]{40}/.exec(results[0])?.[0], title: `Add feature ${tag}`, body: 'Adds a feature file.' }));
      return res.end(say(`Published ${tag}.`));
    }
    if (role === 'reviewer') {
      const auto = /\[Auto-merge review\][\s\S]*?pullRequest: (\d+), headSha: "([a-f0-9]{40})"/.exec(userText), ext = /VERDICT-EXT (\d+) ([a-f0-9]{40})/.exec(userText);
      if (ext && results.length === 0) return res.end(call('projects_review_verdict', { pullRequest: 1, headSha: 'abc', verdict: 'approve', summary: 'bad sha' }));
      if (ext && results.length === 1) return res.end(call('projects_review_verdict', { pullRequest: Number(ext[1]), headSha: ext[2], verdict: 'approve', summary: 'Looks fine (external).' }));
      if (auto && results.length === 0) return res.end(call('projects_review_verdict', { pullRequest: Number(auto[1]), headSha: auto[2], verdict: verdictPlan, summary: verdictPlan === 'approve' ? 'Correct and safe.' : 'MARK-CHANGES rename the file' }));
      return res.end(say('Reviewed.'));
    }
    res.end(say('Done.'));
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
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Mari merge', cwd: workspace, objective: 'Disposable auto-merge fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const second = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'github-quick-authorize', id, confirm: id, expectedRevision: second.githubRevision });
  const alerts = await rpc({ action: 'chat-create', id, title: 'Alerts' });
  const snap = () => rpc({ action: 'automation-snapshot', id });
  const events = async () => (await rpc({ action: 'schedule-history', id, kind: 'intents', limit: 100, textLimit: 4000 })).items.filter(item => item.kind === 'event');
  const lastEvent = async () => (await events()).at(-1)?.text ?? '';
  const plan = async () => (await rpc({ action: 'plan-snapshot', id })).work;
  const reviewers = async () => (await plan()).filter(w => w.role === 'reviewer' && w.text.includes('[Auto-merge review]'));
  const poll = () => rpc({ action: 'follow-poll', id });
  const settleAll = () => eventually(async () => { const view = await rpc({ action: 'show', id, chatId: alerts.id }), main = await rpc({ action: 'show', id }); return !view.chats.some(c => c.busy) && !main.chats.some(c => c.busy) && !(await plan()).some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 900);
  const ask = async text => { await rpc({ action: 'message', id, text }); await delay(300); await settleAll(); };
  const prHead = n => { const item = pull(gh$(), n); return item.sha ?? git(bare, 'rev-parse', `refs/heads/${item.head}`); };

  // The project publishes PR #2 through a worker (verified create-pr receipt).
  await ask('MARK-PUBLISH-A please');
  const pr2 = await eventually(() => pull(gh$(), 2), 'worker did not open PR #2');
  check('setup: a worker published draft PR #2 on its pi/ branch', pr2.draft === true && pr2.head.startsWith('pi/'), pr2);
  const H1 = prHead(2);
  ghSet(state => { state.checks[H1] = [{ name: 'lint', conclusion: 'success' }]; });

  // A1: off by default; old configs load.
  const initial = await snap();
  check('A1 auto-merge is off by default', initial.follow.autoMerge === false, initial.follow);
  await rpc({ action: 'automation-update', id, change: { eventChat: alerts.id, follow: { enabled: true, autoFix: false } } });
  await eventually(async () => (await snap()).follow.repos[0]?.baselined, 'baseline did not run');
  await poll(); await delay(500);
  check('A1 with auto-merge off a green project PR gets no reviewer and no merge', (await reviewers()).length === 0 && mergeCalls(2).length === 0);

  // A2/A19 Settings UI: toggle on.
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'settings');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#auto-merge #merge-enabled')`, s, 'auto-merge toggle');
  check('A19 Settings shows the auto-merge toggle, unchecked', await evaluate(`!document.querySelector('#merge-enabled').checked`, s));
  verdictPlan = 'request_changes';
  await evaluate(`(() => { document.querySelector('#merge-enabled').checked = true; document.querySelector('[data-action="automation-save"]').click(); })()`, s);
  await eventually(async () => (await snap()).follow.autoMerge === true, 'auto-merge toggle not saved');

  // A11: one reviewer for the green head, with the diff; no merge yet.
  const [review1] = await eventually(async () => { const list = await reviewers(); return list.length === 1 && list; }, 'reviewer not dispatched for H1');
  check('A11 CI green on project PR #2: one reviewer is dispatched with the exact head and the diff, reporting to Alerts', review1.text.includes(`headSha: "${H1}"`) && review1.text.includes('feature-A.txt') && review1.chatConversationId === alerts.conversationId && mergeCalls(2).length === 0, review1);
  await settleAll();
  const reviewerCall = result.calls.find(c => c.role === 'reviewer');
  check('A12 only reviewer threads get projects_review_verdict (not the coordinator or workers)', reviewerCall && !result.calls.some(c => c.role !== 'reviewer' && c.tools.includes('projects_review_verdict')) && result.calls.some(c => c.role === 'coordinator') && result.calls.some(c => c.role === 'worker'));
  // A13: request_changes blocks; the same head is not re-reviewed.
  await eventually(async () => /requested changes at .*MARK-CHANGES/.test(await lastEvent()), 'changes-requested note missing');
  await poll(); await poll();
  check('A13/A11 request_changes blocks the merge, is reported once, and the head is not re-reviewed', (await reviewers()).length === 1 && mergeCalls(2).length === 0 && (await events()).filter(e => /requested changes/.test(e.text)).length === 1);
  await settleAll();

  // A5/A8: a new push; pending then failing CI never merges; the old verdict does not carry over.
  verdictPlan = 'approve';
  execFileSync('/usr/bin/git', ['clone', '-q', bare, clone]); git(clone, 'config', 'user.email', 'e2e@example.invalid'); git(clone, 'config', 'user.name', 'E2E');
  git(clone, 'checkout', '-q', pr2.head); writeFileSync(join(clone, 'feature-A.txt'), 'renamed\n'); git(clone, 'commit', '-qam', 'address review'); git(clone, 'push', '-q', 'origin', pr2.head);
  const H2 = prHead(2);
  ghSet(state => { state.checks[H2] = [{ name: 'lint', status: 'in_progress' }]; });
  await poll();
  ghSet(state => { state.checks[H2] = [{ name: 'lint', conclusion: 'failure' }]; });
  await poll(); await delay(300);
  check('A5 pending and failed CI on the new head: no reviewer, no merge', (await reviewers()).length === 1 && mergeCalls(2).length === 0);
  ghSet(state => { state.checks[H2] = [{ name: 'lint', conclusion: 'success' }]; });
  await poll();
  // A8 + A6: reviewer approves H2; the verdict kicks a poll; "build" (required commit status) is missing.
  await eventually(async () => (await reviewers()).length === 2, 'no reviewer for H2');
  check('A8 a new head needs a new review (the H1 verdict is not reused)', (await reviewers())[1].text.includes(H2));
  await eventually(async () => /required check build not passed/.test(await lastEvent()), 'required-check note missing (verdict should kick a poll)');
  check('A6 a missing required commit status ("build") blocks the merge even with green check runs and approval', mergeCalls(2).length === 0);
  await settleAll();

  // A9/A10: build passes, but a push lands just before the merge call: GitHub refuses the pinned sha.
  const H3 = sha('H3');
  ghSet(state => { state.statuses = { [H2]: [{ context: 'build', state: 'success' }] }; state.racePush = { 2: H3 }; });
  await poll();
  const raced = await eventually(async () => { const merges = (await snap()).follow.merges.find(m => m.pr === 'acme/mari#2'); return merges?.receipts.length === 1 && merges; }, 'no receipt after race');
  const raceBody = JSON.parse(mergeAttempts(2)[0].body);
  check('A10 the draft was marked ready (GraphQL) only after every gate passed', ghLog().some(c => c.target === 'graphql') && pull(gh$(), 2).draft === false);
  check('A9 the merge call pins the reviewed head; a push in between makes GitHub refuse it, recorded as failed and not merged', raceBody.sha === H2 && raceBody.merge_method === 'squash' && raced.receipts[0].state === 'failed' && /Head branch was modified/.test(raced.receipts[0].error) && !pull(gh$(), 2).merged && /refused by GitHub/.test(await lastEvent()), { raced, raceBody });

  // A7: the new head H3 gets CI, build and a fresh approval; then it merges once, pinned to H3.
  ghSet(state => { state.checks[H3] = [{ name: 'lint', conclusion: 'success' }]; state.statuses[H3] = [{ context: 'build', state: 'success' }]; });
  await poll();
  await eventually(async () => /auto-merged at/.test(await lastEvent()), 'PR #2 not merged after approval of H3', 900);
  const merged = pull(gh$(), 2), receipt2 = (await snap()).follow.merges.find(m => m.pr === 'acme/mari#2').receipts.at(-1);
  check('A7 approved, green, required checks passed: merged once with sha=H3, receipt has merge commit and reviewer thread', merged.merged && mergeAttempts(2).length === 2 && JSON.parse(mergeAttempts(2)[1].body).sha === H3 && receipt2.state === 'merged' && receipt2.mergeCommit === merged.mergeCommit && receipt2.sha === H3 && (await reviewers()).length === 3, { receipt2, attempts: mergeAttempts(2).length });
  const mergedEvent = (await events()).at(-1);
  check('A17 the merge is reported to the event chat (Alerts)', mergedEvent.conversationId === alerts.conversationId && mergedEvent.text.includes(`merge commit ${merged.mergeCommit.slice(0, 7)}`), mergedEvent);
  await settleAll();

  // A14/A16: no second merge on later polls or after a restart; the receipt survives.
  await poll();
  await stopHost(); startHost(); await waitHost();
  await poll();
  const afterRestart = (await snap()).follow.merges.find(m => m.pr === 'acme/mari#2');
  check('A14/A16 no second merge on a later poll or after a host restart; the receipt survives', mergeAttempts(2).length === 2 && afterRestart.receipts.at(-1).state === 'merged');
  await settleAll();

  // A4: a person's PR (#1) and a pi/-prefixed PR the project did not publish (#3), both green with required checks; #1 even has a reviewer approval.
  const B1 = sha('B1'), M1 = sha('M1');
  ghSet(state => { state.pulls.push({ number: 3, title: 'Manual pi branch', head: 'pi/manual', base: 'main', sha: M1, user: 'bob' }); for (const value of [B1, M1]) { state.checks[value] = [{ name: 'lint', conclusion: 'success' }]; state.statuses[value] = [{ context: 'build', state: 'success' }]; } });
  await ask(`MARK-EXT-REVIEW ${B1}`);
  const extReviewer = result.calls.filter(c => c.role === 'reviewer' && /VERDICT-EXT/.test(c.user));
  check('A12 the verdict tool rejects a malformed head SHA', extReviewer.some(c => c.results.length >= 1 && /headSha|pattern|must match/i.test(c.results[0])), extReviewer.map(c => c.results));
  await poll(); await poll(); await delay(300);
  check('A4 PRs not published by the project are never reviewed for or merged, even with an approval or a pi/ branch', mergeCalls(1).length === 0 && mergeCalls(3).length === 0 && !(await reviewers()).some(w => /PR #(1|3) /.test(w.text)));
  await settleAll();

  // A3: auto-merge off: a second project PR gets no reviewer.
  await rpc({ action: 'automation-update', id, change: { autoMerge: { enabled: false } } });
  await ask('MARK-PUBLISH-B please');
  const pr4 = await eventually(() => pull(gh$(), 4), 'worker did not open PR #4');
  const H4 = prHead(4);
  ghSet(state => { state.checks[H4] = [{ name: 'lint', conclusion: 'success' }]; state.statuses[H4] = [{ context: 'build', state: 'success' }]; });
  await poll(); await delay(300);
  check('A3 with auto-merge turned off, a green project PR gets no reviewer and no merge', !(await reviewers()).some(w => w.text.includes('PR #4')) && mergeCalls(4).length === 0, pr4);

  // A15: back on. First a 502 (no effect) → uncertain → inspected as "no merge" → retried; that call merges but answers 502 → inspected and confirmed, never repeated.
  await rpc({ action: 'automation-update', id, change: { autoMerge: { enabled: true } } });
  ghSet(state => { state.failPaths = ['/pulls/4/merge']; });
  await eventually(async () => (await reviewers()).some(w => w.text.includes('PR #4')), 'no reviewer for #4');
  await eventually(async () => /outcome unknown/.test(await lastEvent()), 'no uncertain note for #4', 900);
  const uncertain = (await snap()).follow.merges.find(m => m.pr === 'acme/mari#4').receipts;
  check('A15 a 502 on the merge call is recorded as uncertain, not failed or merged', uncertain.length === 1 && uncertain[0].state === 'uncertain', uncertain);
  ghSet(state => { delete state.failPaths; });
  await poll();
  const inspected = (await snap()).follow.merges.find(m => m.pr === 'acme/mari#4').receipts;
  check('A15 the next poll inspects first: PR still open, so the uncertain receipt becomes a retryable failure without a merge call', inspected[0].state === 'failed' && inspected[0].retryable === true && mergeCalls(4).length === 1, inspected);
  // The retry: the fake merges and then answers 502.
  writeFileSync(join(root, 'merge-then-fail'), '');
  const fakeMergeThenFail = join(root, 'fake-gh-mtf');
  writeFileSync(fakeMergeThenFail, `#!/bin/sh\n"${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\ncode=$?\ncase "$*" in *pulls/4/merge*) echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1;; esac\nexit $code\n`); chmodSync(fakeMergeThenFail, 0o755);
  writeFileSync(fakeGh, `#!/bin/sh\nexec "${fakeMergeThenFail}" "$@"\n`);
  await poll();
  writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`);
  const afterRetry = (await snap()).follow.merges.find(m => m.pr === 'acme/mari#4').receipts;
  check('A15 the retry merged on GitHub but answered 502: recorded uncertain', pull(gh$(), 4).merged === true && afterRetry.at(-1).state === 'uncertain', afterRetry);
  await poll();
  const confirmed = (await snap()).follow.merges.find(m => m.pr === 'acme/mari#4').receipts.at(-1);
  check('A15 the next poll confirms the merge by the marker in the merge commit and never calls merge again', confirmed.state === 'merged' && confirmed.mergeCommit === pull(gh$(), 4).mergeCommit && mergeAttempts(4).length === 1 && /confirmed after an interrupted call/.test(await lastEvent()), { confirmed, attempts: mergeAttempts(4).length });
  await settleAll();

  // A18: a paused project neither polls nor merges.
  await rpc({ action: 'pause', id });
  const paused = await poll().then(() => null, error => error.message);
  check('A18 a paused project refuses to poll, so nothing merges', /paused/.test(paused ?? ''), paused);
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });

  // A19: Settings shows the toggle on, receipts and states; fits 390 px.
  const settingsUrl = new URL((await rpc({ action: 'web' })).url); settingsUrl.searchParams.set('project', id); settingsUrl.searchParams.set('tab', 'settings');
  await send('Page.navigate', { url: settingsUrl.toString() }, s);
  await waitFor(`!!document.querySelector('#merge-receipts')`, s, 'merge receipts');
  const ui = await evaluate(`({ on: document.querySelector('#merge-enabled').checked, rows: [...document.querySelectorAll('#merge-receipts .merge-row')].map(row => row.innerText), merged: document.querySelectorAll('#merge-receipts .merge-receipt.merged').length, failed: document.querySelectorAll('#merge-receipts .merge-receipt.failed').length })`, s);
  check('A19 Settings lists receipts per PR (failed race, merged with merge commit) and the toggle state', ui.on && ui.merged === 2 && ui.failed >= 2 && ui.rows.some(r => r.includes('acme/mari#2') && r.includes('→')), ui);
  await evaluate(`document.querySelector('#auto-merge').scrollIntoView()`, s);
  await shot('01-settings-auto-merge', s);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await delay(300);
  check('A19 the auto-merge section fits a 390 px screen', await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s));
  await evaluate(`document.querySelector('#auto-merge').scrollIntoView()`, s);
  await shot('02-settings-auto-merge-mobile', s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, s);
  const chatUrl = new URL(settingsUrl); chatUrl.searchParams.set('tab', 'coordinator'); chatUrl.searchParams.set('chat', alerts.id);
  await send('Page.navigate', { url: chatUrl.toString() }, s);
  await waitFor(`[...document.querySelectorAll('#messages .event-card.github')].some(c => c.innerText.length)`, s, 'event cards');
  const cardFound = await evaluate(`(() => { const cards = [...document.querySelectorAll('#messages .event-card.github')]; for (const card of cards) card.open = true; const c = cards.findLast(card => card.innerText.includes('auto-merged at')); for (const card of cards) card.open = card === c; c?.scrollIntoView({ block: 'center' }); return !!c; })()`, s);
  check('A17 the Alerts transcript shows the merge as a GitHub activity card', cardFound);
  await shot('03-alerts-merge-event', s);

  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api'));
  check('no browser errors', !result.errors.length && !result.httpErrors.length, result.errors.concat(result.httpErrors));
  result.mergeCalls = ghLog().filter(c => c.target.includes('/merge') || c.target === 'graphql');
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
