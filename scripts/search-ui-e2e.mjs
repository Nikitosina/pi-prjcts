// Browser E2E for full-text search (chats, worker threads, knowledge, uploads; Cmd/Ctrl+K; jump + highlight; 390 px)
// and worker-failure notices in the host notification feed. Isolated host, fake model, headless Chrome.
// Failure cases recorded in search-ui-failures.md before implementation.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, delay } from './notify-kit.mjs';

const respond = ({ coordinator, userText, results, say, call }) => {
  if (coordinator) {
    const owner = !userText.startsWith('[Durable work') && !userText.startsWith('[Owner-local event');
    const task = owner && results.length === 0 && /MARK-(WORK|WFAIL|WSTOP)\b/.exec(userText)?.[1];
    if (task) return call('projects_delegate', { role: 'worker', task: `${task}-TASK please do it` });
    if (!owner) return say(`Coordinator noted the worker report ${/WORK-TASK|WFAIL-TASK|WSTOP-TASK/.exec(userText)?.[0] ?? ''}.`);
    return undefined;
  }
  if (/WFAIL-TASK/.test(userText)) return { error: 'Fake worker provider error WFAIL' };
  if (/WSTOP-TASK/.test(userText)) return 'HOLD';
  // The worker's intermediate step says a word that only exists in its own thread.
  if (/WORK-TASK/.test(userText) && results.length === 0) return call('projects_knowledge_list', {}).replace('"role":"assistant",', '"role":"assistant","content":"Looking around for ibexvortex first.",');
  if (/WORK-TASK/.test(userText)) return say('Worker result: all good.');
  return undefined;
};
const k = await kit('search-ui', {}, respond);
const { result, rpc, eventually, evaluate, waitFor, shot, send } = k;
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); };
const search = (id, query) => rpc({ action: 'search', id, query });
const plan = id => rpc({ action: 'plan-snapshot', id });
const ok = async (id, chatId, text) => { const job = await k.ask(id, chatId, text); if (job.state !== 'done') throw Error(`${text}: ${job.state} ${job.error}`); return job; };
const keyK = (s, target = 'document.activeElement || document.body') => evaluate(`(${target}).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: navigator.platform.includes('Mac'), ctrlKey: !navigator.platform.includes('Mac'), bubbles: true, cancelable: true }))`, s);
const typeQuery = (s, value) => evaluate(`(() => { const i = document.querySelector('#search-input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
const key = (s, name) => evaluate(`document.querySelector('#search-input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`, s);
const rows = s => evaluate(`[...document.querySelectorAll('#search-results .search-row')].map(n => ({ source: n.dataset.source, text: n.innerText }))`, s);
const inView = (container, node) => `(() => { const c = document.querySelector(${JSON.stringify(container)}).getBoundingClientRect(), n = document.querySelector(${JSON.stringify(node)})?.getBoundingClientRect(); return !!n && n.height > 0 && n.top < c.bottom && n.bottom > c.top; })()`;

let s;
try {
  await k.startHost();
  const a = await k.setup('Alpha', k.gitRepo);
  await (async () => { const snap = await rpc({ action: 'owner-setup-snapshot', id: a }); await rpc({ action: 'workspace-quick-grant', id: a, confirm: a, expectedRevision: snap.workspaceRevision }); })();
  const two = await rpc({ action: 'chat-create', id: a, title: 'Two' });
  const three = await rpc({ action: 'chat-create', id: a, title: 'Three' });
  const webUrl = new URL((await rpc({ action: 'web' })).url), token = new URLSearchParams(webUrl.hash.slice(1)).get('token'); k.secrets.push(token);

  // Fixtures: an old turn in chat Two pushed out of the 30-message window, an archived chat, a worker thread, knowledge, a long upload, an HTML-ish message.
  await ok(a, two.id, 'MARK-OLD remember the pangolinsaxophone plan');
  for (let n = 0; n < 20; n++) await ok(a, two.id, `MARK-FILL${n} routine update`);
  await ok(a, three.id, 'MARK-ARCH note about archivedwombat');
  await rpc({ action: 'chat-update', id: a, chatId: three.id, archived: true });
  await ok(a, 'main', 'MARK-XSS <img src=x onerror="window.__xss=1"> xssmarmot');
  await ok(a, 'main', 'MARK-WORK delegate something');
  await eventually(async () => (await plan(a)).work.some(w => w.text.includes('WORK-TASK') && w.status === 'completed'), 'worker did not complete');
  await eventually(async () => (await rpc({ action: 'show', id: a })).messages.some(m => m.text?.includes('Coordinator noted the worker report WORK-TASK')), 'coordinator did not get report');
  const doc = `# Zoo\n\n${'Plain filler paragraph about nothing in particular.\n\n'.repeat(60)}The narwhalcompass points north.\n`;
  await rpc({ action: 'knowledge-write', id: a, path: 'research/zoo.md', text: doc, expectedRevision: null });
  const big = 'lorem ipsum dolor '.repeat(1400) + 'capybaraorbit marks the spot ' + 'tail text '.repeat(200);
  const up = await fetch(`${webUrl.origin}/upload?project=${a}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-filename': 'big.txt' }, body: big }).then(r => r.json());
  check('fixture upload stored', up.ok, up);
  const bigOffset = big.indexOf('capybaraorbit');

  // S1/S2/S3/S5: one search finds each place, with its location.
  const old = await search(a, 'routine pangolinsaxophone');
  check('S1/S5 an old turn of a non-Main chat outside the window is found and outranks common words', old.results[0]?.source === 'chat' && old.results[0].chatId === two.id && old.results[0].role === 'user' && old.results[0].snippet.includes('pangolinsaxophone') && Number.isInteger(old.results[0].index) && old.results.length <= 30, old.results.slice(0, 3));
  const arch = await search(a, 'archivedwombat');
  check('S1 archived chats are searched', arch.results.some(r => r.source === 'chat' && r.chatId === three.id && r.archived === true), arch.results);
  const ibex = await search(a, 'ibexvortex');
  const workHit = ibex.results.find(r => r.source === 'worker');
  check('S2 a word said only in a worker thread is found in that thread', workHit && !ibex.results.some(r => r.source === 'chat') && (await plan(a)).work.some(w => w.threadId === workHit.threadId) && workHit.role === 'assistant' && /worker/i.test(workHit.label), ibex.results);
  const narwhal = await search(a, 'narwhalcompass');
  check('S3 knowledge documents are searched', narwhal.results[0]?.source === 'knowledge' && narwhal.results[0].path === 'research/zoo.md', narwhal.results);
  const capy = await search(a, 'capybaraorbit');
  check('S3 upload text is searched', capy.results[0]?.source === 'upload' && capy.results[0].uploadId === up.data.id && capy.results[0].filename === 'big.txt', capy.results);
  check('S3 the upload hit offset is past 20 000 characters, near the word', bigOffset > 20000 && Math.abs(capy.results[0].offset - bigOffset) < 1300, { offset: capy.results[0].offset, bigOffset });
  const stop = await search(a, 'the and of').then(() => null, error => error.message);
  check('S6 a stop-word-only query is refused with an explanation', /at least one word/.test(stop ?? ''), stop);
  check('S6 an unknown word gives an empty list', (await search(a, 'nonexistentwordzz')).results.length === 0);
  await rpc({ action: 'knowledge-write', id: a, path: 'research/zoo.md', text: '# Zoo\n\nEmptied.\n', expectedRevision: (await rpc({ action: 'knowledge-read', id: a, path: 'research/zoo.md' })).revision });
  check('S3 an edited document stops matching at once', !(await search(a, 'narwhalcompass')).results.length);
  await rpc({ action: 'knowledge-write', id: a, path: 'research/zoo.md', text: doc, expectedRevision: (await rpc({ action: 'knowledge-read', id: a, path: 'research/zoo.md' })).revision });

  // Worker-failure notices (W1-W5).
  const feedAll = async () => (await rpc({ action: 'notify-feed', after: 0 })).items;
  await ok(a, two.id, 'MARK-WFAIL delegate a doomed task');
  const failed = await eventually(async () => (await plan(a)).work.find(w => w.text.includes('WFAIL-TASK') && w.status === 'failed'), 'worker did not fail');
  const notice = await eventually(async () => (await feedAll()).find(n => n.kind === 'error' && n.workId === failed.id), 'no worker failure notice', 300);
  check('W1/W2 a failed worker is a notice for the delegating chat, naming role, task and reason', notice.chatId === two.id && notice.chat === 'Two' && /worker/i.test(notice.title) && notice.text.includes('WFAIL-TASK') && notice.threadId === failed.threadId, notice);
  await ok(a, 'main', 'MARK-WSTOP delegate a slow task');
  const slow = await eventually(async () => (await plan(a)).work.find(w => w.text.includes('WSTOP-TASK') && w.status === 'running'), 'slow worker did not start');
  await rpc({ action: 'thread-stop', id: a, threadId: slow.threadId });
  await eventually(async () => (await plan(a)).work.find(w => w.id === slow.id && !['queued', 'running'].includes(w.status)), 'slow worker did not stop');
  await delay(2000);
  const afterStop = await feedAll();
  check('W3 one notice per failure across scans', afterStop.filter(n => n.workId === failed.id).length === 1, afterStop);
  check('W5 a stopped worker is not a failure notice', !afterStop.some(n => n.workId === slow.id), afterStop.filter(n => n.workId));
  // W4: a feed file written before this feature (no work baseline) must not flood old failures.
  await k.stopHost();
  const path = join(k.home, 'notifications.json'), state = JSON.parse(readFileSync(path, 'utf8'));
  const before = state.feed.length;
  for (const entry of Object.values(state.projects)) { delete entry.workBaselined; entry.seen = entry.seen.filter(key => !key.startsWith('work:')); }
  writeFileSync(path, JSON.stringify(state, null, 2));
  await k.startHost();
  await delay(2500);
  const restarted = await feedAll();
  check('W3/W4 a restart, even from a pre-feature feed file, re-emits no worker failure', restarted.length === before && restarted.filter(n => n.workId === failed.id).length === 1, { before, after: restarted.length });

  // Browser: Cmd/Ctrl+K from the composer, arrows + Enter, jump into the old turn and highlight it.
  const web = new URL((await rpc({ action: 'web' })).url); web.searchParams.set('project', a);
  s = await k.openPage(web.toString());
  await waitFor(`document.querySelector('#messages')?.innerText.includes('Coordinator noted')`, s, 'page loaded');
  await evaluate(`document.querySelector('#compose textarea').focus()`, s);
  await keyK(s);
  await waitFor(`document.querySelector('dialog[open] #search-input') === document.activeElement`, s, 'search dialog focused');
  check('S11 Cmd/Ctrl+K opens search even from the composer, input focused', true);
  await typeQuery(s, 'xssmarmot');
  await waitFor(`document.querySelectorAll('#search-results .search-row').length > 0`, s, 'xss results');
  check('S4 transcript HTML is shown as text, never run', await evaluate(`window.__xss === undefined && !document.querySelector('#search-results img') && document.querySelector('#search-results').innerText.includes('<img')`, s));
  // S12: a later query wins over an earlier one.
  await typeQuery(s, 'routine'); await typeQuery(s, 'pangolinsaxophone routine');
  await waitFor(`document.querySelector('#search-results .search-row')?.innerText.includes('pangolinsaxophone')`, s, 'old-turn results');
  await delay(800);
  check('S12 the latest query owns the list', (await rows(s))[0].text.includes('pangolinsaxophone'), await rows(s));
  check('S4 rows name their source', /Two/.test((await rows(s))[0].text) && await evaluate(`!!document.querySelector('#search-results .search-row mark')`, s), await rows(s));
  await shot('01-search-dialog', s);
  await key(s, 'ArrowDown'); await key(s, 'ArrowUp');
  check('S11 arrows move the selection', await evaluate(`document.querySelector('#search-results .search-row.active') === document.querySelector('#search-results .search-row')`, s));
  await key(s, 'Enter');
  await waitFor(`!document.querySelector('dialog').open && new URL(location.href).searchParams.get('chat') === ${JSON.stringify(two.id)} && !!document.querySelector('#messages .search-focus')`, s, 'jumped to chat Two');
  await waitFor(inView('#transcript', '#messages .search-focus'), s, 'focused message visible');
  check('S7 Enter opens the right chat, renders the old message, highlights the word and scrolls to it', await evaluate(`document.querySelector('#messages .search-focus').innerText.includes('pangolinsaxophone') && [...document.querySelectorAll('#messages .search-focus mark')].some(m => /pangolinsaxophone/i.test(m.textContent))`, s));
  await shot('02-jumped-old-message', s);
  await delay(5000);
  check('S7 refreshes keep the highlight in view', await evaluate(`!!document.querySelector('#messages .search-focus mark')`, s) && await evaluate(inView('#transcript', '#messages .search-focus'), s));
  // S8: sending a message returns to the normal window.
  await evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = 'MARK-NEXT after search'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#compose').requestSubmit(); })()`, s);
  await waitFor(`document.querySelector('#messages').innerText.includes('Done MARK-NEXT.')`, s, 'next reply');
  check('S8 after the owner moves on the transcript is the normal tail again', await evaluate(`!document.querySelector('#messages .search-focus') && !document.querySelector('#messages').innerText.includes('pangolinsaxophone')`, s));

  // S9: worker hit opens the thread at that message.
  await keyK(s, 'document.body');
  await waitFor(`document.querySelector('dialog[open] #search-input')`, s, 'dialog again');
  await typeQuery(s, 'ibexvortex');
  await waitFor(`document.querySelector('#search-results .search-row[data-source="worker"]')`, s, 'worker result');
  await evaluate(`document.querySelector('#search-results .search-row[data-source="worker"]').click()`, s);
  await waitFor(`!!document.querySelector('#worker-messages .search-focus mark')`, s, 'worker message highlighted');
  await waitFor(inView('#worker-messages', '#worker-messages .search-focus'), s, 'worker message visible');
  check('S9 a worker hit opens Activity on that thread and highlights the message', await evaluate(`new URL(location.href).searchParams.get('tab') === 'activity' && document.querySelector('#worker-messages .search-focus').innerText.includes('ibexvortex')`, s));
  await shot('03-worker-hit', s);

  // S10: knowledge and upload hits.
  await keyK(s, 'document.body');
  await waitFor(`document.querySelector('dialog[open] #search-input')`, s, 'dialog again');
  await typeQuery(s, 'narwhalcompass');
  await waitFor(`document.querySelector('#search-results .search-row[data-source="knowledge"]')`, s, 'knowledge result');
  await evaluate(`document.querySelector('#search-results .search-row[data-source="knowledge"]').click()`, s);
  await waitFor(`!!document.querySelector('dialog[open] .doc-view mark.search-mark')`, s, 'doc highlighted');
  await waitFor(inView('dialog .dialog-body', 'dialog .doc-view mark.search-mark.current'), s, 'doc mark visible');
  check('S10 a knowledge hit opens the document scrolled to the highlighted word', true);
  await shot('04-knowledge-hit', s);
  await keyK(s, 'document.body');
  await waitFor(`document.querySelector('dialog[open] #search-input')`, s, 'dialog again');
  await typeQuery(s, 'capybaraorbit');
  await waitFor(`document.querySelector('#search-results .search-row[data-source="upload"]')`, s, 'upload result');
  await evaluate(`document.querySelector('#search-results .search-row[data-source="upload"]').click()`, s);
  await waitFor(`!!document.querySelector('dialog[open] .upload-text mark.search-mark')`, s, 'upload highlighted');
  await waitFor(inView('dialog .dialog-body', 'dialog .upload-text mark.search-mark.current'), s, 'upload mark visible');
  check('S10 an upload hit past 20 000 characters opens at that place, highlighted', true);
  await shot('05-upload-hit', s);
  await evaluate(`document.querySelector('[data-action="close-dialog"]').click()`, s);

  // S6 in the UI, S11 Escape, header button.
  await evaluate(`document.querySelector('#search-button').click()`, s);
  await waitFor(`document.querySelector('dialog[open] #search-input')`, s, 'dialog via button');
  await typeQuery(s, 'nonexistentwordzz');
  await waitFor(`/No matches/.test(document.querySelector('#search-results').innerText)`, s, 'no matches');
  await typeQuery(s, 'the of');
  await waitFor(`/at least one word/.test(document.querySelector('#search-results').innerText)`, s, 'stop-word message');
  check('S6 the UI says when nothing matches and why a stop-word query is refused', true);
  await evaluate(`document.querySelector('#search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); document.querySelector('dialog').close()`, s);
  // "/" still focuses the composer.
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))`, s);
  check('S11 the "/" composer shortcut still works', await evaluate(`document.activeElement === document.querySelector('#compose textarea')`, s));

  // S13: 390 px.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await evaluate(`document.querySelector('#search-button').click()`, s);
  await waitFor(`document.querySelector('dialog[open] #search-input')`, s, 'mobile dialog');
  await typeQuery(s, 'routine pangolinsaxophone');
  await waitFor(`document.querySelectorAll('#search-results .search-row').length > 3`, s, 'mobile results');
  check('S13 search fits 390 px', await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('#search-results .search-row')].every(n => n.getBoundingClientRect().right <= innerWidth + 1) && document.querySelector('#search-button').getBoundingClientRect().right <= innerWidth`, s));
  await shot('06-mobile-search', s);
  await evaluate(`document.querySelector('#search-results .search-row').click()`, s);
  await waitFor(`!!document.querySelector('#messages .search-focus mark')`, s, 'mobile jump');
  await waitFor(inView('#transcript', '#messages .search-focus'), s, 'mobile focus visible');
  check('S13 at 390 px the jumped-to message is visible', true);
  await shot('07-mobile-jump', s);

  result.notice = notice;
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = k.redact(error?.stack ?? error);
  if (s) { try { await shot('failure', s); result.dom = await evaluate(`({ url: location.href, error: document.querySelector('#error')?.innerText, warning: document.querySelector('#warning')?.innerText, worker: document.querySelector('#inline-thread')?.innerHTML.slice(0, 6000) })`, s); } catch {} }
}
await k.finish(result.status);
