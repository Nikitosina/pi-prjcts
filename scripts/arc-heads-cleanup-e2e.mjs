// E2E: Arc PR-head reads and worktree cleanup (S5). Fake arc / arc-wt / arcanum / model. Failure cases: arc-heads-cleanup-failures.md.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';
import { fakeArcadia, assertFakeOnly, SUBPATH } from './lib/fake-arc-kit.mjs';

const handler = ({ role, user, results, tools }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator' && results.length === 0) {
    const review = /MARK-R (\S+)\n([\s\S]+)$/.exec(user); if (review) return call('projects_delegate', { role: 'reviewer', ref: review[1], task: review[2] });
    const task = /MARK-W ([\s\S]+)$/.exec(user)?.[1]; if (task) return call('projects_delegate', { role: 'worker', task });
  }
  if (role === 'coordinator') return results.length ? say('Noted.') : undefined;
  if (role === 'reviewer') return results.length === 0 ? call('code_read', { path: `${SUBPATH}/Sources/Keys.swift` }) : undefined;
  if (role !== 'worker') return undefined;
  const steps = [...user.matchAll(/RUN\[([^\]]*)\]RUN|PR\[([^\]]*)\]PR/g)], step = steps[results.length];
  if (!step) return undefined;
  if (step[1] !== undefined) return call('bash', { command: step[1] });
  const [title, body = ''] = step[2].split('|');
  return call(tools.find(name => /^projects_arc_.*_open_draft_pr$/.test(name)), { title, body });
};
const kit = await createKit('arc-heads-cleanup', { handler });
const { check, rpc, result, root } = kit;
const fake = fakeArcadia(kit.root);
Object.assign(kit.hostEnv, fake.env);
kit.initRepo();
const wtBase = realpathSync(fake.wtBase);
const run = (...cmds) => cmds.map(cmd => `RUN[${cmd}]RUN`).join(' ');
const commit = (file, text) => [`echo '${text}' >> Sources/${file}`, `arc add Sources/${file}`, `arc commit -m "${text}"`];
const store = () => JSON.parse(readFileSync(join(fake.dir, 'arcanum.json'), 'utf8'));
const patch = change => { const data = store(); change(data); writeFileSync(join(fake.dir, 'arcanum.json'), JSON.stringify(data)); };
const wtCalls = () => fake.calls().filter(item => item.tool === 'arc-wt');

await kit.run(async () => {
  const id = await kit.createProject('YKKeyboard', { grant: false, cwd: fake.subdir });
  let snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'arc-quick-authorize', id, confirm: id, expectedRevision: snap.arcRevision });
  const dispatch = async task => { await kit.ask(id, `MARK-W ${task}`); return (await kit.plan(id)).filter(work => work.role === 'worker').at(-1); };
  const inventory = async () => (await rpc({ action: 'worktrees-snapshot', id })).inventory ?? (await rpc({ action: 'worktrees-snapshot', id }));
  const item = async branch => (await inventory()).items.find(entry => entry.branch === branch);

  const w1 = await dispatch(`KEYBOARD-101 open pr w1\n${run(...commit('Keys.swift', 'let a = 1'))} PR[KEYBOARD-101: a|A.]PR`);
  const w2 = await dispatch(`KEYBOARD-102 dirty w2\n${run("echo dirty >> Sources/Keys.swift")}`);
  const w3 = await dispatch(`KEYBOARD-103 unpushed w3\n${run(...commit('Keys.swift', 'let c = 3'))}`);
  const w4 = await dispatch(`KEYBOARD-104 clean pushed w4\n${run(...commit('Keys.swift', 'let d = 4'), 'arc push')}`);
  const w5 = await dispatch(`KEYBOARD-105 merged pr w5\n${run(...commit('Keys.swift', 'let e = 5'))} PR[KEYBOARD-105: e|E.]PR`);
  const w6 = await dispatch(`KEYBOARD-106 foreign w6\n${run(...commit('Keys.swift', 'let f = 6'), 'arc push')}`);
  patch(data => { const pr = data.prs.find(entry => entry.from_branch.includes('KEYBOARD-105')); pr.status = 'merged'; pr.merge_commit = pr.diffSets.at(-1).head; });
  const own = name => `pi-projects:${id}`;
  const wt = (...args) => new Promise(done => { import('node:child_process').then(({ spawn }) => { const proc = spawn(fake.env.PI_PROJECTS_ARC_WT_CLI, args, { stdio: 'ignore' }); proc.on('close', done); }); });
  const name6 = 'KEYBOARD-106-foreign-w6';
  await wt('lease', 'release', name6, '--owner', own()); await wt('lease', 'acquire', name6, '--owner', 'someone-else', '--reason', 'theirs');

  // Inventory.
  const b = word => `KEYBOARD-${word}`;
  const [i1, i2, i3, i4, i5, i6] = await Promise.all(['KEYBOARD-101-open-pr-w1', 'KEYBOARD-102-dirty-w2', 'KEYBOARD-103-unpushed-w3', 'KEYBOARD-104-clean-pushed-w4', 'KEYBOARD-105-merged-pr-w5', name6].map(item));
  const why = entry => entry?.reasons.join('; ') ?? 'missing';
  check('F4 an open PR keeps the worktree', i1 && !i1.removable && /open PR/.test(why(i1)), why(i1));
  check('F4 uncommitted changes keep it', i2 && !i2.removable && /uncommitted/.test(why(i2)), why(i2));
  check('F4 commits not on the server keep it', i3 && !i3.removable && /not on the server/.test(why(i3)), why(i3));
  check('F4 clean and pushed (no PR) is removable', i4?.removable === true, why(i4));
  check('F4 a merged PR makes it removable', i5?.removable === true && i5.pullRequests.some(pr => pr.state === 'merged'), i5);
  check('F4 a lease held by someone else keeps it', i6 && !i6.removable && /lease/.test(why(i6)), why(i6));
  check('F5 Arc items are marked as arc-wt managed', [i1, i4].every(entry => entry.provider === 'arc'));

  // PR-head reads.
  const pr1 = store().prs.find(entry => entry.from_branch.includes('KEYBOARD-101')), head1 = pr1.diffSets.at(-1).head;
  const adds = () => wtCalls().filter(call2 => call2.argv[0] === 'add' && call2.argv[1].startsWith('pi-read-'));
  const review = async (ref, tag) => { await kit.ask(id, `MARK-R ${ref}\nreview ${tag}`); return kit.lastCall('reviewer', `review ${tag}`); };
  const r1 = await review(`pull/${pr1.id}`, 'r1');
  check('F2/F3 a reviewer on pull/<n> reads exactly the PR head files', /let a = 1/.test(r1.results.join('')) && !/let c = 3/.test(r1.results.join('')), r1.results);
  const add1 = adds();
  check('F3 one leased read-only worktree at read-heads/<sha>, based on the head', add1.length === 1 && add1[0].argv.includes('--path') && add1[0].argv[add1[0].argv.indexOf('--path') + 1] === join(realpathSync(kit.home), id, 'read-heads', head1) && add1[0].argv[add1[0].argv.indexOf('--base') + 1] === head1 && add1[0].argv[add1[0].argv.indexOf('--lease-owner') + 1] === own(), add1.map(entry => entry.argv));
  await review(String(pr1.id), 'r2'); await review(`users/${fake.login}/KEYBOARD-101-open-pr-w1`, 'r3'); await review(head1, 'r4');
  check('F3 the PR number, the branch and the SHA reuse that worktree', adds().length === 1);
  const before = adds().length;
  for (const [ref, tag] of [['--upload-pack=touch', 'bad1'], ['nope/not-there', 'bad2']]) await kit.ask(id, `MARK-R ${ref}\nreview ${tag}`);
  const refused = result.calls.filter(entry => entry.role === 'coordinator' && entry.results.some(text => /Invalid ref|was not found in Arcadia/.test(text))).length;
  check('F2 option-like and unknown refs are refused at delegation, nothing mounted, no reviewer admitted', adds().length === before && !(await kit.plan(id)).some(work => /review bad[12]/.test(work.text)) && refused >= 2, { refused, adds: adds().length });
  check('F2 the refused refs reached no arc command', !fake.calls().some(entry => entry.argv.some(arg => arg.startsWith('--upload-pack'))));

  // Cleanup.
  const calls0 = wtCalls().length;
  const done = await rpc({ action: 'worktrees-cleanup', id, confirm: id });
  const removedPaths = (done.removed ?? []).map(entry => entry.path);
  check('F5 cleanup removed the clean-pushed, the merged-PR and the idle read-head worktrees', [i4.path, i5.path].every(path => removedPaths.includes(path)) && removedPaths.some(path => path.includes('read-heads')), done);
  check('F5 and kept the open-PR, dirty, unpushed and foreign-lease ones', [i1.path, i2.path, i3.path, i6.path].every(path => existsSync(path) && !removedPaths.includes(path)), removedPaths);
  const fresh = wtCalls().slice(calls0).map(entry => entry.argv);
  const removes = fresh.filter(argv => argv[0] === 'remove');
  check('F5 each removal was preceded by a lease renew and carried --lease-owner and --lease-renewed, never --force', removes.length >= 3 && removes.every(argv => argv.includes('--lease-owner') && argv.includes('--lease-renewed') && !argv.includes('--force')) && removes.every(argv => fresh.some(other => other[0] === 'lease' && other[1] === 'renew' && other[2] === argv[1])), fresh);
  check('F5 the foreign-lease worktree was never removed or renewed by us', !fresh.some(argv => (argv[0] === 'remove' && argv[1] === name6) || (argv[0] === 'lease' && argv[2] === name6)));
  check('F5 branches are kept', fake.git(fake.arcadia, 'branch', '--list', 'KEYBOARD-104-clean-pushed-w4').length > 0);
  check('F1 no git command ran in an Arc worktree', !fake.calls().some(entry => entry.tool === 'arc' && /^git/.test(entry.argv[0])));
  // A thread whose worktree was cleaned up says so.
  await rpc({ action: 'thread-send', id, threadId: w4.threadId, text: `follow after cleanup\n${run('pwd')}`, requestId: randomUUID() });
  await delay(300); await kit.settle(id);
  const after = (await kit.plan(id)).filter(work => work.threadId === w4.threadId).at(-1);
  check('F5 a follow-up to a cleaned-up thread is refused with the continue-the-branch message', /cleaned up/.test(JSON.stringify(after)), JSON.stringify(after).slice(0, 300));
  assertFakeOnly(fake, root, check);
});
