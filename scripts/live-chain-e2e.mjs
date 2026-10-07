// Browser E2E with an isolated host and local fake model. No real providers.
// Failure cases recorded in live-chain-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `live-chain-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `live-chain-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
let releaseHold; const hold = new Promise(ok => { releaseHold = ok; });
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const think = text => chunk({ role: 'assistant', reasoning_content: text }, null);
const text = value => chunk({ role: 'assistant', content: value }, null);
const tool = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null);
const end = reason => chunk({}, reason) + 'data: [DONE]\n\n';
// Streams parts with pauses so the browser sees each step live; numbers are pauses in ms.
async function stream(res, parts) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const part of parts) { if (typeof part === 'number') await delay(part); else res.write(part); }
  res.end();
}
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages;
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const userText = String(typeof msgs[lastUser]?.content === 'string' ? msgs[lastUser].content : JSON.stringify(msgs[lastUser]?.content ?? ''));
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
    const stage = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').length;
    result.calls.push({ at: Date.now(), marker, stage });
    if (marker === 'MARK-LONG' && stage < LONG) return stream(res, [tool('projects_knowledge_list', {}), end('tool_calls')]);
    if (marker === 'MARK-LONG') return stream(res, [text('LONG-DONE after many steps.'), end('stop')]);
    if (marker === 'MARK-CHAIN' && stage === 0) return stream(res, [think('Planning the check'), 400, think(' of the index'), 400, text('STEP-ONE I will list knowledge.'), 600, tool('projects_knowledge_list', {}), end('tool_calls')]);
    if (marker === 'MARK-CHAIN' && stage === 1) return stream(res, [800, think('Choosing a document'), 600, text('STEP-TWO reading MEMORY.md.'), 600, tool('projects_knowledge_read', { path: 'MEMORY.md' }), end('tool_calls')]);
    if (marker === 'MARK-CHAIN') { await hold; return stream(res, [think('Composing the answer'), 1500, text('STEP-FINAL done.'), end('stop')]); }
    return stream(res, [text(`Answer ${marker}.`), end('stop')]);
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'wx', mode: 0o600 });
const host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
let hostEnded = false;
const hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 60000 }, res => {
      res.setEncoding('utf8');
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = 600) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error(description);
}

let chrome, cdpEnded = false, cdpId = 0, buffer = ''; const pending = new Map();
function startChrome() {
  const clog = createWriteStream(join(artifacts, 'chrome.log'), { flags: 'wx', mode: 0o600 });
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${join(root, 'chrome-profile')}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  chrome.stdout.pipe(clog); chrome.stderr.pipe(clog);
  chrome.once('exit', () => { cdpEnded = true; });
  chrome.stdio[4].on('data', part => {
    buffer += part.toString(); let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const text = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!text) continue;
      const msg = JSON.parse(text);
      if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } }
      else if (msg.method === 'Runtime.exceptionThrown') result.errors.push(redact(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
      else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') result.errors.push(redact(msg.params.entry.text));
      else if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) { const u = new URL(msg.params.response.url); result.httpErrors.push({ url: u.origin + u.pathname, status: msg.params.response.status }); }
    }
  });
}
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const key = ++cdpId; const timer = setTimeout(() => { pending.delete(key); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    chrome.stdio[3].write(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression, session) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session); if (r.exceptionDetails) throw Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; }
async function shot(name, session) { const image = await send('Page.captureScreenshot', { format: 'png' }, session); writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 }); }
async function waitFor(expression, session, label, tries = 240) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expression, session)) return; await delay(250); }
  throw Error(`Timed out waiting for ${label}`);
}

const settle = async (id, job) => eventually(async () => { const view = await rpc({ action: 'show', id }); const found = view.jobs.find(j => j.id === job.id); return ['done', 'failed', 'interrupted'].includes(found?.state) && found; }, 'Job did not settle');
const lastReply = async id => (await rpc({ action: 'show', id })).messages.findLast(m => m.role === 'assistant')?.text ?? '';
const workFor = async (id, task) => eventually(async () => (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.text.startsWith(task)), `work ${task} missing`);
const terminal = async (id, task, status) => eventually(async () => { const w = (await rpc({ action: 'plan-snapshot', id })).work.find(w => w.text.startsWith(task)); return w?.status === status && w; }, `work ${task} not ${status}`);
const scrollInfo = s => evaluate(`(() => { const t = document.querySelector('#transcript'); return { top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight, height: t.scrollHeight }; })()`, s);
const box = (sel, s) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, visible: !!(r.width || r.height) && getComputedStyle(n).visibility !== 'hidden' }; })()`, s);
const LONG = 36;
try {
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Live chain', cwd: workspace, objective: 'Disposable live chain fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  const legacy = randomUUID();
  for (const [path, body] of [['decisions/issue-95-generic-flow.md', '# Flow decisions\n'], ['plans/issue-generic-expanded-sources.md', '# Sources plan\n'], ['plans/a-very-long-document-name-that-must-truncate-inside-the-rail-card-instead-of-overflowing.md', '# Long\n'], [`research/legacy/${legacy}.md`, '# Legacy answer\n'], ['research/summary.md', '# Research\n']]) await rpc({ action: 'knowledge-write', id, path, text: body, expectedRevision: null });
  const ask = async text => { const job = await rpc({ action: 'message', id, text }); const done = await settle(id, job); if (done.state !== 'done') throw Error(`${text} failed: ${done.error}`); };
  await ask('MARK-LONG run a long chain');

  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#title')?.innerText === 'Live chain' && document.querySelector('#messages').innerText.includes('LONG-DONE')`, s, 'project loaded');
  await delay(400);

  // Long turn: the owner's message and every step stay in the transcript (failure 5).
  const long = await evaluate(`({ you: document.querySelector('#messages').innerText.includes('MARK-LONG run a long chain'), tools: document.querySelectorAll('#messages .tool-call').length })`, s);
  if (!long.you || long.tools < LONG) throw Error('Long turn truncated: ' + JSON.stringify(long));
  result.checks.push(`LC5 a ${LONG}-tool turn keeps the owner's message and all ${LONG} steps`);

  // Rail order (failure 11) and rail tree (failures 9, 10).
  const order = await evaluate(`[...document.querySelectorAll('.col .card')].filter(n => n.offsetParent).map(n => n.querySelector('b')?.innerText)`, s);
  if (order.indexOf('Knowledge') < 0 || order.indexOf('Recent results') < 0 || order.indexOf('Knowledge') > order.indexOf('Recent results')) throw Error('Rail order wrong: ' + JSON.stringify(order));
  result.checks.push('O1 rail shows Knowledge before Recent results');
  const rail = await evaluate(`(() => { const card = document.querySelector('#notes'); const r = card.closest('.card').getBoundingClientRect(); return { folders: [...card.querySelectorAll('.tree-folder > summary .tree-name')].map(n => n.innerText), files: [...card.querySelectorAll('.tree-file .tree-name')].map(n => n.innerText), overflow: [...card.querySelectorAll('.tree-file')].some(n => n.getBoundingClientRect().right > r.right + 1), scroll: card.scrollWidth > card.clientWidth + 1 }; })()`, s);
  if (!rail.folders.includes('decisions') || !rail.folders.includes('plans') || !rail.files.includes('issue-95-generic-flow.md') || rail.files.some(f => f.includes('/')) || rail.overflow || rail.scroll) throw Error('Rail knowledge not a tidy tree: ' + JSON.stringify(rail));
  result.checks.push('KT3 rail Knowledge card is a folder tree of file names, long names truncate without overflow');
  await evaluate(`[...document.querySelectorAll('#notes .tree-file')].find(n => n.innerText.includes('issue-95-generic-flow.md')).click()`, s);
  await waitFor(`document.querySelector('#dialog')?.open && document.querySelector('#dialog').innerText.includes('Flow decisions')`, s, 'rail file opens doc');
  await evaluate(`document.querySelector('#dialog [data-action="close-dialog"]').click()`, s);
  result.checks.push('KT4 a rail tree file opens its document');
  await shot('01-rail', s);

  // Knowledge panel tree (failures 7, 8).
  await evaluate(`document.querySelector('[data-tab="knowledge"]').click()`, s);
  await waitFor(`document.querySelectorAll('#knowledge-inline .tree-file').length >= 6`, s, 'knowledge tree');
  const tree = await evaluate(`(() => { const root = document.querySelector('#knowledge-inline'); const folder = name => [...root.querySelectorAll('.tree-folder')].find(n => n.querySelector(':scope > summary .tree-name').innerText === name); const file = name => [...root.querySelectorAll('.tree-file')].find(n => n.querySelector('.tree-name').innerText === name); const depth = n => { let d = 0; for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (p.classList.contains('tree-folder')) d++; return d; }; const legacyFolder = folder('legacy'); return { rootFiles: ['MEMORY.md', 'preferences.md'].map(n => file(n) && depth(file(n))), decisions: file('issue-95-generic-flow.md') && depth(file('issue-95-generic-flow.md')), legacyDepth: legacyFolder && depth(legacyFolder), legacyOpen: legacyFolder?.open, researchOpen: folder('research')?.open, count: folder('plans')?.querySelector(':scope > summary .tree-count')?.innerText, meta: file('issue-95-generic-flow.md')?.innerText, fullPaths: [...root.querySelectorAll('.tree-name')].some(n => n.innerText.includes('/')) }; })()`, s);
  if (JSON.stringify(tree.rootFiles) !== '[0,0]' || tree.decisions !== 1 || tree.legacyDepth !== 1 || tree.legacyOpen !== false || tree.researchOpen !== true || tree.count !== '2' || !/just now|ago/.test(tree.meta ?? '') || tree.fullPaths) throw Error('Knowledge tree wrong: ' + JSON.stringify(tree));
  result.checks.push('KT1 Knowledge panel is a nested folder tree: root files at depth 0, folder files nested, folder counts, relative times');
  await evaluate(`[...document.querySelectorAll('#knowledge-inline .tree-folder > summary')].find(n => n.innerText.includes('plans')).click()`, s);
  const collapsed = await evaluate(`[...document.querySelectorAll('#knowledge-inline .tree-folder')].find(n => n.querySelector(':scope > summary').innerText.includes('plans')).open`, s);
  if (collapsed !== false) throw Error('Folder does not collapse');
  await evaluate(`render()`, s);
  if (await evaluate(`[...document.querySelectorAll('#knowledge-inline .tree-folder')].find(n => n.querySelector(':scope > summary').innerText.includes('plans')).open`, s) !== false) throw Error('Folder state lost on re-render');
  result.checks.push('KT2 folders collapse and stay collapsed across re-render; research/legacy is collapsed by default');
  await shot('02-knowledge-tree', s);
  await evaluate(`document.querySelector('[data-tab="coordinator"]').click()`, s);

  // Live chain (failures 1-4, 6): sample the DOM every 50 ms during a three-step turn.
  await evaluate(`(() => { window.__samples = []; const visible = n => !!n && !n.hidden && n.offsetParent !== null; window.__timer = setInterval(() => { const live = document.querySelector('#live-reply'), pill = document.querySelector('#working-pill'), messages = document.querySelector('#messages').innerText; window.__samples.push({ t: performance.now(), messages, live: visible(live) ? live.innerText : '', status: visible(live) ? live.querySelector('.live-status')?.innerText ?? '' : '', pill: visible(pill) ? pill.innerText : '' }); }, 50); const ta = document.querySelector('#compose textarea'); ta.value = 'MARK-CHAIN check knowledge'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#compose').requestSubmit(); })()`, s);
  await waitFor(`window.__samples.some(x => x.messages.includes('STEP-TWO')) && document.querySelector('#live-reply').innerText.includes('Thinking')`, s, 'stage two committed');
  // Held before the final answer: scroll up and the working pill must appear (failure 3).
  await delay(600);
  await evaluate(`(() => { const t = document.querySelector('#transcript'); t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); })()`, s);
  await waitFor(`!!document.querySelector('#working-pill') && !document.querySelector('#working-pill').hidden`, s, 'working pill while scrolled up', 40);
  await shot('03-scrolled-working', s);
  await evaluate(`document.querySelector('#working-pill').click()`, s);
  await waitFor(`(() => { const t = document.querySelector('#transcript'); return t.scrollHeight - t.scrollTop - t.clientHeight < 40 && document.querySelector('#working-pill').hidden; })()`, s, 'pill returns to latest');
  await shot('04-live-chain', s);
  releaseHold();
  await waitFor(`document.querySelector('#messages').innerText.includes('STEP-FINAL') && document.querySelector('#live-reply').hidden`, s, 'final answer');
  await delay(300);
  const samples = await evaluate(`(clearInterval(window.__timer), window.__samples)`, s);
  result.samples = samples.map(x => ({ t: Math.round(x.t), steps: ['MARK-CHAIN check', 'STEP-ONE', 'STEP-TWO', 'STEP-FINAL'].filter(k => x.messages.includes(k)).length, live: x.live.replace(/\s+/g, ' ').slice(0, 120), pill: x.pill })).filter((x, i, all) => !i || JSON.stringify({ ...x, t: 0 }) !== JSON.stringify({ ...all[i - 1], t: 0 }));
  const seen = key => samples.findIndex(x => x.messages.includes(key) || x.live.includes(key));
  for (const key of ['STEP-ONE', 'STEP-TWO']) {
    const first = seen(key);
    if (first < 0) throw Error(`${key} never shown`);
    const gap = samples.slice(first).find(x => !x.messages.includes(key) && !x.live.includes(key));
    if (gap) throw Error(`${key} vanished mid-turn: ` + JSON.stringify(gap).slice(0, 400));
  }
  result.checks.push('LC1/LC2 streamed step text never vanishes once shown, through tool rounds and refreshes');
  const finalAt = samples.findIndex(x => x.messages.includes('STEP-FINAL'));
  const runStart = samples.findIndex(x => x.messages.includes('MARK-CHAIN check knowledge'));
  const idle = samples.slice(runStart + 4, finalAt).filter(x => !x.status && !x.pill);
  if (runStart < 0 || idle.length) throw Error(`No working indicator in ${idle.length} samples: ` + JSON.stringify(idle[0] ?? {}).slice(0, 400));
  result.checks.push('LC3 a working indicator is visible for the whole run, including while scrolled up');
  if (!samples.some(x => x.live.includes('Planning the check of the index'))) throw Error('Live reasoning summary not shown');
  const thoughts = await evaluate(`[...document.querySelectorAll('#messages .thought')].map(n => n.innerText)`, s);
  if (!thoughts.some(t => t.includes('Planning the check of the index')) || !thoughts.some(t => t.includes('Choosing a document'))) throw Error('Committed thoughts missing: ' + JSON.stringify(thoughts));
  result.checks.push('LC4 reasoning summaries show live and stay as quiet thought lines in the transcript');
  const raw = samples.filter(x => /projects_/.test(x.status + x.pill));
  if (raw.length) throw Error('Raw tool names in live status: ' + JSON.stringify(raw[0]).slice(0, 300));
  result.checks.push('LC6 live status never shows raw tool names');
  const order2 = await evaluate(`(() => { const t = document.querySelector('#messages').innerText; return ['MARK-CHAIN check knowledge', 'Planning the check', 'STEP-ONE', 'Listed knowledge', 'Choosing a document', 'STEP-TWO', 'Read knowledge MEMORY.md', 'STEP-FINAL'].reduce((at, k) => [...at, t.indexOf(k, (at.at(-1) ?? 0) + 1)], []); })()`, s);
  if (order2.some(v => v < 0)) throw Error('Chain out of order: ' + JSON.stringify(order2));
  result.checks.push('LC7 the full chain reads in order: message, thought, text, tool, thought, text, tool, answer');
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  releaseHold?.();
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { if (!hostEnded) { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(10000)]); } } catch { host.kill('SIGKILL'); }
  if (!hostEnded) host.kill('SIGKILL');
  model.closeAllConnections(); model.close(); log.end(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
