// Direct tool calls, no host: default responses stay within 8 KiB and explicit arguments still reach everything.
// Failure modes: context-bounds-failures.md. Run: node scripts/context-bounds-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOnlyCodeTools } from '../src/durable-code-tools.ts';
import { coordinatorWorkerTools } from '../src/durable-worker-tools.ts';
import { workerChanges } from '../src/code-diff.ts';
import { fitJson } from '../src/response-limit.ts';

const LIMIT = 8192, bytes = text => Buffer.byteLength(text), checks = [];
const check = (name, ok, detail) => { checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) { process.exitCode = 1; console.error('FAIL', name, typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail)?.slice(0, 300)); } };
const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-bounds-')));
const git = (...args) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const numbered = (prefix, count, pad = 40) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')} ${'x'.repeat(pad)}`).join('\n') + '\n';
git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E');
writeFileSync(join(root, 'big.txt'), numbered('L', 5000));
writeFileSync(join(root, 'grep.txt'), Array.from({ length: 3000 }, (_, i) => `needle line ${i} ${'y'.repeat(120)}`).join('\n') + '\n');
writeFileSync(join(root, 'wide.txt'), 'é'.repeat(20000) + '\n' + numbered('W', 50));
mkdirSync(join(root, 'many')); for (let i = 0; i < 1500; i++) writeFileSync(join(root, 'many', `file-with-a-reasonably-long-name-${String(i).padStart(4, '0')}.txt`), 'x');
writeFileSync(join(root, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(root, 'd1.txt'), numbered('A', 600)); writeFileSync(join(root, 'd2.txt'), numbered('B', 600));
git('add', '.'); git('commit', '-q', '-m', 'base');
writeFileSync(join(root, 'd1.txt'), numbered('a', 600)); writeFileSync(join(root, 'd2.txt'), numbered('b', 600));

const { tools } = readOnlyCodeTools(root), code = Object.fromEntries(tools.map(tool => [tool.name, tool]));
const api = { callId: 'check', output() {}, conversationId: 1 }, context = { abortSignal: undefined };
const run = async (name, args) => (await code[name].execute(args, api, context)).content;
const textOf = content => content.filter(block => block.type === 'text').map(block => block.text).join('');
const call = async (name, args) => textOf(await run(name, args));

// C1 grep
const grep = await call('code_grep', { pattern: 'needle' });
check('C1 code_grep default is at most 8 KiB and says how to get more', bytes(grep) <= LIMIT && /limit|path|glob|pattern/.test(grep.slice(-300)) && grep.startsWith('grep.txt:1:'), { size: bytes(grep), tail: grep.slice(-200) });
const grepMore = await call('code_grep', { pattern: 'needle', limit: 150 });
check('C6a an explicit grep limit is not clipped by the default budget', bytes(grepMore) > LIMIT && grepMore.includes('needle line 149'), bytes(grepMore));
// C2 read paging: every line exactly once
const seen = []; let offset, guard = 0;
for (;;) {
  const page = await call('code_read', offset ? { path: 'big.txt', offset } : { path: 'big.txt' });
  check(`C2 code_read page ${guard} is at most 8 KiB`, bytes(page) <= LIMIT, bytes(page));
  seen.push(...page.split('\n').filter(line => /^L\d{4} /.test(line)).map(line => line.slice(0, 5)));
  const next = /offset=(\d+)/.exec(page.slice(-250))?.[1];
  if (!next || ++guard > 60) break;
  offset = Number(next);
}
check('C2 paging by the offset in each note visits all 5000 lines once, in order', seen.length === 5000 && seen.every((tag, i) => tag === `L${String(i + 1).padStart(4, '0')}`), { count: seen.length, first: seen[0], last: seen.at(-1), pages: guard });
const ranged = await call('code_read', { path: 'big.txt', offset: 100, limit: 3 });
check('C6b an explicit read range returns exactly those lines', ranged.startsWith('L0100 ') && ranged.includes('L0102 ') && !ranged.includes('L0103 '), ranged.slice(0, 120));
const wide = await call('code_read', { path: 'wide.txt' });
check('C4 a clip keeps UTF-8 whole (no replacement character) and stays within 8 KiB', bytes(wide) <= LIMIT && !wide.includes('\uFFFD'), { size: bytes(wide) });
// C3 find, ls
const found = await call('code_find', { pattern: '*.txt' }), listed = await call('code_ls', { path: 'many' });
check('C3 code_find default is at most 8 KiB with a hint', bytes(found) <= LIMIT && /limit|narrow|refine|pattern|path/.test(found.slice(-300)), { size: bytes(found), tail: found.slice(-160) });
check('C3 code_ls default is at most 8 KiB with a hint', bytes(listed) <= LIMIT && /limit|narrow|refine|path/.test(listed.slice(-300)), { size: bytes(listed), tail: listed.slice(-160) });
// C5 image
const image = await run('code_read', { path: 'pixel.png' });
check('C5 an image read still returns its image block', image.some(block => block.type === 'image') && bytes(textOf(image)) < 2000, image.map(block => block.type));
// C7/C8 diff
const expected = git('diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--');
check('fixture: the working diff is well above one page', expected.length > 3 * LIMIT, expected.length);
const first = await call('code_diff', {});
check('C7 code_diff default is at most 8 KiB, lists changed files and gives the continuation offset', bytes(first) <= LIMIT && /d1\.txt/.test(first) && /d2\.txt/.test(first) && /offset=\d+/.test(first.slice(-250)), { size: bytes(first), tail: first.slice(-200) });
let rebuilt = '', diffOffset = 0, pages = 0;
for (;;) {
  const page = pages === 0 ? first : await call('code_diff', { offset: diffOffset });
  const note = /\n\[diff chars (\d+)-(\d+) of (\d+); continue with offset=(\d+)[^\]]*\]\s*$/.exec(page) ?? /\n\[diff chars (\d+)-(\d+) of (\d+)[^\]]*\]\s*$/.exec(page);
  if (!note) { check('C7 every diff page ends with a position note', false, page.slice(-200)); break; }
  const body = pages === 0 ? page.slice(page.indexOf('\n\n', page.indexOf('Changed files:')) + 2, note.index) : page.slice(0, note.index);
  rebuilt += body;
  if (bytes(page) > LIMIT) check('C7 each diff page is at most 8 KiB', false, bytes(page));
  if (!note[4] || ++pages > 40) break;
  diffOffset = Number(note[4]);
}
check('C7 paging by offset rebuilds the exact git diff text', rebuilt === expected, { rebuilt: rebuilt.length, expected: expected.length, pages });
const one = await call('code_diff', { path: 'd2.txt' });
check('C7 code_diff path returns only that file, fully when it fits', /^diff --git a\/d2\.txt/m.test(one) && !/diff --git a\/d1\.txt/.test(one) && bytes(one) <= LIMIT, { size: bytes(one), head: one.slice(0, 200) });
for (const bad of ['../x', '/etc/passwd', '--output=/tmp/x', 'a/../../b']) {
  const refused = await code.code_diff.execute({ path: bad }, api, context).then(() => false, error => /path/i.test(error.message));
  check(`C8 code_diff refuses path ${bad}`, refused);
}
// C9 worker_diff pages like code_diff
const workerRuntime = { workerDiff: (_id, base, page) => workerChanges(root, base, page) };
const diffTool = coordinatorWorkerTools({ root: () => ({}), runtime: () => workerRuntime, isCoordinator: () => true }).tools.find(tool => tool.name === 'projects_worker_diff');
const workerPage = async offset => textOf((await diffTool.execute(offset ? { threadId: '00000000-0000-4000-8000-000000000001', offset } : { threadId: '00000000-0000-4000-8000-000000000001' }, api, context)).content);
const workerFirst = await workerPage(0);
check('C9 projects_worker_diff default is at most 8 KiB, leads with branch/status and ends with a continuation offset', bytes(workerFirst) <= LIMIT && /^Worktree /.test(workerFirst) && /offset=\d+/.test(workerFirst.slice(-250)), { size: bytes(workerFirst), tail: workerFirst.slice(-200) });
{
  let rebuiltWorker = '', next = 0, n = 0, page = workerFirst;
  for (;;) {
    const note = /\n\[diff chars (\d+)-(\d+) of (\d+)(?:; continue with offset=(\d+))?[^\]]*\]\s*$/.exec(page);
    if (!note) break;
    rebuiltWorker += n === 0 ? page.slice(page.indexOf('\n\n', page.indexOf('Changed files:')) + 2, note.index) : page.slice(0, note.index);
    if (!note[4] || ++n > 40) break;
    next = Number(note[4]); page = await workerPage(next);
    if (bytes(page) > LIMIT) { check('C9 each worker-diff page is at most 8 KiB', false, bytes(page)); break; }
  }
  check('C9 worker-diff pages rebuild the exact git diff text', rebuiltWorker === expected, { rebuilt: rebuiltWorker.length, expected: expected.length, pages: n });
}
// C10 worker list and read
const rows = Array.from({ length: 40 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, threadId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, role: 'worker', text: `task ${i} ${'t'.repeat(300)}`, dependsOn: [], priority: 0, status: 'running', blocker: 'b'.repeat(400), workspaceScopeId: null, model: 'fake/fake-model', toolNames: Array.from({ length: 20 }, (_, n) => `tool_${n}`), startedAt: 1, endedAt: null, archived: false, parentThreadId: null, report: null, workId: `w${i}`, }));
const snapshot = { projectId: 'p', paused: false, pausing: false, workerCap: 5, work: rows, threads: [], offset: 0, total: 40, nextOffset: null, observedAtMs: 1 };
const history = { items: Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', text: `m${i} ${'h'.repeat(4000)}` })), offset: 0, limit: 30, textLimit: 4000, total: 30, nextOffset: null };
const runtime = { workerSnapshot: async page => ({ ...snapshot, work: rows.slice(page?.offset ?? 0, (page?.offset ?? 0) + (page?.limit ?? 30)), offset: page?.offset ?? 0, total: 40, nextOffset: (page?.offset ?? 0) + (page?.limit ?? 30) < 40 ? (page?.offset ?? 0) + (page?.limit ?? 30) : null }), workerRead: async (_id, options) => { const offset = options?.offset ?? 0, limit = options?.limit ?? 30, textLimit = options?.textLimit ?? 4000, items = history.items.slice(offset, offset + limit).map(item => ({ ...item, text: item.text.slice(0, textLimit) })); return { ...history, items, offset, limit, textLimit, nextOffset: offset + items.length < 30 ? offset + items.length : null }; }, plan: async () => {}, planSnapshot: async () => ({ work: [] }) };
const workerTools = Object.fromEntries(coordinatorWorkerTools({ root: () => ({}), runtime: () => runtime, isCoordinator: () => true }).tools.map(tool => [tool.name, tool]));
const asJson = async (name, args) => { const text = textOf((await workerTools[name].execute(args, api, context)).content); return { text, value: JSON.parse(text) }; };
const listed40 = await asJson('projects_workers', {});
check('C10 projects_workers default is valid JSON of at most 8 KiB and nextOffset counts only the rows kept', bytes(listed40.text) <= LIMIT && listed40.value.work.length >= 1 && listed40.value.nextOffset === listed40.value.work.length, { size: bytes(listed40.text), rows: listed40.value.work?.length, next: listed40.value.nextOffset });
const read30 = await asJson('projects_worker_read', { threadId: '10000000-0000-4000-8000-000000000001' });
check('C10 projects_worker_read default is valid JSON of at most 8 KiB and nextOffset counts only the items kept', bytes(read30.text) <= LIMIT && read30.value.items.length >= 1 && read30.value.nextOffset === read30.value.items.length, { size: bytes(read30.text), items: read30.value.items?.length, next: read30.value.nextOffset });
const readBig = await asJson('projects_worker_read', { threadId: '10000000-0000-4000-8000-000000000001', limit: 10, textLimit: 4000 });
check('C6c explicit read limits still return 10 full messages', readBig.value.items.length === 10 && readBig.value.items[0].text.length >= 4000 && bytes(readBig.text) > LIMIT, readBig.value.items.length);
const receipt = await asJson('projects_worker_plan', { work: rows.slice(0, 3).map(({ id, threadId, role, text }) => ({ id, threadId, role, text })) });
check('C11 projects_worker_plan returns a receipt of what was admitted, not the worker snapshot', bytes(receipt.text) < 2000 && receipt.value.admitted?.length === 3 && !('toolNames' in receipt.value) && !receipt.text.includes('tool_1'), receipt.text.slice(0, 300));
// C12 a lone row larger than the budget
const huge = { index: 0, text: 'é'.repeat(1000), args: 'x'.repeat(20000) };
const loneRow = fitJson(1, kept => ({ items: [huge].slice(0, kept), nextOffset: null }), { fallback: () => ({ items: [{ omitted: true, index: 0, note: 'row exceeds 8 KiB; read it with an explicit limit' }], nextOffset: 1 }) });
check('C12 fitJson with one oversized row returns the metadata-only fallback within 8 KiB and advances nextOffset', bytes(loneRow) <= LIMIT && JSON.parse(loneRow).items?.[0]?.omitted === true && JSON.parse(loneRow).nextOffset === 1, bytes(loneRow));
const hugeHistory = { items: [{ role: 'assistant', text: 'ok', calls: 'c'.repeat(30000) }, { role: 'assistant', text: 'second' }], offset: 0, limit: 8, textLimit: 700, total: 2, nextOffset: null };
const hugeRead = Object.fromEntries(coordinatorWorkerTools({ root: () => ({}), runtime: () => ({ workerRead: async (_id, options) => ({ ...hugeHistory, offset: options?.offset ?? 0, items: hugeHistory.items.slice(options?.offset ?? 0) }) }), isCoordinator: () => true }).tools.map(tool => [tool.name, tool])).projects_worker_read;
const hugeText = textOf((await hugeRead.execute({ threadId: '10000000-0000-4000-8000-000000000001' }, api, context)).content);
let hugeJson; try { hugeJson = JSON.parse(hugeText); } catch {}
check('C12 projects_worker_read: a first message larger than 8 KiB is replaced by a small row and nextOffset moves past it', bytes(hugeText) <= LIMIT && hugeJson?.items?.length >= 1 && hugeJson.nextOffset === 1, { size: bytes(hugeText) });
// C13 long paths in the lead of a diff page
const long = execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', join(root, 'long')]) && join(root, 'long');
const lg = (...args) => execFileSync('/usr/bin/git', ['-C', long, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
lg('config', 'user.email', 'e2e@example.invalid'); lg('config', 'user.name', 'E2E');
const deep = join(long, 'a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100)); mkdirSync(deep, { recursive: true });
for (let i = 0; i < 60; i++) writeFileSync(join(deep, `tracked-${String(i).padStart(2, '0')}.txt`), numbered('T', 30));
lg('add', '.'); lg('commit', '-q', '-m', 'base');
for (let i = 0; i < 60; i++) { writeFileSync(join(deep, `tracked-${String(i).padStart(2, '0')}.txt`), numbered('t', 30)); writeFileSync(join(deep, `untracked-${String(i).padStart(2, '0')}.txt`), numbered('u', 5)); }
const longPages = []; let longOffset = 0, longGuard = 0, stalled = false;
for (;;) {
  const page = await workerChanges(long, undefined, longOffset ? { offset: longOffset } : {});
  longPages.push(bytes(page));
  const next = /offset=(\d+)/.exec(page.slice(-260))?.[1];
  if (!next) break;
  if (Number(next) <= longOffset) { stalled = true; break; }
  longOffset = Number(next); if (++longGuard > 200) break;
}
check('C13 worker diff with long paths: every page is at most 8 KiB and offset always advances to the end', !stalled && longGuard <= 200 && longPages.every(size => size <= LIMIT), { pages: longPages.length, max: Math.max(...longPages), stalled });
rmSync(root, { recursive: true, force: true });
console.log(checks.join('\n'));
console.log(process.exitCode ? 'FAILED' : `PASS ${checks.length} checks`);
