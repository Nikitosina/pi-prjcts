// The canonical verify-pi-prjcts skill runs inside real verifier attempts. A deterministic provider drives tools at the model seam;
// the worker worktree, isolated verification host, headless Chrome, screenshots, stored transcript, cleanup and durable repair loop are real.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = process.env.VERIFY_LOOP_EVIDENCE ?? join(repo, 'artifacts', `verification-trusted-browser-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `verification-trusted-browser-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
if (!existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && !process.env.VERIFY_CHROME) throw Error('Google Chrome is required (or set VERIFY_CHROME)');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], requests: [], reports: [], provider: 'deterministic fake at the existing OpenAI-completions model seam' };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const text = content => typeof content === 'string' ? content : JSON.stringify(content ?? '');
const parse = output => JSON.parse(output.slice(output.indexOf('{')));
const verification = { attempt: 0, runs: new Map() };
const composeGuard = 'document.addEventListener("submit", event => { if';
const brokenGuard = 'document.addEventListener("submit", event => { if (event.target.matches("#compose")) return; if';
const mutation = `python3 -c 'from pathlib import Path; p=Path("web/app.js"); s=p.read_text(); old=${JSON.stringify(composeGuard)}; new=${JSON.stringify(brokenGuard)}; assert s.count(old)==1; p.write_text(s.replace(old,new))'`;
const repair = `python3 -c 'from pathlib import Path; p=Path("web/app.js"); s=p.read_text(); old=${JSON.stringify(brokenGuard)}; new=${JSON.stringify(composeGuard)}; assert s.count(old)==1; p.write_text(s.replace(old,new))'`;
const V = 'node .agents/skills/verify-pi-prjcts/scripts/verify.mjs';

const model = createServer((req, res) => {
  req.setEncoding('utf8'); let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages, names = (input.tools ?? []).map(tool => tool.function?.name);
    const lastUser = msgs.findLastIndex(m => m.role === 'user'), user = text(msgs[lastUser]?.content);
    const turn = msgs.slice(lastUser + 1).filter(m => m.role === 'tool'), stage = turn.length, last = text(turn.at(-1)?.content);
    const role = names.includes('projects_delegate') ? 'coordinator' : names.includes('projects_verify_run') ? 'verifier' : names.includes('bash') ? 'worker' : 'other';
    result.requests.push({ at: Date.now(), role, model: input.model, stage, tools: names, user: user.slice(0, 200), last: last.slice(0, 1000) });
    const reply = output => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(output); };
    try {
      if (role === 'coordinator') {
        if (user.startsWith('[Durable work')) { result.reports.push(user); return reply(say('Noted.')); }
        if (stage === 0) return reply(call('projects_delegate', { task: 'MARK-BROWSER keep coordinator messaging working', acceptance: ['the canonical message-coordinator browser journey passes', 'the host stores the sent message and coordinator reply'] }));
        return reply(say('Delegated.'));
      }
      if (role === 'worker') {
        if (stage === 1) return reply(call('projects_request_verification', {}));
        if (stage > 1) return reply(say('Coordinator messaging is ready for verification.'));
        return reply(call('bash', { command: user.startsWith('[Automatic verification failed]') ? repair : mutation }));
      }
      if (role === 'verifier') {
        if (stage === 0) {
          verification.attempt++; verification.runs.set(verification.attempt, {});
          return reply(call('projects_skill_file', { skill: 'verify-pi-prjcts' }));
        }
        const state = verification.runs.get(verification.attempt);
        if (stage === 1) return reply(call('projects_verify_run', { command: `${V} launch --evidence "$PI_ARTIFACTS_DIR/browser"`, timeoutSeconds: 120 }));
        if (stage === 2) { const launched = parse(last), output = parse(launched.tail); Object.assign(state, output, { launchRun: launched.runId }); return reply(call('projects_verify_run', { command: `${V} doctor --run ${state.scratch}`, timeoutSeconds: 60 })); }
        if (stage === 3) return reply(call('projects_verify_run', { command: `${V} drive --run ${state.scratch} message-coordinator`, timeoutSeconds: 180 }));
        if (stage === 4) { const drive = parse(last), journey = readdirSync(state.evidence).find(name => name.startsWith('drive-message-coordinator-')); if (!journey) throw Error('canonical drive wrote no evidence directory'); Object.assign(state, { driveRun: drive.runId, driveExit: drive.exitCode, driveTail: drive.tail, journeyEvidence: join(state.evidence, journey) }); return reply(call('projects_verify_run', { command: `${V} cleanup --run ${state.scratch}`, timeoutSeconds: 120 })); }
        if (stage === 5) {
          state.cleanupRun = parse(last).runId;
          const pass = state.driveExit === 0;
          // Evidence paths are relative to the verifier's artifact root, as required by the verdict tool.
          const evidenceRoot = join(state.evidence, '..'), journey = state.journeyEvidence;
          const evidence = [{ runId: state.driveRun }, { artifact: relative(evidenceRoot, join(journey, 'report.json')) }];
          if (pass) evidence.push({ artifact: relative(evidenceRoot, join(journey, 'host-show-messages.json')) }, { artifact: relative(evidenceRoot, join(journey, '03-reply.png')) });
          else evidence.push({ artifact: relative(evidenceRoot, join(journey, '99-failure.png')) });
          return reply(call('projects_verification_verdict', { summary: pass ? 'The canonical browser journey passed and independently checked stored messages.' : 'The canonical browser journey failed; its failure screenshot and report are attached.', criteria: [
            { id: 'c1', status: pass ? 'pass' : 'fail', reason: pass ? 'launch, doctor and message-coordinator drive exited 0' : `message-coordinator drive exited ${state.driveExit}`, evidence },
            { id: 'c2', status: pass ? 'pass' : 'fail', reason: pass ? 'host-show-messages.json contains both turns' : 'the journey did not reach its stored-transcript assertion', evidence },
          ] }));
        }
        return reply(say('Verdict recorded.'));
      }
      return reply(say('ok'));
    } catch (error) { res.writeHead(500); res.end(String(error?.stack ?? error)); }
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
const modelEntry = { id: 'fake-model', name: 'fake-model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 };
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [modelEntry] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'a', mode: 0o600 });
let host, hostExit;
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 60000 }, res => {
      res.setEncoding('utf8'); let data = ''; res.on('data', part => { data += part; });
      res.on('end', () => { try { const reply = JSON.parse(data); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = Number(process.env.E2E_TRIES ?? 1800)) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error(`Timed out: ${description}`);
}
async function startHost() {
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
  hostExit = new Promise(ok => host.once('exit', ok));
  await eventually(async () => { try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'owned outer host did not start');
}
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const plan = id => rpc({ action: 'plan-snapshot', id });
const settingsUpdate = async (id, changes) => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: (await rpc({ action: 'settings-snapshot', id })).revision, changes });
const check = (name, ok, detail) => { assert.ok(ok, `${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 800)}`}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);

try {
  // A disposable full source checkout gives the worker and the canonical skill their real target and dependencies.
  cpSync(repo, workspace, { recursive: true, filter: source => { const rel = relative(repo, source); return rel === '' || !['.git', 'node_modules', 'artifacts'].some(part => rel === part || rel.startsWith(part + '/')); } });
  git(workspace, 'init', '-b', 'main'); git(workspace, 'config', 'user.email', 'e2e@example.invalid'); git(workspace, 'config', 'user.name', 'E2E');
  git(workspace, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git'); git(workspace, 'add', '.'); git(workspace, 'commit', '-m', 'source');
  await startHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Trusted browser verification', cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' }), id = project.id;
  await settingsUpdate(id, { workerCap: 1, worktreeSetup: `ln -s ${repo}/node_modules node_modules`, models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model', verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'verify-pi-prjcts' } });
  const job = await rpc({ action: 'message', id, text: 'MARK-BROWSER please implement and verify coordinator messaging' });
  await eventually(async () => (await rpc({ action: 'show', id })).jobs.find(item => item.id === job.id)?.state === 'done', 'coordinator delegation');
  const worker = await eventually(async () => (await plan(id)).work.find(item => item.role === 'worker' && item.text.includes('MARK-BROWSER')), 'browser worker');
  const cycle = await eventually(async () => { const current = (await plan(id)).verification?.[worker.threadId]; return current && !current.open ? current : false; }, 'canonical fail-repair-pass cycle', 3600);
  check('B1 the canonical journey really failed, the same worker repaired it, and a fresh verifier passed', cycle.outcome === 'verified' && cycle.attempts.map(item => item.state).join() === 'fail,pass' && cycle.attempts[0].verifierThreadId !== cycle.attempts[1].verifierThreadId, cycle);
  check('B2 each attempt ran the full canonical command sequence and used the frozen verifier model', verification.attempt === 2 && [...verification.runs.values()].every(state => state.launchRun && state.driveRun && state.cleanupRun) && result.requests.filter(item => item.role === 'verifier').every(item => item.model === 'fake-model'), [...verification.runs.values()]);
  const workerTurns = (await plan(id)).work.filter(item => item.threadId === worker.threadId && item.role === 'worker');
  check('B3 the failure returned to the same worker and cap 1 did not deadlock', workerTurns.length === 2 && result.requests.some(item => item.role === 'worker' && item.user.startsWith('[Automatic verification failed]')), workerTurns.map(item => item.status));
  check('B4 completion was reported only after the passing canonical verdict', result.reports.some(item => item.includes('VERIFIED by an independent verifier after 2 attempt(s)')) && !result.reports.some(item => item.includes('NOT VERIFIED')), result.reports);

  // Copy verifier-owned proof out before the disposable project home is removed.
  const attempts = [];
  for (const attempt of cycle.attempts) {
    const dest = join(artifacts, `attempt-${attempt.n}`), source = join(home, id, 'artifacts', attempt.verifierThreadId);
    cpSync(source, dest, { recursive: true });
    const files = walk(dest), reports = files.filter(file => /drive-message-coordinator-.*\/report\.json$/.test(file));
    check(`B5 attempt ${attempt.n} retained its browser report, action/result screenshots and command logs`, reports.length === 1 && files.some(file => file.endsWith('02-typed.png')) && files.some(file => file.endsWith(attempt.n === 1 ? '99-failure.png' : '03-reply.png')) && files.some(file => /\/bg\/bg-[a-f0-9]{8}\.log$/.test(file)), files.map(file => relative(dest, file)));
    const report = JSON.parse(readFileSync(reports[0], 'utf8'));
    check(`B6 attempt ${attempt.n} has the expected real browser outcome`, report.ok === (attempt.n === 2) && (attempt.n === 2 || report.problems.length > 0), report);
    const diagnostics = JSON.parse(readFileSync(join(dest, 'browser/diagnostics/run.json'), 'utf8'));
    check(`B7 attempt ${attempt.n} cleaned up its isolated host, provider and Chrome scratch while evidence survived`, !existsSync(diagnostics.scratch) && existsSync(join(dest, 'browser/diagnostics/host.log')) && existsSync(join(dest, 'browser/diagnostics/fake-provider.log')), diagnostics.scratch);
    attempts.push({ n: attempt.n, state: attempt.state, evidence: relative(artifacts, dest), browserReport: relative(artifacts, reports[0]) });
    if (attempt.n === 2) {
      const transcript = JSON.parse(readFileSync(reports[0].replace(/report\.json$/, 'host-show-messages.json'), 'utf8'));
      check('B8 the passing journey independently proves both messages in host storage', transcript.some(line => line.includes('VERIFY-PING')) && transcript.some(line => line.includes('VERIFY-FAKE-REPLY: VERIFY-PING')), transcript);
    }
  }
  result.attempts = attempts;
  writeFileSync(join(artifacts, 'plan.json'), JSON.stringify(await plan(id), null, 2));
  console.log(JSON.stringify({ ok: true, checks: result.checks, attempts: result.attempts }, null, 2));
} catch (error) {
  result.error = String(error?.stack ?? error); save(); console.error(result.error); process.exitCode = 1;
} finally {
  // A provider error or assertion can interrupt the scripted cleanup. Never leave a canonical detached host/provider/browser behind.
  for (const state of verification.runs.values()) if (state.scratch && existsSync(join(state.scratch, 'run.json'))) {
    try { execFileSync(process.execPath, [join(repo, '.agents/skills/verify-pi-prjcts/scripts/verify.mjs'), 'cleanup', '--run', state.scratch], { stdio: 'pipe', env }); }
    catch (error) { result.cleanupErrors ??= []; result.cleanupErrors.push(String(error)); process.exitCode = 1; }
  }
  save();
  try { await rpc({ action: 'shutdown' }); await hostExit; } catch { host?.kill('SIGKILL'); }
  model.close();
  if (!process.exitCode) rmSync(root, { recursive: true, force: true });
}
