// E2E: workers of an Arc project on arc-wt worktrees (S2). Fake arc / arc-wt / model, private HOME. Failure cases: arc-workers-failures.md.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';
import { fakeArcadia, assertFakeOnly, SUBPATH } from './lib/fake-arc-kit.mjs';

// Coordinator: `MARK-W <task>` delegates the rest of the message. Worker: runs every RUN[...]RUN of its task through bash, in order.
const handler = ({ role, user, results }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator') { const task = /MARK-W ([\s\S]+)$/.exec(user)?.[1]; return task && results.length === 0 ? call('projects_delegate', { role: 'worker', task }) : results.length ? say('Noted.') : undefined; }
  if (role === 'worker') { const commands = [...user.matchAll(/RUN\[([^\]]*)\]RUN/g)].map(match => match[1]); if (results.length < commands.length) return call('bash', { command: commands[results.length] }); }
  return undefined;
};
const kit = await createKit('arc-workers', { handler });
const { check, rpc, result, root } = kit;
const fake = fakeArcadia(kit.root);
Object.assign(kit.hostEnv, fake.env);
kit.initRepo();
const real = path => realpathSync(path), wtBase = real(fake.wtBase);
const run = cmds => cmds.map(cmd => `RUN[${cmd}]RUN`).join(' ');
const BLOCKED = /Blocked by worker Arc policy/;

await kit.run(async () => {
  const id = await kit.createProject('YKKeyboard', { grant: false, cwd: fake.subdir });
  let snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'arc-quick-authorize', id, confirm: id, expectedRevision: snap.arcRevision });
  const wtCalls = () => fake.calls().filter(item => item.tool === 'arc-wt');
  const adds = () => wtCalls().filter(item => item.argv[0] === 'add');
  const dispatch = async task => { const before = (await kit.plan(id)).length; await kit.ask(id, `MARK-W ${task}`); const work = (await kit.plan(id)).slice(before).at(-1) ?? (await kit.plan(id)).at(-1); return work; };
  const lastWorker = marker => kit.lastCall('worker', marker);

  // W1: ticket task, full commit and push flow.
  const w1 = await dispatch(`KEYBOARD-15934 keys visual fix a1\n${run(['pwd', 'which arc', "echo 'let more = 2' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "KEYBOARD-15934: more keys"', 'arc push', 'arc status --short'])}`);
  const name1 = 'KEYBOARD-15934-keys-visual-fix-a1';
  const add1 = adds().find(item => item.argv[1] === name1);
  check('F2 a ticket task names the worktree and branch KEYBOARD-15934-<slug>, unprefixed', Boolean(add1) && add1.argv[2] === '--name' && add1.argv[3] === name1 && !add1.argv[1].startsWith('users/'), adds().map(item => item.argv.slice(0, 4)));
  const flag = (argv, name) => argv[argv.indexOf(name) + 1];
  check('F3 the base is the trunk head, not the owner feature branch', flag(add1.argv, '--base') === fake.trunkHead && flag(add1.argv, '--base') !== fake.featureHead, flag(add1.argv, '--base'));
  check('F6 the lease owner names the project and the reason names project and thread', flag(add1.argv, '--lease-owner') === `pi-projects:${id}` && /YKKeyboard/.test(flag(add1.argv, '--lease-reason')) && flag(add1.argv, '--lease-reason').includes(w1.threadId), add1.argv);
  check('F2 the worktree lives in the arc-wt folder, not the project home', flag(add1.argv, '--path') === join(wtBase, name1) && flag(add1.argv, '--object-store-path') === real(fake.objects), add1.argv);
  const c1 = lastWorker('#a1') ?? lastWorker('keys visual fix a1');
  const results1 = c1.results;
  check('F4 the worker shell runs in <worktree>/<project folder>', results1[0].trim() === join(wtBase, name1, SUBPATH), results1[0]);
  check('F1 the worker shell resolves arc to the fake', results1[1].trim() === join(fake.bin, 'arc'), results1[1]);
  check('F5 the project folder AGENTS.md reaches the worker prompt', /SUBDIR-STANDING-MARKER/.test(c1.system), c1.system.slice(0, 300));
  check('F8 the prompt names the branch and the server ref once', c1.system.includes(`users/${fake.login}/${name1}`) && !c1.system.includes(`users/${fake.login}/users/`) && c1.system.includes('-u users/'), c1.system.slice(-1200));
  const head1 = fake.git(join(wtBase, name1), 'rev-parse', 'HEAD');
  const refs = fake.serverRefs();
  check('F8 push created users/<login>/<branch> once, at the worktree HEAD', refs.length === 1 && refs[0][0] === `users/${fake.login}/${name1}` && refs[0][1] === head1, refs);
  check('F4 the owner mount stayed on its branch and untouched', fake.git(fake.arcadia, 'branch', '--show-current') === 'owner-feature' && fake.git(fake.arcadia, 'status', '--porcelain') === '');

  // W2: no ticket; W3: same task again -> -2.
  const w2 = await dispatch(`keys polish b2\n${run(['pwd'])}`);
  const name2 = wtCalls().filter(item => item.argv[0] === 'add').map(item => item.argv[3]).find(value => /^pi-[0-9a-f]{8}-keys-polish-b2$/.test(value));
  check('F2 a task without a ticket is named pi-<thread>-<slug>', Boolean(name2) && name2.startsWith(`pi-${w2.threadId.replaceAll('-', '').slice(0, 8)}-`), adds().map(item => item.argv[3]));
  await kit.ask(id, `MARK-W KEYBOARD-15934 keys visual fix a1\n${run(['pwd'])}`);
  check('F2 a clashing name gets -2', adds().some(item => item.argv[3] === `${name1}-2`), adds().map(item => item.argv[3]));

  // W4: guard.
  const guarded = ['git status', 'gh pr list', 'arc pr merge 1', 'arc push -d', 'arc push -u users/e2euser/x', 'arc push other-branch', 'arc-wt remove foo', 'arc pr create -m x', 'arc submit', 'ya tool arcanum pr auto-merge enable', 'arc checkout -b scratch', 'arc checkout trunk', 'arc push', 'arc status --short; git log', 'arc log -n 1 --oneline'];
  await dispatch(`KEYBOARD-20000 guard probe g4\n${run(guarded)}`);
  const g = lastWorker('guard probe g4').results;
  const blockedAt = Object.fromEntries(guarded.map((cmd, at) => [cmd, BLOCKED.test(g[at] ?? '')]));
  const mustBlock = guarded.filter(cmd => !['arc status --short', 'arc log -n 1 --oneline'].includes(cmd) && cmd !== 'arc checkout trunk');
  check('F7 every dangerous command is blocked', mustBlock.every(cmd => blockedAt[cmd]), blockedAt);
  check('F7 reads and trunk checkout run', !blockedAt['arc log -n 1 --oneline'] && !blockedAt['arc checkout trunk'], blockedAt);
  check('F7 a bare push from a checked-out trunk is refused (not a project branch)', /not a branch of this project/.test(g[guarded.indexOf('arc push')]), g[guarded.indexOf('arc push')]);
  const toolCalls = fake.calls().filter(item => item.tool === 'arc').map(item => item.argv.join(' '));
  check('F7 blocked commands never reached the fake arc / arc-wt', !toolCalls.some(text => /^pr |^submit|^push -d|-u users|other-branch|-b scratch/.test(text)) && !wtCalls().some(item => item.argv[0] === 'remove'), toolCalls.filter(text => /^pr |^submit/.test(text)));
  check('F9 no foreign or scratch ref reached the server', fake.serverRefs().every(([ref]) => ref === `users/${fake.login}/${name1}`), fake.serverRefs());

  // W5: follow-up renews the lease and reuses the worktree.
  const renewCount = () => wtCalls().filter(item => item.argv[0] === 'lease' && item.argv[1] === 'renew' && item.argv[2] === name1).length;
  const addCountBefore = adds().length, renewsBefore = renewCount();
  await rpc({ action: 'thread-send', id, threadId: w1.threadId, text: `follow up f5\n${run(['pwd', 'arc log -n 1 --oneline'])}`, requestId: randomUUID() });
  await delay(300); await kit.settle(id);
  const f5 = lastWorker('follow up f5').results;
  check('F10/F6 a follow-up continues the same worktree, renews the lease and adds nothing', f5[0].trim() === join(wtBase, name1, SUBPATH) && renewCount() > renewsBefore && adds().length === addCountBefore, { f5, renews: [renewsBefore, renewCount()] });

  // W6: lease lost -> the dispatch is refused.
  const run2 = await kit.plan(id);
  const thread2 = run2.find(item => item.threadId === w2.threadId);
  const wt = (...args) => new Promise(done => { import('node:child_process').then(({ spawn }) => { const proc = spawn(fake.env.PI_PROJECTS_ARC_WT_CLI, args, { stdio: 'ignore' }); proc.on('close', done); }); });
  await wt('lease', 'release', name2, '--owner', `pi-projects:${id}`); await wt('lease', 'acquire', name2, '--owner', 'someone-else', '--reason', 'theirs');
  await rpc({ action: 'thread-send', id, threadId: w2.threadId, text: `follow up f6\n${run(['pwd'])}`, requestId: randomUUID() });
  await delay(300); await kit.settle(id);
  const after = (await kit.plan(id)).filter(item => item.threadId === w2.threadId).at(-1);
  check('F6 a lease held by someone else refuses the dispatch with a clear message and runs no tool', ['failed', 'blocked', 'interrupted'].includes(after.status) && /lease/i.test(JSON.stringify(after)) && !result.calls.some(item => item.role === 'worker' && item.user.includes('follow up f6') && item.results.length), JSON.stringify(after).slice(0, 500));
  check('F6 the foreign lease was left alone (no remove, no force)', !wtCalls().some(item => item.argv[0] === 'remove' || item.forced));

  // Restart, then a follow-up on W1 again; then the watchdog digest for an Arc worktree.
  Object.assign(kit.hostEnv, { PI_PROJECTS_WATCHDOG_MS: '4000', PI_PROJECTS_WATCHDOG_TICK_MS: '400' });
  await kit.restartHost();
  const addsBeforeRestart = adds().length;
  await rpc({ action: 'thread-send', id, threadId: w1.threadId, text: `follow up r7\n${run(['pwd'])}`, requestId: randomUUID() });
  await delay(300); await kit.settle(id);
  check('F10 after a host restart the follow-up reuses the worktree', lastWorker('follow up r7').results[0].trim() === join(wtBase, name1, SUBPATH) && adds().length === addsBeforeRestart);
  await rpc({ action: 'thread-send', id, threadId: w1.threadId, text: `watch w8\n${run(["echo wd >> Sources/Keys.swift", 'sleep 14'])}`, requestId: randomUUID() });
  await kit.eventually(() => result.calls.some(item => item.role === 'coordinator' && /worker\.watchdog/.test(item.user) && /files changed in its worktree/.test(item.user)), 'no watchdog digest reached the coordinator', 400);
  const digest = result.calls.findLast(item => item.role === 'coordinator' && /worker\.watchdog/.test(item.user)).user;
  check('F11 the watchdog digest lists changed files from arc status', /files changed in its worktree: 1 \(/.test(digest) && /Keys\.swift/.test(digest) && !/unreadable/.test(digest), digest.slice(-300));
  await kit.settle(id);
  assertFakeOnly(fake, root, check);
});
