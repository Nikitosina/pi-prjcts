// E2E: continue a branch/worktree from a new worker thread (fromThread / branch) and the coordinator's projects_worker_diff.
// Fake model, private HOME, git project with a local bare origin. Failure cases: worker-continuation-failures.md. (Provider-plugin variants live in the plugin repositories.)
// Artifact: artifacts/worker-continuation-<time>/report.json (+ summary.json with the key observed facts).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';

// Coordinator: `MARK-J {args}` delegates with those projects_delegate arguments; `MARK-D <threadId>` reads projects_worker_diff.
// Worker: RUN[cmd]RUN (bash) steps in order of appearance.
const fullDiffs = [];
const handler = ({ role, user, results }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator') {
    if (results.length) { if (user.includes('MARK-D')) fullDiffs.push(results.at(-1)); return say('Noted.'); }
    const args = /MARK-J (\{[\s\S]+\})$/.exec(user)?.[1], diff = /MARK-D ([a-f0-9-]{36})/.exec(user)?.[1], bad = /MARK-X ([^\s]+)/.exec(user)?.[1];
    if (args) return call('projects_delegate', JSON.parse(args));
    if (diff || bad) return call('projects_worker_diff', { threadId: diff ?? bad });
    return undefined;
  }
  if (role !== 'worker') return undefined;
  const step = [...user.matchAll(/RUN\[([^\]]*)\]RUN/g)][results.length];
  return step ? call('bash', { command: step[1] }) : undefined;
};
const kit = await createKit('worker-continuation', { handler });
const { check, rpc, result, root } = kit;
kit.initRepo();
const run = (...cmds) => cmds.map(cmd => `RUN[${cmd}]RUN`).join(' ');
const git = (dir, ...args) => kit.git(dir, ...args);
const summary = {};

// Git project: a bare origin with main and an open-PR style branch pi/existing that exists only on origin.
const origin = join(root, 'origin.git');
execFileSync('/usr/bin/git', ['init', '--bare', '-q', '-b', 'main', origin]);
git(kit.workspace, 'remote', 'add', 'origin', origin);
git(kit.workspace, 'push', '-q', 'origin', 'main');
git(kit.workspace, 'checkout', '-qb', 'pi/existing'); writeFileSync(join(kit.workspace, 'existing.txt'), 'EXISTING-PR-WORK\n'); git(kit.workspace, 'add', '.'); git(kit.workspace, 'commit', '-qm', 'existing pr work');
const existingTip = git(kit.workspace, 'rev-parse', 'HEAD');
git(kit.workspace, 'push', '-q', 'origin', 'pi/existing'); git(kit.workspace, 'checkout', '-q', 'main'); git(kit.workspace, 'branch', '-D', 'pi/existing');
// A branch that exists only locally (never pushed), at the commit the worktree should start from.
const localTree = git(kit.workspace, 'rev-parse', 'HEAD^{tree}');
const localTip = execFileSync('/usr/bin/git', ['-C', kit.workspace, 'commit-tree', localTree, '-p', 'HEAD', '-m', 'local only work'], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } }).trim();
git(kit.workspace, 'update-ref', 'refs/heads/pi/local-only', localTip);
const originRefs = () => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').sort();
const worktreeCount = dir => git(dir, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length;

await kit.run(async () => {
  const projects = [];
  for (const [title, cwd] of [['GitProj', kit.workspace]]) {
    const id = await kit.createProject(title, { grant: false, cwd });
    const snap = await rpc({ action: 'owner-setup-snapshot', id });
    await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
    projects.push({ id });
  }
  const [gp] = projects;
  const delegate = async (project, args, tag) => { await kit.ask(project.id, `MARK-J ${JSON.stringify({ ...args, task: `${args.task ?? ''} ${tag}` })}`); const out = kit.result.calls.findLast(c => c.role === 'coordinator' && c.user.includes(tag) && c.results.length)?.results.at(-1) ?? ''; if (process.env.E2E_DEBUG) console.error(`[delegate ${tag}]`, out.slice(0, 500)); return out; };
  const work = async (project, tag) => (await kit.plan(project.id)).findLast(item => item.text.includes(tag));
  const workerRun = tag => kit.lastCall('worker', tag);
  const diffOf = async (project, threadId, label, marker = 'MARK-D') => { await kit.ask(project.id, `${marker} ${threadId} LBL-${label}`); return kit.result.calls.findLast(c => c.role === 'coordinator' && c.user.includes(`LBL-${label}`) && c.results.length)?.results.at(-1) ?? ''; };
  const rejected = async (project, args, tag, pattern, label) => {
    const before = (await kit.plan(project.id)).length, text = await delegate(project, args, tag);
    check(label, pattern.test(text) && (await kit.plan(project.id)).length === before, text.slice(0, 400));
    return text;
  };

  // ---- git: fromThread ----
  const w1Plan = await (async () => { await delegate(gp, { role: 'worker', task: run('pwd', 'git branch --show-current', 'echo COMMITTED-W1 > committed.txt', 'git add committed.txt', 'git commit -qm w1-commit', 'echo DIRTY-W1 >> README.md', 'echo UNTRACKED-W1 > loose.txt') }, 'g-w1'); return work(gp, 'g-w1'); })();
  const w1 = workerRun('g-w1').results, w1Path = w1[0].trim(), w1Branch = w1[1].trim();
  check('git: worker 1 finished in its own worktree on a pi/ branch with commit, dirty file and untracked file', w1Plan.status === 'completed' && /^pi\//.test(w1Branch) && w1Path !== kit.workspace, { w1Path, w1Branch, status: w1Plan.status });
  const w1Head = git(w1Path, 'rev-parse', 'HEAD');
  const worktreesBefore = worktreeCount(kit.workspace);

  // F21/F24 coordinator diff tool.
  const d1 = await diffOf(gp, w1Plan.threadId, 'd1');
  check('F21 projects_worker_diff shows branch, head, status codes and the diff with committed, dirty and untracked content', d1.includes(`Branch: ${w1Branch}`) && d1.includes(`Head: ${w1Head}`) && /^ M README\.md$/m.test(d1) && /^\?\? loose\.txt$/m.test(d1) && d1.includes('+COMMITTED-W1') && d1.includes('+DIRTY-W1') && d1.includes('UNTRACKED-W1'), d1.slice(0, 1200));
  const wTools = workerRun('g-w1').tools;
  check('F24 the worker is not offered the coordinator diff tool; the coordinator is', !wTools.includes('projects_worker_diff') && kit.lastCall('coordinator', 'LBL-d1').tools.includes('projects_worker_diff'), wTools);
  const notFound = await diffOf(gp, '00000000-0000-4000-8000-000000000000', 'd2');
  check('F22 unknown thread: clear error', /Unknown worker thread/.test(notFound), notFound);
  const badSchema = await diffOf(gp, '../../etc', 'd3', 'MARK-X');
  check('F24 non-UUID thread id never reaches the tool (schema)', !/Branch:/.test(badSchema), badSchema.slice(0, 200));

  // F1 takeover keeps worktree, branch, commits and uncommitted state.
  await delegate(gp, { role: 'worker', fromThread: w1Plan.threadId, task: run('pwd', 'git branch --show-current', 'cat committed.txt', 'git status --short', 'echo MORE-W2 >> README.md', 'git add -A', 'git commit -qm w2-commit') }, 'g-w2');
  const w2Plan = await work(gp, 'g-w2'); if (!workerRun('g-w2')) throw Error(`w2 never ran: ${JSON.stringify(w2Plan)}`); const w2 = workerRun('g-w2').results;
  check('F1 fromThread: the new thread runs in the same worktree on the same branch', w2Plan.status === 'completed' && w2Plan.threadId !== w1Plan.threadId && w2[0].trim() === w1Path && w2[1].trim() === w1Branch, w2);
  check('F1 fromThread: the source commit and uncommitted state are there', w2[2].includes('COMMITTED-W1') && /M README\.md/.test(w2[3]) && /\?\? loose\.txt/.test(w2[3]), w2[3]);
  check('F1 no second worktree was created', worktreeCount(kit.workspace) === worktreesBefore, [worktreesBefore, worktreeCount(kit.workspace)]);
  check('F1 the new thread builds on the old commit (history keeps w1-commit below w2-commit)', git(w1Path, 'log', '--format=%s', '-3').split('\n').join('|') === 'w2-commit|w1-commit|c1', git(w1Path, 'log', '--format=%s', '-3'));
  check('F1 the worker is told the worktree was taken over', /taken over from an earlier worker thread/.test(workerRun('g-w2').system), workerRun('g-w2').system.slice(-600));

  // F5 the old thread can no longer work: follow-up refused at admission, nothing runs.
  const callsBefore = result.calls.length;
  const refused = await kit.rejects({ action: 'thread-send', id: gp.id, threadId: w1Plan.threadId, text: `AFTER-TRANSFER ${run('echo hacked > hacked.txt')}`, requestId: randomUUID() });
  await delay(500); await kit.settle(gp.id);
  check('F5 a follow-up to the old thread is refused with the new owner named', /handed to thread/.test(refused ?? '') && refused.includes(w2Plan.threadId), refused);
  check('F5 nothing ran for the old thread and the worktree is untouched', !result.calls.slice(callsBefore).some(c => c.role === 'worker') && !existsSync(join(w1Path, 'hacked.txt')), result.calls.slice(callsBefore).map(c => c.role));
  const d4 = await diffOf(gp, w1Plan.threadId, 'd4');
  check('F21 the diff of the old thread id resolves to the worktree its successor now owns', d4.includes('+MORE-W2') && d4.includes(`Branch: ${w1Branch}`), d4.slice(0, 400));

  // F10 rejections.
  await rejected(gp, { role: 'worker', fromThread: w1Plan.threadId, task: 'x' }, 'g-r1', /already handed to thread/, 'F8 taking over an already transferred thread is rejected and names the owner');
  await rejected(gp, { role: 'worker', fromThread: '00000000-0000-4000-8000-000000000000', task: 'x' }, 'g-r2', /Unknown thread/, 'F3 unknown source thread rejected');
  await rejected(gp, { role: 'worker', fromThread: w2Plan.threadId, branch: 'pi/existing', task: 'x' }, 'g-r3', /either fromThread or branch/, 'F10 fromThread plus branch rejected');
  await rejected(gp, { role: 'worker', fromThread: w2Plan.threadId, workspaceScopeId: randomUUID(), task: 'x' }, 'g-r4', /differs from the source thread's scope/, 'F10 a different workspaceScopeId is rejected');
  await rejected(gp, { role: 'reviewer', fromThread: w2Plan.threadId, task: 'x' }, 'g-r5', /for worker delegations/, 'F10 fromThread on a reviewer rejected');
  await rejected(gp, { role: 'worker', fromThread: w2Plan.threadId, threadId: w2Plan.threadId, task: 'x' }, 'g-r6', /threadId is for scout and reviewer/, 'F10 fromThread plus threadId rejected');

  // F8 chain: w2 -> w3; both older threads are refused; then w3 is the only owner.
  await delegate(gp, { role: 'worker', fromThread: w2Plan.threadId, task: run('pwd', 'git log --format=%s -3') }, 'g-w3');
  const w3Plan = await work(gp, 'g-w3'), w3 = workerRun('g-w3').results;
  check('F8 chain: a third thread takes over and sees the same worktree and history', w3[0].trim() === w1Path && w3[1].trim().split('\n').join('|') === 'w2-commit|w1-commit|c1', w3);
  const refusedOld = await kit.rejects({ action: 'thread-send', id: gp.id, threadId: w2Plan.threadId, text: 'AFTER-TRANSFER-2', requestId: randomUUID() });
  check('F8 chain: the middle thread is refused too', /handed to thread/.test(refusedOld ?? '') && refusedOld.includes(w3Plan.threadId), refusedOld);

  // F2 running source rejected; F7 maintenance keeps the worktree while its new owner runs although the original thread is idle.
  await rpc({ action: 'message', id: gp.id, text: `MARK-J ${JSON.stringify({ role: 'worker', fromThread: w3Plan.threadId, task: `${run('echo SLEEPER > sleeper.txt', 'sleep 8')} g-w4` })}` });
  const w4Plan = await kit.eventually(async () => { const item = await work(gp, 'g-w4'); return item?.status === 'running' ? item : null; }, 'takeover worker did not start running', 200);
  const inventory = await rpc({ action: 'worktrees-snapshot', id: gp.id });
  const item = inventory.items.find(entry => entry.path === w1Path);
  check('F7 the worktree is not removable while the thread that took it over is running (and is listed once)', item && !item.removable && /queued, running or interrupted/.test(item.reasons.join(' ')) && inventory.items.filter(entry => entry.path === w1Path).length === 1, item);
  await rejected(gp, { role: 'worker', fromThread: w4Plan.threadId, task: 'x' }, 'g-r7', /still has queued, running or interrupted work/, 'F2 taking over a running thread is rejected');
  await kit.settle(gp.id);

  // ---- git: branch ----
  const before = { refs: originRefs(), trees: worktreeCount(kit.workspace) };
  for (const [ref, pattern, label] of [['main', /not a project branch/, 'main'], ['origin/main', /not a project branch/, 'origin/main'], ['feature/other', /not a project branch/, 'a branch outside the project prefix'], ['--upload-pack=touch /tmp/pwned-continuation', /Invalid branch/, 'an option-like ref'], ['pi/a..b', /Invalid branch/, 'a traversal ref'], ['pi/missing-branch', /not found/, 'an unresolvable branch'], ['12', /PR number/, 'a PR number (git)']]) {
    await rejected(gp, { role: 'worker', branch: ref, task: 'x' }, `g-b-${label.replace(/\W/g, '')}`, pattern, `F13/F14/F15 git branch ${label} rejected, no work admitted`);
  }
  check('F13/F15 rejected branches created no worktree, no origin ref and no side-effect file', worktreeCount(kit.workspace) === before.trees && originRefs().join() === before.refs.join() && !existsSync('/tmp/pwned-continuation'), { trees: worktreeCount(kit.workspace), refs: originRefs() });

  await delegate(gp, { role: 'worker', branch: 'pi/existing', task: run('pwd', 'git branch --show-current', 'cat existing.txt', 'echo CONT-WORK > cont.txt', 'git add cont.txt', 'git commit -qm cont-work', 'git push origin HEAD:pi/existing') }, 'g-b1');
  const b1Plan = await work(gp, 'g-b1'), b1 = workerRun('g-b1').results;
  check('F12 branch: the worktree is on the existing branch name and has its content', b1Plan.status === 'completed' && b1[1].trim() === 'pi/existing' && b1[2].includes('EXISTING-PR-WORK'), b1);
  check('F12 branch: the push landed on the existing branch on top of its old tip (same PR), no new branch on origin', git(origin, 'rev-parse', 'pi/existing^') === existingTip && git(origin, 'log', '-1', '--format=%s', 'pi/existing') === 'cont-work' && originRefs().join() === ['main', 'pi/existing'].join(), { refs: originRefs(), tip: existingTip });
  check('F12 branch: the worker is told this is an existing PR', /continues the existing branch pi\/existing/.test(workerRun('g-b1').system), workerRun('g-b1').system.slice(-500));
  // F18 a follow-up to the continued thread keeps the frozen branch.
  await rpc({ action: 'thread-send', id: gp.id, threadId: b1Plan.threadId, text: `follow ${run('git branch --show-current', 'pwd')} g-f1`, requestId: randomUUID() }); await delay(300); await kit.settle(gp.id);
  check('F18 a follow-up reuses the frozen branch and worktree', workerRun('g-f1').results[0].trim() === 'pi/existing' && workerRun('g-f1').results[1].trim() === b1[0].trim(), workerRun('g-f1').results);
  // F16 a branch that exists locally at the intended tip is checked out as is.
  await delegate(gp, { role: 'worker', branch: 'pi/local-only', task: run('git branch --show-current', 'git rev-parse HEAD') }, 'g-b2');
  const b2 = workerRun('g-b2').results;
  check('F16 a local-only branch at its tip is continued without recreating it', b2[0].trim() === 'pi/local-only' && b2[1].trim() === localTip && git(kit.workspace, 'rev-parse', 'pi/local-only') === localTip, b2);

  // F23 cap on a huge change.
  await delegate(gp, { role: 'worker', fromThread: b1Plan.threadId, task: run("yes 'BIG-LINE-0123456789012345678901234567890123456789' | head -n 12000 > big.txt") }, 'g-big');
  const bigPlan = await work(gp, 'g-big');
  await diffOf(gp, bigPlan.threadId, 'dbig');
  const big = fullDiffs.at(-1) ?? '';
  check('F23 an oversized worker diff is capped under the harness clip with a truncation note', big.length > 40 * 1024 && big.length < 50 * 1024 && /\[diff truncated at 46 KB of \d+ KB/.test(big), big.length);

  summary.git = { w1Path, w1Branch, w1Head, existingTip, localTip, originRefs: originRefs() };
  summary.sampleDiff = d1;
  writeFileSync(join(kit.artifacts, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
});
