// Opt-in verification loop on an isolated host, with a deterministic fake provider at the model seam and real everything else: git worktrees,
// trusted command execution, revision drift checks, artifacts and the durable plan. No real providers, no owner state.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = process.env.VERIFY_LOOP_EVIDENCE ?? join(repo, 'artifacts', `verification-loop-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `verification-loop-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], requests: [], reports: [] };
const crashPlans = Object.fromEntries(['MARK-CRASHNO', 'MARK-CRASHYES'].map(marker => [marker, { workId: randomUUID(), threadId: randomUUID(), depId: randomUUID(), depThread: randomUUID() }]));
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const gates = new Map(); // marker -> { open, wait }
const gate = marker => { if (!gates.has(marker)) { let open; const wait = new Promise(ok => { open = ok; }); gates.set(marker, { open, wait }); } return gates.get(marker); };
const text = content => typeof content === 'string' ? content : JSON.stringify(content ?? '');

// One provider plays every role; the tools a request offers say who is asking. Worker behavior depends on the task marker and on whether a verification failure was handed back.
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, names = (input.tools ?? []).map(tool => tool.function?.name);
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), user = text(msgs[lastUser]?.content);
    const all = msgs.map(m => text(m.content)).join('\n'), marker = /MARK-[A-Z0-9]+/.exec(all)?.[0] ?? 'none';
    const turn = msgs.slice(lastUser + 1).filter(m => m.role === 'tool'), stage = turn.length, last = text(turn.at(-1)?.content);
    const role = names.includes('projects_delegate') ? 'coordinator' : names.includes('projects_verify_run') ? 'verifier' : names.includes('bash') ? 'worker' : 'other';
    result.requests.push({ at: Date.now(), role, model: input.model, marker, stage, tools: names, messages: msgs.length, user: user.slice(0, 160), last: last.slice(0, 500) });
    const reply = out => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(out); };
    try {
      if (role === 'coordinator') {
        const crash = Object.keys(crashPlans).find(key => user.startsWith(key));
        if (crash && stage === 0) { const c = crashPlans[crash]; return reply(call('projects_worker_plan', { work: [{ id: c.workId, threadId: c.threadId, role: 'worker', workspaceScopeId: result.scopeId, text: `${crash}\nAcceptance criteria:\n- feature.txt says done\n- node check.mjs exits 0` }, { id: c.depId, threadId: c.depThread, role: 'scout', text: `dependent for ${crash}`, dependsOn: [c.workId] }] })); }
        if (user === 'UNAUTHORIZED-REQUEST') return stage === 0 ? reply(call('projects_request_verification', {})) : reply(say('Attempt rejected.'));
        if (user.startsWith('RECOVER ')) {
          const threadId = user.slice('RECOVER '.length).trim();
          if (stage === 0) return reply(call('projects_workers', { threadId, all: true }));
          if (stage === 1) return reply(call('projects_worker_control', { action: 'follow_up', threadId, text: 'Repair and explicitly request verification without changing frozen criteria.' }));
          return reply(say('Recovery delegated to the same worker.'));
        }
        if (user.startsWith('INSPECT-ARCHIVE ')) {
          const id = user.slice('INSPECT-ARCHIVE '.length).trim();
          if (stage === 0) return reply(call('projects_workers', { workId: id, all: true }));
          if (stage === 1) return reply(call('projects_work_result', { workId: id }));
          if (stage === 2) return reply(call('projects_knowledge_write', { path: 'plans/verification-fixture.md', text: 'Handled: candidate drift was investigated and superseded; keep unrelated blockers open.', expectedRevision: null }));
          if (stage === 3) return reply(call('projects_worker_archive', { workIds: [id] }));
          return reply(say('Handled and archived; unresolved work stays tracked.'));
        }
        if (user.startsWith('[Durable work')) { result.reports.push(user); return reply(say('Noted.')); }
        const task = user.match(/MARK-[A-Z0-9]+/)?.[0];
        if (task && stage === 0) return reply(call('projects_delegate', { task: `${task} write feature.txt`, acceptance: ['feature.txt exists in the repository and contains the word done', 'node check.mjs exits 0'] }));
        return reply(say('Delegated.'));
      }
      if (role === 'other' && user === 'MARK-CHILD-SCOUT') { await gate('child-ready').wait; return reply(say('child finished')); }
      if (role === 'worker' && marker === 'MARK-CHILD') {
        if (user.startsWith('[Child work')) {
          if (stage === 0) return reply(call('bash', { command: 'echo done > feature.txt' }));
          if (stage === 1) return reply(call('projects_request_verification', {}));
          return reply(say('Child result handled.'));
        }
        if (stage === 0) return reply(call('projects_delegate_child', { role: 'scout', task: 'MARK-CHILD-SCOUT' }));
        if (stage === 1) return reply(call('projects_request_verification', {}));
        return reply(say('Waiting for child.'));
      }
      if (role === 'worker' && (marker === 'MARK-CRASHNO' || marker === 'MARK-CRASHYES')) {
        if (user.startsWith('The project was paused')) {
          if (marker === 'MARK-CRASHYES' && stage === 0) return reply(call('bash', { command: 'echo done > feature.txt' }));
          if (marker === 'MARK-CRASHYES' && stage === 1) return reply(call('projects_request_verification', {}));
          return reply(say('Restart continuation finished.'));
        }
        if (user.startsWith('[Automatic verification failed]')) {
          if (stage === 0) return reply(call('bash', { command: marker === 'MARK-CRASHYES' ? 'echo old > feature.txt' : 'echo done > feature.txt' }));
          if (stage === 1) return reply(call('projects_request_verification', {}));
          await gate(marker).wait; return reply(say('Original held repair turn.'));
        }
        if (stage === 0) return reply(call('bash', { command: 'echo nope > feature.txt' }));
        if (stage === 1) return reply(call('projects_request_verification', {}));
        return reply(say('Initial candidate ready.'));
      }
      if (role === 'worker' && (marker === 'MARK-PAUSENO' || marker === 'MARK-PAUSEYES')) {
        if (user.startsWith('The project was paused')) {
          if (marker === 'MARK-PAUSEYES' && stage === 0) return reply(call('bash', { command: 'echo done > feature.txt' }));
          if (marker === 'MARK-PAUSEYES' && stage === 1) return reply(call('projects_request_verification', {}));
          return reply(say('Resumed worker finished.'));
        }
        if (stage === 0) return reply(call('bash', { command: marker === 'MARK-PAUSEYES' ? 'echo original > feature.txt' : 'echo done > feature.txt' }));
        if (stage === 1) return reply(call('projects_request_verification', {}));
        await gate(marker).wait; return reply(say('Old turn.'));
      }
      if (role === 'worker') {
        if (marker === 'MARK-WORKERJOB') {
          if (stage === 0) return reply(call('projects_bg_start', { command: 'sleep 60', label: 'active job' }));
          if (stage === 1) return reply(call('projects_request_verification', {}));
          if (stage === 2) return reply(call('projects_bg_stop', { id: JSON.parse(text(turn[0].content)).id }));
          if (stage === 3) return reply(call('bash', { command: 'echo done > feature.txt' }));
          if (stage === 4) return reply(call('projects_request_verification', {}));
          return reply(say('Worker stopped job and requested verification.'));
        }
        if (marker === 'MARK-WORKERLEASE') {
          if (stage === 0) return reply(call('projects_lease_acquire', { resource: 'worker-verification-fixture', ttlMinutes: 1 }));
          if (stage === 1) return reply(call('projects_request_verification', {}));
          if (stage === 2) return reply(call('projects_lease_release', { resource: 'worker-verification-fixture' }));
          if (stage === 3) return reply(call('bash', { command: 'echo done > feature.txt' }));
          if (stage === 4) return reply(call('projects_request_verification', {}));
          return reply(say('Worker released lease and requested verification.'));
        }
        if (marker === 'MARK-NOCHANGE' && stage === 0) return reply(call('bash', { command: 'echo nope > feature.txt' }));
        if (/^\[Automatic verification failed\]/.test(user) && marker !== 'MARK-NOCHANGE' && stage === 0) { return reply(call('bash', { command: 'echo done > feature.txt' })); }
        if (marker === 'MARK-FREEZEPASS' && !user.startsWith('Frozen follow-up') && stage > 0) await gate('worker-ready').wait;
        if (stage === 0) return reply(call('bash', { command: marker === 'MARK-GOOD' || marker === 'MARK-INVALID' || marker === 'MARK-DUP' || marker === 'MARK-BG' || marker === 'MARK-FREEZEPASS' ? 'echo done > feature.txt' : 'echo nope > feature.txt' }));
        if (marker === 'MARK-INVALID' && stage === 1) return reply(call('projects_request_verification', { model: 'attacker', criteria: ['fake'], target: '/tmp' }));
        if (marker === 'MARK-INVALID' && stage === 2) return reply(call('projects_request_verification', {}));
        if (stage === 1 && marker !== 'MARK-PROGRESS' && marker !== 'MARK-PLAIN' && names.includes('projects_request_verification')) return reply(call('projects_request_verification', {}));
        if (marker === 'MARK-DUP' && stage === 2) return reply(call('projects_request_verification', {}));
        if (marker === 'MARK-STALE' && stage === 2) return reply(call('bash', { command: 'echo changed > feature.txt' }));
        return reply(say(`Worker finished ${marker}`));
      }
      if (role === 'verifier') {
        if (stage === 0) return reply(call('projects_skill_file', { skill: 'mini-verify' }));
        if (marker === 'MARK-BLOCKED') return stage === 1 ? reply(call('projects_verification_verdict', { summary: 'Cannot exercise the feature.', criteria: ['c1', 'c2'].map(id => ({ id, status: 'blocked', reason: 'no browser available' })) })) : reply(say('Recorded.'));
        if (marker === 'MARK-LEASE' && stage === 1) return reply(call('projects_lease_acquire', { resource: 'verification-loop-browser', ttlMinutes: 5 }));
        if (marker === 'MARK-BG' && stage === 1) return reply(call('projects_bg_start', { command: 'sleep 1; echo tampered > feature.txt', label: 'late verifier drift' }));
        if (stage === 1 || (marker === 'MARK-LEASE' || marker === 'MARK-BG') && stage === 2) {
          if (marker === 'MARK-LEASE') { const acquired = JSON.parse(last); (result.leases ??= []).push(acquired); if (!acquired.acquired) throw Error(`fresh verifier could not take released lease: ${last}`); }
          return reply(call('projects_verify_run', { command: marker === 'MARK-ESCAPE' ? 'echo tampered > feature.txt; node check.mjs' : 'node check.mjs; echo "exit-code-now=$?"; mkdir -p "$PI_ARTIFACTS_DIR"; cp feature.txt "$PI_ARTIFACTS_DIR/feature-seen.txt"; node check.mjs' }));
        }
        if (stage === 2 || (marker === 'MARK-LEASE' || marker === 'MARK-BG') && stage === 3) {
          if (marker === 'MARK-DRIFT') await gate('drift').wait;
          const run = JSON.parse(last), pass = run.exitCode === 0;
          const evidence = [{ runId: run.runId }, ...(existsSync(join(home, '..', 'unused')) ? [] : [])];
          return reply(call('projects_verification_verdict', { summary: pass ? 'check.mjs exits 0 on the worktree.' : 'check.mjs fails on the worktree.', criteria: [{ id: 'c1', status: pass ? 'pass' : 'fail', reason: pass ? 'feature.txt says done' : 'feature.txt does not say done', evidence }, { id: 'c2', status: pass ? 'pass' : 'fail', reason: pass ? 'exit 0' : `exit ${run.exitCode}`, evidence }] }));
        }
        if (marker === 'MARK-FREEZEPASS' || marker === 'MARK-FREEZEFAIL') await gate(`${marker}-verdict`).wait;
        return reply(say('Verdict recorded.'));
      }
      return reply(say('ok'));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
const modelEntry = id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 });
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [modelEntry('fake-model'), modelEntry('fake-judge')] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'a', mode: 0o600 });
let host, hostExit;
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 60000 }, res => {
      res.setEncoding('utf8');
      let data = ''; res.on('data', part => { data += part; }); res.on('end', () => { try { const reply = JSON.parse(data); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = Number(process.env.E2E_TRIES ?? 1200)) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await delay(50); }
  throw Error(`Timed out: ${description}`);
}
async function startHost() {
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
  hostExit = new Promise(ok => host.once('exit', ok));
  await eventually(async () => { try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'owned host did not start');
}
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const plan = id => rpc({ action: 'plan-snapshot', id });
const settingsUpdate = async (id, changes) => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: (await rpc({ action: 'settings-snapshot', id })).revision, changes });
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const cycleOf = (snapshot, work) => snapshot.verification?.[work.threadId];
const delegateTask = async (id, marker) => { const job = await rpc({ action: 'message', id, text: `${marker} please do the task` }); await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(j => j.id === job.id)?.state === 'done', `coordinator turn for ${marker}`); return eventually(async () => (await plan(id)).work.find(w => w.role === 'worker' && w.text.includes(marker)), `worker for ${marker}`); };
const settled = (snapshot, work) => { const cycle = cycleOf(snapshot, work); return cycle && !cycle.open && cycle; };
const waitCycle = async (id, marker) => { const worker = await delegateTask(id, marker); const cycle = await eventually(async () => settled(await plan(id), worker), `${marker} cycle did not end`); return { worker, cycle, snapshot: await plan(id) }; };
const reportFor = (marker, needle) => result.reports.find(report => report.includes(marker) && report.includes(needle));
let peak = 0; const watcher = (id) => { let stop = false; (async () => { while (!stop) { try { peak = Math.max(peak, (await plan(id)).work.filter(w => w.status === 'running').length); } catch { /* host restarting */ } await delay(25); } })(); return () => { stop = true; }; };

try {
  git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
  git(workspace, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  mkdirSync(join(workspace, '.agents/skills/mini-verify'), { recursive: true });
  writeFileSync(join(workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Verify that feature.txt says done by running node check.mjs in the worktree.\n---\n\nRun `node check.mjs` from the worktree root; it exits 0 only when feature.txt contains done.\n');
  writeFileSync(join(workspace, 'check.mjs'), "import { readFileSync } from 'node:fs';\nconst text = readFileSync('feature.txt', 'utf8').trim();\nconsole.log('feature.txt =', JSON.stringify(text));\nprocess.exit(text === 'done' ? 0 : 1);\n");
  writeFileSync(join(workspace, 'README.md'), 'demo\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'base');
  await startHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Verification loop', cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' });
  const id = project.id;
  await settingsUpdate(id, { workerCap: 1, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } });

  // V0: off by default, nothing changes for a project that did not opt in.
  assert.equal((await rpc({ action: 'settings-snapshot', id })).values.verification, null);
  const plain = await delegateTask(id, 'MARK-PLAIN');
  await eventually(async () => (await plan(id)).work.find(w => w.id === plain.id)?.status === 'completed', 'plain worker completes');
  await eventually(async () => reportFor('MARK-PLAIN', 'Worker finished'), 'plain worker reported');
  check('V0 a project that did not opt in completes workers as before: no verifier, no cycle', !(await plan(id)).work.some(w => w.role === 'verifier') && (await plan(id)).verification === undefined && !reportFor('MARK-PLAIN', 'VERIFIED'));

  // V1: enabling needs its own verifier model and an installed skill; nothing is assumed.
  await assert.rejects(settingsUpdate(id, { verification: { enabled: true, skill: 'mini-verify' } }), /own verifier model/);
  await assert.rejects(settingsUpdate(id, { models: { verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'no-such-skill' } }), /not installed/);
  // The same checks apply when the change also carries a setting that needs the idle path.
  await assert.rejects(settingsUpdate(id, { name: 'Renamed', models: { verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'no-such-skill' } }), /not installed/);
  assert.equal((await rpc({ action: 'settings-snapshot', id })).values.name, 'Verification loop', 'a refused mixed change stores nothing');
  assert.equal((await rpc({ action: 'settings-snapshot', id })).values.models.verifier, undefined, 'a rejected update must not half-apply');
  await settingsUpdate(id, { models: { verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'mini-verify' } });
  const settings = (await rpc({ action: 'settings-snapshot', id })).values;
  check('V1 opt-in needs a separately chosen verifier model and an installed skill; both are stored', settings.verification.enabled && settings.verification.skill === 'mini-verify' && settings.models.verifier === 'fake/fake-judge' && settings.models.worker === 'fake/fake-model');

  result.scopeId = (await rpc({ action: 'show', id })).project.workspaceAuthorization.scopes[0].id;
  for (const marker of ['MARK-CRASHNO', 'MARK-CRASHYES']) {
    const ids = crashPlans[marker];
    await rpc({ action: 'message', id, text: `${marker} start` });
    await eventually(() => result.requests.some(r => r.role === 'worker' && r.marker === marker && r.user.startsWith('[Automatic verification failed]') && r.stage === 2 && /Verification requested/.test(r.last)), `${marker} persisted request acknowledged`);
    const beforeCrash = await plan(id), original = beforeCrash.work.find(w => w.id === ids.workId);
    check(`${marker} holds dependent and admits no verifier before restart`, original.status === 'completed' && beforeCrash.work.find(w => w.id === ids.depId).status === 'queued' && cycleOf(beforeCrash, original)?.open && cycleOf(beforeCrash, original)?.attempts.length === 1 && cycleOf(beforeCrash, original).attempts[0].state === 'fail', beforeCrash);
    const repair = beforeCrash.work.find(w => w.threadId === ids.threadId && w.text.startsWith('[Automatic verification failed]'));
    check(`${marker} same worker repair is held after its explicit request`, repair?.status === 'running', repair);
    const killed = { pid: host.pid, lstart: execFileSync('/bin/ps', ['-p', String(host.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(), signal: 'SIGKILL' }; (result.ownedRestarts ??= []).push(killed); host.kill('SIGKILL'); await hostExit; gate(marker).open();
    const probe = `import {openDurableProject} from './src/durable-runtime.ts'; import {DurablePlanning} from './src/durable-planning.ts'; import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context'; import {loadProject,projectDir} from './src/state.ts'; import {loadProjectResourceLoader} from './src/project-resources.ts'; const p=loadProject(process.argv[1]), l=await loadProjectResourceLoader(p); const r=await openDurableProject({project:p,dir:projectDir(p.id),configuredSkillLoader:l,discoverSkills:()=>loadProjectResourceLoader(loadProject(p.id))}); const w=await r.withRoot(root=>root.commit(async tx=>JSON.parse(JSON.stringify((await tx.doc(DurablePlanning,root.id)).work[process.argv[2]])),BACKGROUND_CONTEXT)); console.log('RECEIPT '+JSON.stringify(w)); await r.close();`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe, id, repair.id], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
    const stored = JSON.parse(output.split('\n').find(line => line.startsWith('RECEIPT ')).slice(8));
    (result.restartReceipts ??= []).push({ marker, killed, workId: repair.id, threadId: stored.threadId, taskId: stored.taskId, receipt: stored.verificationRequest, before: beforeCrash.verification[ids.threadId] });
    check(`${marker} original request and execution identity persisted across process death`, stored.verificationRequest?.taskId === stored.taskId && /^[a-f0-9]{64}$/.test(stored.verificationRequest.revision) && stored.threadId === ids.threadId, { killed, stored });
    await startHost();
    const paused = await eventually(async () => { const view = await plan(id); return view.paused && view.work.find(w => w.id === repair.id)?.status === 'interrupted' && view; }, `${marker} restart paused`);
    check(`${marker} restart retains dependency barrier and frozen thread`, paused.work.find(w => w.id === ids.depId)?.status !== 'completed' && paused.work.find(w => w.id === repair.id)?.threadId === ids.threadId && paused.verification?.[ids.threadId]?.attempts.length === 1 && paused.verification[ids.threadId].attempts[0].verifierThreadId === beforeCrash.verification[ids.threadId].attempts[0].verifierThreadId, paused);
    await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
    const ended = await eventually(async () => settled(await plan(id), original), `${marker} restart settled`);
    const view = await plan(id);
    const frozen = c => JSON.stringify({ model: c.model, skill: c.skill, criteria: c.criteria, first: c.attempts[0] });
    check(`${marker} retains frozen criteria, settings and first attempt across restart`, frozen(ended) === frozen(beforeCrash.verification[ids.threadId]), ended);
    result.restartReceipts.at(-1).after = ended;
    if (marker === 'MARK-CRASHYES') await eventually(async () => (await plan(id)).work.find(w => w.id === ids.depId)?.status === 'completed', 'fresh request releases dependent');
    check(`${marker} restart requires a renewed request`, marker === 'MARK-CRASHNO' ? ended.outcome === 'escalated' && ended.attempts.length === 1 && view.work.find(w => w.id === ids.depId)?.status !== 'completed' : ended.outcome === 'verified' && ended.attempts.length === 2 && ended.model === 'fake/fake-judge' && ended.skill === 'mini-verify' && ended.criteria.length === 2 && ended.attempts[1].revision !== stored.verificationRequest.revision && ended.attempts[0].verifierThreadId === beforeCrash.verification[ids.threadId].attempts[0].verifierThreadId, ended);
  }

  // A successful progress turn is not a verification request or task completion.
  const progress = await delegateTask(id, 'MARK-PROGRESS');
  const progressState = await eventually(async () => { const snapshot = await plan(id); const work = snapshot.work.find(w => w.id === progress.id); return work && !['queued', 'running'].includes(work.status) ? snapshot : null; }, 'progress turn settles');
  check('worker progress without a request is blocked without spending a verifier attempt', progressState.work.find(w => w.id === progress.id).status === 'blocked' && !cycleOf(progressState, progress)?.attempts.length && !progressState.work.some(w => w.role === 'verifier' && w.parentThreadId === progress.threadId), progressState.work.find(w => w.id === progress.id));

  const verifierCountBeforeUnauthorized = (await plan(id)).work.filter(w => w.role === 'verifier').length;
  const unauthorizedTurn = await rpc({ action: 'message', id, text: 'UNAUTHORIZED-REQUEST' });
  await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(j => j.id === unauthorizedTurn.id)?.state === 'done', 'unauthorized coordinator call settled');
  check('coordinator is not offered the worker verification request', result.requests.some(r => r.role === 'coordinator' && r.user === 'UNAUTHORIZED-REQUEST' && !r.tools.includes('projects_request_verification')) && (await plan(id)).work.filter(w => w.role === 'verifier').length === verifierCountBeforeUnauthorized, result.requests.filter(r => r.user === 'UNAUTHORIZED-REQUEST'));
  const childParent = await delegateTask(id, 'MARK-CHILD');
  await eventually(async () => result.requests.some(r => r.role === 'worker' && r.marker === 'MARK-CHILD' && /child work/.test(r.last)), 'premature request refused');
  const childHeld = await plan(id);
  check('request with active child is refused without an attempt', !cycleOf(childHeld, childParent)?.attempts.length && !childHeld.work.some(w => w.role === 'verifier' && w.parentThreadId === childParent.threadId), childHeld);
  gate('child-ready').open();
  const childCycle = await eventually(async () => settled(await plan(id), childParent), 'child result wakes parent and verifies');
  check('child result wakes the same parent which explicitly requests verification', childCycle.outcome === 'verified' && childCycle.attempts.length === 1, childCycle);
  for (const marker of ['MARK-PAUSENO', 'MARK-PAUSEYES']) {
    const work = await delegateTask(id, marker);
    await eventually(async () => result.requests.some(r => r.marker === marker && r.role === 'worker' && r.stage === 2), `${marker} request recorded`);
    await rpc({ action: 'pause', id }); gate(marker).open();
    await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
    const resumed = await eventually(async () => settled(await plan(id), work), `${marker} resumed`);
    check(`${marker} resumed requires a fresh request`, marker === 'MARK-PAUSENO' ? resumed.attempts.length === 0 && resumed.outcome === 'escalated' : resumed.attempts.length === 1 && resumed.outcome === 'verified', resumed);
  }
  const invalid = await waitCycle(id, 'MARK-INVALID');
  check('request refuses caller-selected target model and criteria', invalid.cycle.attempts.length === 1 && invalid.cycle.model === 'fake/fake-judge' && invalid.cycle.criteria.length === 2 && result.requests.some(r => r.role === 'worker' && r.marker === 'MARK-INVALID' && r.stage === 2 && /invalid|additional|unexpected|error/i.test(r.last)), invalid.cycle);
  const workerJob = await waitCycle(id, 'MARK-WORKERJOB');
  check('request with a worker background job is refused until stopped', workerJob.cycle.attempts.length === 1 && workerJob.cycle.outcome === 'verified' && result.requests.some(r => r.role === 'worker' && r.marker === 'MARK-WORKERJOB' && /background jobs/.test(r.last)), workerJob.cycle);
  const workerLease = await waitCycle(id, 'MARK-WORKERLEASE');
  check('request with a worker lease is refused until the worker releases it', workerLease.cycle.attempts.length === 1 && workerLease.cycle.outcome === 'verified' && result.requests.some(r => r.role === 'worker' && r.marker === 'MARK-WORKERLEASE' && /release leases/.test(r.last)), workerLease.cycle);
  const duplicate = await waitCycle(id, 'MARK-DUP');
  check('duplicate requests start only one verifier and report rejection', duplicate.cycle.attempts.length === 1 && duplicate.cycle.outcome === 'verified' && result.requests.some(r => r.role === 'worker' && r.marker === 'MARK-DUP' && /already requested/.test(r.last)), duplicate.cycle);
  const staleRequest = await waitCycle(id, 'MARK-STALE');
  check('a candidate changed after the request cannot start a verifier', staleRequest.cycle.attempts.length === 0 && staleRequest.cycle.outcome === 'escalated' && /changed after verification/.test(staleRequest.cycle.reason), staleRequest.cycle);

  // V2: fail, the worker fixes, a fresh verifier passes (cap 1: the worker's slot is free while it is verified).
  const stopWatching = watcher(id);
  const start = Date.now();
  const loop = await waitCycle(id, 'MARK-LOOP');
  const sourceHead = loop.snapshot.work.find(w => w.id === loop.worker.id).attempt.cwd;
  check('V2 attempt 1 fails, the worker fixes it, a fresh attempt 2 passes and the work is verified', loop.cycle.outcome === 'verified' && loop.cycle.attempts.map(a => a.state).join() === 'fail,pass', loop.cycle);
  const [first, second] = loop.cycle.attempts;
  check('V2 each attempt ran in a different, fresh verifier thread bound to the exact revision it checked', first.verifierThreadId !== second.verifierThreadId && first.revision !== second.revision && /^[a-f0-9]{64}$/.test(first.revision));
  const verifierReqs = result.requests.filter(r => r.role === 'verifier' && r.marker === 'MARK-LOOP');
  check('V2 verifier requests used the verifier model, never the worker model', verifierReqs.length >= 6 && verifierReqs.every(r => r.model === 'fake-judge') && result.requests.filter(r => r.role === 'worker').every(r => r.model === 'fake-model'));
  const attemptTwoFirst = verifierReqs.filter(r => r.stage === 0 && r.messages <= 3);
  check('V2 a retry verifier starts with no memory of the first attempt', attemptTwoFirst.length === 2);
  const verifierTools = new Set(verifierReqs.flatMap(r => r.tools));
  check('V2 verifiers are not given edit, write, shell, delegation, knowledge or publication tools', ['bash', 'write', 'edit', 'projects_delegate', 'projects_delegate_child', 'projects_knowledge_write', 'projects_knowledge_read'].every(name => !verifierTools.has(name)) && ['projects_verify_run', 'projects_verification_verdict', 'projects_skill_file', 'code_read'].every(name => verifierTools.has(name)) && ![...verifierTools].some(name => /github|vcs|gh_|push|pr_/.test(name)), [...verifierTools]);
  check('V2 the failure went back to the worker as feedback naming the failing criterion and the command output', result.requests.some(r => r.role === 'worker' && r.user.startsWith('[Automatic verification failed]')));
  await eventually(async () => reportFor('MARK-LOOP', 'VERIFIED by an independent verifier'), 'coordinator told the work is verified');
  check('V2 the coordinator hears of completion only after the passing verdict, with attempt count and evidence', !reportFor('MARK-LOOP', 'NOT VERIFIED') && reportFor('MARK-LOOP', 'after 2 attempt(s)') && reportFor('MARK-LOOP', 'artifact:'), result.reports.at(-1));
  const afterWork = (await plan(id)).work;
  check('V2 verifier threads are children of the worker thread and share its pool', afterWork.filter(w => w.role === 'verifier' && w.text.includes('MARK-LOOP')).every(w => w.parentThreadId === loop.worker.threadId) && afterWork.filter(w => w.role === 'verifier' && w.parentThreadId === loop.worker.threadId).length === 2);
  const listing = await rpc({ action: 'artifacts-list', id, threadId: second.verifierThreadId });
  check('V2 command logs and a saved artifact are kept for the verifier thread', listing.files.some(f => /^bg\/bg-[a-f0-9]{8}\.log$/.test(f.path)) && listing.files.some(f => f.path === 'feature-seen.txt'), listing.files.map(f => f.path));
  check('V2 the worker\'s worktree holds its fix and nothing from the verifier', readFileSync(join(sourceHead, 'feature.txt'), 'utf8') === 'done\n' && git(sourceHead, 'status', '--porcelain') === '?? feature.txt');
  const keys = readdirSync(join(home, id, 'verification'));
  check('V2 no snapshots are made; revision manifests and other evidence stay', keys.length >= 2 && keys.every(key => !existsSync(join(home, id, 'verification', key, 'target')) && existsSync(join(home, id, 'verification', key, 'manifest.json'))), keys);
  check('V2 capacity: cap 1 was never exceeded while a parent waited on its verifier', peak <= 1, peak);

  // V3: trusted commands can change the worktree. Undeclared drift makes the verdict stale instead of a false pass.
  stopWatching();
  const escape = await waitCycle(id, 'MARK-ESCAPE');
  check('V3 a verifier command can write the trusted target, but an undeclared change never passes', escape.cycle.attempts[0].state === 'stale' && escape.cycle.outcome === 'escalated' && escape.cycle.attempts.length === 1, escape.cycle);
  await eventually(async () => reportFor('MARK-ESCAPE', 'NOT VERIFIED'), 'escalation reported');
  check('V3 the coordinator is told the work is NOT verified and the work is not completed', (await plan(id)).work.find(w => w.id === escape.worker.id).status === 'blocked' && !reportFor('MARK-ESCAPE', 'VERIFIED by'));

  const unresolved = await waitCycle(id, 'MARK-BLOCKED');
  const archiveTurn = await rpc({ action: 'message', id, text: `INSPECT-ARCHIVE ${escape.worker.id}` });
  await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(j => j.id === archiveTurn.id)?.state === 'done', 'coordinator archives handled failure');
  const archivePlan = await plan(id);
  const archived = archivePlan.work.find(w => w.id === escape.worker.id), tracked = archivePlan.work.find(w => w.id === unresolved.worker.id);
  check('coordinator inspects and archives handled blocker without dropping unresolved history', archived.archived && archived.status === 'blocked' && archived.blocker && tracked.status === 'blocked' && !tracked.archived && result.requests.filter(r => r.role === 'coordinator' && r.user.startsWith('INSPECT-ARCHIVE')).length >= 5 && result.requests.some(r => r.role === 'coordinator' && r.user.startsWith('INSPECT-ARCHIVE') && /Handled: candidate drift/.test(r.last)), { archived, tracked });

  // V4: blocked verdict escalates immediately (no retry), drift invalidates a verdict.
  const blocked = await waitCycle(id, 'MARK-BLOCKED');
  check('V4 a blocked verdict escalates at once and spends one attempt', blocked.cycle.attempts.length === 1 && blocked.cycle.attempts[0].state === 'blocked' && blocked.cycle.outcome === 'escalated');
  const blockedOriginal = JSON.stringify({ model: blocked.cycle.model, skill: blocked.cycle.skill, criteria: blocked.cycle.criteria, first: blocked.cycle.attempts[0] });
  await rpc({ action: 'thread-send', id, threadId: blocked.worker.threadId, requestId: randomUUID(), text: 'Repair the blocker.\n\nAcceptance criteria:\n- replace all criteria' });
  const resumedBlocked = await eventually(async () => { const cycle = cycleOf(await plan(id), blocked.worker); return cycle && !cycle.open && cycle.attempts.length >= 2 && cycle; }, 'blocked cycle continues without resetting its attempt count');
  check('a recoverable blocked cycle retains its first attempt and frozen settings on follow-up', JSON.stringify({ model: resumedBlocked.model, skill: resumedBlocked.skill, criteria: resumedBlocked.criteria, first: resumedBlocked.attempts[0] }) === blockedOriginal && resumedBlocked.attempts[1].n === 2, resumedBlocked);
  const driftWorker = await delegateTask(id, 'MARK-DRIFT');
  const liveRevision = await eventually(async () => { const c = cycleOf(await plan(id), driftWorker); return c?.attempts[0]?.state === 'running' && c; }, 'drift verifier running');
  const frozen = await eventually(async () => result.requests.some(r => r.role === 'verifier' && r.marker === 'MARK-DRIFT' && r.stage === 2), 'drift verifier reached its verdict step');
  writeFileSync(join((await plan(id)).work.find(w => w.id === driftWorker.id).attempt.cwd, 'feature.txt'), 'edited behind the verifier\n');
  gate('drift').open();
  const drift = await eventually(async () => settled(await plan(id), driftWorker), 'drift cycle ended');
  check('V4 a verdict for a tree that changed afterwards is rejected as stale and escalated, not accepted', drift.attempts[0].state === 'stale' && drift.outcome === 'escalated' && drift.attempts.length === 1, drift);

  // V5: a worker that changes nothing is not looped: the same failure twice escalates after two attempts.
  const same = await waitCycle(id, 'MARK-NOCHANGE');
  check('V5 the same failure twice escalates instead of burning the third attempt', same.cycle.attempts.length === 2 && same.cycle.attempts.every(a => a.state === 'fail') && same.cycle.outcome === 'escalated' && /same way/.test(same.cycle.reason), same.cycle);

  // V5b: a failed verifier's lease is released before its fresh replacement starts.
  const leased = await waitCycle(id, 'MARK-LEASE');
  check('V5b both attempts acquire the same shared resource: failed-attempt cleanup releases it', leased.cycle.outcome === 'verified' && result.leases?.length === 2 && result.leases.every(item => item.acquired), result.leases);

  // V5c: settlement stops a verifier background job before accepting the revision and releasing the worker.
  const background = await waitCycle(id, 'MARK-BG');
  await delay(1200);
  const backgroundTree = background.snapshot.work.find(w => w.id === background.worker.id).attempt.cwd;
  check('V5c a leftover verifier background process cannot change the tree after a pass or overlap the worker', background.cycle.outcome === 'verified' && readFileSync(join(backgroundTree, 'feature.txt'), 'utf8') === 'done\n', background.cycle);

  // V5d: leave a slot free so the freeze guard, not the pool cap, holds a queued follow-up.
  await settingsUpdate(id, { workerCap: 2 });
  const freezePass = await delegateTask(id, 'MARK-FREEZEPASS');
  await eventually(async () => result.requests.some(r => r.role === 'worker' && r.marker === 'MARK-FREEZEPASS' && r.stage === 1), 'worker held before completion');
  await rpc({ action: 'thread-send', id, threadId: freezePass.threadId, requestId: randomUUID(), text: 'Frozen follow-up must wait for settlement\n\nAcceptance criteria:\n- feature.txt says done\n- node check.mjs exits 0' });
  gate('worker-ready').open();
  await eventually(async () => result.requests.some(r => r.role === 'verifier' && r.marker === 'MARK-FREEZEPASS' && r.stage === 3), 'pass recorded, verifier held');
  await waitCycle(id, 'MARK-GOOD'); // Its admission and settlement drive dispatch while the pass remains held.
  const heldPass = await plan(id);
  writeFileSync(join(artifacts, 'held-pass-plan.json'), JSON.stringify(heldPass, null, 2));
  check('V5d recorded pass keeps queued parent follow-up frozen with a free pool slot', cycleOf(heldPass, freezePass).open && cycleOf(heldPass, freezePass).attempts[0].state === 'pass' && heldPass.work.find(w => w.text.startsWith('Frozen follow-up')).status === 'queued' && !result.requests.some(r => r.role === 'worker' && r.user.startsWith('Frozen follow-up')));
  await assert.rejects(rpc({ action: 'thread-send', id, threadId: freezePass.threadId, requestId: randomUUID(), text: 'Must not enter after pass' }), /tree is frozen/);
  check('V5d recorded pass still refuses new parent admission and reports no completion', !reportFor('MARK-FREEZEPASS', 'VERIFIED by'));
  gate('MARK-FREEZEPASS-verdict').open();
  await eventually(async () => (await plan(id)).work.find(w => w.text.startsWith('Frozen follow-up'))?.status === 'completed' && settled(await plan(id), freezePass), 'queued follow-up completes after settlement');
  check('V5d queued follow-up runs after settlement without a stale pass', cycleOf(await plan(id), freezePass).outcome === 'verified');

  await settingsUpdate(id, { workerCap: 1 });
  const freezeFail = await delegateTask(id, 'MARK-FREEZEFAIL');
  await eventually(async () => result.requests.some(r => r.role === 'verifier' && r.marker === 'MARK-FREEZEFAIL' && r.stage === 3), 'fail recorded, verifier held');
  const heldFail = await plan(id);
  writeFileSync(join(artifacts, 'held-fail-plan.json'), JSON.stringify(heldFail, null, 2));
  await assert.rejects(rpc({ action: 'thread-send', id, threadId: freezeFail.threadId, requestId: randomUUID(), text: 'Must not enter after fail' }), /tree is frozen/);
  check('V5d recorded fail keeps parent frozen and does not start repair before settlement', cycleOf(heldFail, freezeFail).open && cycleOf(heldFail, freezeFail).attempts[0].state === 'fail' && heldFail.work.filter(w => w.threadId === freezeFail.threadId).length === 1 && !reportFor('MARK-FREEZEFAIL', 'VERIFIED by'));
  gate('MARK-FREEZEFAIL-verdict').open();
  const repaired = await eventually(async () => settled(await plan(id), freezeFail), 'cap 1 repair and fresh verifier complete');
  check('V5d settlement releases its own repair at cap 1, then a fresh verifier passes', repaired.outcome === 'verified' && repaired.attempts.map(a => a.state).join() === 'fail,pass', repaired);

  // V6: a missing skill or model at the end of a turn escalates; nothing is claimed complete.
  rmSync(join(workspace, '.agents/skills/mini-verify'), { recursive: true });
  const missing = await waitCycle(id, 'MARK-MISSING');
  check('V6 a verification skill that disappeared escalates before any verifier is started', missing.cycle.attempts.length === 0 && missing.cycle.outcome === 'escalated' && /not installed/.test(missing.cycle.reason) && !(await plan(id)).work.some(w => w.role === 'verifier' && w.text.includes('MARK-MISSING')));
  await eventually(async () => reportFor('MARK-MISSING', 'NOT VERIFIED'), 'missing skill reported');
  check('V6 the coordinator is told, and the work is blocked rather than completed', (await plan(id)).work.find(w => w.id === missing.worker.id).status === 'blocked');
  writeFileSync(join(result.root, 'unused'), '');

  // V7: turning it off again returns the old behavior at the next worker turn.
  await settingsUpdate(id, { verification: null });
  const off = await delegateTask(id, 'MARK-OFF');
  await eventually(async () => (await plan(id)).work.find(w => w.id === off.id)?.status === 'completed', 'worker completes with verification off');
  check('V7 verification off again: the next worker completes directly', !(await plan(id)).work.some(w => w.role === 'verifier' && w.text.includes('MARK-OFF')) && cycleOf(await plan(id), off) === undefined);
  console.log(JSON.stringify({ ok: true, seconds: Math.round((Date.now() - start) / 1000), checks: result.checks }, null, 2));
} catch (error) {
  result.error = String(error?.stack ?? error);
  try { result.finalPlan = await plan((await rpc({ action: 'list' })).projects?.[0]?.id ?? (await rpc({ action: 'list' }))[0]?.id); } catch (inner) { result.finalPlan = String(inner); }
  save(); console.error(result.error); process.exitCode = 1;
} finally {
  save();
  try { await rpc({ action: 'shutdown' }); await hostExit; } catch { host?.kill('SIGKILL'); }
  model.close();
  if (!process.exitCode) rmSync(root, { recursive: true, force: true });
}
