// Browser E2E: the legacy (non-Durable) runtime is gone. A Durable project still works end to end in the browser
// (message, delegation, worker report, question + answer); a legacy project record is refused clearly and left untouched.
// Isolated host, local fake model, headless Chrome. Failure cases: scripts/legacy-removal-failures.md.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, randomUUID } from './notify-kit.mjs';

const respond = ({ coordinator, marker, results, call, say }) => {
  if (coordinator && marker === 'MARK-WORK') return results.length === 0 ? call('projects_delegate', { role: 'worker', task: 'MARK-WJOB write the release note' }) : say('Delegated MARK-WJOB.');
  return undefined;
};
const k = await kit('legacy-removal', {}, respond);
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, home } = k;
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const refused = async (input, pattern) => { try { await rpc(input); return null; } catch (error) { return pattern.test(error.message) ? error.message : `wrong error: ${error.message}`; } };
const tree = dir => readdirSync(dir, { recursive: true }).sort().map(name => { const path = join(dir, name); return statSync(path).isFile() ? `${name}:${createHash('sha256').update(readFileSync(path)).digest('hex')}` : `${name}/`; });

// A record written by the removed legacy runtime: no `runtime`, a pi session file, one run and its review decision.
const legacyId = randomUUID(), runId = randomUUID(), legacyDir = join(home, legacyId);
mkdirSync(join(legacyDir, 'decisions'), { recursive: true, mode: 0o700 });
writeFileSync(join(legacyDir, 'project.json'), JSON.stringify({ version: 1, id: legacyId, name: 'Old legacy project', cwd: k.workspace, objective: 'pi-subagents era', createdAt: '2026-09-01T10:00:00.000Z', model: 'fake/fake-model', models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' }, sessionFile: join(legacyDir, 'session.jsonl'), phase: 'ready', problem: null, runs: [{ id: runId, role: 'worker', dir: k.workspace, task: 'old task', createdAt: '2026-09-01T10:01:00.000Z', receipt: null }] }, null, 2) + '\n');
writeFileSync(join(legacyDir, 'decisions', `${runId}.json`), JSON.stringify({ kind: 'review', id: runId, at: '2026-09-01T10:05:00.000Z', title: 'old task', run: runId, outcome: 'done', result: null }) + '\n');
const legacyBefore = tree(legacyDir);

try {
  await k.startHost();
  const id = await k.setup('Durable fixture');
  check('L1/L2 host starts and lists only the Durable project despite a legacy record', (await rpc({ action: 'list' })).map(p => p.id).join() === id);
  const log = await eventually(() => { const text = readFileSync(k.logs[0], 'utf8'); return text.includes('legacy-project-refused') && text; }, 'host never logged the refusal');
  check('L6 host logs the refused legacy record once at start', log.split('\n').filter(line => line.includes('legacy-project-refused') && line.includes(legacyId)).length === 1);

  const message = /Old legacy project.*removed legacy runtime/;
  for (const input of [{ action: 'show', id: legacyId }, { action: 'message', id: legacyId, text: 'hello' }, { action: 'settings-snapshot', id: legacyId }, { action: 'plan-snapshot', id: legacyId }, { action: 'knowledge-list', id: legacyId }]) {
    const error = await refused(input, message);
    check(`L3 ${input.action} on the legacy id is refused with the removed-runtime message`, error && !error.startsWith('wrong'), error);
  }
  result.refusal = await refused({ action: 'show', id: legacyId }, message);

  for (const input of [{ action: 'delegate', id, role: 'worker', task: 'x' }, { action: 'workers', id }, { action: 'control', id, run: 'x', operation: 'stop' }, { action: 'review', id, entry: randomUUID(), operation: 'accept' }]) {
    const error = await refused(input, /Invalid data/);
    check(`L9 removed RPC action ${input.action} is rejected by the request schema`, error && !error.startsWith('wrong'), error);
  }
  const cli = args => spawnSync(process.execPath, ['src/cli.ts', '--no-start', ...args], { cwd: k.repo, encoding: 'utf8', env: { ...process.env, PI_PROJECTS_HOME: home, HOME: join(k.root, 'userhome') } });
  for (const args of [['copy-root-init', join(k.root, 'copy-root')], ['delegate', id, 'worker', 'task'], ['workers', id], ['steer', id, 'run', 'text'], ['stop', id, 'run']]) {
    const out = cli(args);
    check(`L10 removed CLI command ${args[0]} prints the usage line and exits 1`, out.status === 1 && /^Usage: projects/.test(out.stderr) && !/\n\s+at /.test(out.stderr), { status: out.status, stderr: out.stderr.slice(0, 400) });
  }

  // A Durable project that still carries an old review decision file opens and ignores it.
  const durableReview = randomUUID();
  mkdirSync(join(home, id, 'decisions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, id, 'decisions', `${durableReview}.json`), JSON.stringify({ kind: 'review', id: durableReview, at: '2026-09-01T10:05:00.000Z', title: 'stale review', run: durableReview, outcome: 'done', result: null }) + '\n');
  const opened = await rpc({ action: 'show', id });
  check('L11 an old review decision file is ignored, not fatal', opened.inbox.length === 0);
  check('L12 snapshot drops legacy run fields and keeps the Durable ones', !('activeRuns' in opened) && !('runStates' in opened) && ['inbox', 'notes', 'evidence', 'jobs', 'chats'].every(key => key in opened) && opened.project.runtime === 'durable', Object.keys(opened));

  // Durable end to end in the browser: message → delegation → worker report → reply; question → answer.
  const web = await rpc({ action: 'web' }), url = new URL(web.url);
  url.searchParams.set('project', id);
  const s = await openPage(url.toString());
  await waitFor(`document.querySelector('#title')?.innerText === 'Durable fixture'`, s, 'project opened');
  const send = async text => evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#compose').requestSubmit(); })()`, s);
  await send('MARK-HELLO are you there?');
  await waitFor(`document.querySelector('#messages').innerText.includes('Done MARK-HELLO.')`, s, 'coordinator reply');
  check('L19 browser message reaches the Durable coordinator and its reply renders', true);
  await send('MARK-WORK ship the release note');
  await waitFor(`document.querySelector('#messages').innerText.includes('Delegated MARK-WJOB.')`, s, 'delegation reply');
  const plan = await eventually(async () => { const p = await rpc({ action: 'plan-snapshot', id }); return p.work.length === 1 && p.work[0].status === 'completed' && p; }, 'worker never completed');
  const history = await rpc({ action: 'thread-history', id, threadId: plan.work[0].threadId });
  check('L20 the delegated worker ran on the Durable runtime and returned its report', JSON.stringify(history).includes('Worker MARK-WJOB'), JSON.stringify(history).slice(0, 600));
  await eventually(async () => result.calls.some(c => c.coordinator && /Worker MARK-WJOB/.test(c.user)), 'worker report never woke the coordinator');
  check('L20 the worker report woke the coordinator', true);
  await evaluate(`document.querySelector('[data-tab="activity"]').click()`, s);
  await waitFor(`document.querySelector('#work-list').innerText.includes('MARK-WJOB')`, s, 'activity lists the worker');
  await shot('01-activity-worker', s);
  await evaluate(`document.querySelector('[data-tab="coordinator"]').click()`, s);
  await send('MARK-ASK pick one');
  await waitFor(`!!document.querySelector('#questions [data-action="answer"][data-choice-text="blue"]')`, s, 'question card');
  await shot('02-question', s);
  await evaluate(`document.querySelector('#questions [data-action="answer"][data-choice-text="blue"]').click()`, s);
  await waitFor(`document.querySelector('#messages').innerText.includes('ANSWER-ACK blue')`, s, 'answer acknowledged');
  check('L21 answering a coordinator question in the browser wakes the coordinator', true);
  await shot('03-durable-chat', s);

  // The legacy id in the URL: say why, then fall back to a listed project.
  const legacyUrl = new URL(web.url); legacyUrl.searchParams.set('project', legacyId);
  const l = await openPage(legacyUrl.toString());
  await waitFor(`!document.querySelector('#error').hidden && document.querySelector('#error').innerText.includes('removed legacy runtime')`, l, 'refusal banner');
  await waitFor(`document.querySelector('#title')?.innerText === 'Durable fixture'`, l, 'fallback to the Durable project');
  check('L5 a legacy id in the URL shows the refusal and opens a listed project instead', !(await evaluate(`[...document.querySelectorAll('#projects option')].some(o => o.value === ${JSON.stringify(legacyId)})`, l)));
  result.banner = await evaluate(`document.querySelector('#error').innerText`, l);
  await shot('04-legacy-refused', l);

  check('L4 the legacy record is byte-for-byte untouched (no seeded knowledge, inbox or notes)', JSON.stringify(tree(legacyDir)) === JSON.stringify(legacyBefore), { before: legacyBefore, after: tree(legacyDir) });
  await k.stopHost(); await k.startHost();
  check('L2 a restarted host restores the Durable project next to the legacy record', (await rpc({ action: 'show', id })).messages.some(m => m.text.includes('ANSWER-ACK blue')));
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = error.stack ?? String(error);
}
await k.finish(result.status);
