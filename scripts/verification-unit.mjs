// Verification loop building blocks (no model): verdict rules, escalation, exact worktree revisions, trusted-command drift and resource leases.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'verification-unit-')));
process.env.PI_PROJECTS_HOME = join(root, 'projects-home');
const model = await import('../src/verification-model.ts');
const target = await import('../src/verification-target.ts');
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
  const criteria = model.parseCriteria(brief), run = id => ({ id, command: 'x', exitCode: 1, signal: null, timedOut: false, aborted: false, durationMs: 1, log: { path: 'bg/r1.log', bytes: 0, sha256: '' }, tail: 'boom', at: 1 });
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
  const attempt = (n, state, extra = {}) => ({ n, state, verifierWorkId: 'w', verifierThreadId: 't', key: 'k', revision: `rev${n}`, head: null, branch: null, sourcePath: '/x', runs: [], startedAt: 1, ...extra });
  const cycle = attempts => ({ model: 'm', skill: 's', scopeId: 'scope', criteria, attempts, workIds: [], open: true });
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

  // Drift: what a verifier's commands (or anything else) changed in the tree it verifies.
  mkdirSync(join(repo, 'node_modules')); writeFileSync(join(repo, 'node_modules', 'dep.txt'), 'dep');
  const manifest = await target.captureTarget(repo);
  check('ignored dependency folders are not part of the revision', manifest.files.every(file => !file.path.startsWith('node_modules')));
  check('an unchanged tree has no drift', target.driftPaths(target.diffManifests(manifest, await target.captureTarget(repo))).length === 0);
  writeFileSync(join(repo, 'a.txt'), 'changed by a test run\n'); writeFileSync(join(repo, 'coverage.txt'), 'x'); rmSync(join(repo, 'link'));
  const drift = target.diffManifests(manifest, await target.captureTarget(repo));
  check('drift names added, removed and modified files', JSON.stringify(drift) === JSON.stringify({ added: ['coverage.txt'], removed: ['link'], modified: ['a.txt'] }), drift);
  writeFileSync(join(repo, 'ignored.log'), 'more noise');
  check('ignored outputs (builds, logs) are not drift', target.driftPaths(target.diffManifests(manifest, await target.captureTarget(repo))).length === 3);

  // Shared resources: the lease rule workers follow, applied to the commands a verifier runs.
  const resources = await import('../src/verification-resources.ts');
  check('a command naming a simulator, container runtime, fixed browser port or desktop session needs a matching lease', ['xcrun simctl boot X', 'xcodebuild test', 'docker compose up', 'chrome --remote-debugging-port=9222', 'osascript -e x', 'open -a Safari'].every(command => resources.missingLease(command, []) !== null));
  check('the matching lease satisfies it and an unrelated one does not', resources.missingLease('xcrun simctl boot X', ['ios-simulator']) === null && resources.missingLease('docker ps', ['docker']) === null && resources.missingLease('docker ps', ['ios-simulator']) !== null);
  check('ordinary builds, tests, private-port browsers and git need no lease', ['npm test', 'node verify.mjs drive', 'git status', 'chrome --remote-debugging-port=0', 'cat dockerfile.txt'].every(command => resources.missingLease(command, []) === null));
  const { ResourceLeases } = await import('../src/resource-leases.ts'), leases = new ResourceLeases();
  const first = { projectId: 'p', threadId: 'first-verifier' }, otherHolder = { projectId: 'p', threadId: 'second-verifier' };
  check('a shared resource is granted to one verifier and conflicts with another', (await leases.acquire('chrome-9222', first, 60000)).acquired && !(await leases.acquire('chrome-9222', otherHolder, 60000)).acquired);
  check('finishing a failed or stopped verifier releases its leases for the next verifier', leases.releaseWhere(holder => holder.threadId === first.threadId).join() === 'chrome-9222' && (await leases.acquire('chrome-9222', otherHolder, 60000)).acquired);
  check('release is owner-scoped and cannot steal another thread\'s resource', !leases.release('chrome-9222', first) && leases.held().length === 1 && leases.releaseWhere(() => true).join() === 'chrome-9222' && leases.held().length === 0);

  // The shell a verifier uses is its worker's: same policy, from the same function.
  const binding = await import('../src/durable-workspace-binding.ts');
  const ownerCheckout = join(root, 'owner'), workDir = join(root, 'owner-worktrees', 'w1'); mkdirSync(ownerCheckout, { recursive: true }); mkdirSync(workDir, { recursive: true });
  const project = (provider, wholeRepository = true) => ({ workspaceAuthorization: { provider, owner: 'o', repositories: [{ repositoryId: 'r1', provider, ownerCheckout, approvedRoot: join(root, 'owner-worktrees'), fileOwnershipPrefix: 'x' }], scopes: [{ id: 's1', repositoryId: 'r1', ...(wholeRepository ? { wholeRepository: true } : {}) }] } });
  const shell = binding.verifierShell(project('github'), 's1', workDir, 'pi/feature');
  check('a git workspace scope gives the verifier the worker\'s shell policy', 'guard' in shell);
  check('that policy keeps pushes off protected branches and commands out of the owner checkout', /Blocked/.test(shell.guard('git push origin main')) && /exit 126/.test(shell.guard(`echo x > ${ownerCheckout}/a.txt`)) && shell.guard('npm test') === 'npm test' && shell.guard('git push origin pi/feature') === 'git push origin pi/feature');
  check('a folder-limited git worker cannot gain general shell through verification', 'refusal' in binding.verifierShell(project('github', false), 's1', workDir, 'pi/feature'));
  check('a plugin workspace provider, an unknown scope and a project without grants are refused, not run under a weaker policy', 'refusal' in binding.verifierShell(project('arcadia'), 's1', workDir, null) && 'refusal' in binding.verifierShell(project('github'), 'nope', workDir, null) && 'refusal' in binding.verifierShell({}, 's1', workDir, null));

  // Full criteria survive; what cannot fit is refused, never cut.
  const longText = 'x'.repeat(5000), many = `Do it\n\nAcceptance criteria (all):\n${Array.from({ length: 25 }, (_, index) => `- criterion ${index + 1}`).join('\n')}\n`;
  check('a long criterion is kept whole', model.parseCriteria(`Do\n\nAcceptance criteria:\n- ${longText}\n`)[0].text === longText);
  check('more than 20 criteria are all parsed and then refused, not truncated', model.parseCriteria(many).length === 25 && /25 acceptance criteria/.test(model.criteriaProblem(many, model.parseCriteria(many))) && model.criteriaProblem('short', model.parseCriteria('short')) === null && /characters/.test(model.criteriaProblem('y'.repeat(30000), [{ id: 'c1', text: 'a' }])));
  // A pass cannot rest on a run that did not finish; the failure signature sees output and reasons.
  const mkRun = (id, extra) => ({ ...run(id), exitCode: 0, ...extra });
  for (const [name, extra] of [['timed out', { timedOut: true, exitCode: null, signal: 'SIGTERM' }], ['aborted', { aborted: true, exitCode: null, signal: 'SIGTERM' }], ['killed', { signal: 'SIGKILL', exitCode: null }]]) {
    const bad = model.judge(criteria, [mkRun('r1', extra)], { summary: 's', criteria: [{ id: 'c1', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }, { id: 'c2', status: 'pass', reason: 'ok', evidence: [{ runId: 'r1' }] }] }, exists);
    check(`a pass resting on a ${name} run is rejected`, !bad.ok && bad.errors.some(error => /proves nothing/.test(error)));
  }
  const sig = (log, reason = 'broken') => model.failureSignature({ runs: [{ ...run('r1'), log: { path: 'bg/r1.log', bytes: 1, sha256: log } }], verdict: { status: 'fail', summary: 's', recordedAt: 1, criteria: [{ id: 'c1', status: 'fail', reason, evidence: [{ runId: 'r1' }] }] } });
  check('the failure signature changes with the output or the reason, and is stable otherwise', sig('aa') === sig('aa') && sig('aa') !== sig('bb') && sig('aa') !== sig('aa', 'different reason'));
  // The proof the verifier runs: edits to skills, scripts and tests are surfaced.
  const proofRepo = join(root, 'proof'); mkdirSync(join(proofRepo, 'scripts'), { recursive: true }); mkdirSync(join(proofRepo, 'src'));
  git(proofRepo, 'init', '-q', '-b', 'main'); writeFileSync(join(proofRepo, 'scripts/check.mjs'), 'process.exit(1)\n'); writeFileSync(join(proofRepo, 'src/a.ts'), 'a\n'); git(proofRepo, 'add', '-A'); git(proofRepo, 'commit', '-qm', 'base');
  writeFileSync(join(proofRepo, 'scripts/check.mjs'), 'process.exit(0) // weakened\n'); writeFileSync(join(proofRepo, 'src/a.ts'), 'b\n'); writeFileSync(join(proofRepo, 'scripts/new-test.mjs'), 'x\n');
  const proof = await target.proofChanges(proofRepo, await target.captureTarget(proofRepo));
  check('files that define the proof show in a diff, and ordinary source does not', proof.paths.join() === 'scripts/check.mjs,scripts/new-test.mjs' && /weakened/.test(proof.diff) && !/src\/a\.ts/.test(proof.diff));
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
