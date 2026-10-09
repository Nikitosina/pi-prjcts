// E2E: continue a branch/worktree from a new worker thread (fromThread / branch) and the coordinator's projects_worker_diff.
// Fake arc / arc-wt / arcanum / model, private HOME, git project with a local bare origin. Failure cases: worker-continuation-failures.md.
// Artifact: artifacts/worker-continuation-<time>/report.json (+ summary.json with the key observed facts).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';
import { fakeArcadia, assertFakeOnly } from './lib/fake-arc-kit.mjs';

// Coordinator: `MARK-J {args}` delegates with those projects_delegate arguments; `MARK-D <threadId>` reads projects_worker_diff.
// Worker: RUN[cmd]RUN (bash) and PR[title|body]PR (open_draft_pr) steps in order of appearance.
const fullDiffs = [];
const handler = ({ role, user, results, tools }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator') {
    if (results.length) { if (user.includes('MARK-D')) fullDiffs.push(results.at(-1)); return say('Noted.'); }
    const args = /MARK-J (\{[\s\S]+\})$/.exec(user)?.[1], diff = /MARK-D ([a-f0-9-]{36})/.exec(user)?.[1], bad = /MARK-X ([^\s]+)/.exec(user)?.[1];
    if (args) return call('projects_delegate', JSON.parse(args));
    if (diff || bad) return call('projects_worker_diff', { threadId: diff ?? bad });
    return undefined;
  }
  if (role !== 'worker') return undefined;
  const step = [...user.matchAll(/RUN\[([^\]]*)\]RUN|PR\[([^\]]*)\]PR/g)][results.length];
  if (!step) return undefined;
  if (step[1] !== undefined) return call('bash', { command: step[1] });
  const [title, body = ''] = step[2].split('|');
  return call(tools.find(name => /^projects_arc_.*_open_draft_pr$/.test(name)), { title, body });
};
const kit = await createKit('worker-continuation', { handler });
const { check, rpc, result, root } = kit;
const fake = fakeArcadia(kit.root);
Object.assign(kit.hostEnv, fake.env);
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
  for (const [title, cwd, arc] of [['GitProj', kit.workspace, false], ['ArcProj', fake.subdir, true]]) {
    const id = await kit.createProject(title, { grant: false, cwd });
    let snap = await rpc({ action: 'owner-setup-snapshot', id });
    await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
    if (arc) { snap = await rpc({ action: 'owner-setup-snapshot', id }); await rpc({ action: 'arc-quick-authorize', id, confirm: id, expectedRevision: snap.arcRevision }); }
    projects.push({ id, arc });
  }
  const [gp, ap] = projects;
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

  // ---- arc ----
  const adds = () => fake.calls().filter(c => c.tool === 'arc-wt' && c.argv[0] === 'add');
  const flag = (argv, name) => argv[argv.indexOf(name) + 1];
  const store = () => JSON.parse(readFileSync(join(fake.dir, 'arcanum.json'), 'utf8'));
  const patchStore = change => { const data = store(); change(data); writeFileSync(join(fake.dir, 'arcanum.json'), JSON.stringify(data)); };
  const receipts = async () => (await rpc({ action: 'arc-write-snapshot', id: ap.id })).items;
  const createCalls = () => fake.calls().filter(c => c.tool === 'arc' && c.argv[0] === 'pr' && c.argv[1] === 'create');

  await delegate(ap, { role: 'worker', task: `KEYBOARD-7001 cont base ${run("echo 'let a1 = 1' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "KEYBOARD-7001: a1"')} PR[KEYBOARD-7001: a1|first body]PR ${run('echo dirty-a1 > Sources/Dirty.swift', 'pwd', 'arc info --json')}` }, 'a-w1');
  const a1Plan = await work(ap, 'a-w1'), a1 = workerRun('a-w1').results;
  const a1Path = a1[5].trim(), a1Branch = JSON.parse(a1[6]).branch, a1Rows = await receipts();
  check('arc: worker 1 opened one PR from its branch and left an untracked file', a1Plan.status === 'completed' && store().prs.length === 1 && a1Rows.length === 1 && a1Rows[0].branch === a1Branch, { prs: store().prs.length, a1Rows });
  const addsBefore = adds().length, a1Conversation = a1Rows[0].conversationId;

  const ad1 = await diffOf(ap, a1Plan.threadId, 'ad1');
  check('F21 arc: projects_worker_diff shows branch, head, status and the untracked file as an addition', ad1.includes(`Branch: ${a1Branch}`) && /^\?\? .*Dirty\.swift$/m.test(ad1) && ad1.includes('dirty-a1') && ad1.includes('+let a1 = 1'), ad1.slice(0, 900));

  await delegate(ap, { role: 'worker', fromThread: a1Plan.threadId, task: run('pwd', 'arc info --json', 'arc status --short', 'cat Sources/Dirty.swift', "echo 'let a2 = 2' >> Sources/Keys.swift", 'arc add Sources/Keys.swift Sources/Dirty.swift', 'arc commit -m "KEYBOARD-7001: a2"') + ' PR[KEYBOARD-7001: a2|second body]PR' }, 'a-w2');
  const a2Plan = await work(ap, 'a-w2'), a2 = workerRun('a-w2').results;
  check('F1 arc fromThread: same worktree and branch, committed and untracked state present, no new arc-wt add', a2Plan.status === 'completed' && a2[0].trim() === a1Path && JSON.parse(a2[1]).branch === a1Branch && /Dirty\.swift/.test(a2[2]) && a2[3].includes('dirty-a1') && adds().length === addsBefore, { a2: a2.slice(0, 4), adds: [addsBefore, adds().length] });
  const a2Rows = await receipts();
  check('F20/F9 arc: the takeover updated the same PR (one PR, new head, no second create) and the receipt moved to the new thread conversation', store().prs.length === 1 && createCalls().length === 1 && a2Rows.length === 1 && a2Rows[0].head === fake.git(a1Path, 'rev-parse', 'HEAD') && a2Rows[0].head !== a1Rows[0].head && a2Rows[0].conversationId !== a1Conversation, { a1: a1Rows[0].head, a2: a2Rows[0] });
  check('F20 arc: the PR active head is the new commit', store().prs[0].diffSets.at(-1).head === a2Rows[0].head, store().prs[0].diffSets);
  const arcRefused = await kit.rejects({ action: 'thread-send', id: ap.id, threadId: a1Plan.threadId, text: `AFTER ${run('echo hacked > Sources/hacked.swift')}`, requestId: randomUUID() });
  check('F5 arc: the old thread is refused', /handed to thread/.test(arcRefused ?? '') && !existsSync(join(a1Path, 'Sources/hacked.swift')), arcRefused);

  // Arc branch continuation of a PR whose worktree and local branch are gone.
  await delegate(ap, { role: 'worker', task: `KEYBOARD-7002 second pr ${run("echo 'let a3 = 3' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "KEYBOARD-7002: a3"')} PR[KEYBOARD-7002: a3|third body]PR ${run('arc info --json')}` }, 'a-w3');
  const a3Plan = await work(ap, 'a-w3'), a3Branch = JSON.parse(workerRun('a-w3').results.at(-1)).branch, a3Row = (await receipts()).find(row => row.branch === a3Branch), pr2 = a3Row.pullRequest;
  const a3Entry = fake.wt().entries.find(entry => entry.branch === a3Branch), a3Head = a3Row.head;
  execFileSync(fake.env.PI_PROJECTS_ARC_WT_CLI, ['remove', a3Entry.name, '--lease-owner', `pi-projects:${ap.id}`]);
  fake.git(fake.arcadia, 'branch', '-D', a3Branch);
  check('arc: the second PR exists only on the server (worktree and local branch removed)', a3Plan.status === 'completed' && store().prs.length === 2 && !existsSync(a3Entry.path) && fake.serverRefs().some(([ref, sha]) => ref === `users/${fake.login}/${a3Branch}` && sha === a3Head), fake.serverRefs());

  const rejectBefore = adds().length;
  patchStore(data => { const copy = JSON.parse(JSON.stringify(data.prs[0])); copy.id = 99; copy.author = { name: 'someoneelse', uid: 'someoneelse' }; copy.from_branch = 'users/someoneelse/theirs'; data.prs.push(copy); });
  await rejected(ap, { role: 'worker', branch: 'users/someoneelse/theirs', task: 'x' }, 'a-r1', /not under users\/e2euser\//, 'F13 arc: another user\'s branch rejected');
  await rejected(ap, { role: 'worker', branch: '99', task: 'x' }, 'a-r2', /not authored by e2euser/, 'F13 arc: a PR authored by someone else rejected');
  await rejected(ap, { role: 'worker', branch: 'KEYBOARD-9999-nope', task: 'x' }, 'a-r3', /not found in Arcadia/, 'F14 arc: unknown branch rejected, no trunk fallback');
  await rejected(ap, { role: 'worker', branch: '--output=x', task: 'x' }, 'a-r4', /Invalid branch/, 'F15 arc: option-like branch rejected');
  await rejected(ap, { role: 'worker', branch: 'trunk', task: 'x' }, 'a-r5', /not found in Arcadia|cannot be continued/, 'F13 arc: trunk is not continuable');
  check('F13 arc: no worktree was added by any rejected branch', adds().length === rejectBefore, adds().slice(rejectBefore));

  const prCreates = createCalls().length;
  await delegate(ap, { role: 'worker', branch: String(pr2), task: run('pwd', 'arc info --json', 'cat Sources/Keys.swift', "echo 'let b1 = 4' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "KEYBOARD-7002: b1"', 'arc push') }, 'a-b1');
  const ab1Plan = await work(ap, 'a-b1'), ab1 = workerRun('a-b1').results, addB1 = adds().at(-1);
  check('F12 arc branch (by PR number): worktree added on the PR branch name at the PR tip', ab1Plan.status === 'completed' && addB1.argv[1] === a3Branch && flag(addB1.argv, '--base') === a3Head && JSON.parse(ab1[1]).branch === a3Branch && ab1[2].includes('let a3 = 3'), { add: addB1.argv, ab1: ab1.slice(0, 2) });
  const ab1Head = fake.git(ab1[0].trim(), 'rev-parse', 'HEAD');
  check('F12/F20 arc branch: the push advanced the server branch of the existing PR; no second PR for it', fake.serverRefs().some(([ref, sha]) => ref === `users/${fake.login}/${a3Branch}` && sha === ab1Head) && fake.git(fake.arcadia, 'rev-parse', `${ab1Head}^`) === a3Head && createCalls().length === prCreates && store().prs.find(pr => pr.id === pr2).diffSets.at(-1).head === ab1Head, { server: fake.serverRefs(), creates: createCalls().length });
  check('F12 arc branch: the worker is told this is an existing PR and owned branches include it', /continues the existing branch/.test(workerRun('a-b1').system), workerRun('a-b1').system.slice(-500));

  // Replay safety + default behaviour: a plain worker still starts a fresh trunk branch.
  await delegate(ap, { role: 'worker', task: `KEYBOARD-7003 plain ${run('arc info --json')}` }, 'a-plain');
  const plain = JSON.parse(workerRun('a-plain').results[0]);
  check('F19 a plain delegation is unchanged: a fresh KEYBOARD-7003 branch from trunk', plain.branch.startsWith('KEYBOARD-7003') && flag(adds().at(-1).argv, '--base') === fake.trunkHead, { branch: plain.branch, base: flag(adds().at(-1).argv, '--base') });

  // F23 cap on a huge change.
  await delegate(gp, { role: 'worker', fromThread: b1Plan.threadId, task: run("yes 'BIG-LINE-0123456789012345678901234567890123456789' | head -n 12000 > big.txt") }, 'g-big');
  const bigPlan = await work(gp, 'g-big');
  await diffOf(gp, bigPlan.threadId, 'dbig');
  const big = fullDiffs.at(-1) ?? '';
  check('F23 an oversized worker diff is capped under the harness clip with a truncation note', big.length > 40 * 1024 && big.length < 50 * 1024 && /\[diff truncated at 46 KB of \d+ KB/.test(big), big.length);

  summary.git = { w1Path, w1Branch, w1Head, existingTip, localTip, originRefs: originRefs() };
  summary.arc = { a1Branch, a3Branch, serverRefs: fake.serverRefs(), prs: store().prs.map(pr => ({ id: pr.id, from_branch: pr.from_branch, head: pr.diffSets.at(-1).head })) };
  summary.sampleDiff = d1;
  writeFileSync(join(kit.artifacts, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  assertFakeOnly(fake, root, check);
});
