// Browser E2E: worktree lifecycle (C2 git merge/rebase + any thread continues a project PR branch, C3 PR-head reads,
// C4 per-project setup command, C9 safe cleanup + Settings action, C11 a/c/d/f/g, attempt.toolNames).
// Isolated host, local fake model, fake gh, local bare remote. No real providers, no network.
// Failure cases recorded in worktree-lifecycle-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `worktree-lifecycle-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `worktree-lifecycle-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome'), clone = join(root, 'clone');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };

const bare = join(root, 'remote.git'), fakeGh = join(root, 'fake-gh'), ghState = join(root, 'fake-gh-state.json'), ghCalls = join(root, 'fake-gh-calls.jsonl');
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, 'scripts/fake-gh.mjs')}" "$@"\n`); chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: 'acme/mari', default_branch: 'main' }, issues: [], checks: {}, pulls: [] }));
writeFileSync(ghCalls, '');
const gh$ = () => JSON.parse(readFileSync(ghState, 'utf8'));
const ghSet = change => { const state = gh$(); change(state); writeFileSync(ghState, JSON.stringify(state)); };

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = value => chunk({ role: 'assistant', content: value }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
// The fake "brain" remembers W1's branch from its push output.
const brain = { b1: null };
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
    const role = tools.includes('projects_delegate') ? 'coordinator' : tools.includes('projects_review_verdict') ? 'reviewer' : tools.includes('bash') ? 'worker' : tools.includes('code_read') ? 'scout' : 'other';
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), userText = contentText(msgs[lastUser]?.content);
    const firstUser = contentText(msgs.find(m => m.role === 'user')?.content);
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    const system = contentText(msgs.find(m => m.role === 'system' || m.role === 'developer')?.content);
    const descriptions = Object.fromEntries((input.tools ?? []).map(t => [t.function?.name, t.function?.description ?? '']));
    result.calls.push({ at: Date.now(), role, first: firstUser.slice(0, 200), user: userText.slice(0, 1500), results: results.map(r => r.slice(0, 3000)), tools, system: role === 'worker' || role === 'coordinator' ? system : undefined, delegateDescription: descriptions.projects_delegate });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = suffix => tools.find(name => name.endsWith(suffix));
    if (role === 'coordinator') {
      const owner = !userText.startsWith('[Durable work');
      if (!owner) return res.end(say(''));
      const n = results.length;
      if (/MARK-BUILD/.test(userText) && n === 0) return res.end(call('projects_delegate', { role: 'worker', task: 'W1-TASK add feature.txt and open a draft PR for it' }));
      if (/MARK-CONTINUE/.test(userText) && n === 0) return res.end(call('projects_delegate', { role: 'worker', task: `W2-TASK continue the open PR branch ${brain.b1}: merge main into it, resolve conflicts, then rebase it onto main and push it back` }));
      if (/MARK-REVIEW (\S+)/.test(userText)) {
        const scope = /MARK-REVIEW (\S+)/.exec(userText)[1];
        if (n === 0) return res.end(call('projects_delegate', { role: 'reviewer', ref: brain.b1, task: 'REVIEW-HEAD review feature.txt on the PR head' }));
        if (n === 1) return res.end(call('projects_delegate', { role: 'scout', workspaceScopeId: scope, task: 'SCOUT-SCOPED read README.md' }));
        if (n === 2) return res.end(call('projects_delegate', { role: 'reviewer', ref: '--upload-pack=touch /tmp/pwned', task: 'BAD-REF' }));
        if (n === 3) return res.end(call('projects_delegate', { role: 'reviewer', ref: 'pi/does-not-exist', task: 'MISSING-REF' }));
        return res.end(say('Review dispatched.'));
      }
      if (/MARK-LOCAL/.test(userText) && n === 0) return res.end(call('projects_delegate', { role: 'worker', task: 'W3-TASK commit local.txt locally; do not push' }));
      if (/MARK-FOLLOW (\S+)/.test(userText) && n === 0) return res.end(call('projects_worker_control', { action: 'follow_up', threadId: /MARK-FOLLOW (\S+)/.exec(userText)[1], text: 'W1-AGAIN one more change', requestId: randomUUID() }));
      return res.end(say('Noted.'));
    }
    if (role === 'worker') {
      const n = results.length;
      if (/W1-TASK/.test(firstUser) && !/W1-AGAIN/.test(userText)) {
        if (n === 0) return res.end(call('bash', { command: `cat node_modules/dep/ok.txt && printf 'v1\\n' > feature.txt && git add -A && git commit -qm 'Add feature' && git push -q -u origin HEAD && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD` }));
        if (n === 1) { brain.b1 = /(pi\/durable-[0-9a-f-]+)/.exec(results[0])?.[1]; return res.end(call(tool('_open_draft_pr'), { expectedHead: /[a-f0-9]{40}/.exec(results[0])?.[0], title: 'Add feature', body: 'Adds feature.txt.' })); }
        return res.end(say(`W1-DONE branch ${brain.b1}`));
      }
      if (/W2-TASK/.test(firstUser)) {
        if (userText.startsWith('[Child work')) return res.end(say('W2-DONE after child review'));
        const b = brain.b1;
        const steps = [
          `git fetch -q origin && git checkout -q -B cont origin/${b} && git merge --no-edit origin/main; echo MERGE-EXIT=$?`,
          `printf 'v1+main\\n' > feature.txt && git add feature.txt && git -c core.editor=true merge --continue >/dev/null && git log --oneline -1 && git merge-base HEAD origin/main && git push -q origin HEAD:${b} && echo PUSHED-MERGE`,
          `git push origin HEAD:main`,
          `git push --force origin HEAD:${b}`,
          `git log --oneline -1 >/dev/null && git checkout -q -B rb origin/${b} && git rebase -X theirs origin/main >/dev/null 2>&1; git log --format=%s -3 && git push -q --force-with-lease origin HEAD:${b} && echo PUSHED-REBASE && git rev-parse HEAD`,
          `printf 'wip\\n' > wip-note.txt && echo WIP-WRITTEN`,
        ];
        if (n < steps.length) return res.end(call('bash', { command: steps[n] }));
        if (n === steps.length) return res.end(call('projects_delegate_child', { role: 'reviewer', task: 'CHILD-REVIEW read wip-note.txt in my worktree' }));
        return res.end(say('W2-WAITING for the child reviewer'));
      }
      if (/W3-TASK/.test(firstUser)) {
        if (n === 0) return res.end(call('bash', { command: `printf 'local\\n' > local.txt && git add local.txt && git commit -qm 'Local only' && echo COMMITTED` }));
        return res.end(say('W3-DONE'));
      }
      return res.end(say('Worker done.'));
    }
    if (role === 'reviewer' || role === 'scout') {
      const file = /CHILD-REVIEW/.test(firstUser) ? 'wip-note.txt' : /REVIEW-HEAD/.test(firstUser) ? 'feature.txt' : 'README.md';
      if (results.length === 0) return res.end(call('code_read', { path: file }));
      return res.end(say(`SAW[${file}]: ${results[0].replace(/\s+/g, ' ').slice(0, 200)}`));
    }
    res.end(say('Done.'));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: ghCalls };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
execFileSync('/usr/bin/git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
git(workspace, 'remote', 'add', 'origin', 'https://github.com/acme/mari.git'); git(workspace, 'config', 'remote.origin.pushurl', bare);
writeFileSync(join(workspace, 'README.md'), 'base readme\n'); writeFileSync(join(workspace, '.gitignore'), 'node_modules\n'); writeFileSync(join(workspace, 'AGENTS.md'), '# Rules\nRun `worktree:setup` first.\n');
git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'c1'); git(workspace, 'push', '-q', 'origin', 'main');

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
  let page = ''; try { page = await evaluate(`document.body.innerText.slice(0, 3000)`, session); } catch {}
  throw Error(`Timed out waiting for ${label}; page: ${page}`);
}

startHost();
try {
  await waitHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Worktrees', cwd: workspace, objective: 'Disposable worktree-lifecycle fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { workerCap: 3, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const second = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'github-quick-authorize', id, confirm: id, expectedRevision: second.githubRevision });
  const scopeId = (await rpc({ action: 'owner-setup-snapshot', id })).workspace.scopes[0].id;
  // Fetches go to the local bare remote too (set after the grants, which read the GitHub origin URL).
  git(workspace, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/mari.git'); git(workspace, 'fetch', '-q', 'origin');
  const plan = async () => (await rpc({ action: 'plan-snapshot', id })).work;
  const settleAll = () => eventually(async () => { const main = await rpc({ action: 'show', id }); return !main.chats.some(c => c.busy) && !(await plan()).some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 1200);
  const ask = async text => { await rpc({ action: 'message', id, text }); await delay(300); await settleAll(); };
  const byText = (work, marker) => work.filter(w => w.text.includes(marker));
  const inventory = () => rpc({ action: 'worktrees-snapshot', id });

  // UI: Settings → Worktrees card; save the setup command through the page.
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'settings');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`!!document.querySelector('#worktrees #worktree-setup')`, s, 'worktrees card');
  const setupCommand = 'mkdir -p node_modules/dep && echo installed > node_modules/dep/ok.txt && echo SETUP-DONE';
  await evaluate(`(() => { document.querySelector('#worktree-setup').value = ${JSON.stringify(setupCommand)}; document.querySelector('[data-action="worktree-setup-save"]').click(); })()`, s);
  await eventually(async () => (await rpc({ action: 'settings-snapshot', id })).values.worktreeSetup === setupCommand, 'setup command not saved from the UI');
  check('W5 the setup command is saved from Settings (revision-checked settings-update)', true);

  // Step 1: W1 builds and opens a PR; setup ran in its fresh worktree.
  await ask('MARK-BUILD');
  let work = await plan();
  const [w1] = byText(work, 'W1-TASK');
  check('setup: W1 completed and opened draft PR #1 on its pi/ branch', w1?.status === 'completed' && gh$().pulls[0]?.head === brain.b1 && /^pi\/durable-/.test(brain.b1 ?? ''), { w1, pulls: gh$().pulls, b1: brain.b1 });
  const w1Calls = result.calls.filter(c => c.role === 'worker' && /W1-TASK/.test(c.first));
  check('W1/D the setup command ran in the new worktree before the worker (deps present)', /installed/.test(w1Calls[1]?.results[0] ?? ''), w1Calls[1]?.results);
  check('W3 the worker is told the setup result', /Worktree setup ran when this worktree was created/.test(w1Calls[0].system), w1Calls[0].system.slice(-1500));
  check('G10/C11g YOLO text: no unconditional open_draft_pr; merge/rebase/continue-branch allowed; force-with-lease only on project branches', !/After pushing, call the GitHub open_draft_pr/.test(w1Calls[0].system) && /only when your task asks for a PR/.test(w1Calls[0].system) && /fetch, merge, rebase/.test(w1Calls[0].system) && /--force-with-lease, only on project branches/.test(w1Calls[0].system), w1Calls[0].system.slice(-1500));
  check('M1 attempt.toolNames records the tools actually bound (bash, open_draft_pr)', w1.attempt.toolNames.includes('bash') && w1.attempt.toolNames.some(name => name.endsWith('_open_draft_pr')), w1.attempt.toolNames);
  const coordSystem = result.calls.find(c => c.role === 'coordinator').system;
  check('G11/C11a coordinator: any worker may continue a PR branch; no transfer/cherry-pick threads; PR-head ref for reviewers', /any worker may continue the PR branch/.test(coordSystem) && /Never split this into transfer or cherry-pick threads/.test(coordSystem) && /pass ref/.test(coordSystem), coordSystem.slice(0, 400));

  // Base moves with a conflicting feature.txt.
  execFileSync('/usr/bin/git', ['clone', '-q', bare, clone]); git(clone, 'config', 'user.email', 'o@example.invalid'); git(clone, 'config', 'user.name', 'Owner');
  writeFileSync(join(clone, 'feature.txt'), 'main\n'); writeFileSync(join(clone, 'base2.txt'), 'b2\n'); git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'Owner change on main'); git(clone, 'push', '-q', 'origin', 'main');
  const mainHead = git(bare, 'rev-parse', 'main');

  // Step 2: a NEW thread continues W1's PR branch: merge with conflict resolution, merge-base, rebase + force-with-lease.
  await ask('MARK-CONTINUE');
  work = await plan();
  const [w2] = byText(work, 'W2-TASK');
  const w2Calls = result.calls.filter(c => c.role === 'worker' && /W2-TASK/.test(c.first) && !c.user.startsWith('[Child work'));
  const out = i => w2Calls.find(c => c.results.length === i + 1)?.results[i] ?? '';
  check('setup: W2 (a second thread) completed', w2?.status === 'completed' && w2.threadId !== w1.threadId, w2);
  check('G2 git merge origin/main runs (conflict reported, not blocked by policy)', /CONFLICT/.test(out(0)) && /MERGE-EXIT=1/.test(out(0)) && !/Blocked by worker Git policy/.test(out(0)), out(0));
  check('G1/G5 conflict resolved, merge-base allowed in a compound command, pushed to another thread\'s project branch', /PUSHED-MERGE/.test(out(1)) && new RegExp(mainHead).test(out(1)), out(1));
  check('G6/G8 push to main is blocked and the message names the blocked segment', /Blocked by worker Git policy at: git push origin HEAD:main/.test(out(2)), out(2));
  check('G4 plain --force to a project branch is blocked', /Blocked by worker Git policy at: git push --force/.test(out(3)), out(3));
  const rebased = git(bare, 'rev-parse', `refs/heads/${brain.b1}`);
  check('G3 rebase onto main + --force-with-lease to the project PR branch succeeds (linear on top of main)', /PUSHED-REBASE/.test(out(4)) && out(4).includes(rebased) && git(bare, 'rev-parse', `${rebased}^`) === mainHead && git(bare, 'show', `${rebased}:feature.txt`) === 'v1', { out: out(4), rebased });
  const childReview = byText(work, 'CHILD-REVIEW')[0];
  const childSaw = result.calls.filter(c => c.role === 'reviewer' && /CHILD-REVIEW/.test(c.first)).at(-1)?.results[0] ?? '';
  check('R4 a worker\'s child reviewer reads the parent\'s worktree (uncommitted wip-note.txt)', childReview?.status === 'completed' && /wip/.test(childSaw), { childReview, childSaw });

  // Step 3: reviewer with ref reads the PR head; scout with a workspace scope runs read-only; bad refs are refused.
  await ask(`MARK-REVIEW ${scopeId}`);
  work = await plan();
  const [review] = byText(work, 'REVIEW-HEAD'), [scout] = byText(work, 'SCOUT-SCOPED');
  const reviewSaw = result.calls.filter(c => c.role === 'reviewer' && /REVIEW-HEAD/.test(c.first)).at(-1)?.results[0] ?? '';
  const delegations = result.calls.filter(c => c.role === 'coordinator' && /MARK-REVIEW/.test(c.user)).at(-1).results;
  const receipt = JSON.parse(delegations[0]);
  check('R1 a reviewer delegated with ref reads the PR head (feature.txt v1), not the owner checkout (no feature.txt)', review?.status === 'completed' && /v1/.test(reviewSaw) && !existsSync(join(workspace, 'feature.txt')) && receipt.reads?.sha === rebased, { reviewSaw, receipt });
  check('S1/C11f a scout given workspaceScopeId runs read-only (scope ignored, receipt says so)', scout?.status === 'completed' && scout.workspaceScopeId == null && /workspaceScopeId ignored/.test(delegations[1]), { scout, d: delegations[1] });
  check('R2 an option-like ref is refused before any git call', /Invalid ref/.test(delegations[2]) && !existsSync('/tmp/pwned'), delegations[2]);
  check('R6 an unknown ref refuses the delegation clearly', /was not found on origin or locally/.test(delegations[3]) && !byText(work, 'MISSING-REF').length, delegations[3]);

  // Step 4: change the setup to a failing command; W3 commits locally only.
  const s2 = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: s2.revision, changes: { worktreeSetup: 'echo boom-setup >&2; exit 3' } });
  await ask('MARK-LOCAL');
  work = await plan();
  const [w3] = byText(work, 'W3-TASK');
  const w3System = result.calls.find(c => c.role === 'worker' && /W3-TASK/.test(c.first)).system;
  check('W3 a failing setup is visible to the worker (exit code + output)', w3?.status === 'completed' && /Worktree setup FAILED/.test(w3System) && /exited 3/.test(w3System) && /boom-setup/.test(w3System), w3System.slice(-800));

  // C11: the scripted multi-step session stayed small: W1, W2 (continues W1's branch), W2's child reviewer, PR reviewer, scout, W3.
  const threads = new Set(work.map(w => w.threadId));
  result.threads = threads.size; result.workItems = work.length;
  check('C11 six threads for the whole script; no transfer-commit thread, no extra PR', threads.size === 6 && gh$().pulls.length === 1, work.map(w => [w.role, w.status, w.text.slice(0, 30)]));

  // Step 5: inventory before the PR is merged.
  let inv = await inventory();
  result.inventoryBefore = inv;
  const item = branchName => inv.items.find(entry => entry.kind === 'worker' && entry.threadId === branchName);
  const [i1, i2, i3] = [w1, w2, w3].map(w => item(w.threadId));
  check('K4 W1 (open PR #1) is kept', i1 && !i1.removable && i1.reasons.some(r => /open PR #1/.test(r)), i1);
  check('K1 W2 (uncommitted wip-note.txt) is kept', i2 && !i2.removable && i2.reasons.some(r => /uncommitted or untracked/.test(r)), i2);
  check('K2 W3 (commit not on any remote, no PR) is kept', i3 && !i3.removable && i3.reasons.some(r => /1 commit\(s\) not on any remote/.test(r)), i3);
  check('W3 Settings inventory records setup results (W1 ok, W3 failed exit 3)', i1.setup?.ok === true && i3.setup?.ok === false && i3.setup.exitCode === 3, { s1: i1.setup, s3: i3.setup });
  const heads = inv.items.filter(entry => entry.kind === 'read-head');
  check('K10 the settled reviewer\'s PR-head snapshot is removable', heads.length === 1 && heads[0].removable, heads);
  check('K7 reclaimable size is reported', inv.reclaimableKb > 0 && inv.reclaimableKb === inv.items.filter(e => e.removable).reduce((a, e) => a + e.sizeKb, 0), inv);

  // PR #1 merged → W1 becomes removable (its old pre-rebase commit is off-remote, but the PR is merged).
  ghSet(state => { state.pulls[0].state = 'closed'; state.pulls[0].merged = true; });
  inv = await inventory();
  check('K4 after the PR merged, W1 is removable', inv.items.find(e => e.threadId === w1.threadId)?.removable === true, inv.items.find(e => e.threadId === w1.threadId));
  await send('Page.reload', {}, s);
  await waitFor(`!!document.querySelector('#worktree-list') && document.querySelector('[data-action="worktrees-cleanup"]') && !document.querySelector('[data-action="worktrees-cleanup"]').disabled`, s, 'worktree list with cleanup');
  await evaluate(`document.querySelector('#worktrees-card').scrollIntoView()`, s); await delay(300);
  await shot('01-worktrees-before-cleanup', s);
  const uiText = await evaluate(`document.querySelector('#worktrees-card').innerText`, s);
  check('K7 Settings shows sizes, kept reasons, setup failure and the reclaimable cleanup button', /reclaimable/.test(uiText) && /uncommitted or untracked changes/.test(uiText) && /not on any remote/.test(uiText) && /setup failed \(exit 3\)/.test(uiText) && /#1 merged/.test(uiText) && /Clean up worktrees \(/.test(uiText), uiText);
  const w1Path = inv.items.find(e => e.threadId === w1.threadId).path, w2Path = i2.path, w3Path = i3.path, headPath = heads[0].path;
  await evaluate(`document.querySelector('[data-action="worktrees-cleanup"]').click()`, s);
  await eventually(async () => !existsSync(w1Path) && !existsSync(headPath), 'cleanup did not remove W1 and the snapshot', 300);
  await waitFor(`/Removed 2 worktree/.test(document.querySelector('#toast')?.innerText ?? '')`, s, 'cleanup toast');
  await delay(500); await shot('02-worktrees-after-cleanup', s);
  check('C9 manual cleanup removed W1 and the PR-head snapshot; W2 and W3 stay', !existsSync(w1Path) && !existsSync(headPath) && existsSync(w2Path) && existsSync(w3Path) && existsSync(join(w2Path, 'wip-note.txt')));
  check('K5/K9 removal worked with ignored node_modules and kept W1\'s local branch', /^[0-9a-f]{40}$/.test(git(workspace, 'rev-parse', '--verify', `refs/heads/${brain.b1}`)), brain.b1);

  // K6: following up the cleaned thread fails with a clear "continue branch" message.
  await ask(`MARK-FOLLOW ${w1.threadId}`);
  work = await plan();
  const again = byText(work, 'W1-AGAIN')[0];
  check('K6 a follow-up on a cleaned-up thread fails clearly, pointing at the kept branch', again?.status === 'failed' && /worktree was cleaned up/.test(again.blocker ?? '') && /continue branch pi\/durable-/.test(again.blocker ?? ''), again);

  // K8: automatic cleanup. Publish W3's commit, restart with a short interval; W3 goes, dirty W2 stays.
  git(w3Path, 'push', '-q', 'origin', `HEAD:refs/heads/${git(w3Path, 'rev-parse', '--abbrev-ref', 'HEAD')}`);
  await stopHost(); env.PI_PROJECTS_WORKTREE_CLEANUP_MS = '1500'; startHost(); await waitHost();
  await rpc({ action: 'show', id });
  await eventually(async () => !existsSync(w3Path), 'automatic cleanup did not remove W3', 600);
  await delay(2000);
  check('K8 automatic cleanup removed the now-pushed W3 and kept dirty W2', !existsSync(w3Path) && existsSync(join(w2Path, 'wip-note.txt')));

  result.errors = result.errors.filter(e => !/Failed to load resource/.test(e));
  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/api'));
  check('no browser errors', !result.errors.length && !result.httpErrors.length, result.errors.concat(result.httpErrors));
  result.plan = await plan();
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  await stopHost().catch(() => host.kill('SIGKILL'));
  model.closeAllConnections(); model.close(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks.length, failure: result.failure, threads: result.threads, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
