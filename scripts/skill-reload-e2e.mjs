// Browser E2E: skill profiles (Settings picker, per-role index, on-demand reading restricted to the role set). Isolated host, local fake model; no real providers, no network.
// Failure cases recorded in skill-reload-failures.md before implementation.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `skill-reload-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `skill-reload-${randomUUID()}`);
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
// Skills: two repository (.pi/skills), four global (agent dir). Bodies carry BODY-<name> so prompts can be checked for bodies.
const skill = (dir, name, description, { body = `BODY-${name}`, ref, manual = false } = {}) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${manual ? 'disable-model-invocation: true\n' : ''}---\n\n# ${name}\n\n${body}\n`); if (ref) writeFileSync(join(dir, 'ref.md'), ref); };
const homeSkills = join(userHome, '.agents', 'skills'), repoPi = join(workspace, '.pi', 'skills'), repoAgents = join(workspace, '.agents', 'skills'), globalSkills = join(agentDir, 'skills');
skill(join(globalSkills, 'glob-old'), 'glob-old', 'Old global description.', { body: 'BODY-glob-old-v1' });
skill(join(globalSkills, 'glob-excl'), 'glob-excl', 'Global skill switched off for coordinator and worker.');
skill(join(globalSkills, 'glob-manual'), 'glob-manual', 'Manual-only global skill.', { manual: true });
skill(join(repoPi, 'repo-old'), 'repo-old', 'Repository skill present at startup.');
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, tools = (input.tools ?? []).map(t => t.function?.name).filter(Boolean);
    const role = tools.includes('projects_delegate') ? 'coordinator' : tools.includes('code_read') ? 'scout' : tools.includes('bash') ? 'worker' : 'other';
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), userText = contentText(msgs[lastUser]?.content);
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    const system = contentText(msgs.find(m => m.role === 'system' || m.role === 'developer')?.content);
    result.calls.push({ at: Date.now(), role, user: userText.slice(0, 600), results: results.map(r => r.slice(0, 3000)), tools, system });
    if (role === 'coordinator' && /SLOW/.test(userText) && results.length === 0) await delay(2500);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const read = /SKILL-READ (\S+)(?: (\S+))?/.exec(userText);
    if (role === 'coordinator') {
      if (userText.startsWith('[Durable work')) return res.end(say('Noted report.'));
      const w = /MARK-W (.+)$/m.exec(userText)?.[1], s = /MARK-S (.+)$/m.exec(userText)?.[1];
      if (w && results.length === 0) return res.end(call('projects_delegate', { role: 'worker', task: `W-TASK ${w}` }));
      if (s && results.length === 0) return res.end(call('projects_delegate', { role: 'scout', task: `S-TASK ${s}` }));
      if (read && results.length === 0) return res.end(call('projects_skill_file', { skill: read[1], ...(read[2] ? { path: read[2] } : {}) }));
      return res.end(say('Noted.'));
    }
    if (role === 'worker' && /W-TASK child/.test(userText) && results.length === 0) return res.end(call('projects_delegate_child', { role: 'worker', task: 'CHILD-W SKILL-READ glob-gamma' }));
    if (read && results.length === 0) return res.end(call('projects_skill_file', { skill: read[1], ...(read[2] ? { path: read[2] } : {}) }));
    res.end(say(`DONE ${role}`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
writeFileSync(join(workspace, 'README.md'), 'base\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-qm', 'c1');

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
  for (let i = 0; i < tries * 2; i++) { const value = await fn(); if (value) return value; await delay(50); }
  throw Error(description);
}
const waitHost = () => eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
async function stopHost() { if (!hostEnded) { try { await rpc({ action: 'shutdown' }); } catch {} await Promise.race([hostExit, delay(15000)]); } if (!hostEnded) host.kill('SIGKILL'); }


startHost();
try {
  await waitHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Reload', cwd: workspace, objective: 'Disposable skill-reload fixture', model: 'fake/fake-model' });
  const id = project.id;
  let settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { workerCap: 3, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  settings = await rpc({ action: 'settings-snapshot', id });
  // Role exclusions exist before anything new is installed: the coordinator and workers never see glob-excl or home-new.
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { skills: { off: { coordinator: ['glob-excl'], worker: ['glob-excl', 'home-new'] } } } });
  const first = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: first.workspaceRevision });
  const plan = async () => (await rpc({ action: 'plan-snapshot', id })).work;
  const settleAll = () => eventually(async () => { const view = await rpc({ action: 'show', id }); return !view.chats.some(c => c.busy) && !(await plan()).some(w => ['queued', 'running'].includes(w.status)); }, 'project did not go idle', 1200);
  const ask = async text => { await rpc({ action: 'message', id, text }); await delay(300); await settleAll(); };
  const index = system => [...system.matchAll(/^- ([\w-]+): /gm)].map(m => m[1]).sort();
  const described = (system, name) => new RegExp(`^- ${name}: (.*)$`, 'm').exec(system)?.[1];
  const lastCall = (role, marker) => result.calls.findLast(c => c.role === role && c.user.includes(marker));
  const toolResult = (role, marker) => result.calls.findLast(c => c.role === role && c.user.includes(marker) && c.results.length === 1)?.results[0] ?? '';
  const messagesOf = async () => (await rpc({ action: 'show', id })).messages.map(m => m.text ?? '').join('\n');

  // Baseline: only what is installed at startup, exclusions applied.
  await ask('history-marker-one');
  await ask('MARK-W pre');
  const coord0 = lastCall('coordinator', 'history-marker-one'), worker0 = lastCall('worker', 'W-TASK pre');
  check('baseline coordinator index = installed minus its exclusions', index(coord0.system).join() === 'glob-old,repo-old', index(coord0.system));
  check('baseline worker index = installed minus its exclusions', index(worker0.system).join() === 'glob-old,repo-old', index(worker0.system));
  const preThread = (await plan()).find(w => w.text.includes('W-TASK pre')).threadId;
  await ask('MARK-W manual SKILL-READ glob-manual');
  check('a manual-only skill stays out of the index but a worker of that role can still read it', !index(worker0.system).includes('glob-manual') && toolResult('worker', 'W-TASK manual').includes('BODY-glob-manual'), toolResult('worker', 'W-TASK manual').slice(0, 200));
  const toolsBefore = [...coord0.tools].sort();

  // Install after the host and the project runtime are already running; change one existing skill.
  skill(join(homeSkills, 'home-new'), 'home-new', 'Installed into ~/.agents/skills after startup.', { ref: 'REF-home-new' });
  skill(join(repoPi, 'repo-new'), 'repo-new', 'Installed into the project .pi/skills after startup.');
  skill(join(repoAgents, 'agents-new'), 'agents-new', 'Installed into the project .agents/skills after startup.');
  skill(join(globalSkills, 'glob-old'), 'glob-old', 'Changed global description v2.', { body: 'BODY-glob-old-v2' });

  // Instant discovery: the catalog behind Settings and the / picker, previews, and /skill: expansion see them at once.
  const catalog = (await rpc({ action: 'coordinator-skills', id })).skills;
  const found = Object.fromEntries(catalog.map(item => [item.name, item]));
  check('discovery finds the home ~/.agents/skills skill as global', found['home-new']?.source === 'global', found['home-new']);
  check('discovery finds project .pi/skills and .agents/skills skills as repository', found['repo-new']?.source === 'repo' && found['agents-new']?.source === 'repo', [found['repo-new'], found['agents-new']]);
  check('discovery shows a changed description', found['glob-old']?.description === 'Changed global description v2.', found['glob-old']);
  check('discovery keeps the previously installed skills', ['repo-old', 'glob-excl'].every(name => found[name]), Object.keys(found));
  const preview = await rpc({ action: 'ref-preview', id, kind: 'skill', value: 'home-new' });
  check('a new skill previews', preview.text.includes('BODY-home-new'), preview);
  await ask('/skill:home-new SKILL-READ home-new ref.md');
  const invoked = result.calls.findLast(c => c.role === 'coordinator' && c.user.includes('BODY-home-new'));
  check('/skill:<new> expands the freshly installed body', !!invoked, null);
  check('a coordinator invocation of a new skill can read its references', toolResult('coordinator', 'BODY-home-new').includes('REF-home-new'), toolResult('coordinator', 'BODY-home-new').slice(0, 200));
  check('without /reload the coordinator prompt is still the frozen one', index(invoked.system).join() === 'glob-old,repo-old' && described(invoked.system, 'glob-old') === 'Old global description.', index(invoked.system));

  // New workers get the fresh catalog with their exclusions; existing workers stay frozen.
  await ask('MARK-W new');
  const worker1 = lastCall('worker', 'W-TASK new');
  check('a new worker is told about the new skills and the changed description', index(worker1.system).join() === 'agents-new,glob-old,repo-new,repo-old' && described(worker1.system, 'glob-old') === 'Changed global description v2.', index(worker1.system));
  check('role exclusions still apply to new workers (home-new, glob-excl stay off)', !index(worker1.system).includes('home-new') && !index(worker1.system).includes('glob-excl'), index(worker1.system));
  await ask('MARK-W read1 SKILL-READ repo-new');
  await ask('MARK-W read2 SKILL-READ home-new');
  check('a new worker reads a new skill', toolResult('worker', 'W-TASK read1').includes('BODY-repo-new'), toolResult('worker', 'W-TASK read1').slice(0, 200));
  check('a new worker still cannot read an excluded skill', /not in your role's skill set/.test(toolResult('worker', 'W-TASK read2')), toolResult('worker', 'W-TASK read2').slice(0, 200));
  await rpc({ action: 'thread-send', id, threadId: preThread, text: 'FOLLOW1 SKILL-READ repo-new', requestId: randomUUID() });
  await delay(300); await settleAll();
  const follow = lastCall('worker', 'FOLLOW1');
  check('an existing worker keeps its frozen index', index(follow.system).join() === 'glob-old,repo-old' && described(follow.system, 'glob-old') === 'Old global description.', index(follow.system));
  check('an existing worker cannot read a skill installed after it started', /not in your role's skill set/.test(toolResult('worker', 'FOLLOW1')), toolResult('worker', 'FOLLOW1').slice(0, 200));

  // /reload for the coordinator chat.
  const historyBefore = await messagesOf();
  const reloaded = await rpc({ action: 'chat-reload', id });
  check('reload reports a change', reloaded.changed === true && reloaded.chatId === 'main', reloaded);
  await ask('post-reload-turn');
  const coord1 = lastCall('coordinator', 'post-reload-turn');
  check('after reload the coordinator prompt lists every new skill and the changed description', index(coord1.system).join() === 'agents-new,glob-old,home-new,repo-new,repo-old' && described(coord1.system, 'glob-old') === 'Changed global description v2.', index(coord1.system));
  check('reload keeps the coordinator exclusions', !index(coord1.system).includes('glob-excl'), index(coord1.system));
  check('reload leaves the coordinator tool bindings identical (no permission change)', JSON.stringify([...coord1.tools].sort()) === JSON.stringify(toolsBefore), { before: toolsBefore, after: coord1.tools });
  const historyAfter = await messagesOf();
  check('reload preserves the conversation history', historyBefore.includes('history-marker-one') && historyAfter.includes('history-marker-one') && historyAfter.startsWith(historyBefore.slice(0, 200)), null);
  check('reload does not touch existing workers', (await plan()).filter(w => w.threadId === preThread).length === 2 && index(lastCall('worker', 'FOLLOW1').system).join() === 'glob-old,repo-old', null);
  check('a second reload with nothing new changes nothing', (await rpc({ action: 'chat-reload', id })).changed === false);
  // The changed body is read fresh by the next skill read.
  await ask('SKILL-READ glob-old');
  check('a changed skill body is read from disk', toolResult('coordinator', 'SKILL-READ glob-old').includes('BODY-glob-old-v2'), toolResult('coordinator', 'SKILL-READ glob-old').slice(0, 200));

  // A turn in progress is never rewritten.
  await rpc({ action: 'message', id, text: 'SLOW turn' });
  await eventually(async () => (await rpc({ action: 'show', id })).chats.some(c => c.busy), 'chat did not start working', 100);
  let refusal = '';
  try { await rpc({ action: 'chat-reload', id }); } catch (error) { refusal = error.message; }
  check('reload is refused with a clear message while the chat is working', /working; wait for it to finish/.test(refusal), refusal);
  await settleAll();
  check('reload works again once the turn finished', (await rpc({ action: 'chat-reload', id })).changed === false);

  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  await stopHost().catch(() => host.kill('SIGKILL'));
  model.closeAllConnections(); model.close(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks.length, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
