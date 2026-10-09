// E2E: draft PRs of an Arc project through the host (S3). Fake arc / arc-wt / arcanum / model, private HOME. Failure cases: arc-pr-failures.md.
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';
import { fakeArcadia, assertFakeOnly } from './lib/fake-arc-kit.mjs';

// Worker steps in order of appearance: RUN[cmd]RUN (bash), PR[title|body|publish]PR (open_draft_pr, `~` = line break), STATUS (pr_status).
const handler = ({ role, user, results, tools }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator') { const task = /MARK-W ([\s\S]+)$/.exec(user)?.[1]; return task && results.length === 0 ? call('projects_delegate', { role: 'worker', task }) : results.length ? say('Noted.') : undefined; }
  if (role !== 'worker') return undefined;
  const steps = [...user.matchAll(/RUN\[([^\]]*)\]RUN|PR\[([^\]]*)\]PR|(STATUS)/g)];
  const step = steps[results.length];
  if (!step) return undefined;
  if (step[1] !== undefined) return call('bash', { command: step[1] });
  if (step[3]) return call(tools.find(name => /^projects_arc_.*_pr_status$/.test(name)), {});
  const [title, body = '', publish] = step[2].split('|');
  return call(tools.find(name => /^projects_arc_.*_open_draft_pr$/.test(name)), { title, body: body.replaceAll('~', '\n'), ...(publish === 'publish' ? { publish: true } : {}) });
};
const kit = await createKit('arc-pr', { handler });
const { check, rpc, result, root } = kit;
const fake = fakeArcadia(kit.root);
Object.assign(kit.hostEnv, fake.env);
kit.initRepo();
const wtBase = realpathSync(fake.wtBase);
const run = (...cmds) => cmds.map(cmd => `RUN[${cmd}]RUN`).join(' ');
const store = () => JSON.parse(readFileSync(join(fake.dir, 'arcanum.json'), 'utf8'));
const patchStore = change => { const data = store(); change(data); writeFileSync(join(fake.dir, 'arcanum.json'), JSON.stringify(data)); };
const patchState = change => { const path = join(fake.dir, 'state.json'), data = JSON.parse(readFileSync(path, 'utf8')); change(data); writeFileSync(path, JSON.stringify(data)); };
const arcCalls = () => fake.calls().filter(item => item.tool === 'arc').map(item => item.argv);
const createCalls = () => arcCalls().filter(argv => argv[0] === 'pr' && argv[1] === 'create');

await kit.run(async () => {
  const id = await kit.createProject('YKKeyboard', { grant: false, cwd: fake.subdir });
  let snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'arc-quick-authorize', id, confirm: id, expectedRevision: snap.arcRevision });
  const dispatch = async task => { await kit.ask(id, `MARK-W ${task}`); return (await kit.plan(id)).at(-1); };
  const lastResults = marker => kit.lastCall('worker', marker).results;
  const followUp = async (threadId, text) => { await rpc({ action: 'thread-send', id, threadId, text, requestId: randomUUID() }); await delay(300); await kit.settle(id); };
  const receipts = async () => (await rpc({ action: 'arc-write-snapshot', id })).items;

  // P1: ticket branch, curated multi-line body, draft.
  const w1 = await dispatch(`KEYBOARD-15934 keys fix p1\n${run("echo 'let z = 3' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "KEYBOARD-15934: z"')} PR[KEYBOARD-15934: add z|Adds z.~~Second paragraph.]PR`);
  const name1 = 'KEYBOARD-15934-keys-fix-p1';
  const tools1 = kit.lastCall('worker', 'keys fix p1').tools;
  check('F10 the worker is offered the Arc PR tools (open_draft_pr, pr_status)', tools1.some(name => /^projects_arc_.*_open_draft_pr$/.test(name)) && tools1.some(name => /^projects_arc_.*_pr_status$/.test(name)), tools1);
  const prs1 = store().prs;
  check('F2/F5 exactly one draft PR from users/<login>/<branch> by the Arc login', prs1.length === 1 && prs1[0].status === 'draft' && prs1[0].published === false && prs1[0].from_branch === `users/${fake.login}/${name1}` && prs1[0].author.name === fake.login, prs1);
  const create = createCalls()[0];
  check('F2/F3/F4 arc pr create ran once: --publish=disabled --no-commits -F, no -m, no separate arc push', createCalls().length === 1 && create.includes('--publish=disabled') && create.includes('--no-commits') && create.includes('-F') && !create.includes('-m') && !arcCalls().some(argv => argv[0] === 'push'), arcCalls());
  check('F3 title is the first line, body keeps its real line breaks', prs1[0].summary === 'KEYBOARD-15934: add z' && /Adds z\.\n\nSecond paragraph\./.test(prs1[0].description), prs1[0]);
  check('F9 the ticket in the branch is linked, nothing else touched', JSON.stringify(prs1[0].tickets) === '["KEYBOARD-15934"]' && !fake.calls().some(item => item.tool === 'arcanum' && /status|transition/.test(item.argv.join(' '))), prs1[0].tickets);
  let rows = await receipts();
  check('F5 the receipt is done and verified, with the PR number and ticket link', rows.length === 1 && rows[0].state === 'done' && rows[0].verified === true && rows[0].pullRequest === prs1[0].id && rows[0].ticketLinked === true && rows[0].branch === name1, rows);
  const files = readdirSync(join(kit.home, id, 'arc-pr'));
  check('F3 the message file with real line breaks sits in the project home, outside the worktree', files.length === 1 && /\n\n/.test(readFileSync(join(kit.home, id, 'arc-pr', files[0]), 'utf8')), files);

  // P2: second call after a new commit updates the same PR.
  await followUp(w1.threadId, `follow p2\n${run("echo 'let y = 4' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "KEYBOARD-15934: y"')} PR[KEYBOARD-15934: add z and y|Adds y too.]PR`);
  const head2 = fake.git(join(wtBase, name1), 'rev-parse', 'HEAD'), after2 = store();
  check('F7 a second call updates the same PR (no second create), pushes and re-verifies at the new head', after2.prs.length === 1 && createCalls().length === 1 && after2.prs[0].diffSets.length === 2 && after2.prs[0].diffSets.at(-1).head === head2, after2.prs[0].diffSets);
  check('F7 the update result says updated', /"updated":true/.test(lastResults('follow p2').at(-1)), lastResults('follow p2').at(-1));

  // P3: uncommitted changes are refused.
  await followUp(w1.threadId, `follow p3\n${run("echo 'let x = 5' >> Sources/Keys.swift")} PR[t|b]PR`);
  check('F6 uncommitted changes are refused and nothing is created or pushed', /uncommitted changes/.test(lastResults('follow p3').at(-1)) && store().prs[0].diffSets.length === 2, lastResults('follow p3').at(-1));
  await followUp(w1.threadId, `follow p3b\n${run('arc checkout -- Sources/Keys.swift')}`);

  // P4: publish on request; no ticket -> no link.
  const w4 = await dispatch(`polish p4\n${run("echo 'let p = 1' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "polish"')} PR[Polish keys|Polishes.|publish]PR`);
  const pr4 = store().prs.find(item => item.from_branch.includes('polish-p4'));
  const create4 = createCalls().at(-1);
  check('F2 publish: true opens a published PR with a bare --publish', pr4 && pr4.published === true && pr4.status === 'open' && create4.includes('--publish') && !create4.includes('--publish=disabled'), create4);
  check('F9 without a ticket nothing is linked', pr4.tickets.length === 0 && (await receipts()).at(-1).ticketLinked === false);

  // P5: verification failure is not a verified receipt, and says why; a retry re-verifies without a second PR.
  patchStore(data => { data.failPaths = ['active-diff']; });
  await dispatch(`KEYBOARD-777 unverified p5\n${run("echo 'let q = 1' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "q"')} PR[q|q]PR`);
  rows = await receipts();
  const bad = rows.find(row => row.branch.includes('unverified-p5'));
  check('F5 a failed verification leaves a done but unverified receipt and a clear error', bad.state === 'done' && bad.verified === false && /not recorded as verified|backend unavailable|failed/.test(lastResults('unverified p5').at(-1)), { bad, result: lastResults('unverified p5').at(-1) });
  const w5 = (await kit.plan(id)).at(-1);
  patchStore(data => { data.failPaths = []; });
  await followUp(w5.threadId, `follow p5b\nPR[q|q]PR`);
  rows = await receipts();
  check('F5/F7 the retry re-verifies the same PR (verified now, still one PR for the branch)', rows.find(row => row.branch.includes('unverified-p5')).verified === true && store().prs.filter(item => item.from_branch.includes('unverified-p5')).length === 1);

  // P6: uncertain create.
  patchState(data => { data.prCreateBroken = true; });
  const before = store().prs.length;
  const w6 = await dispatch(`KEYBOARD-888 uncertain p6\n${run("echo 'let u = 1' >> Sources/Keys.swift", 'arc add Sources/Keys.swift', 'arc commit -m "u"')} PR[u|u]PR`);
  patchState(data => { data.prCreateBroken = false; });
  rows = await receipts();
  const uncertain = rows.find(row => row.branch.includes('uncertain-p6'));
  check('F8 a failed arc pr create leaves an uncertain receipt and no PR', uncertain?.state === 'uncertain' && store().prs.length === before, uncertain);
  await followUp(w6.threadId, `follow p6b\nPR[u|u]PR`);
  check('F8 a retry never repeats the create: it reports the uncertainty', /uncertain/.test(lastResults('follow p6b').at(-1)) && store().prs.length === before, lastResults('follow p6b').at(-1));
  const schedule = await rpc({ action: 'schedules', id }).catch(() => null);
  result.scheduleBlocker = schedule?.automaticAdmissionBlocker ?? null;

  // P7: pr_status, after a restart.
  patchStore(data => { const pr = data.prs[0], diff = pr.diffSets.at(-1); pr.checks[diff.id] = [{ system: 'ci', type: 'build', status: 'success', required: true, satisfied: true }, { system: 'ci', type: 'lint', status: 'pending', required: false, satisfied: false }]; pr.comments = [{ content: 'Please rename', author: 'reviewer' }]; });
  await kit.restartHost();
  await followUp(w1.threadId, `follow p7\nSTATUS`);
  const status = JSON.parse(lastResults('follow p7').at(-1));
  check('F11/F12 after a restart pr_status reports checks, merge readiness and comments (read-only)', status.pullRequest === store().prs[0].id && status.checks.length === 2 && status.comments === 1 && status.mergeAllowed === false, status);
  const mutations = fake.calls().filter(item => item.tool === 'arcanum' && /auto-merge|link-tickets|update-/.test(item.argv.join(' ')) && item.at > 0).length;
  check('F11 pr_status performed no write', fake.calls().filter(item => item.tool === 'arcanum').slice(-6).every(item => !/link-tickets|auto-merge/.test(item.argv.join(' '))), mutations);
  check('F10 GitHub tools are absent for an Arc project', !kit.lastCall('worker', 'follow p7').tools.some(name => /projects_github_/.test(name)));
  assertFakeOnly(fake, root, check);
});
