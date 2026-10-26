// Verification loop building blocks, real files and a real OS sandbox (no model): criteria and verdict rules, attempt budget and escalation,
// content revision of a worktree with uncommitted and untracked work, the disposable snapshot, and what the sandbox lets a command do.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'verification-unit-')));
process.env.PI_PROJECTS_HOME = join(root, 'projects-home');
const model = await import('../src/verification-model.ts');
const target = await import('../src/verification-target.ts');
const sandbox = await import('../src/verification-sandbox.ts');
const settings = await import('../src/project-settings.ts');
const checks = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } });

try {
  // Criteria: the delegation's bullet list, else the whole brief as one criterion.
  const brief = 'Do the thing\n\nAcceptance criteria (done means all are met):\n- first thing works\n- second thing works\n';
  check('criteria come from the acceptance list, numbered c1..', JSON.stringify(model.parseCriteria(brief)) === JSON.stringify([{ id: 'c1', text: 'first thing works' }, { id: 'c2', text: 'second thing works' }]));
  check('a brief without a list is one criterion', model.parseCriteria('Just fix it').length === 1 && model.parseCriteria('Just fix it')[0].text === 'Just fix it');

  // Verdict rules.
  const criteria = model.parseCriteria(brief), run = id => ({ id, command: 'x', exitCode: 1, signal: null, timedOut: false, durationMs: 1, stdout: { path: 'a', bytes: 0, sha256: '' }, stderr: { path: 'b', bytes: 0, sha256: '' }, tail: 'boom', at: 1 });
  const exists = path => path === 'shot.png';
  const verdict = (items, runs = [run('r1')]) => model.judge(criteria, runs, { summary: 's', criteria: items }, exists);
  check('a missing criterion is rejected', !verdict([{ id: 'c1', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }]).ok);
  check('an unknown criterion id is rejected (criteria cannot be rewritten)', !verdict([{ id: 'c1', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }, { id: 'c2', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }, { id: 'c9', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }]).ok);
  check('a pass without a run is rejected', !verdict([{ id: 'c1', status: 'pass', reason: 'looks right' }, { id: 'c2', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }]).ok);
  check('evidence naming a run that never ran is rejected', !verdict([{ id: 'c1', status: 'pass', reason: 'ok', evidence: [{ runId: 'r7' }] }, { id: 'c2', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }]).ok);
  check('evidence naming a missing artifact is rejected', !verdict([{ id: 'c1', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1', artifact: 'nope.png' }] }, { id: 'c2', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }]).ok);
  const mixed = verdict([{ id: 'c1', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1', artifact: 'shot.png' }] }, { id: 'c2', status: 'fail', reason: 'broken', evidence: [{ runId: 'r1' }] }]);
  check('the host derives the overall status: one fail makes the verdict fail', mixed.ok && mixed.verdict.status === 'fail');
  check('blocked outranks fail', verdict([{ id: 'c1', status: 'blocked', reason: 'no browser' }, { id: 'c2', status: 'fail', reason: 'broken' }]).verdict.status === 'blocked');
  check('all criteria passing with runs is a pass', verdict([{ id: 'c1', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }, { id: 'c2', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }]).verdict.status === 'pass');

  // Attempt budget and escalation.
  const attempt = (n, state, extra = {}) => ({ n, state, verifierWorkId: 'w', verifierThreadId: 't', key: 'k', revision: `rev${n}`, head: null, branch: null, sourcePath: '/x', targetPath: '/y', runs: [], startedAt: 1, ...extra });
  const cycle = attempts => ({ model: 'm', skill: 's', criteria, attempts, workIds: [], open: true });
  check('a pass is verified', model.nextStep(cycle([]), attempt(1, 'pass')).kind === 'verified');
  check('a first fail goes back to the worker', model.nextStep(cycle([attempt(1, 'fail', { signature: 'a' })]), attempt(1, 'fail', { signature: 'a' })).kind === 'retry');
  check('blocked escalates', model.nextStep(cycle([]), attempt(1, 'blocked', { reason: 'no skill' })).kind === 'escalate');
  check('a stale verdict escalates, never passes', model.nextStep(cycle([]), attempt(1, 'stale')).kind === 'escalate');
  check('a verifier that recorded nothing escalates', model.nextStep(cycle([]), attempt(1, 'running')).kind === 'escalate');
  const second = attempt(2, 'fail', { signature: 'a' });
  check('the same failure twice escalates instead of looping', model.nextStep(cycle([attempt(1, 'fail', { signature: 'a' }), second]), second).kind === 'escalate');
  const differing = attempt(2, 'fail', { signature: 'b' });
  check('a different failure still gets another attempt', model.nextStep(cycle([attempt(1, 'fail', { signature: 'a' }), differing]), differing).kind === 'retry');
  const third = attempt(3, 'fail', { signature: 'c' });
  check('the third failed attempt exhausts the budget', model.nextStep(cycle([attempt(1, 'fail', { signature: 'a' }), differing, third]), third).kind === 'escalate' && model.MAX_VERIFICATION_ATTEMPTS === 3);

  // Revision of a worktree: committed, modified, untracked and deleted work all count; ignored files do not.
  const repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\nnode_modules\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho ran\n'); chmodSync(join(repo, 'run.sh'), 0o755);
  symlinkSync('a.txt', join(repo, 'link'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const clean = await target.captureTarget(repo);
  check('a clean worktree records head and branch', clean.head === git(repo, 'rev-parse', 'HEAD').trim() && clean.branch === 'main' && clean.files.length === 4);
  writeFileSync(join(repo, 'ignored.log'), 'noise');
  check('ignored files do not change the revision', (await target.captureTarget(repo)).revision === clean.revision);
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  const edited = await target.captureTarget(repo);
  check('an uncommitted edit changes the revision', edited.revision !== clean.revision && edited.head === clean.head);
  writeFileSync(join(repo, 'new.txt'), 'untracked\n');
  const withNew = await target.captureTarget(repo);
  check('an untracked file changes the revision', withNew.revision !== edited.revision);
  rmSync(join(repo, 'run.sh'));
  check('a deleted file changes the revision', (await target.captureTarget(repo)).revision !== withNew.revision);
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho ran\n'); chmodSync(join(repo, 'run.sh'), 0o644);
  const noExec = await target.captureTarget(repo);
  chmodSync(join(repo, 'run.sh'), 0o755);
  check('the executable bit is part of the revision', (await target.captureTarget(repo)).revision !== noExec.revision);

  // Snapshot: a disposable copy that is its own clean git repository; the source is never touched.
  mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules', 'dep.txt'), 'dep');
  const manifest = await target.captureTarget(repo), dest = join(root, 'attempt', 'target');
  await target.snapshotTarget(repo, dest, manifest);
  check('the snapshot has the uncommitted and untracked files', readFileSync(join(dest, 'a.txt'), 'utf8') === 'two\n' && readFileSync(join(dest, 'new.txt'), 'utf8') === 'untracked\n');
  check('the snapshot is a clean one-commit repository of that content', git(dest, 'status', '--porcelain').trim() === '' && git(dest, 'rev-list', '--count', 'HEAD').trim() === '1');
  check('the snapshot reads node_modules through a link and keeps the executable bit', readFileSync(join(dest, 'node_modules', 'dep.txt'), 'utf8') === 'dep' && (await target.captureTarget(dest)).revision === manifest.revision);
  writeFileSync(join(dest, 'a.txt'), 'tampered\n');
  check('changes to the snapshot are detected against the manifest', JSON.stringify(await target.changedFromManifest(dest, manifest)) === JSON.stringify(['a.txt']));
  check('and the source did not move', readFileSync(join(repo, 'a.txt'), 'utf8') === 'two\n' && (await target.captureTarget(repo)).revision === manifest.revision);
  writeFileSync(join(dest, 'a.txt'), 'two\n'); writeFileSync(join(dest, 'build-output.txt'), 'x');
  check('untracked outputs in the snapshot are allowed', (await target.changedFromManifest(dest, manifest)).length === 0);

  // Sandbox: confined writes, no credentials, no remote network. macOS only; elsewhere verifier commands are refused (checked below).
  if (sandbox.sandboxAvailable()) {
    const work = join(root, 'sbx', 'work'), scratch = join(root, 'sbx', 'scratch'), artifacts = join(process.env.PI_PROJECTS_HOME, 'proj', 'artifacts', 'thread'), other = join(root, 'sbx', 'other'), secrets = join(root, 'sbx', 'secrets');
    for (const dir of [work, scratch, artifacts, other, secrets]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(secrets, 'token'), 'hunter2'); writeFileSync(join(process.env.PI_PROJECTS_HOME, 'proj', 'knowledge.md'), 'other thread data');
    const policy = { writable: [work, scratch, artifacts], unreadable: [secrets, process.env.PI_PROJECTS_HOME], readable: [artifacts] };
    const env = sandbox.sandboxEnv(scratch, artifacts);
    const sh = async command => sandbox.runSandboxed({ command, cwd: work, policy, env, timeoutMs: 20000, stdoutPath: join(artifacts, 'o.log'), stderrPath: join(artifacts, 'e.log') });
    check('a command writes its snapshot, scratch and artifacts', (await sh(`echo a > ok.txt && echo b > ${scratch}/s.txt && echo c > ${artifacts}/c.txt`)).exitCode === 0 && existsSync(join(work, 'ok.txt')));
    check('a command cannot write anywhere else, with absolute or relative paths', (await sh(`echo x > ${other}/pwn.txt`)).exitCode !== 0 && (await sh('echo x > ../other/pwn.txt')).exitCode !== 0 && !existsSync(join(other, 'pwn.txt')));
    check('a command cannot rewrite the source worktree or its git metadata', (await sh(`echo x > ${repo}/a.txt`)).exitCode !== 0 && (await sh(`git -C ${repo} commit --allow-empty -qm x`)).exitCode !== 0 && readFileSync(join(repo, 'a.txt'), 'utf8') === 'two\n' && git(repo, 'rev-list', '--count', 'HEAD').trim() === '1');
    check('a command cannot read credentials or other projects\' data', (await sh(`cat ${secrets}/token`)).exitCode !== 0 && (await sh(`cat ${process.env.PI_PROJECTS_HOME}/proj/knowledge.md`)).exitCode !== 0);
    check('but its own artifacts folder inside the project home stays readable', (await sh(`cat ${artifacts}/c.txt`)).exitCode === 0);
    const net = await sh('curl -s -m 4 https://example.com >/dev/null');
    check('a command cannot reach the network beyond loopback', net.exitCode !== 0);
    const loop = await sh(`node -e "const s=require('http').createServer((q,r)=>r.end('pong')).listen(0,'127.0.0.1',()=>fetch('http://127.0.0.1:'+s.address().port).then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}))"`);
    check('loopback still works (the verification host and browser need it)', loop.exitCode === 0 && loop.tail.includes('pong'));
    check('the environment carries no credentials and points HOME at scratch', (await sh('echo "$HOME|$TMPDIR|${GITHUB_TOKEN:-none}"')).tail.trim() === `${join(scratch, 'home')}|${join(scratch, 'tmp')}|none`);
    const slow = await sandbox.runSandboxed({ command: 'sleep 30', cwd: work, policy, env, timeoutMs: 400, stdoutPath: join(artifacts, 'o.log'), stderrPath: join(artifacts, 'e.log') });
    check('a command that overruns is killed and reported as timed out', slow.timedOut && slow.durationMs < 5000);
    const big = await sh('yes | head -c 300000');
    check('output is hashed in full and only a tail comes back', big.stdoutBytes === 300000 && big.tail.length <= sandbox.TAIL_CHARS && /^[a-f0-9]{64}$/.test(big.stdoutSha256));
  } else {
    await assert.rejects(sandbox.runSandboxed({ command: 'true', cwd: root, policy: { writable: [], unreadable: [], readable: [] }, env: {}, timeoutMs: 1000, stdoutPath: join(root, 'o'), stderrPath: join(root, 'e') }), /No enforceable sandbox/);
    checks.push('without an enforceable sandbox verifier commands are refused');
  }

  // Settings: the verifier model is never assumed.
  const base = { version: 1, id: '11111111-1111-4111-8111-111111111111', name: 'p', objective: 'o', model: 'fake/m', models: {}, createdAt: 'x', cwd: root, runtime: 'durable', phase: 'ready', problem: null };
  const update = (project, changes) => settings.updateProjectSettings(project, { action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.projectSettings(project).revision, changes });
  assert.throws(() => update(base, { verification: { enabled: true, skill: 'verify-pi-prjcts' } }), /own verifier model/);
  const withModel = update(base, { models: { verifier: 'fake/judge' } });
  assert.throws(() => update(withModel, { verification: { enabled: true, skill: '  ' } }), /verification skill/);
  const on = update(withModel, { verification: { enabled: true, skill: 'verify-pi-prjcts' } });
  check('verification is on only with its own model and skill, and shows in Settings', on.verification.enabled && settings.projectSettings(on).values.verification.skill === 'verify-pi-prjcts' && settings.projectSettings(on).values.models.verifier === 'fake/judge');
  check('null turns it off and the default is off', update(on, { verification: null }).verification === undefined && settings.projectSettings(base).values.verification === null);
  check('removing the verifier model while it is on is refused', (() => { try { update(on, { models: { verifier: null } }); return false; } catch (error) { return /own verifier model/.test(error.message); } })());
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
