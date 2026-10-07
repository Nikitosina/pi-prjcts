// Browser E2E with an isolated host and a local fake model. No real providers, no network.
// Failure cases recorded in skills-scale-chats-failures.md before implementation.
// Covers: owner worker-skills catalog with 89 configured skills (paged), usage/observability across chats,
// project attention aggregated across chats, the chat bar at 390px, and a project written by the pre-multi-chat host (95817c3).
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream, symlinkSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `skills-scale-chats-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `skills-chats-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), legacyCwd = join(root, 'legacy-cwd'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome'), legacySrc = join(root, 'legacy-src');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, legacyCwd, agentDir, userHome, legacySrc]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
writeFileSync(join(legacyCwd, 'README.md'), 'legacy fixture\n');

// 89 configured skills, the owner's real count; above the old 64 cap.
const SKILLS = 89;
for (let i = 0; i < SKILLS; i++) { const name = `owner-skill-${String(i).padStart(2, '0')}`, dir = join(agentDir, 'skills', name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Generated owner skill number ${i}.\n---\n\n# ${name}\n\n${'Body text for a realistic skill. '.repeat(40)}\n`); }
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
git(workspace, 'remote', 'add', 'origin', 'https://github.com/acme/skills.git');
writeFileSync(join(workspace, 'README.md'), 'base\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'c1');

// The pre-multi-chat host, extracted from git (no worktree metadata), sharing this checkout's node_modules.
execFileSync('/bin/sh', ['-c', `git -C "${repo}" archive 95817c3 | tar -x -C "${legacySrc}"`]);
symlinkSync(join(repo, 'node_modules'), join(legacySrc, 'node_modules'));
// src/github-authorization.ts was gitignored (*auth*) at 95817c3, so the archive lacks it; it is unchanged by the multi-chat commit.
if (!existsSync(join(legacySrc, 'src/github-authorization.ts'))) copyFileSync(join(repo, 'src/github-authorization.ts'), join(legacySrc, 'src/github-authorization.ts'));

const usage = { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 };
const chunk = (delta, finish, extra = {}) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls', { usage }) + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop', { usage }) + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
const scripts = { 'MARK-DELEG': [['projects_delegate', { role: 'scout', task: 'MARK-SCOUTJOB look around' }]] };
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages;
    const tools = (input.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
    const coordinator = tools.includes('projects_delegate');
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const userText = contentText(msgs[lastUser]?.content);
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    result.calls.push({ coordinator, marker, stage: results.length, user: userText.slice(0, 300) });
    const reply = text => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
    if (marker === 'MARK-FAIL') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'FAKE-MODEL-BROKEN', type: 'invalid_request_error' } })); }
    if (!coordinator) return reply(say(marker === 'MARK-SCOUTJOB' ? 'SCOUT-RESULT-42' : `Worker ${marker}`));
    if (userText.startsWith('[Durable work')) return reply(say('REPORT-ACK'));
    const steps = scripts[marker] ?? [];
    if (results.length < steps.length) return reply(call(...steps[results.length]));
    return reply(say(`Done ${marker}.`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'wx', mode: 0o600 });
let host, hostEnded = true, hostExit = Promise.resolve();
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 120000 }, res => {
      res.setEncoding('utf8');
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = 600) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error(description);
}
async function startHost(source = repo) {
  host = spawn(process.execPath, [join(source, 'src/host.ts')], { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
  hostEnded = false; hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
}
async function stopHost() { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(15000)]); if (!hostEnded) throw Error('Host did not stop'); }

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
    const key = ++cdpId; const timer = setTimeout(() => { pending.delete(key); reject(Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(key, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression, session) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; }
async function shot(name, session) { const image = await send('Page.captureScreenshot', { format: 'png' }, session); writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); }
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expression, session)) return; await delay(250); }
  throw Error(`Timed out waiting for ${label}`);
}
const click = (s, selector) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw Error('missing ' + ${JSON.stringify(selector)}); n.click(); })()`, s);
const settle = async (id, chatId, job) => eventually(async () => { const view = await rpc({ action: 'show', id, ...(chatId ? { chatId } : {}) }); const found = view.jobs.find(j => j.id === job.id); return ['done', 'failed', 'interrupted'].includes(found?.state) && found; }, 'Job did not settle');
const ask = async (id, chatId, text) => { const job = await rpc({ action: 'message', id, text, ...(chatId ? { chatId } : {}) }); const done = await settle(id, chatId, job); if (done.state !== 'done') throw Error(`${text} failed: ${done.error}`); return done; };

try {
  // F19 part 1: the pre-multi-chat host writes a project with one turn.
  await startHost(legacySrc);
  const legacy = await rpc({ action: 'create', requestId: randomUUID(), name: 'Legacy fixture', cwd: legacyCwd, objective: 'Written by 95817c3', model: 'fake/fake-model' });
  const legacySettings = await rpc({ action: 'settings-snapshot', id: legacy.id });
  await rpc({ action: 'settings-update', id: legacy.id, confirm: legacy.id, expectedRevision: legacySettings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const legacyJob = await rpc({ action: 'message', id: legacy.id, text: 'MARK-LEGACY hello from the old host' });
  const legacyDone = await eventually(async () => { const view = await rpc({ action: 'show', id: legacy.id }); const found = view.jobs.find(j => j.id === legacyJob.id); return found?.state === 'done' && view; }, 'Legacy turn did not finish');
  if ('chats' in legacyDone || legacyDone.jobs.some(job => 'chatId' in job)) throw Error('Fixture is not the pre-multi-chat shape');
  await stopHost();
  result.legacyFiles = readdirSync(join(home, legacy.id)).sort();
  result.checks.push('F19 fixture: commit 95817c3 host created a project and finished a turn (no chats, jobs without chatId)');

  await startHost();
  const opened = await rpc({ action: 'show', id: legacy.id });
  if (opened.chats?.length !== 1 || opened.chats[0].id !== 'main' || opened.chats[0].title !== 'Main' || opened.chatId !== 'main' || !opened.messages.some(m => m.text === 'Done MARK-LEGACY.') || opened.jobs.length !== 1 || opened.project.problem) throw Error('Legacy project opened wrong: ' + JSON.stringify({ chats: opened.chats, jobs: opened.jobs, problem: opened.project.problem }));
  await ask(legacy.id, undefined, 'MARK-LEGACY2 after upgrade');
  result.checks.push('F19 the 95817c3 project opens with exactly Main, keeps its transcript and ledger, and accepts a new turn');

  // A: 89 configured skills, paged.
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Skills and chats', cwd: workspace, objective: 'Disposable fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const setup = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: setup.workspaceRevision });
  const pages = [];
  for (let offset = 0; offset !== null;) { const page = await rpc({ action: 'worker-skills-catalog', id, offset, limit: 16 }); pages.push(page); offset = page.page.nextOffset; if (pages.length > 10) throw Error('Paging never ends'); }
  const all = pages.flatMap(page => page.candidates), configured = all.filter(c => c.origin.kind === 'configured');
  if (pages.length !== 6 || new Set(pages.map(p => p.revision)).size !== 1 || pages.some(p => p.page.total !== SKILLS) || new Set(all.map(c => c.catalogId)).size !== SKILLS || configured.length !== SKILLS) throw Error('Catalog paging wrong: ' + JSON.stringify(pages.map(p => ({ rev: p.revision, page: p.page, n: p.candidates.length }))));
  const big = await rpc({ action: 'worker-skills-catalog', id, offset: 64, limit: 64 });
  if (big.candidates.length !== SKILLS - 64 || big.page.nextOffset !== null || big.revision !== pages[0].revision) throw Error('64-wide page wrong');
  result.catalog = { total: SKILLS, pages: pages.length, revision: pages[0].revision };
  // L2: the CLI prints every page, not the first 16.
  const cliEnv = { ...env }; delete cliEnv.PI_PROJECTS_HOST;
  const cli = JSON.parse(execFileSync(process.execPath, [join(repo, 'src/cli.ts'), '--no-start', 'owner-skills-catalog', id], { cwd: repo, env: cliEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  if (cli.candidates.length !== SKILLS || cli.page.nextOffset !== null || cli.revision !== pages[0].revision || new Set(cli.candidates.map(c => c.catalogId)).size !== SKILLS) throw Error('CLI catalog incomplete: ' + JSON.stringify({ n: cli.candidates.length, page: cli.page }));
  result.checks.push(`L2 CLI owner-skills-catalog returns all ${SKILLS} candidates of one revision`);
  result.checks.push('F1-F5 owner worker-skills catalog with 89 configured skills captures; 16-wide pages 0..88 are disjoint, stable revision, nextOffset ends null; offset 64 accepted');
  const last = all.at(-1), scopeId = (await rpc({ action: 'show', id })).project.workspaceAuthorization.scopes[0].id;
  const grants = await rpc({ action: 'worker-skills-grants', id });
  await rpc({ action: 'worker-skills-grant-set', id, confirm: id, expectedCatalogRevision: pages[0].revision, expectedGrantsRevision: grants.revision, selection: { id: randomUUID(), scopeIds: [scopeId], skills: [{ catalogId: last.catalogId, references: [] }], enabled: true } });
  const granted = await rpc({ action: 'worker-skills-grants', id });
  if (granted.grants.length !== 1 || granted.grants[0].skills[0].name !== last.name) throw Error('Grant from last page failed');
  result.checks.push(`F7 a skill from the last page (${last.name}) is granted against the same catalog revision`);

  // B: three chats. Main answers, "Research" delegates a scout, "Broken" fails.
  await ask(id, undefined, 'MARK-MAIN hello');
  const research = await rpc({ action: 'chat-create', id, title: 'Research' });
  await ask(id, research.id, 'MARK-DELEG scout please');
  await eventually(async () => (await rpc({ action: 'show', id, chatId: research.id })).messages.some(m => m.text === 'REPORT-ACK'), 'Report did not reach Research');
  const broken = await rpc({ action: 'chat-create', id, title: 'Broken' });

  // F14/F16: fail in Broken, observe only through Main; the unsettled job in the other chat is settled.
  const failJob = await rpc({ action: 'message', id, chatId: broken.id, text: 'MARK-FAIL boom' });
  const failing = await eventually(async () => { const view = await rpc({ action: 'show', id }); return view.project.problem && view; }, 'Failure in Broken never reached Main', 900);
  if (!failing.project.problem.startsWith('Chat "Broken": ') || failing.project.phase !== 'attention' || !failing.chats.find(c => c.id === broken.id)?.attention || failing.chats.find(c => c.id === 'main').attention) throw Error('Aggregated attention wrong: ' + JSON.stringify({ problem: failing.project.problem, chats: failing.chats }));
  const failedRecord = (await rpc({ action: 'show', id, chatId: broken.id })).jobs.find(j => j.id === failJob.id);
  if (failedRecord?.state !== 'failed') throw Error('Broken job not failed: ' + JSON.stringify(failedRecord));
  const fromResearch = await rpc({ action: 'show', id, chatId: research.id });
  if (fromResearch.project.problem !== failing.project.problem) throw Error('Viewing a healthy chat cleared the failure');
  const fromBroken = await rpc({ action: 'show', id, chatId: broken.id });
  if (fromBroken.project.problem !== failedRecord.error) throw Error('Viewed failing chat should show its raw error');
  result.aggregatedProblem = failing.project.problem;
  result.checks.push('F14/F15/F16 a failed turn in "Broken" is settled and raised as project attention while only Main is viewed; viewing a healthy chat keeps it; the failing chat is flagged');

  // UI.
  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#messages')?.innerText.includes('Done MARK-MAIN') && document.querySelectorAll('#chat-list .chat').length === 3`, s, 'project loaded');
  await waitFor(`document.querySelector('#chat-list .chat[data-chat=${JSON.stringify(broken.id)}]').classList.contains('attention') && document.querySelector('#warning')?.innerText.includes('Chat "Broken"') && !!document.querySelector('#warning [data-action="chat-select"]')`, s, 'attention in UI');
  await shot('01-main-shows-broken-chat-attention', s);
  result.checks.push('F17 Main shows the Broken chat failure with Open chat, and the Broken pill is flagged');

  // A in UI: the grant dialog lists all 89.
  await click(s, '#owner-setup-button');
  await waitFor(`!!document.querySelector('#dialog [data-kind="worker-skills-grant-set"]')`, s, 'owner setup dialog');
  await click(s, '#dialog [data-kind="worker-skills-grant-set"]');
  await waitFor(`document.querySelectorAll('#dialog .dialog-body ul li').length === ${SKILLS} && document.querySelector('#dialog .dialog-body').innerText.includes('${SKILLS} skills')`, s, 'grant dialog lists every skill', 400);
  await evaluate(`document.querySelector('#dialog .dialog-body ul li:last-child').scrollIntoView()`, s);
  await shot('02-skill-grant-dialog-89', s);
  await evaluate(`document.querySelector('#dialog').close()`, s);
  result.checks.push('F6 the owner grant dialog pages through and lists all 89 skills');

  // F10-F13: Observability covers every chat.
  const usagePage = await rpc({ action: 'usage-snapshot', id });
  const researchUsage = usagePage.chats?.find(c => c.chatId === research.id);
  if (usagePage.chats?.length !== 2 || !(researchUsage?.total.totalTokens > 0) || !(usagePage.coordinator.total.totalTokens > 0) || usagePage.chatTotal.totalTokens !== usagePage.chats.reduce((n, c) => n + c.total.totalTokens, 0)) throw Error('Usage misses chats: ' + JSON.stringify({ chats: usagePage.chats?.map(c => ({ id: c.chatId, t: c.total.totalTokens })), main: usagePage.coordinator.total.totalTokens }));
  result.usage = { main: usagePage.coordinator.total.totalTokens, chats: usagePage.chats.map(c => ({ title: c.title, tokens: c.total.totalTokens })), workers: usagePage.workers.map(w => w.total.totalTokens) };
  await click(s, '[data-tab="observability"]');
  await waitFor(`document.querySelectorAll('#obs-trace .trace-chat').length === 3 && document.querySelector('#obs-usage')?.innerText.includes('Chat · Research') && document.querySelector('#obs-usage')?.innerText.includes('Chat · Main')`, s, 'observability lists chats');
  const trace = await evaluate(`Object.fromEntries([...document.querySelectorAll('#obs-trace .trace-chat')].map(n => [n.dataset.chat, n.querySelector('summary').innerText + ' | ' + [...n.querySelectorAll(':scope > details > ul > li')].map(li => li.innerText.split('\\n')[0]).join(' / ')]))`, s);
  if (!/scout thread/.test(trace[research.id]) || /scout thread/.test(trace.main) || !/needs attention/.test(trace[broken.id])) throw Error('Trace grouping wrong: ' + JSON.stringify(trace));
  const usageText = await evaluate(`document.querySelector('#obs-usage').innerText`, s);
  if (!/3\s*chats/.test(usageText)) throw Error('Usage head lacks chat count: ' + usageText.slice(0, 300));
  result.trace = trace;
  // L1: host health aggregates failed jobs and attention across chats while Main is viewed.
  await waitFor(`(() => { const t = document.querySelector('#obs-health')?.innerText ?? ''; return /Failed jobs\\s*1\\b/.test(t) && /Project\\s*needs attention/.test(t); })()`, s, 'health aggregates chats');
  result.checks.push('L1 Observability health shows Failed jobs 1 and Project "needs attention" from the Broken chat while Main is viewed');
  await shot('03-observability-all-chats', s);
  result.checks.push('F10-F13 usage counts Main, Research and Broken with per-chat rows; the trace has one node per chat with the scout thread under Research');

  // F15: a later success in Broken clears the aggregated problem.
  await ask(id, broken.id, 'MARK-OK recovered');
  const cleared = await rpc({ action: 'show', id });
  if (cleared.project.problem || cleared.chats.some(c => c.attention)) throw Error('Problem not cleared: ' + cleared.project.problem);
  result.checks.push('F15 a later success in the failing chat clears project attention');

  // F18: chat bar at 390px.
  await click(s, '[data-tab="coordinator"]');
  const mobile = await rpc({ action: 'chat-create', id, title: 'A rather long chat title for narrow screens' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await waitFor(`document.querySelectorAll('#chat-list .chat').length === 4`, s, 'four chats at 390px');
  await delay(500);
  const layout = await evaluate(`(() => { const r = n => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; }; const bar = document.querySelector('#chat-bar'); return { viewport: innerWidth, docWidth: document.documentElement.scrollWidth, bar: r(bar), list: r(document.querySelector('#chat-list')), newChat: r(bar.querySelector('[data-action="chat-new"]')), tools: [...bar.querySelectorAll('.chat-tools button')].map(r), pills: [...bar.querySelectorAll('#chat-list .chat')].map(r) }; })()`, s);
  result.layout390 = layout;
  const inside = b => b.left >= -0.5 && b.right <= layout.viewport + 0.5;
  if (layout.docWidth > layout.viewport || !inside(layout.bar) || !inside(layout.list) || !inside(layout.newChat) || !layout.tools.every(inside)) throw Error('Chat bar overflows at 390px: ' + JSON.stringify(layout));
  const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  if (layout.tools.some(t => overlap(t, layout.newChat) || overlap(t, layout.list)) || overlap(layout.newChat, layout.list)) throw Error('Chat bar controls overlap at 390px: ' + JSON.stringify(layout));
  await shot('04-chat-bar-390', s);
  await click(s, `#chat-list .chat[data-chat="${mobile.id}"]`);
  await waitFor(`document.querySelector('#chat-list .chat.on')?.dataset.chat === ${JSON.stringify(mobile.id)}`, s, 'select long chat at 390px');
  await shot('05-chat-bar-390-long-selected', s);
  result.checks.push('F18 at 390px the chat bar stays within the viewport, no horizontal page scroll, pills/New chat/tools do not overlap');

  // F19 in the browser: the legacy project shows Main only.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  const legacyUrl = new URL(web.url); legacyUrl.searchParams.set('project', legacy.id); legacyUrl.searchParams.set('tab', 'coordinator');
  await send('Page.navigate', { url: legacyUrl.toString() }, s);
  await waitFor(`document.querySelector('#messages')?.innerText.includes('Done MARK-LEGACY.') && document.querySelectorAll('#chat-list .chat').length === 1 && document.querySelector('#chat-list .chat.on')?.dataset.chat === 'main'`, s, 'legacy project in browser');
  await shot('06-legacy-project-main', s);
  result.checks.push('F19 the 95817c3 project renders with a single Main pill and its old transcript');

  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/live'));
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured: ' + JSON.stringify({ errors: result.errors, http: result.httpErrors }));
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { if (!hostEnded) await stopHost(); } catch { host?.kill('SIGKILL'); }
  model.closeAllConnections(); model.close(); log.end(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.status === 'passed' ? undefined : result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
