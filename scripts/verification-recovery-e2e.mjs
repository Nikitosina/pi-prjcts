// Restart recovery, frozen model/skill, three real attempts and saturated multi-parent scheduling for the verification loop, on an isolated host, with a deterministic fake provider at the model seam and real everything else: git worktrees,
// snapshots, the OS sandbox, command execution, artifacts and the durable plan. No real providers, no owner state.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = process.env.VERIFY_LOOP_EVIDENCE ?? join(repo, 'artifacts', `verification-recovery-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `verification-recovery-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], requests: [], reports: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const gates = new Map(); // marker -> { open, wait }
const gate = marker => { if (!gates.has(marker)) { let open; const wait = new Promise(ok => { open = ok; }); gates.set(marker, { open, wait }); } return gates.get(marker); };
const text = content => typeof content === 'string' ? content : JSON.stringify(content ?? '');

// One provider plays every role. Worker/verifier behavior is keyed by the task marker.
const FEATURE = /feature\.txt = "([a-z0-9]*)"/;
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, names = (input.tools ?? []).map(tool => tool.function?.name);
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), user = text(msgs[lastUser]?.content);
    const all = msgs.map(m => text(m.content)).join('\n'), marker = /MARK-[A-Z0-9]+/.exec(all)?.[0] ?? 'none';
    const turn = msgs.slice(lastUser + 1).filter(m => m.role === 'tool'), stage = turn.length, last = text(turn.at(-1)?.content);
    const role = names.includes('projects_delegate') ? 'coordinator' : names.includes('projects_verify_run') ? 'verifier' : names.includes('bash') ? 'worker' : 'other';
    result.requests.push({ at: Date.now(), role, model: input.model, marker, stage, tools: names, user: user.slice(0, 160), proofNote: /define the proof/.test(all), longCriterion: all.includes('L'.repeat(3000)) });
    const reply = out => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(out); };
    try {
      if (role === 'coordinator') {
        if (user.startsWith('[Durable work')) { result.reports.push(user); return reply(say('Noted.')); }
        const task = user.match(/MARK-[A-Z0-9]+/)?.[0];
        if (task && stage === 0) {
          // The tool caps acceptance at 20 items of 500 characters; a brief can still carry its own criteria list, which the verification must keep whole.
          const list = items => `${task} write feature.txt\n\nAcceptance criteria (done means all are met):\n${items.map(item => `- ${item}`).join('\n')}`;
          if (task === 'MARK-MANY') return reply(call('projects_delegate', { task: list(Array.from({ length: 21 }, (_, i) => `criterion ${i + 1} holds`)) }));
          if (task === 'MARK-LONG') return reply(call('projects_delegate', { task: list(['feature.txt exists in the repository and contains the word done', `node check.mjs exits 0 ${'L'.repeat(3000)}`]) }));
          return reply(call('projects_delegate', { task: `${task} write feature.txt`, acceptance: ['feature.txt exists in the repository and contains the word done', 'node check.mjs exits 0'] }));
        }
        return reply(say('Delegated.'));
      }
      if (role === 'worker') {
        if (stage > 0) return reply(say(`Worker finished ${marker}`));
        if (marker === 'MARK-REPAIRFAIL' && /^\[Automatic verification failed\]/.test(user)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'repair turn refused by the provider', type: 'invalid_request_error' } })); }
        if (marker === 'MARK-PROOF') return reply(call('bash', { command: 'mkdir -p scripts && echo "process.exit(0)" > scripts/check.mjs && echo done > feature.txt' }));
        if (marker.startsWith('MARK-SAT') && marker !== 'MARK-SATA') await gate(marker).wait; // B and C hold their slots until released
        const left = /(\d) attempt\(s\) left/.exec(user)?.[1];
        const content = /^\[Automatic verification failed\]/.test(user) ? (marker === 'MARK-THREE' ? (left === '2' ? 'half' : 'half2') : 'done') : marker.startsWith('MARK-SAT') ? 'done' : 'nope';
        return reply(call('bash', { command: `echo ${content} > feature.txt` }));
      }
      if (role === 'verifier') {
        if (stage === 0) return reply(call('projects_skill_file', { skill: input.model === 'fake-judge' ? 'mini-verify' : 'other-verify' }));
        if (stage === 1) return reply(call('projects_verify_run', { command: 'node check.mjs; true' }));
        if (stage === 2) {
          if (marker === 'MARK-RESTART') await gate('restart-verifier').wait;
          const parsed = JSON.parse(last.slice(last.indexOf('{'))), seen = FEATURE.exec(parsed.tail)?.[1] ?? '?', c1 = seen === 'done' || seen === 'half2', c2 = seen === 'done' || seen === 'half';
          const run = parsed.runId, evidence = [{ runId: run }];
          return reply(call('projects_verification_verdict', { summary: `feature.txt is ${seen}`, criteria: [{ id: 'c1', status: c1 ? 'pass' : 'fail', reason: `feature.txt ${seen}`, evidence }, { id: 'c2', status: c2 ? 'pass' : 'fail', reason: `check ${seen}`, evidence }] }));
        }
        return reply(say('Verdict recorded.'));
      }
      return reply(say('ok'));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
const modelEntry = id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 });
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [modelEntry('fake-model'), modelEntry('fake-judge'), modelEntry('fake-judge2')] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
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
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const plan = id => rpc({ action: 'plan-snapshot', id });
const settingsUpdate = async (id, changes) => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: (await rpc({ action: 'settings-snapshot', id })).revision, changes });
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const cycleOf = (snapshot, work) => snapshot.verification?.[work.threadId];
const delegateTask = async (id, marker) => { const job = await rpc({ action: 'message', id, text: `${marker} please do the task` }); await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(j => j.id === job.id)?.state === 'done', `coordinator turn for ${marker}`); return eventually(async () => (await plan(id)).work.find(w => w.role === 'worker' && w.text.includes(marker)), `worker for ${marker}`); };
const settled = (snapshot, work) => { const cycle = cycleOf(snapshot, work); return cycle && !cycle.open && cycle; };
const waitCycle = async (id, marker) => { const worker = await delegateTask(id, marker); const cycle = await eventually(async () => settled(await plan(id), worker), `${marker} cycle did not end`); return { worker, cycle, snapshot: await plan(id) }; };
const reportFor = (marker, needle) => result.reports.find(report => report.includes(marker) && report.includes(needle));
let peak = 0; const watcher = (id) => { let stop = false; (async () => { while (!stop) { try { peak = Math.max(peak, (await plan(id)).work.filter(w => w.status === 'running').length); } catch { /* host restarting */ } await delay(25); } })(); return () => { stop = true; }; };

const killHost = async () => { host.kill('SIGKILL'); await hostExit; };
try {
  git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
  git(workspace, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  for (const name of ['mini-verify', 'other-verify']) { mkdirSync(join(workspace, '.agents/skills', name), { recursive: true }); writeFileSync(join(workspace, '.agents/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Verify that feature.txt says done by running node check.mjs in the snapshot (${name}).\n---\n\nRun \`node check.mjs\` from the snapshot root.\n`); }
  writeFileSync(join(workspace, 'check.mjs'), "import { readFileSync } from 'node:fs';\nconst text = readFileSync('feature.txt', 'utf8').trim();\nconsole.log('feature.txt =', JSON.stringify(text));\nprocess.exit(text === 'done' ? 0 : 1);\n");
  writeFileSync(join(workspace, 'README.md'), 'demo\n'); git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'base');
  await startHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Verification recovery', cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' });
  const id = project.id;
  await settingsUpdate(id, { workerCap: 1, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model', verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'mini-verify' } });

  // R1: three real attempts. Each fails differently (so the repeat rule does not fire); the third failure ends the cycle.
  const three = await waitCycle(id, 'MARK-THREE');
  check('R1 three real verifier attempts run, each a separate thread on a different revision, then the budget escalates', three.cycle.attempts.length === 3 && three.cycle.attempts.every(a => a.state === 'fail') && new Set(three.cycle.attempts.map(a => a.verifierThreadId)).size === 3 && new Set(three.cycle.attempts.map(a => a.revision)).size === 3 && three.cycle.outcome === 'escalated' && /attempts exhausted/.test(three.cycle.reason), three.cycle);
  check('R1 no fourth verifier is ever started and the work is blocked, not completed', (await plan(id)).work.filter(w => w.role === 'verifier' && w.text.includes('MARK-THREE')).length === 3 && (await plan(id)).work.find(w => w.id === three.worker.id).status === 'blocked');
  await eventually(async () => reportFor('MARK-THREE', 'NOT VERIFIED'), 'exhaustion reported');

  // R2: the host is killed while a verifier is mid-attempt, and the owner changes the verifier model and skill meanwhile.
  const job = await rpc({ action: 'message', id, text: 'MARK-RESTART please do the task' });
  await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(j => j.id === job.id)?.state === 'done', 'coordinator turn');
  const restartWorker = await eventually(async () => (await plan(id)).work.find(w => w.role === 'worker' && w.text.includes('MARK-RESTART')), 'restart worker');
  await eventually(async () => result.requests.some(r => r.role === 'verifier' && r.marker === 'MARK-RESTART' && r.stage === 2), 'verifier waiting at its verdict step');
  const before = cycleOf(await plan(id), restartWorker);
  check('R2 an attempt is running when the host dies', before.open && before.attempts.length === 1 && before.attempts[0].state === 'running');
  await settingsUpdate(id, { models: { verifier: 'fake/fake-judge2' }, verification: { enabled: true, skill: 'other-verify' } });
  await killHost();
  gate('restart-verifier').open();
  await startHost();
  const paused = await eventually(async () => { const p = await plan(id); return p.paused && p.work.find(w => w.role === 'verifier' && w.text.includes('feature.txt') && w.status === 'interrupted'); }, 'restart pauses the project with the verifier interrupted');
  check('R2 after the kill the project comes back paused with the verifier interrupted and its attempt still open (nothing guessed)', paused.status === 'interrupted' && cycleOf(await plan(id), restartWorker).open);
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  const after = await eventually(async () => { const c = cycleOf(await plan(id), restartWorker); return c && !c.open && c; }, 'cycle ends after restart', 2400);
  check('R2 the cycle survives the kill: first attempt record is kept and the loop finishes', after.attempts[0].verifierThreadId === before.attempts[0].verifierThreadId && after.attempts[0].revision === before.attempts[0].revision && after.outcome !== undefined, after);
  check('R2 model and skill were frozen when the cycle started: nothing used the changed settings', after.model === 'fake/fake-judge' && after.skill === 'mini-verify' && !result.requests.some(r => r.role === 'verifier' && r.marker === 'MARK-RESTART' && r.model === 'fake-judge2'), { model: after.model, skill: after.skill, verifierModels: [...new Set(result.requests.filter(r => r.marker === 'MARK-RESTART' && r.role === 'verifier').map(r => r.model))] });
  check('R2 the restart ended in an honest state: verified after a real retry, or escalated, never a silent completion', after.outcome === 'verified' ? after.attempts.at(-1).state === 'pass' : after.outcome === 'escalated' && (await plan(id)).work.find(w => w.id === restartWorker.id).status === 'blocked', after);
  result.restartOutcome = after;
  await settingsUpdate(id, { models: { verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'mini-verify' } });

  // R3: saturated scheduler with several parents. Cap 2: B holds a slot, A takes the other, C is queued behind them. A finishes and needs a verifier.
  await settingsUpdate(id, { workerCap: 2 });
  const stopWatching = watcher(id);
  const send = async marker => { const j = await rpc({ action: 'message', id, text: `${marker} please do the task` }); await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(x => x.id === j.id)?.state === 'done', `coordinator turn ${marker}`); };
  await send('MARK-SATB');
  await eventually(async () => (await plan(id)).work.find(w => w.text.includes('MARK-SATB') && w.role === 'worker')?.status === 'running', 'B running');
  await send('MARK-SATC');
  await eventually(async () => (await plan(id)).work.find(w => w.text.includes('MARK-SATC') && w.role === 'worker')?.status === 'running', 'C running (pool saturated by B and C)');
  await send('MARK-SATA');
  const queuedA = await eventually(async () => (await plan(id)).work.find(w => w.text.includes('MARK-SATA') && w.role === 'worker' && w.status === 'queued'), 'A waits for a slot behind the saturated pool');
  check('R3 with cap 2 saturated by two parents, a third parent waits queued', queuedA.status === 'queued' && peak <= 2, { peak });
  gate('MARK-SATB').open();
  // B finishes, its verifier and queued A compete for the freed slot; the verifier has priority, so no finished parent starves behind queued work.
  gate('MARK-SATC').open();
  const cycles = await Promise.all(['MARK-SATB', 'MARK-SATC', 'MARK-SATA'].map(marker => eventually(async () => { const p = await plan(id); const w = p.work.find(x => x.role === 'worker' && x.text.includes(marker)); return w && settled(p, w); }, `${marker} cycle ends`, 2400)));
  stopWatching();
  const finalPlan = await plan(id), startOf = marker => finalPlan.work.find(w => w.text.includes(marker) && w.role === 'worker').attempt?.startedAt ?? Infinity, verifierOf = marker => finalPlan.work.find(w => w.role === 'verifier' && w.parentThreadId === finalPlan.work.find(x => x.role === 'worker' && x.text.includes(marker)).threadId);
  check('R3 all three parents end verified, the cap of 2 was never exceeded and nobody deadlocked', cycles.every(c => c.outcome === 'verified') && peak <= 2, { peak, outcomes: cycles.map(c => c.outcome) });
  check('R3 a finished parent\'s verifier is scheduled ahead of work that was queued earlier', verifierOf('MARK-SATB').attempt.startedAt <= startOf('MARK-SATA'), { verifierB: verifierOf('MARK-SATB').attempt.startedAt, workerA: startOf('MARK-SATA') });
  // R4: a repair turn that fails must not leave the cycle open forever.
  const repairFail = await waitCycle(id, 'MARK-REPAIRFAIL');
  const repairTurns = (await plan(id)).work.filter(w => w.threadId === repairFail.worker.threadId && w.role === 'worker');
  check('R4 a failed repair turn ends the cycle as escalated and the earlier "completed" turn stops counting as complete', repairFail.cycle.outcome === 'escalated' && /repair turn failed/.test(repairFail.cycle.reason) && repairTurns.length === 2 && repairTurns[0].status === 'blocked' && repairTurns[1].status === 'failed', { cycle: repairFail.cycle, statuses: repairTurns.map(w => [w.status, w.blocker]) });
  // R5: criteria that do not fit are refused whole; nothing is silently dropped.
  const many = await waitCycle(id, 'MARK-MANY');
  check('R5 21 criteria are refused with a reason and no verifier starts; the work is blocked, not completed', many.cycle.attempts.length === 0 && many.cycle.outcome === 'escalated' && /21 acceptance criteria/.test(many.cycle.reason) && many.snapshot.work.find(w => w.id === many.worker.id).status === 'blocked', many.cycle);
  const long = await waitCycle(id, 'MARK-LONG');
  check('R5 a 3000-character criterion reaches the verifier whole', long.cycle.outcome === 'verified' && long.cycle.criteria[1].text.length > 3000 && result.requests.some(r => r.role === 'verifier' && r.marker === 'MARK-LONG' && r.longCriterion), long.cycle.criteria.map(c => c.text.length));
  // R6: edits to the proof (scripts, tests, skills) are shown to the verifier and recorded.
  const proof = await waitCycle(id, 'MARK-PROOF');
  check('R6 a worker that adds a script file shows it as changed proof to the verifier and in the cycle', proof.cycle.attempts[0].proofFiles.includes('scripts/check.mjs') && result.requests.some(r => r.role === 'verifier' && r.marker === 'MARK-PROOF' && r.proofNote), proof.cycle.attempts[0]);
  // R7: finished attempts leave no snapshots behind.
  await delay(1500);
  const left = execFileSync('/usr/bin/find', [root, '-type', 'd', '-path', '*/verification/*/target', '-maxdepth', '12'], { encoding: 'utf8' }).trim();
  check('R7 no verification snapshot (target or scratch) stays after the cycles ended', left === '', left);
  // R8: with verification on, a top-level worker that has no isolated worktree is not silently completed.
  const loose = join(root, 'loose'); mkdirSync(join(loose, '.agents/skills/mini-verify'), { recursive: true }); writeFileSync(join(loose, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Verify that feature.txt says done (loose workspace).\n---\n\nRun node check.mjs.\n');
  writeFileSync(join(loose, 'README.md'), 'not a git repository\n');
  const looseProject = (await rpc({ action: 'create', requestId: randomUUID(), name: 'No worktree', cwd: loose, objective: 'Disposable', model: 'fake/fake-model' })).id;
  await settingsUpdate(looseProject, { models: { verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'mini-verify' } });
  const unscoped = await waitCycle(looseProject, 'MARK-UNSCOPED');
  check('R8 a worker without an isolated worktree is escalated as not verifiable and blocked, never reported complete', unscoped.cycle.outcome === 'escalated' && /does not apply/.test(unscoped.cycle.reason) && unscoped.cycle.attempts.length === 0 && unscoped.snapshot.work.find(w => w.id === unscoped.worker.id).status === 'blocked', unscoped.cycle);
  console.log(JSON.stringify({ ok: true, checks: result.checks }, null, 2));
} catch (error) {
  result.error = String(error?.stack ?? error);
  try { result.finalPlan = await plan((await rpc({ action: 'list' }))[0]?.id); } catch (inner) { result.finalPlan = String(inner); }
  save(); console.error(result.error); process.exitCode = 1;
} finally {
  save();
  try { await rpc({ action: 'shutdown' }); await hostExit; } catch { host?.kill('SIGKILL'); }
  model.close();
  if (!process.exitCode) rmSync(root, { recursive: true, force: true });
}
