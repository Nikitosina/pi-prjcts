// E2E: Follow PRs, auto-fix and auto-merge for an Arc project (S4). Fake arc / arc-wt / arcanum / model. Failure cases: arc-follow-failures.md.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';
import { fakeArcadia, assertFakeOnly } from './lib/fake-arc-kit.mjs';

let verdict = 'approve';
const handler = ({ role, user, results, tools }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator') { const task = /MARK-W ([\s\S]+)$/.exec(user)?.[1]; return task && results.length === 0 ? call('projects_delegate', { role: 'worker', task }) : results.length ? say('Noted.') : undefined; }
  if (role === 'reviewer' && results.length === 0) { const match = /pullRequest: (\d+), headSha: "([0-9a-f]+)"/.exec(user); return match ? call('projects_review_verdict', { repository: 'arcadia', pullRequest: Number(match[1]), headSha: match[2], verdict, summary: 'Reviewed.' }) : undefined; }
  if (role !== 'worker') return undefined;
  const steps = [...user.matchAll(/RUN\[([^\]]*)\]RUN|PR\[([^\]]*)\]PR/g)], step = steps[results.length];
  if (!step) return undefined;
  if (step[1] !== undefined) return call('bash', { command: step[1] });
  const [title, body = ''] = step[2].split('|');
  return call(tools.find(name => /^projects_arc_.*_open_draft_pr$/.test(name)), { title, body });
};
const kit = await createKit('arc-follow', { handler, env: { PI_PROJECTS_FOLLOW_TICK_MS: '86400000' } });
const { check, rpc, result, root } = kit;
const fake = fakeArcadia(kit.root);
Object.assign(kit.hostEnv, fake.env);
kit.initRepo();
const store = () => JSON.parse(readFileSync(join(fake.dir, 'arcanum.json'), 'utf8'));
const patch = change => { const data = store(); change(data); writeFileSync(join(fake.dir, 'arcanum.json'), JSON.stringify(data)); };
const run = (...cmds) => cmds.map(cmd => `RUN[${cmd}]RUN`).join(' ');
const arcanumCalls = () => fake.calls().filter(item => item.tool === 'arcanum');
const mergeCalls = () => fake.calls().filter(item => item.tool === 'arc' && item.argv[0] === 'pr' && item.argv[1] === 'merge');
const events = () => result.calls.filter(item => item.role === 'coordinator' && /Arcadia activity \(Follow PRs\)/.test(item.user));

await kit.run(async () => {
  const id = await kit.createProject('YKKeyboard', { grant: false, cwd: fake.subdir });
  let snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'arc-quick-authorize', id, confirm: id, expectedRevision: snap.arcRevision });
  const dispatch = async task => { await kit.ask(id, `MARK-W ${task}`); return (await kit.plan(id)).filter(work => work.role === 'worker').at(-1); };
  const poll = async () => { const value = (await rpc({ action: 'follow-poll', id })).result; await delay(300); await kit.settle(id); return value; };
  const snapshot = () => rpc({ action: 'automation-snapshot', id });
  const w1 = await dispatch(`KEYBOARD-15934 follow one f1\n${run("echo 'let a = 1' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "a"')} PR[KEYBOARD-15934: a|A.]PR`);
  const pr1 = store().prs[0];
  // An owner PR the project did not open: must stay invisible.
  patch(data => { data.prs.push({ id: 900, summary: 'Owner PR', description: '', status: 'open', published: true, author: { name: 'owner', uid: 'owner' }, from_branch: 'users/owner/other', tickets: [], auto_merge: 'disabled', checks: { 9001: [{ system: 'ci', type: 'x', status: 'failure', required: true, satisfied: false }] }, comments: [{ content: 'foreign comment', author: 'x' }], approvedHead: null, diffSets: [{ id: 9001, head: 'f'.repeat(40), base: 'e'.repeat(40), merge: 'f'.repeat(40), published: true }] }); data.nextPr = 901; });
  await rpc({ action: 'automation-update', id, change: { follow: { enabled: true, autoFix: true, fixCap: 2 } } });

  const first = await poll();
  check('F2 the first poll baselines silently', first.events === 0 && events().length === 0, first);
  const calls0 = arcanumCalls().length;
  check('F1 only the project PRs are read (the owner PR id 900 never queried)', !arcanumCalls().some(item => item.argv.includes('900')), arcanumCalls().map(item => item.argv.join(' ')));

  // CI failure -> one event, one auto-fix to the opening thread.
  patch(data => { const pr = data.prs.find(item => item.id === pr1.id); pr.checks[pr.diffSets.at(-1).id] = [{ system: 'ci', type: 'build', status: 'failure', required: true, satisfied: false }]; });
  const failed = await poll();
  check('F3 a failing check yields one event naming the check', failed.events >= 1 && events().length === 1 && /CI failed/.test(events()[0].user) && /ci\/build/.test(events()[0].user), events().map(item => item.user));
  const fixes = (await kit.plan(id)).filter(work => work.text.includes('[Follow PRs auto-fix]'));
  check('F4 the fix went to the thread that opened the PR (follow-up), pointing at open_draft_pr, check data untrusted', fixes.length === 1 && fixes[0].threadId === w1.threadId && /open_draft_pr/.test(fixes[0].text) && /untrusted/.test(fixes[0].text), fixes.map(work => ({ thread: work.threadId, text: work.text.slice(0, 200) })));
  const again = await poll();
  check('F2/F4 an unchanged poll repeats nothing and does not fix again', again.events === 0 && (await kit.plan(id)).filter(work => work.text.includes('[Follow PRs auto-fix]')).length === 1);

  // Comments, once each; drafts ignored.
  patch(data => { const pr = data.prs.find(item => item.id === pr1.id); pr.comments.push({ id: 11, content: 'Please rename `a`', author: 'reviewer' }, { id: 12, content: 'draft only', author: 'reviewer', is_draft: true }); });
  await poll();
  const commentEvent = events().at(-1);
  check('F5 a new comment is one event, untrusted, drafts ignored', /Please rename/.test(commentEvent.user) && !/draft only/.test(commentEvent.user) && /untrusted/.test(commentEvent.user), commentEvent.user);
  const quiet = await poll();
  check('F2 the comment is not repeated', quiet.events === 0);

  // Rate limit: the poll fails whole, then each pending change arrives once.
  patch(data => { data.prs.find(item => item.id === pr1.id).comments.push({ id: 13, content: 'Second note after limit', author: 'reviewer' }); data.rateLimit = 1; });
  const limited = await rpc({ action: 'follow-poll', id }).then(() => null, error => error.message);
  check('F8 a rate-limited poll fails as a whole and says so', /rate|too many|RATE/i.test(limited ?? ''), limited);
  check('F8 the failure is visible (lastError)', /rate|too many|RATE/i.test((await snapshot()).follow.lastError ?? ''), (await snapshot()).follow);
  const eventsBefore = events().length;
  await poll();
  check('F8 the next poll delivers the change exactly once', events().length === eventsBefore + 1 && (events().at(-1).user.match(/Second note after limit/g) ?? []).length === 1);
  await poll();
  check('F8 and then nothing more', events().length === eventsBefore + 1);

  // Green CI, auto-merge.
  patch(data => { const pr = data.prs.find(item => item.id === pr1.id); pr.checks[pr.diffSets.at(-1).id] = [{ system: 'ci', type: 'build', status: 'success', required: true, satisfied: true }]; });
  await poll();
  check('F3 CI passing on the same head is news', /CI passed/.test(events().at(-1).user));
  const reviewers = async () => (await kit.plan(id)).filter(work => work.role === 'reviewer' && work.text.includes('[Auto-merge review]'));
  check('F6 auto-merge off: no reviewer, no merge', (await reviewers()).length === 0 && mergeCalls().length === 0);
  await rpc({ action: 'automation-update', id, change: { autoMerge: { enabled: true } } });
  await poll();
  const asked = await reviewers();
  const head1 = store().prs.find(item => item.id === pr1.id).diffSets.at(-1).head;
  check('F6/F9 one reviewer is asked for this head, with the diff and the Arc repository id', asked.length === 1 && asked[0].text.includes(head1) && /Keys\.swift/.test(asked[0].text) && /repository: "arcadia"/.test(asked[0].text), asked.map(work => work.text.slice(0, 300)));
  await poll();
  check('F6 approved but Arcanum requirements not met: no merge call, a note', mergeCalls().length === 0 && /merge requirements are not satisfied/.test(events().at(-1)?.user ?? ''), events().at(-1)?.user);
  patch(data => { data.prs.find(item => item.id === pr1.id).approvedHead = head1; });
  await poll();
  const merge = mergeCalls();
  check('F6 with every gate green: exactly one arc pr merge --now for the PR', merge.length === 1 && merge[0].argv.includes('--now') && merge[0].argv.includes(String(pr1.id)), merge.map(item => item.argv));
  check('F6 the PR merged and the event says so', store().prs.find(item => item.id === pr1.id).status === 'merged' && /auto-merged/.test(events().at(-1).user), events().at(-1).user);
  await poll();
  check('F6 no second merge', mergeCalls().length === 1);

  // Head moved after approval.
  const w2 = await dispatch(`KEYBOARD-15935 follow two f2\n${run("echo 'let b = 2' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "b"')} PR[KEYBOARD-15935: b|B.]PR`);
  const pr2 = store().prs.find(item => item.summary.startsWith('KEYBOARD-15935'));
  patch(data => { const pr = data.prs.find(item => item.id === pr2.id); pr.checks[pr.diffSets.at(-1).id] = [{ system: 'ci', type: 'build', status: 'success', required: true, satisfied: true }]; });
  await poll(); // baselines the new PR as opened; CI passed at head 1 -> reviewer
  await poll();
  const head2a = store().prs.find(item => item.id === pr2.id).diffSets.at(-1).head;
  patch(data => { const pr = data.prs.find(item => item.id === pr2.id); pr.approvedHead = head2a; });
  await kit.eventually(async () => (await reviewers()).some(work => work.text.includes(head2a)), 'reviewer for PR 2 head 1', 100);
  const mergesBefore = mergeCalls().length;
  // A push lands before the next poll: new diff-set, green, but not reviewed.
  patch(data => { const pr = data.prs.find(item => item.id === pr2.id), diff = { id: data.nextDiff++, head: 'c'.repeat(40), base: pr.diffSets[0].base, merge: 'c'.repeat(40), published: false }; pr.diffSets.push(diff); pr.checks[diff.id] = [{ system: 'ci', type: 'build', status: 'success', required: true, satisfied: true }]; });
  await poll();
  check('F7 a moved head is not merged on the old approval', mergeCalls().length === mergesBefore && store().prs.find(item => item.id === pr2.id).status !== 'merged', mergeCalls().length);
  await poll();
  check('F7 a new reviewer is asked for the new head', (await reviewers()).some(work => work.text.includes('c'.repeat(40))));
  check('F1 the owner PR produced no event, fix, reviewer or merge', !events().some(item => /Owner PR|foreign comment|#900/.test(item.user)) && !mergeCalls().some(item => item.argv.includes('900')));
  assertFakeOnly(fake, root, check);
});
