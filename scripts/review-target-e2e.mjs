// E2E: scout/reviewer review targets (threadId / ref) and code_diff. Fake model, private HOME, git project. (Provider-plugin variants live in the plugin repositories.)
// Failure cases: review-target-failures.md. Artifact: artifacts/review-target-<time>/report.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say } from './lib/e2e-kit.mjs';

// Coordinator: `MARK-J {args}` delegates with exactly those projects_delegate arguments.
// Worker: runs each RUN[...]RUN via bash. Scout/reviewer: runs each STEP[tool|json]STEP in order.
const fullResults = [];
const handler = ({ role, user, results }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'reviewer' && user.includes('git-BIG')) fullResults.push(...results);
  if (role === 'coordinator') { const args = /MARK-J (\{[\s\S]+\})$/.exec(user)?.[1]; return args && results.length === 0 ? call('projects_delegate', JSON.parse(args)) : results.length ? say('Noted.') : undefined; }
  if (role === 'worker') { const commands = [...user.matchAll(/RUN\[([^\]]*)\]RUN/g)].map(match => match[1]); if (results.length < commands.length) return call('bash', { command: commands[results.length] }); }
  const steps = [...user.matchAll(/STEP\[(\w+)\|([^\]]*)\]STEP/g)];
  if (steps[results.length]) return call(steps[results.length][1], JSON.parse(steps[results.length][2]));
  return undefined;
};
const kit = await createKit('review-target', { handler });
const { check, rpc, result } = kit;
kit.initRepo();
// A git project: base README plus a local branch with a file that exists only there.
kit.git(kit.workspace, 'checkout', '-qb', 'feature-x'); writeFileSync(join(kit.workspace, 'feat.txt'), 'FEATURE-ONLY\n'); kit.git(kit.workspace, 'add', '.'); kit.git(kit.workspace, 'commit', '-qm', 'feature'); kit.git(kit.workspace, 'checkout', '-q', 'main');
writeFileSync(join(kit.workspace, 'TRUNK-ONLY.txt'), 'trunk marker\n'); kit.git(kit.workspace, 'add', '.'); kit.git(kit.workspace, 'commit', '-qm', 'trunk marker');
const run = cmds => cmds.map(cmd => `RUN[${cmd}]RUN`).join(' ');
const step = (tool, args = {}) => `STEP[${tool}|${JSON.stringify(args)}]STEP`;

await kit.run(async () => {
  const projects = [];
  for (const [title, cwd, file] of [['GitProj', kit.workspace, 'README.md']]) {
    const id = await kit.createProject(title, { grant: false, cwd });
    const snap = await rpc({ action: 'owner-setup-snapshot', id });
    await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
    projects.push({ id, file, title });
  }
  const delegate = async (project, args, tag) => { await kit.ask(project.id, `MARK-J ${JSON.stringify({ ...args, task: `${args.task ?? ''} ${tag}` })}`); return kit.result.calls.findLast(c => c.role === 'coordinator' && c.user.includes(tag) && c.results.length)?.results.at(-1) ?? ''; };
  const reviewerOut = tag => kit.lastCall('reviewer', tag)?.results ?? [];

  for (const project of projects) {
    const label = 'git', file = project.file, untracked = 'new-file.txt';
    // Worker edits one tracked file (uncommitted) and creates a new untracked file.
    await kit.ask(project.id, `MARK-J ${JSON.stringify({ role: 'worker', task: `${label} edit ${run([`echo 'WORKER-EDIT-${label}' >> ${file}`, `echo 'WORKER-NEW-${label}' > ${untracked}`, 'pwd'])}` })}`);
    const worker = (await kit.plan(project.id)).filter(work => work.role === 'worker').at(-1);
    check(`${label}: worker finished`, worker.status === 'completed', worker.status);

    // F1 reviewer given the worker's threadId sees the edit, the new file and the diff.
    const receipt = await delegate(project, { role: 'reviewer', threadId: worker.threadId, task: `${step('code_read', { path: file })} ${step('code_diff')} ${step('code_read', { path: untracked })}` }, `${label}-T1`);
    check(`${label}: delegate receipt names the target thread`, receipt.includes(worker.threadId), receipt);
    await kit.settle(project.id);
    const [content, diff, fresh] = reviewerOut(`${label}-T1`);
    check(`${label} F1: reviewer with threadId reads the worker's uncommitted edit`, content?.includes(`WORKER-EDIT-${label}`), content);
    check(`${label} F1/F10: code_diff shows the edit and the untracked new file with content`, diff?.includes(`+WORKER-EDIT-${label}`) && diff.includes(untracked) && diff.includes(`WORKER-NEW-${label}`), diff);
    check(`${label} F12: diff is against the merge-base (trunk-only commit is not shown as a change)`, !diff.includes('TRUNK-ONLY'), diff);
    check(`${label} F1: new file readable`, fresh?.includes(`WORKER-NEW-${label}`), fresh);
    const reviewerCall = kit.lastCall('reviewer', `${label}-T1`);
    check(`${label} F14: reviewer has code_diff and no write/edit/shell tool`, reviewerCall.tools.includes('code_diff') && !reviewerCall.tools.some(name => ['bash', 'write', 'edit', 'code_write', 'code_edit'].includes(name)), reviewerCall.tools);

    // F14 path escape stays refused, F8 option-like base rejected without side effects.
    await delegate(project, { role: 'reviewer', threadId: worker.threadId, task: `${step('code_read', { path: '../../../../etc/hosts' })} ${step('code_diff', { base: '--output=/tmp/pwned-review-target' })}` }, `${label}-T2`);
    const [escaped, badBase] = reviewerOut(`${label}-T2`);
    check(`${label} F14: path outside the worker root refused`, /outside this thread's code root/.test(escaped ?? ''), escaped);
    check(`${label} F8: option-like base refused, nothing written`, /Invalid base/.test(badBase ?? '') && !existsSync('/tmp/pwned-review-target'), badBase);

    // F2 unknown thread, F4/F5 conflicting params, F6 bad id: delegate fails, no work admitted.
    const work0 = (await kit.plan(project.id)).length;
    const unknown = await delegate(project, { role: 'reviewer', threadId: '00000000-0000-4000-8000-000000000000', task: 'x' }, `${label}-U`);
    check(`${label} F2: unknown threadId fails the call with a clear error`, /Unknown thread/.test(unknown), unknown);
    const both = await delegate(project, { role: 'reviewer', threadId: worker.threadId, ref: 'main', task: 'x' }, `${label}-B`);
    check(`${label} F4: threadId plus ref rejected`, /either threadId or ref/.test(both), both);
    const onWorker = await delegate(project, { role: 'worker', threadId: worker.threadId, task: 'x' }, `${label}-W`);
    check(`${label} F5: threadId on a worker delegation rejected`, /threadId is for scout and reviewer/.test(onWorker), onWorker);
    const badId = await delegate(project, { role: 'reviewer', threadId: '../../etc', task: 'x' }, `${label}-I`);
    check(`${label} F6: malformed threadId rejected by the schema`, /pattern|threadId/i.test(badId), badId);
    check(`${label}: none of the rejected delegations admitted work`, (await kit.plan(project.id)).length === work0, (await kit.plan(project.id)).length - work0);

    // F13 default reviewer: project checkout, unchanged; sees trunk, not the worker's edit; code_diff works there too.
    await delegate(project, { role: 'reviewer', task: `${step('code_read', { path: file })} ${step('code_diff')}` }, `${label}-D`);
    const [plain, plainDiff] = reviewerOut(`${label}-D`);
    check(`${label} F13: default reviewer reads the project checkout (no worker edit)`, plain && !plain.includes(`WORKER-EDIT-${label}`), plain);
    check(`${label} F13: default reviewer still has code_diff`, typeof plainDiff === 'string' && !/failed|Invalid/.test(plainDiff.slice(0, 80)), plainDiff);
  }

  // F7 refs. A local branch resolves, a bogus ref fails.
  const [git] = projects;
  await delegate(git, { role: 'reviewer', ref: 'feature-x', task: `${step('code_read', { path: 'feat.txt' })} ${step('code_diff', { base: 'main' })}` }, 'git-R1');
  const [featRead, featDiff] = reviewerOut('git-R1');
  check('git F7: reviewer with a ref sees that ref\'s content', featRead?.includes('FEATURE-ONLY'), featRead);
  check('git: code_diff on a ref snapshot shows its change against base', featDiff?.includes('+FEATURE-ONLY'), featDiff);
  const missing = await delegate(git, { role: 'reviewer', ref: 'nope/not-there', task: 'x' }, 'git-R2');
  check('git F7: unresolvable ref fails the delegation (no trunk fallback)', /not found/.test(missing), missing);

  // F9 cap: a huge uncommitted change is truncated with a note (git project reviewer on the worker worktree).
  await kit.ask(git.id, `MARK-J ${JSON.stringify({ role: 'worker', task: `big ${run(["yes 'BIG-LINE-0123456789012345678901234567890123456789' | head -n 12000 >> README.md"])}` })}`);
  const big = (await kit.plan(git.id)).filter(work => work.role === 'worker').at(-1);
  await delegate(git, { role: 'reviewer', threadId: big.threadId, task: step('code_diff') }, 'git-BIG');
  const bigText = fullResults.at(-1) ?? '';
  check('git F9: oversized diff (~590 KB) is capped under the harness 50 KB clip and ends with the truncation note', bigText.length > 40 * 1024 && bigText.length < 50 * 1024 && /\[diff truncated at 46 KB of \d+ KB/.test(bigText), bigText.length);

  // F15 worker children still inherit the parent worktree: covered by nested-subagents-e2e (run as regression).
});
