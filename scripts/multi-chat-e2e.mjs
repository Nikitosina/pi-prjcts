// Browser E2E with an isolated host and a local fake model. No real providers, no network.
// Failure cases recorded in multi-chat-failures.md before implementation.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `multi-chat-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `multi-chat-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent'), userHome = join(root, 'userhome');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
writeFileSync(join(workspace, 'README.md'), 'fixture\n');

const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const contentText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : JSON.stringify(content ?? '');
// Coordinator turns are scripted by marker; each step sees earlier tool results.
const scripts = {
  'MARK-DELEG': [['projects_delegate', { role: 'scout', task: 'MARK-SCOUTJOB look around' }], ['projects_workers', {}]],
  'MARK-ASK': [['projects_question', { question: 'Pick a colour for chat two?', choices: ['red', 'blue'] }]],
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
    const history = msgs.filter(m => m.role === 'user').map(m => contentText(m.content)).join('\n');
    const marker = /MARK-[A-Z0-9]+/.exec(userText)?.[0] ?? 'none';
    const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(m => contentText(m.content));
    result.calls.push({ coordinator, marker, stage: results.length, tools, user: userText.slice(0, 600), history: history.slice(-3000), results });
    const reply = text => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
    if (!coordinator) return reply(say(marker === 'MARK-SCOUTJOB' ? 'SCOUT-RESULT-42' : `Worker ${marker}`));
    if (userText.startsWith('[Durable work')) return reply(say(`REPORT-ACK ${userText.includes('SCOUT-RESULT-42') ? 'with-result' : 'no-result'}`));
    if (userText.startsWith('Owner answered your question')) return reply(say('ANSWER-ACK'));
    if (marker === 'MARK-SLOW') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }, null));
      for (let i = 0; i < 12; i++) { await delay(500); if (res.destroyed) return; res.write(chunk({ content: `STREAM-LINE-${i}\n\n` }, null)); }
      res.end(chunk({ content: 'STREAM-END' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    const steps = scripts[marker] ?? [];
    if (results.length < steps.length) return reply(call(...steps[results.length]));
    return reply(say(`Done ${marker}.`));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
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

const settle = async (id, chatId, job) => eventually(async () => { const view = await rpc({ action: 'show', id, chatId }); const found = view.jobs.find(j => j.id === job.id); return ['done', 'failed', 'interrupted'].includes(found?.state) && found; }, 'Job did not settle');
const ask = async (id, chatId, text) => { const job = await rpc({ action: 'message', id, text, ...(chatId ? { chatId } : {}) }); const done = await settle(id, chatId, job); if (done.state !== 'done') throw Error(`${text} failed: ${done.error}`); return done; };
const turns = marker => result.calls.filter(call => call.coordinator && call.marker === marker);
const transcript = async (id, chatId) => (await rpc({ action: 'show', id, chatId })).messages.map(m => m.text).join('\n');
const chatButtons = s => evaluate(`[...document.querySelectorAll('#chat-list .chat')].map(n => ({ id: n.dataset.chat, title: n.querySelector('.chat-title')?.innerText ?? '', on: n.classList.contains('on') }))`, s);
const setComposer = (s, value) => evaluate(`(() => { const t = document.querySelector('#compose textarea'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, s);
const click = (s, selector) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) throw Error('missing ' + ${JSON.stringify(selector)}); n.click(); })()`, s);
try {
  await startHost();
  const project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Chats fixture', cwd: workspace, objective: 'Disposable multi-chat fixture', model: 'fake/fake-model' });
  const id = project.id;
  const settings = await rpc({ action: 'settings-snapshot', id });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });

  // F1: an existing project (no stored chat list) opens with exactly Main, the root conversation; no chatId means Main.
  await ask(id, undefined, 'MARK-MAIN hello main');
  const first = await rpc({ action: 'show', id });
  if (!Array.isArray(first.chats) || first.chats.length !== 1 || first.chats[0].id !== 'main' || first.chats[0].title !== 'Main' || first.chatId !== 'main') throw Error('Default chat list wrong: ' + JSON.stringify(first.chats));
  if (!first.messages.some(m => m.text === 'Done MARK-MAIN.') || first.durableInspection.coordinator.conversationId !== first.durableInspection.identity.coordinatorConversationId) throw Error('Main is not the root transcript');
  result.checks.push('F1 a project without a chat list opens with one chat, Main, on the existing root conversation and transcript');
  await rejects({ action: 'show', id, chatId: randomUUID() }, /Unknown chat/, 'unknown chat');
  await rejects({ action: 'message', id, chatId: randomUUID(), text: 'x' }, /Unknown chat/, 'unknown chat message');
  result.checks.push('F4 unknown chat IDs are refused for show and message');

  const web = await rpc({ action: 'web' });
  const launch = new URL(web.url); launch.searchParams.set('project', id); launch.searchParams.set('tab', 'coordinator');
  startChrome();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(method, {}, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url: launch.toString() }, s);
  await waitFor(`document.querySelector('#title')?.innerText === 'Chats fixture' && document.querySelector('#messages').innerText.includes('Done MARK-MAIN')`, s, 'project loaded');
  const initial = await chatButtons(s);
  if (initial.length !== 1 || initial[0].title !== 'Main' || !initial[0].on) throw Error('Chat list wrong: ' + JSON.stringify(initial));

  // F2/F12: a new chat is its own conversation, selected, with an empty transcript; the URL carries it.
  await click(s, '[data-action="chat-new"]');
  await waitFor(`document.querySelectorAll('#chat-list .chat').length === 2 && document.querySelector('#chat-list .chat.on')?.dataset.chat !== 'main'`, s, 'new chat selected');
  const chatId = await evaluate(`document.querySelector('#chat-list .chat.on').dataset.chat`, s);
  await waitFor(`!document.querySelector('#messages').innerText.includes('MARK-MAIN')`, s, 'empty new chat');
  if (new URL(await evaluate('location.href', s)).searchParams.get('chat') !== chatId) throw Error('URL does not carry the chat');
  result.checks.push('F2/F12/F15 New chat creates and selects an empty chat; the URL names it');
  await shot('01-new-chat', s);

  // F5/F6/F8: delegate from the new chat; the report returns there and only there; coordinator-only tools work there.
  await setComposer(s, 'MARK-DELEG please scout');
  await evaluate(`document.querySelector('#compose').requestSubmit()`, s);
  await waitFor(`document.querySelector('#messages').innerText.includes('REPORT-ACK')`, s, 'report in chat two', 400);
  const deleg = turns('MARK-DELEG').at(-1), mainTurn = turns('MARK-MAIN')[0];
  if (JSON.stringify([...deleg.tools].sort()) !== JSON.stringify([...mainTurn.tools].sort())) throw Error('Chat tools differ from Main: ' + JSON.stringify({ chat: deleg.tools, main: mainTurn.tools }));
  if (deleg.history.includes('MARK-MAIN')) throw Error('Chat two saw Main history');
  const [receipt, workers] = deleg.results;
  if (/coordinator-only|Error/.test(receipt + workers) || !JSON.parse(workers).work?.length) throw Error('Coordinator tools refused in chat two: ' + receipt + workers);
  result.checks.push('F5/F6 a new chat gets the same coordinator tools and they are authorized there; history is separate');
  const report = result.calls.find(c => c.coordinator && c.user.startsWith('[Durable work'));
  if (!report.user.includes('SCOUT-RESULT-42') || !report.history.includes('MARK-DELEG') || report.history.includes('MARK-MAIN')) throw Error('Report reached the wrong conversation: ' + report.history.slice(-400));
  const card = await evaluate(`[...document.querySelectorAll('#messages details.report summary')].map(n => n.innerText).join('|')`, s);
  if (!/Scout report/.test(card)) throw Error('Report card missing in chat two: ' + card);
  const mainText = await transcript(id, 'main');
  if (mainText.includes('[Durable work') || mainText.includes('REPORT-ACK')) throw Error('Report also went to Main');
  result.checks.push('F8 the worker report goes to the delegating chat only and renders as a report card there');
  await shot('02-report-in-chat', s);

  // F6/F16: the shared worker pool is one plan; Activity lists the chat's work.
  const plan = await rpc({ action: 'plan-snapshot', id });
  if (plan.work.length !== 1 || !plan.work[0].text.includes('MARK-SCOUTJOB')) throw Error('Plan wrong: ' + JSON.stringify(plan.work));
  await click(s, '[data-tab="activity"]');
  await waitFor(`document.querySelector('#work-list').innerText.includes('MARK-SCOUTJOB')`, s, 'activity lists chat work');
  result.checks.push('F6/F16 work delegated from a chat lands in the one shared plan and the Activity tab');
  await click(s, '[data-tab="coordinator"]');

  // F12: drafts are per chat.
  await setComposer(s, 'draft-for-chat-two');
  await click(s, '#chat-list .chat[data-chat="main"]');
  await waitFor(`document.querySelector('#messages').innerText.includes('Done MARK-MAIN')`, s, 'main selected');
  if (await evaluate(`document.querySelector('#compose textarea').value`, s) !== '') throw Error('Draft leaked to Main');
  await click(s, `#chat-list .chat[data-chat="${chatId}"]`);
  await waitFor(`document.querySelector('#messages').innerText.includes('REPORT-ACK') && !document.querySelector('#messages').innerText.includes('Done MARK-MAIN')`, s, 'chat two selected');
  if (await evaluate(`document.querySelector('#compose textarea').value`, s) !== 'draft-for-chat-two') throw Error('Chat draft lost');
  await setComposer(s, '');
  result.checks.push('F12 switching chats swaps transcript and keeps a draft per chat');

  // F13: the live bubble belongs to its chat.
  const slow = await rpc({ action: 'message', id, chatId, text: 'MARK-SLOW stream please' });
  await waitFor(`!document.querySelector('#live-reply').hidden && document.querySelector('#live-reply').innerText.includes('STREAM-LINE')`, s, 'live bubble in chat two');
  await click(s, '#chat-list .chat[data-chat="main"]');
  await waitFor(`document.querySelector('#messages').innerText.includes('Done MARK-MAIN')`, s, 'main selected during stream');
  for (let i = 0; i < 6; i++) { if (!(await evaluate(`document.querySelector('#live-reply').hidden`, s))) throw Error('Chat two stream shown in Main'); await delay(250); }
  const busyList = (await rpc({ action: 'show', id })).chats;
  if (!busyList.find(c => c.id === chatId)?.busy || busyList.find(c => c.id === 'main').busy) throw Error('Chat busy flags wrong: ' + JSON.stringify(busyList));
  await shot('03-main-while-chat-streams', s);
  result.checks.push('F13 the live stream of one chat never shows in another; the chat list marks the busy chat');
  await settle(id, chatId, slow);
  await click(s, `#chat-list .chat[data-chat="${chatId}"]`);
  await waitFor(`document.querySelector('#messages').innerText.includes('STREAM-END')`, s, 'stream committed');

  // F10: an answer to a question asked in chat two wakes chat two.
  await ask(id, chatId, 'MARK-ASK need a decision');
  const question = (await rpc({ action: 'show', id })).inbox.find(item => item.kind === 'question' && !item.result);
  await rpc({ action: 'answer', id, entry: question.id, text: 'blue' });
  await eventually(async () => (await transcript(id, chatId)).includes('ANSWER-ACK'), 'Answer did not reach chat two');
  if ((await transcript(id, 'main')).includes('Owner answered')) throw Error('Answer went to Main');
  result.checks.push('F10 an owner answer wakes the chat that asked');

  // F14: rename persists and shows; reload keeps chat and title (F15).
  await click(s, '[data-action="chat-rename"]');
  await waitFor(`!!document.querySelector('#dialog form[data-chat-rename] input[name="title"]')`, s, 'rename dialog');
  await evaluate(`(() => { const f = document.querySelector('#dialog form[data-chat-rename]'); f.querySelector('input[name="title"]').value = 'Research'; f.requestSubmit(); })()`, s);
  await waitFor(`document.querySelector('#chat-list .chat.on .chat-title')?.innerText === 'Research'`, s, 'renamed');
  await send('Page.reload', {}, s);
  await waitFor(`document.querySelector('#chat-list .chat.on')?.dataset.chat === ${JSON.stringify(chatId)} && document.querySelector('#chat-list .chat.on .chat-title')?.innerText === 'Research' && document.querySelector('#messages').innerText.includes('ANSWER-ACK')`, s, 'reload keeps chat');
  result.checks.push('F14/F15 rename persists; reload keeps the selected chat');
  await shot('04-renamed', s);

  // F14/F18: archive hides the chat, returns to Main and refuses messages; Main cannot be archived.
  await click(s, '[data-action="chat-archive"]');
  await waitFor(`document.querySelectorAll('#chat-list .chat').length === 1 && document.querySelector('#chat-list .chat.on')?.dataset.chat === 'main' && document.querySelector('#chat-archived')?.textContent.includes('Research')`, s, 'archived');
  await rejects({ action: 'message', id, chatId, text: 'MARK-NOPE' }, /archived/i, 'archived chat message');
  await rejects({ action: 'chat-update', id, chatId: 'main', archived: true }, /Main/, 'archive main');
  result.checks.push('F14/F18 archive hides the chat and refuses its messages; Main cannot be archived');
  await shot('05-archived', s);

  // F3: restart keeps chats, titles, transcripts and coordinator tools.
  await send('Browser.close').catch(() => {}); await delay(500); if (!cdpEnded) chrome.kill('SIGTERM');
  await stopHost(); await startHost();
  const restarted = await rpc({ action: 'show', id, chatId });
  const restored = restarted.chats.find(c => c.id === chatId);
  if (!restored || restored.title !== 'Research' || !restored.archived || !restarted.messages.some(m => m.text.includes('ANSWER-ACK'))) throw Error('Chat lost on restart: ' + JSON.stringify(restarted.chats));
  await rpc({ action: 'chat-update', id, chatId, archived: false });
  await ask(id, chatId, 'MARK-AFTER restart');
  const after = turns('MARK-AFTER').at(-1);
  if (!['projects_delegate', 'projects_workers', 'projects_question', 'projects_knowledge_write'].every(n => after.tools.includes(n))) throw Error('Chat lost tools after restart: ' + JSON.stringify(after.tools));
  if (!after.history.includes('MARK-DELEG') || after.history.includes('MARK-MAIN')) throw Error('Chat history wrong after restart');
  result.checks.push('F3 after restart chats keep titles, archive state, transcripts and coordinator tools; restore works');

  // F17: project pause stops every chat.
  const held = await rpc({ action: 'message', id, chatId, text: 'MARK-SLOW then pause' });
  await eventually(async () => (await rpc({ action: 'show', id, chatId })).chats.find(c => c.id === chatId)?.busy, 'Chat did not start');
  await rpc({ action: 'pause', id });
  const paused = await settle(id, chatId, held);
  if (paused.state !== 'interrupted') throw Error('Pause did not stop chat two: ' + paused.state);
  await rejects({ action: 'message', id, chatId, text: 'MARK-NOPE' }, /paused/i, 'paused chat message');
  result.checks.push('F17/F18 project pause interrupts a running non-Main chat and blocks its messages');

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
