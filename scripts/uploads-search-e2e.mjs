// Browser E2E for uploads + knowledge search, with an isolated host and a local fake model. No real providers, no network.
// Failure cases recorded in uploads-search-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `uploads-search-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `uploads-search-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome'), files = join(root, 'files');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome, files]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]').replace(/Bearer [a-f0-9]{64}/g, 'Bearer [redacted]');
writeFileSync(join(workspace, 'README.md'), 'fixture\n');

// Fixtures: a real PDF with text, PNG images (small and > 5 MiB), a > 32 KiB Markdown file, a corrupt PDF.
function pdf(lines) {
  const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function png(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); raw.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
const fixtures = {
  'migration-report.pdf': pdf(['Quantum zebrafish migration report', 'Harmonic tagging results for the estuary study', 'Contact: Dr. Okonkwo']),
  'diagram.png': png(96, 64, (x, y) => [x * 2, 120 + y, 200 - x]),
  'big-photo.png': png(1400, 1300, () => [...randomBytes(3)]),
  'field-notes.md': Buffer.from(`# Field notes\n\n${'The river was calm and the boats were moored. '.repeat(1200)}\n\nOne zebrafish was seen near the dock.\n\n${'Weather notes repeat every day. '.repeat(600)}`),
  'broken.pdf': Buffer.from('%PDF-1.4 this is not really a pdf'),
  'dropped-snippet.ts': Buffer.from('export const ostrichSpeed = 70; // km/h, the dropped file\n'),
  'composer-drop.txt': Buffer.from('flamingo roster for the composer drop\n'),
};
for (const [name, bytes] of Object.entries(fixtures)) writeFileSync(join(files, name), bytes);

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
const firstHit = results => JSON.parse(results.at(-1)).results[0];
// Coordinator turns scripted by marker; a step may be a function of earlier tool results.
const scripts = {
  'MARK-SEARCH': [['projects_search', { query: 'zebrafish quantum' }], results => ['projects_upload_read', { uploadId: firstHit(results).uploadId, offset: firstHit(results).offset, limit: 400 }]],
  'MARK-STOP': [['projects_search', { query: 'the and of' }]],
  'MARK-DELEG': [['projects_delegate', { role: 'scout', task: 'MARK-WSEARCH find the pelican notes' }]],
  'MARK-CHAT2': [['projects_search', { query: 'ostrich' }]],
  'MARK-PENGUIN': [['projects_search', { query: 'penguin' }]],
  'MARK-AFTER': [['projects_search', { query: 'zebrafish' }], ['projects_upload_list', {}]],
  'MARK-GONE': [['projects_search', { query: 'zebrafish quantum' }]],
};
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', async () => {
    const input = JSON.parse(body), msgs = input.messages;
    const tools = (input.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
    const coordinator = tools.includes('projects_delegate');
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const userText = contentText(msgs[lastUser]?.content);
    const images = Array.isArray(msgs[lastUser]?.content) ? msgs[lastUser].content.filter(part => part.type === 'image_url').map(part => part.image_url.url.slice(0, 40)) : [];
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    result.calls.push({ model: input.model, coordinator, marker, stage: results.length, tools, user: userText.slice(-1500), images, results: results.map(r => r.slice(0, 3000)) });
    const reply = text => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
    if (!coordinator) {
      if (marker === 'MARK-WSEARCH' && results.length === 0) return reply(call('projects_search', { query: 'pelican' }));
      return reply(say(marker === 'MARK-WSEARCH' ? `WORKER-FOUND ${firstHit(results)?.path ?? 'nothing'}` : `Worker ${marker}`));
    }
    if (userText.startsWith('[Durable work')) return reply(say(`REPORT-ACK ${/WORKER-FOUND research\/pelican-notes\.md/.test(userText) ? 'found' : 'missing'}`));
    const steps = scripts[marker] ?? [];
    if (results.length < steps.length) { const step = steps[results.length]; return reply(call(...(typeof step === 'function' ? step(results) : step))); }
    return reply(say(`Done ${marker}.`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [
  { id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 },
  { id: 'fake-vision', name: 'Fake vision', reasoning: false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096 },
] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, HOME: userHome, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'wx', mode: 0o600 });
let host, hostEnded = true, hostExit = Promise.resolve();
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
async function startHost() {
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
  hostEnded = false; hostExit = new Promise(ok => host.once('exit', () => { hostEnded = true; ok(); }));
  await eventually(async () => { if (hostEnded) throw Error('Host exited'); try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
}
async function stopHost() { await rpc({ action: 'shutdown' }); await Promise.race([hostExit, delay(15000)]); if (!hostEnded) throw Error('Host did not stop'); }
const rejects = async (input, pattern, label) => { try { await rpc(input); } catch (error) { if (pattern.test(error.message)) return error.message; throw Error(`${label}: wrong error ${error.message}`); } throw Error(`${label}: accepted`); };

let chrome, cdpEnded = false, cdpId = 0, buffer = ''; const pending = new Map();
function startChrome() {
  const clog = createWriteStream(join(artifacts, 'chrome.log'), { flags: 'a', mode: 0o600 });
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
async function setFiles(session, selector, names) {
  const { root: doc } = await send('DOM.getDocument', { depth: 1 }, session);
  const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector }, session);
  await send('DOM.setFileInputFiles', { nodeId, files: names.map(name => join(files, name)) }, session);
}
// A real DragEvent with a DataTransfer carrying a File, dropped on the given element.
const drop = (session, selector, name, text) => evaluate(`(() => { const zone = document.querySelector(${JSON.stringify(selector)}); const data = new DataTransfer(); data.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'text/plain' })); zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data })); const dragging = zone.closest('.dragging') !== null || zone.querySelector('.dragging') !== null || zone.classList.contains('dragging'); zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); return dragging; })()`, session);

const settle = async (id, chatId, job) => eventually(async () => { const view = await rpc({ action: 'show', id, chatId }); const found = view.jobs.find(j => j.id === job.id); return ['done', 'failed', 'interrupted'].includes(found?.state) && found; }, 'Job did not settle');
const ask = async (id, chatId, text, extra = {}) => { const job = await rpc({ action: 'message', id, text, ...(chatId ? { chatId } : {}), ...extra }); const done = await settle(id, chatId, job); if (done.state !== 'done') throw Error(`${text} failed: ${done.error}`); return done; };
const turns = marker => result.calls.filter(call => call.coordinator && call.marker === marker);
const click = (s, selector) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw Error('missing ' + ${JSON.stringify(selector)}); n.click(); })()`, s);
const setComposer = (s, value) => evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
let webOrigin = '', webToken = '';
async function upload(id, name, bytes, headers = {}) {
  const response = await fetch(`${webOrigin}/upload?project=${id}`, { method: 'POST', headers: { authorization: `Bearer ${webToken}`, 'x-filename': encodeURIComponent(name), ...headers }, body: bytes }).catch(error => ({ status: 0, error }));
  const reply = response.json ? await response.json().catch(() => null) : null;
  return { status: response.status, reply, error: response.error?.cause?.message ?? response.error?.message };
}
try {
  await startHost();
  const create = async (name, coordinator) => {
    const project = await rpc({ action: 'create', requestId: randomUUID(), name, cwd: workspace, objective: 'Disposable uploads fixture', model: coordinator });
    const settings = await rpc({ action: 'settings-snapshot', id: project.id });
    await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
    return project.id;
  };
  const id = await create('Uploads fixture', 'fake/fake-vision'), textOnly = await create('Text-only fixture', 'fake/fake-model');
  const web = await rpc({ action: 'web' });
  webOrigin = new URL(web.url).origin; webToken = new URL(web.url).hash.slice('#token='.length);

  // U1-U5, U8, U9, U11: the upload endpoint.
  const noToken = await fetch(`${webOrigin}/upload?project=${id}`, { method: 'POST', headers: { 'x-filename': 'a.txt' }, body: 'x' });
  const crossOrigin = await upload(id, 'a.txt', 'x', { origin: 'http://evil.example' });
  if (noToken.status !== 401 || crossOrigin.status !== 403) throw Error(`Upload auth wrong: ${noToken.status} ${crossOrigin.status}`);
  const bad = {};
  for (const [label, name, bytes] of [['empty', 'empty.txt', Buffer.alloc(0)], ['path', '../evil.txt', 'x'], ['slash', 'a/b.txt', 'x'], ['control', 'a\u0001.txt', 'x'], ['long', 'x'.repeat(241), 'x'], ['binary', 'archive.zip', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from([0, 0, 255, 254, 0, 1])])], ['oversized', 'huge.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 97)]]) {
    const r = await upload(id, name, bytes); bad[label] = { status: r.status, error: r.reply?.error ?? String(r.error ?? '') };
    if (r.status === 200) throw Error(`Upload ${label} accepted`);
  }
  if (bad.oversized.status !== 413 && bad.oversized.status !== 0) throw Error('Oversized upload not refused with 413: ' + JSON.stringify(bad.oversized));
  if (!/Unsupported file type/.test(bad.binary.error) || !/empty/.test(bad.empty.error) || !/plain file name/.test(bad.path.error)) throw Error('Upload errors unclear: ' + JSON.stringify(bad));
  const unknownProject = await upload(randomUUID(), 'a.txt', 'x');
  if (unknownProject.status === 200) throw Error('Upload to unknown project accepted');
  if ((await rpc({ action: 'upload-list', id })).length !== 0) throw Error('Refused uploads were stored');
  result.uploadRefusals = bad;
  result.checks.push('U1-U4/U8 uploads need the bearer token and same origin; empty, path-like, control-char, over-long, binary, unknown-project and >20 MiB files are refused and nothing is stored');
  const fakePng = await upload(id, 'not-really.png', 'just text in a png name\n');
  if (fakePng.status !== 200 || fakePng.reply.data.kind !== 'text') throw Error('Extension trusted over magic bytes: ' + JSON.stringify(fakePng.reply));
  const again = await upload(id, 'not-really.png', 'just text in a png name\n');
  if (again.reply.data.id !== fakePng.reply.data.id || (await rpc({ action: 'upload-list', id })).length !== 1) throw Error('Identical re-upload duplicated');
  result.checks.push('U5/U9 the kind comes from magic bytes, not the extension; re-uploading identical name+bytes returns the same upload');

  // Browser: Knowledge tab upload via the file picker, then drop.
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'knowledge');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable', 'DOM.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#title')?.innerText === 'Uploads fixture' && !!document.querySelector('[data-action="upload-pick"]') && !document.querySelector('[data-panel="knowledge"]').hidden`, s, 'knowledge tab');
  await setFiles(s, '#upload-input', ['migration-report.pdf', 'diagram.png', 'field-notes.md', 'broken.pdf', 'big-photo.png']);
  await waitFor(`document.querySelectorAll('#uploads-inline .upload-row').length === 6`, s, 'picker uploads listed', 400);
  const listed = await rpc({ action: 'upload-list', id });
  const byName = Object.fromEntries(listed.map(item => [item.filename, item]));
  const notes = byName['field-notes.md'], report = byName['migration-report.pdf'], diagram = byName['diagram.png'], broken = byName['broken.pdf'], big = byName['big-photo.png'];
  if (notes?.kind !== 'text' || notes.size <= 32768 || report?.kind !== 'pdf' || report.extractError || !(report.textChars > 20) || diagram?.kind !== 'image' || diagram.mime !== 'image/png' || broken?.kind !== 'pdf' || !/PDF text extraction failed/.test(broken.extractError ?? '') || big?.kind !== 'image' || !(big.size > 5 * 1024 * 1024)) throw Error('Stored uploads wrong: ' + JSON.stringify(listed));
  result.uploads = listed.map(({ filename, kind, size, textChars, extractError }) => ({ filename, kind, size, textChars, extractError }));
  result.checks.push(`U6/U11/K2 the Knowledge picker uploads a ${notes.size}-byte Markdown file (old cap 32 KiB), a PDF with extracted text, PNGs (one ${big.size} bytes) and a corrupt PDF stored with an extraction error`);
  const dropped = await drop(s, '[data-panel="knowledge"] #uploads-inline', 'dropped-snippet.ts', fixtures['dropped-snippet.ts'].toString());
  await waitFor(`[...document.querySelectorAll('#uploads-inline .upload-row')].some(n => n.innerText.includes('dropped-snippet.ts'))`, s, 'dropped file listed');
  if (!dropped) throw Error('Drop zone not highlighted on dragover');
  result.checks.push('K2 a file dropped on the Knowledge tab is highlighted on dragover and uploaded');
  await shot('01-knowledge-uploads', s);

  // K1: view the image and the PDF text.
  await click(s, `#uploads-inline [data-upload="${diagram.id}"]`);
  await waitFor(`document.querySelector('#dialog img.upload-image')?.naturalWidth === 96`, s, 'image viewer');
  await shot('02-image-viewer', s);
  await click(s, '#dialog [data-action="close-dialog"]');
  await click(s, `#uploads-inline [data-upload="${report.id}"]`);
  await waitFor(`document.querySelector('#dialog .upload-text')?.innerText.includes('Quantum zebrafish migration report')`, s, 'pdf text viewer');
  await shot('03-pdf-text-viewer', s);
  await click(s, '#dialog [data-action="close-dialog"]');
  result.checks.push('K1 the image renders in the viewer and the PDF shows its extracted text');

  // S1/S2/S3/S6: the coordinator searches; the PDF with both rare terms ranks first; the hit opens at its offset.
  await rpc({ action: 'knowledge-write', id, path: 'research/pelican-notes.md', text: '# Pelicans\n\nThe pelican colony nests on the north spit.\n', expectedRevision: null });
  await ask(id, undefined, 'MARK-SEARCH find the zebrafish report');
  const searched = turns('MARK-SEARCH').at(-1), hits = JSON.parse(searched.results[0]).results;
  if (!searched.tools.includes('projects_search') || !searched.tools.includes('projects_upload_read') || !searched.tools.includes('projects_upload_list')) throw Error('Coordinator lacks search tools: ' + searched.tools);
  if (hits[0]?.source !== 'upload' || hits[0].uploadId !== report.id || !hits.some(hit => hit.uploadId === notes.id) || hits.findIndex(hit => hit.uploadId === notes.id) < 1 || !hits.every(hit => typeof hit.offset === 'number' && hit.snippet.length <= 330)) throw Error('Ranking/shape wrong: ' + JSON.stringify(hits));
  const read = JSON.parse(searched.results[1]);
  if (!read.text.includes('zebrafish') || read.record.id !== report.id || read.text.length > 400) throw Error('Upload read wrong: ' + searched.results[1]);
  result.search = hits.map(hit => ({ source: hit.source, name: hit.filename ?? hit.path, score: hit.score }));
  result.checks.push('S1/S2/S3/S6 the coordinator finds the PDF first for "zebrafish quantum" (BM25, the long Markdown with one mention ranks lower), with bounded snippets and offsets, then reads that range');
  await ask(id, undefined, 'MARK-STOP common words');
  if (!/at least one word/.test(turns('MARK-STOP').at(-1).results[0])) throw Error('Stop-word query not explained: ' + turns('MARK-STOP').at(-1).results[0]);
  result.checks.push('S4 a stop-word-only query returns a clear error, not everything');
  const uuidRead = await rejects({ action: 'upload-read', id, uploadId: randomUUID() }, /Unknown upload/, 'unknown upload read');
  await rejects({ action: 'upload-read', id: textOnly, uploadId: report.id }, /Unknown upload/, 'cross-project upload read');
  result.checks.push(`S6/C5 an unknown or other-project upload ID is refused (${uuidRead})`);

  // S1/S7: a scout (worker) searches knowledge too, with no library grant.
  if ((await rpc({ action: 'show', id })).project.libraryAccess === 'coordinator') throw Error('Fixture unexpectedly has the library grant');
  await ask(id, undefined, 'MARK-DELEG scout the pelicans');
  await eventually(async () => (await rpc({ action: 'show', id })).messages.some(m => /REPORT-ACK/.test(m.text)), 'Scout report did not arrive', 900);
  const worker = result.calls.find(c => !c.coordinator && c.marker === 'MARK-WSEARCH' && c.stage === 1);
  if (!worker?.tools.includes('projects_search') || !worker.tools.includes('projects_upload_read') || worker.tools.includes('projects_library_read')) throw Error('Worker tools wrong: ' + worker?.tools);
  if (!(await rpc({ action: 'show', id })).messages.some(m => m.text === 'REPORT-ACK found')) throw Error('Worker search did not find the knowledge doc');
  result.checks.push('S1/S7 a scout gets projects_search/projects_upload_read without the library grant and finds research/pelican-notes.md');

  // C1-C3/C6: composer attachments, picker + drop; the image goes to the vision model as image content.
  await click(s, '[data-tab="coordinator"]');
  await waitFor(`!document.querySelector('[data-panel="coordinator"]').hidden && !document.querySelector('#compose textarea').disabled`, s, 'coordinator tab');
  await setFiles(s, '#attach-input', ['diagram.png']);
  const composerDrop = await drop(s, '#compose textarea', 'composer-drop.txt', fixtures['composer-drop.txt'].toString());
  await waitFor(`document.querySelectorAll('#attachments .attach-chip:not(.pending)').length === 2 && !document.querySelector('#attachments').hidden`, s, 'two composer chips');
  if (!composerDrop) throw Error('Composer not highlighted on dragover');
  await shot('04-composer-attachments', s);
  await setComposer(s, 'MARK-IMG what is in this diagram?');
  await evaluate(`document.querySelector('#compose').requestSubmit()`, s);
  await waitFor(`document.querySelector('#messages').innerText.includes('Done MARK-IMG.') && document.querySelectorAll('#messages .msg.you .attach-chip').length === 2`, s, 'sent with chips');
  if (await evaluate(`document.querySelector('#attachments').hidden && document.querySelectorAll('#attachments .attach-chip').length === 0`, s) !== true) throw Error('Composer chips not cleared after send');
  const imageTurn = turns('MARK-IMG').at(-1);
  if (imageTurn.images.length !== 1 || !imageTurn.images[0].startsWith('data:image/png;base64,') || !imageTurn.user.includes('[Attached files:') || !imageTurn.user.includes(`upload ${diagram.id} · image attached`) || !/composer-drop\.txt · text · \d+ bytes · upload [a-f0-9-]{36}/.test(imageTurn.user)) throw Error('Vision turn wrong: ' + JSON.stringify(imageTurn));
  const chipText = await evaluate(`[...document.querySelectorAll('#messages .msg.you .attach-chip')].map(n => n.innerText.replace(/\\s+/g, ' ')).join(' | ')`, s);
  if (!chipText.includes('diagram.png') || !chipText.includes('composer-drop.txt') || (await evaluate(`[...document.querySelectorAll('#messages .msg.you .text')].at(-1).innerText`, s)).includes('[Attached files')) throw Error('Transcript chips wrong: ' + chipText);
  const labels = await evaluate(`document.querySelector('#messages').innerText`, s);
  if (!labels.includes('Searched knowledge for “zebrafish quantum”') || !labels.includes('Read upload migration-report.pdf')) throw Error('Search tool rows lack human labels');
  await shot('05-transcript-attachment-chips', s);
  await click(s, `#messages .msg.you .attach-chip[data-upload="${diagram.id}"]`);
  await waitFor(`document.querySelector('#dialog img.upload-image')?.naturalWidth === 96`, s, 'image from transcript chip');
  await click(s, '#dialog [data-action="close-dialog"]');
  result.checks.push('C1/C2/C3/C6 picker + drop attach in the composer; the vision coordinator gets the PNG as image content plus a named reference block; chips render in the transcript, open the image, and clear from the composer');

  // C4: an image > 5 MiB is a stored reference only. C3: a text-only coordinator gets no image parts.
  await ask(id, undefined, 'MARK-BIG large photo', { attachments: [big.id] });
  const bigTurn = turns('MARK-BIG').at(-1);
  if (bigTurn.images.length !== 0 || !bigTurn.user.includes(`upload ${big.id}`) || bigTurn.user.includes(`${big.id} · image attached`)) throw Error('Large image inlined: ' + JSON.stringify(bigTurn));
  const own = await upload(textOnly, 'diagram.png', fixtures['diagram.png']);
  await ask(textOnly, undefined, 'MARK-TEXTONLY see image', { attachments: [own.reply.data.id] });
  const textTurn = turns('MARK-TEXTONLY').at(-1);
  if (textTurn.model !== 'fake-model' || textTurn.images.length !== 0 || !textTurn.user.includes(`upload ${own.reply.data.id}`) || textTurn.user.includes('image attached')) throw Error('Text-only model got an image: ' + JSON.stringify(textTurn));
  await rejects({ action: 'message', id, text: 'MARK-NOPE', attachments: [randomUUID()] }, /Unknown upload/, 'foreign attachment');
  await rejects({ action: 'message', id: textOnly, text: 'MARK-NOPE', attachments: [diagram.id] }, /Unknown upload/, 'other project attachment');
  result.checks.push('C3/C4/C5 a >5 MiB image and any image to a text-only coordinator are references only; attachment IDs from nowhere or another project are refused');

  // S1: chats other than Main search too.
  const chat = await rpc({ action: 'chat-create', id, title: 'Second' });
  await ask(id, chat.id, 'MARK-CHAT2 find the ostrich');
  const chatTurn = turns('MARK-CHAT2').at(-1);
  if (JSON.parse(chatTurn.results[0]).results[0]?.filename !== 'dropped-snippet.ts') throw Error('Chat search wrong: ' + chatTurn.results[0]);
  result.checks.push('S1 a second chat has projects_search and finds the dropped code file');

  // S5: an edited knowledge document is searchable at once.
  const pelican = await rpc({ action: 'knowledge-read', id, path: 'research/pelican-notes.md' });
  await rpc({ action: 'knowledge-write', id, path: 'research/pelican-notes.md', text: pelican.text + '\nA penguin visited once.\n', expectedRevision: pelican.revision });
  await ask(id, undefined, 'MARK-PENGUIN');
  if (JSON.parse(turns('MARK-PENGUIN').at(-1).results[0]).results[0]?.path !== 'research/pelican-notes.md') throw Error('Edited knowledge not searchable');
  result.checks.push('S5 an edited knowledge document is found by its new words');

  // U10/S1: restart keeps uploads; the reopened coordinator still has the tools.
  await send('Browser.close').catch(() => {}); await delay(500); if (!cdpEnded) chrome.kill('SIGTERM');
  await stopHost(); await startHost();
  const after = await rpc({ action: 'show', id });
  if (after.uploads?.length !== listed.length + 2) throw Error('Uploads lost on restart: ' + after.uploads?.length);
  await ask(id, undefined, 'MARK-AFTER restart');
  const afterTurn = turns('MARK-AFTER').at(-1);
  if (!afterTurn.tools.includes('projects_search') || JSON.parse(afterTurn.results[0]).results[0]?.uploadId !== report.id || JSON.parse(afterTurn.results[1]).total !== listed.length + 2) throw Error('After restart wrong: ' + JSON.stringify(afterTurn.results.map(r => r.slice(0, 300))));
  result.checks.push('U10/S1 after a host restart uploads, extracted text and search tools remain');

  // K3/S5: deleting in the UI removes it from search.
  cdpEnded = false; buffer = ''; startChrome();
  const relaunch = new URL((await rpc({ action: 'web' })).url); relaunch.searchParams.set('project', id); relaunch.searchParams.set('tab', 'knowledge');
  const { targetId: t2 } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s2 } = await send('Target.attachToTarget', { targetId: t2, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s2);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s2);
  await send('Page.navigate', { url: relaunch.toString() }, s2);
  await waitFor(`!!document.querySelector('#uploads-inline [data-upload="${report.id}"]')`, s2, 'uploads after restart');
  await click(s2, `#uploads-inline [data-upload="${report.id}"]`);
  await waitFor(`!!document.querySelector('#dialog [data-action="upload-delete"]')`, s2, 'viewer with delete');
  await click(s2, '#dialog [data-action="upload-delete"]');
  await waitFor(`!document.querySelector('#uploads-inline [data-upload="${report.id}"]')`, s2, 'deleted from list');
  await ask(id, undefined, 'MARK-GONE');
  if (JSON.parse(turns('MARK-GONE').at(-1).results[0]).results.some(hit => hit.uploadId === report.id)) throw Error('Deleted upload still searchable');
  result.checks.push('K3/S5 deleting an upload in the viewer removes it from the list and from search');

  // K4: 390px.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s2);
  await delay(500);
  const layout = await evaluate(`({ viewport: innerWidth, docWidth: document.documentElement.scrollWidth, rows: [...document.querySelectorAll('#uploads-inline .upload-row')].map(n => n.getBoundingClientRect().right) })`, s2);
  if (layout.docWidth > layout.viewport || layout.rows.some(right => right > layout.viewport + 0.5)) throw Error('Uploads overflow at 390px: ' + JSON.stringify(layout));
  await shot('06-knowledge-uploads-390', s2);
  await click(s2, '[data-tab="coordinator"]');
  await delay(500);
  await shot('07-composer-390', s2);
  result.checks.push('K4 the uploads list fits a 390px viewport');

  result.httpErrors = result.httpErrors.filter(e => !e.url.endsWith('/live'));
  if (result.errors.length || result.httpErrors.length) throw Error('Browser errors captured: ' + JSON.stringify({ errors: result.errors, http: result.httpErrors }));
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
} finally {
  if (chrome && !cdpEnded) { try { await send('Browser.close'); } catch {} await delay(500); if (!cdpEnded) chrome.kill('SIGTERM'); }
  try { if (!hostEnded) await stopHost(); } catch { host?.kill('SIGKILL'); }
  model.closeAllConnections(); model.close(); log.end(); save();
}
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
