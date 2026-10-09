// Browser E2E: Activity panel = workers | chat | artifact browser. Isolated host, local fake model, headless Chrome.
// Failure modes (written first): scripts/worker-artifacts-browser-failures.md. Artifact: artifacts/worker-artifacts-browser-<stamp>/{result.json,*.png}.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, delay } from './notify-kit.mjs';

let root;
const respond = async ({ coordinator, userText, results, tools, say, call }) => {
  if (coordinator) {
    if (/MARK-BROWSE\b/.test(userText)) {
      const steps = [{ role: 'worker', task: 'BROWSE-A produce evidence' }, { role: 'worker', task: 'BROWSE-B second worker' }, { role: 'worker', task: 'BROWSE-C saves nothing' }];
      if (results.length < steps.length) return call('projects_delegate', steps[results.length]);
    }
    return undefined;
  }
  if (!tools.includes('bash')) return undefined;
  if (/BROWSE-A/.test(userText)) {
    if (results.length === 0) return call('bash', { command: [
      'echo "DIR=$PI_ARTIFACTS_DIR"', 'cd "$PI_ARTIFACTS_DIR"', 'mkdir -p docs data logs a/b/c "my notes"',
      `cp ${root}/shot.png shot.png`, `cp ${root}/demo.webm demo.webm`,
      `printf '# Report title\\n\\nSome **bold** text <script>window.__xss=1</script>\\n\\n- item one\\n' > docs/readme.md`,
      `printf '{"ok":true,"items":[1,2]}' > data/result.json`,
      `yes 'LOG-LINE-0123456789 padding padding padding' | head -c 700000 > logs/big.log && printf 'TAIL-MARKER-END\\n' >> logs/big.log`,
      'head -c 2000 /dev/urandom > blob.bin', `printf 'deep file' > a/b/c/deep.txt`, `printf 'unicode ok' > "my notes/résumé 日本.txt"`,
      `printf '<script>window.__xss=1</script><iframe src=x></iframe><h1>HTML-AS-TEXT</h1>' > xss.html`,
      `printf x > "<img src=x onerror=window.__xss=1>.txt"`, 'sleep 1.2', `printf newest > zz-newest.txt`,
    ].join(' && ') });
    const thread = /DIR=\S*\/artifacts\/([0-9a-f-]{36})/.exec(results[0] ?? '')?.[1];
    return say(`BROWSE-DONE\n\n![Screenshot](artifact:${thread}/shot.png)\n\nSummary: [readme](artifact:${thread}/docs/readme.md) and [deep](artifact:${thread}/a/b/c/deep.txt)`);
  }
  if (/BROWSE-B/.test(userText)) {
    if (results.length === 0) return call('bash', { command: 'cd "$PI_ARTIFACTS_DIR" && printf second > second.txt' });
    return say('BROWSE-B-DONE');
  }
  return undefined;
};
const k = await kit('worker-artifacts-browser', {}, respond);
root = k.root;
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, send } = k;
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const q = value => JSON.stringify(value);
const click = (selector, s) => evaluate(`document.querySelector(${q(selector)}).click()`, s);
const file = path => `document.querySelector('#artifact-tree .artifact-file[data-path=${q(path)}]')`;
const select = async (path, s) => { await evaluate(`${file(path)}.click()`, s); await waitFor(`${file(path)}?.classList.contains('on') && document.querySelector('#artifact-preview .artifact-meta')?.innerText.startsWith(${q(path)})`, s, `select ${path}`); };
const viewport = (width, height, mobile, s) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, s);
const setFilter = (value, s) => evaluate(`(() => { const i = document.querySelector('#artifact-filter'); i.value = ${q(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);

try {
  await k.startHost();
  const web = await rpc({ action: 'web' }), base = new URL(web.url);
  const s = k.lastSession = await openPage(`${base.origin}/`);
  await delay(800);
  const media = await evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d');
    g.fillStyle = '#c2653a'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('ARTIFACT', 80, 110);
    const png = c.toDataURL('image/png').split(',')[1];
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' }); const parts = [];
    rec.ondataavailable = e => parts.push(e.data); const done = new Promise(ok => rec.onstop = ok); rec.start(100);
    for (let i = 0; i < 12; i++) { g.fillStyle = 'hsl(' + i * 30 + ',70%,50%)'; g.fillRect(i * 20, 0, 20, 200); await new Promise(ok => setTimeout(ok, 80)); }
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()); let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
    return { png, webm: btoa(bin) };
  })()`, s);
  writeFileSync(join(root, 'shot.png'), Buffer.from(media.png, 'base64'));
  writeFileSync(join(root, 'demo.webm'), Buffer.from(media.webm, 'base64'));
  check('fixtures: browser-made PNG and webm', media.png.length > 100 && media.webm.length > 1000);

  const id = await k.setup('Browse', k.gitRepo);
  const snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  await rpc({ action: 'message', id, text: 'MARK-BROWSE please produce evidence with three workers' });
  const plan = await eventually(async () => { const p = await rpc({ action: 'plan-snapshot', id }); return p.work.length >= 3 && p.work.every(w => ['completed', 'failed'].includes(w.status)) && p; }, 'workers did not settle', 1800);
  const threadOf = marker => plan.work.find(w => w.text.includes(marker)).threadId;
  const [threadA, threadB, threadC] = ['BROWSE-A', 'BROWSE-B', 'BROWSE-C'].map(threadOf);
  const listingA = await rpc({ action: 'artifacts-list', id, threadId: threadA });
  const dirA = join(k.home, id, 'artifacts', threadA);
  check('setup: fake worker saved nested, unicode, large and hostile files', listingA.files.length === 11 && listingA.files.some(f => f.path === 'a/b/c/deep.txt') && listingA.files.some(f => f.path === 'my notes/résumé 日本.txt'), listingA.files.map(f => f.path));

  const url = new URL(web.url); url.searchParams.set('project', id); url.searchParams.set('tab', 'activity');
  await send('Page.navigate', { url: url.toString() }, s);
  await waitFor(`!!document.querySelector('[data-action="thread"][data-thread="${threadA}"]')`, s, 'worker A in the list');

  check('F12 no worker selected: browser column shows an empty state', await evaluate(`document.querySelector('#artifact-pane').innerText.includes('Select a worker') && !document.querySelector('#artifact-filter').offsetParent`, s));
  await click(`[data-action="thread"][data-thread="${threadA}"]`, s);
  await waitFor(`document.querySelectorAll('#artifact-tree .artifact-file').length >= 5`, s, 'artifact tree');
  const layout = await evaluate(`(() => { const r = sel => document.querySelector(sel).getBoundingClientRect(); const w = r('.work-pane'), c = r('#inline-thread'), a = r('#artifact-pane'); return { w: [w.x, w.width, w.top], c: [c.x, c.width, c.top], a: [a.x, a.width, a.top, a.bottom], vh: innerHeight, vw: innerWidth, overflow: ['#work-list', '#worker-messages', '#artifact-tree'].map(sel => getComputedStyle(document.querySelector(sel)).overflowY) }; })()`, s);
  result.layout = layout;
  check('F1 three columns left to right: workers (280) | chat | artifacts (340), same top', layout.w[0] < layout.c[0] && layout.c[0] < layout.a[0] && Math.abs(layout.w[1] - 280) < 4 && Math.abs(layout.a[1] - 340) < 4 && layout.c[1] > 450 && Math.abs(layout.w[2] - layout.a[2]) < 2, layout);
  check('F1 columns scroll independently and the pane fits the viewport', layout.overflow.every(v => v === 'auto' || v === 'scroll') && layout.a[3] <= layout.vh + 1, layout);

  const tree = await evaluate(`({ dirs: [...document.querySelectorAll('#artifact-tree .artifact-dir > button')].map(b => b.dataset.dir), summary: document.querySelector('#artifact-summary').innerText, rootFiles: [...document.querySelectorAll('#artifact-tree > .artifact-file')].map(b => b.dataset.path) })`, s);
  result.tree = tree;
  check('F2 folders render as a tree (docs, data, logs, a, my notes) with nested a/b/c', ['docs', 'data', 'logs', 'a', 'my notes', 'a/b', 'a/b/c'].every(d => tree.dirs.includes(d)), tree);
  check('F4 summary shows file count and total size', tree.summary.includes(`${listingA.files.length} file(s)`) && /MB|KB/.test(tree.summary), tree.summary);
  await click('#artifact-tree [data-dir="a"]', s);
  check('F2 collapsing a folder hides its children', await evaluate(`!${file('a/b/c/deep.txt')} && document.querySelector('#artifact-tree [data-dir="a"]').getAttribute('aria-expanded') === 'false'`, s));
  await click('#artifact-tree [data-dir="a"]', s);
  check('F2 expanding shows them again', await evaluate(`!!${file('a/b/c/deep.txt')}`, s));

  check('F3 default sort is newest first', tree.rootFiles[0] === 'zz-newest.txt', tree.rootFiles);
  await click('#artifact-sort', s);
  const byName = await evaluate(`[...document.querySelectorAll('#artifact-tree > .artifact-file')].map(b => b.dataset.path)`, s);
  const expectedName = [...tree.rootFiles].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  check('F3 name sort orders files alphabetically', JSON.stringify(byName) === JSON.stringify(expectedName) && byName[0] !== 'zz-newest.txt', { byName, expectedName });
  await click('#artifact-sort', s);
  await setFilter('deep', s);
  check('F3 filter keeps matching files with their folders, hides the rest', await evaluate(`!!${file('a/b/c/deep.txt')} && document.querySelectorAll('#artifact-tree .artifact-file').length === 1 && !!document.querySelector('#artifact-tree [data-dir="a/b/c"]')`, s));
  await setFilter('zzqqxx', s);
  check('F3 empty filter result says so', await evaluate(`document.querySelector('#artifact-tree').innerText.includes('No files match')`, s));
  await setFilter('', s);
  await waitFor(`document.querySelectorAll('#artifact-tree .artifact-file').length >= 10`, s, 'filter cleared');

  await select('shot.png', s);
  await waitFor(`document.querySelector('#artifact-body img.artifact-media')?.naturalWidth === 320`, s, 'image preview');
  await shot('01-image-preview', s);
  check('F5 image preview renders', true);
  await select('demo.webm', s);
  await waitFor(`document.querySelector('#artifact-body video.artifact-media')?.readyState >= 1`, s, 'video preview');
  check('F5 video preview plays in a <video> player', true);
  await select('docs/readme.md', s);
  await waitFor(`!!document.querySelector('#artifact-body .artifact-md h1')`, s, 'markdown preview');
  check('F5 markdown is rendered (heading, bold, list)', await evaluate(`!!document.querySelector('#artifact-body .artifact-md strong') && !!document.querySelector('#artifact-body .artifact-md li')`, s));
  check('F7 markdown <script> is shown as text, never executed', await evaluate(`!window.__xss && !document.querySelector('#artifact-preview script') && document.querySelector('#artifact-body').innerText.includes('<script>')`, s));
  await shot('02-markdown-preview', s);
  await select('data/result.json', s);
  await waitFor(`!!document.querySelector('#artifact-body pre.artifact-text')`, s, 'json preview');
  check('F5 JSON is pretty-printed in monospace', await evaluate(`document.querySelector('#artifact-body pre').innerText.includes('"ok": true') && getComputedStyle(document.querySelector('#artifact-body pre')).fontFamily.includes('Menlo')`, s));
  await select('logs/big.log', s);
  await waitFor(`!!document.querySelector('#artifact-body pre.artifact-text')`, s, 'log preview');
  const log = await evaluate(`({ len: document.querySelector('#artifact-body pre').textContent.length, note: document.querySelector('#artifact-body .note')?.innerText ?? '', hasTail: document.querySelector('#artifact-body').textContent.includes('TAIL-MARKER-END') })`, s);
  check('F6 700 KB log is capped at 512 KB with a "download" hint', log.len <= 524288 && log.len > 500000 && !log.hasTail && /first 512\.0 KB of 683\.\d KB/.test(log.note), log);
  await select('blob.bin', s);
  await waitFor(`document.querySelector('#artifact-body')?.innerText.includes('No preview')`, s, 'binary preview');
  check('F5 binary file shows metadata + download, no content', await evaluate(`document.querySelector('#artifact-preview').innerText.includes('application/octet-stream') && !!document.querySelector('#artifact-preview [data-action="artifact-download"]')`, s));

  await select('xss.html', s);
  await waitFor(`!!document.querySelector('#artifact-body pre.artifact-text')`, s, 'html preview');
  check('F7 HTML artifact is shown as text: no script/iframe, nothing executed', await evaluate(`!window.__xss && !document.querySelector('#artifact-preview script, #artifact-preview iframe, #artifact-preview h1') && document.querySelector('#artifact-body pre').textContent.includes('<iframe src=x>')`, s));
  check('F14 hostile file name is escaped in the tree', await evaluate(`!window.__xss && !document.querySelector('#artifact-tree img') && [...document.querySelectorAll('#artifact-tree .af-name')].some(n => n.textContent === '<img src=x onerror=window.__xss=1>.txt')`, s));

  const dl = join(k.root, 'downloads'); mkdirSync(dl);
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await select('my notes/résumé 日本.txt', s);
  await waitFor(`document.querySelector('#artifact-body pre')?.innerText === 'unicode ok'`, s, 'unicode preview');
  await click('#artifact-preview [data-action="artifact-download"]', s);
  await eventually(() => readdirSync(dl).some(f => !f.endsWith('.crdownload')), 'download did not finish', 100);
  const downloaded = readdirSync(dl); result.downloads = downloaded;
  check('F8 download saves the right bytes under the unicode/space file name', downloaded.includes('résumé 日本.txt') && readFileSync(join(dl, 'résumé 日本.txt'), 'utf8') === 'unicode ok', downloaded);
  const pages = async () => (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
  const tabs = async () => (await pages()).length;
  const known = new Set((await pages()).map(t => t.targetId)), before = known.size;
  await send('Runtime.evaluate', { expression: `document.querySelector('#artifact-preview [data-action="artifact-open"]').click()`, userGesture: true }, s); // popups need a user gesture
  await eventually(async () => (await tabs()) > before, 'no new tab', 50);
  check('F8 "Open in new tab" opens a tab', true);
  for (const t of await pages()) if (!known.has(t.targetId)) await send('Target.closeTarget', { targetId: t.targetId }); // a background page stops polling
  for (const targetId of known) { await send('Target.activateTarget', { targetId }); if (!(await evaluate('document.hidden', s))) break; await delay(300); }
  await waitFor(`!document.hidden`, s, 'original tab visible again');

  await select('docs/readme.md', s);
  await waitFor(`!!document.querySelector('#artifact-body .artifact-md h1')`, s, 'markdown preview again');
  const fetchesBefore = await evaluate(`performance.getEntriesByType('resource').filter(e => e.name.includes('readme.md')).length`, s);
  mkdirSync(join(dirA, 'late'), { recursive: true }); writeFileSync(join(dirA, 'late', 'new-late.txt'), 'arrived later');
  await waitFor(`!!document.querySelector('#artifact-tree .artifact-file[data-path="late/new-late.txt"].fresh')`, s, 'new file highlighted (listing refresh)');
  check('F9 a file written while viewing appears (auto refresh) and is highlighted', true);
  check('F9 selection and preview survive the refresh without refetching', await evaluate(`document.querySelector('#artifact-tree .artifact-file.on')?.dataset.path === 'docs/readme.md' && !!document.querySelector('#artifact-body .artifact-md h1') && performance.getEntriesByType('resource').filter(e => e.name.includes('readme.md')).length === ${fetchesBefore}`, s));

  await click('#artifact-preview [data-action="artifact-deselect"]', s);
  check('F10 closing the preview hides it', await evaluate(`document.querySelector('#artifact-preview').hidden`, s));
  await waitFor(`!!document.querySelector('#worker-messages .artifact-ref[data-state=link] a') && document.querySelector('#worker-messages img.artifact-media')?.naturalWidth === 320`, s, 'chat artifact links');
  check('F10 inline image still renders in the chat', true);
  await evaluate(`[...document.querySelectorAll('#worker-messages .artifact-ref a')].find(a => a.textContent === 'deep').click()`, s);
  await waitFor(`document.querySelector('#artifact-tree .artifact-file.on')?.dataset.path === 'a/b/c/deep.txt' && document.querySelector('#artifact-body pre')?.innerText === 'deep file'`, s, 'chat link selects file');
  check('F10 clicking an artifact link in the chat selects that file in the browser', true);
  await evaluate(`document.querySelector('#worker-messages img.artifact-media').click()`, s);
  await waitFor(`document.querySelector('#artifact-tree .artifact-file.on')?.dataset.path === 'shot.png'`, s, 'chat image selects file');
  check('F10 clicking the inline image selects it too', true);
  await shot('03-three-columns', s);

  await click(`[data-action="thread"][data-thread="${threadB}"]`, s);
  await waitFor(`document.querySelectorAll('#artifact-tree .artifact-file').length === 1 && !!${file('second.txt')}`, s, 'worker B files');
  check('F11 switching workers swaps the browser (no files or selection from worker A)', await evaluate(`!${file('shot.png')} && document.querySelector('#artifact-preview').hidden && document.querySelector('#artifact-summary').innerText.includes('1 file')`, s));
  await click(`[data-action="thread"][data-thread="${threadC}"]`, s);
  await waitFor(`document.querySelector('#artifact-tree').innerText.includes('No artifacts yet')`, s, 'worker C empty state');
  check('F12 a worker without artifacts shows an empty state', true);
  await click('[data-action="thread-close"]', s);
  check('F12 closing the worker resets the browser', await evaluate(`document.querySelector('#artifact-pane').innerText.includes('Select a worker')`, s));
  await click(`[data-action="thread"][data-thread="${threadA}"]`, s);
  await waitFor(`document.querySelectorAll('#artifact-tree .artifact-file').length >= 10`, s, 'worker A again');

  await viewport(1000, 900, false, s);
  await delay(400);
  const narrow = await evaluate(`(() => { const a = document.querySelector('#artifact-pane'); return { hidden: getComputedStyle(a).visibility === 'hidden', toggle: !!document.querySelector('.artifact-toggle').offsetParent, chatW: document.querySelector('#inline-thread').getBoundingClientRect().width }; })()`, s);
  check('F13 <1200px: the browser leaves the grid (hidden drawer) and the chat keeps its width', narrow.hidden && narrow.toggle && narrow.chatW > 300, narrow);
  await click('.artifact-toggle', s);
  await delay(400);
  const open = await evaluate(`(() => { const p = document.querySelector('#artifact-pane'); return { visible: getComputedStyle(p).visibility === 'visible', right: Math.round(p.getBoundingClientRect().right), vw: innerWidth, files: document.querySelectorAll('#artifact-tree .artifact-file').length }; })()`, s);
  check('F13 the toggle opens the drawer on the right edge with the file list', open.visible && open.right === open.vw && open.files >= 10, open);
  await shot('04-drawer-1000px', s);
  await click('.artifact-drawer-close', s);
  await delay(400);
  check('F13 the drawer closes', await evaluate(`getComputedStyle(document.querySelector('#artifact-pane')).visibility === 'hidden'`, s));
  await viewport(390, 844, true, s);
  await delay(400);
  await click('.artifact-toggle', s);
  await delay(400);
  check('F13 390px: single column, drawer opens full width', await evaluate(`Math.round(document.querySelector('#artifact-pane').getBoundingClientRect().width) === innerWidth && getComputedStyle(document.querySelector('#artifact-pane')).visibility === 'visible' && document.documentElement.scrollWidth <= innerWidth + 1`, s));
  await shot('05-mobile-drawer', s);
  check('F15 no browser console or HTTP errors', result.errors.length === 0 && result.httpErrors.length === 0, { errors: result.errors, http: result.httpErrors });
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = k.redact(error?.stack ?? error);
  try { result.diagnostic = await evaluate(`document.querySelector('#artifact-pane').innerText.slice(0, 1500)`, k.lastSession); } catch {}
}
writeFileSync(join(k.artifacts, 'result.json'), JSON.stringify({ status: result.status, failure: result.failure, diagnostic: result.diagnostic, checks: result.checks, layout: result.layout, tree: result.tree, downloads: result.downloads }, null, 2) + '\n');
await k.finish(result.status);
