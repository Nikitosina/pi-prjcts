import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, symlinkSync, openSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTelegram, TelegramRequestNotSentError } from '../src/telegram.ts';
import { loadTelegramMedia, extractTelegramMedia, telegramAlbumForm } from '../src/telegram-media.ts';
import { image, video } from './telegram-media-fixtures.mjs';
import { htmlToPlain, splitTelegramCaption } from '../src/telegram-html.ts';

const root = mkdtempSync(join(tmpdir(), 'telegram-media-'));
process.env.PI_PROJECTS_HOME = root;
process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = '60000';
const project = randomUUID(), thread = randomUUID(), other = randomUUID();
const dir = join(root, project, 'artifacts', thread);
mkdirSync(dir, { recursive: true });
writeFileSync(join(root, project, 'project.json'), JSON.stringify({ version: 1, id: project, name: 'Test', runtime: 'durable', cwd: root, objective: '', createdAt: new Date().toISOString(), model: 'test', models: {}, phase: 'ready', problem: null }));
writeFileSync(join(dir, 'demo.png'), image);
writeFileSync(join(dir, 'Screenshot (1 (copy)).png'), image);
writeFileSync(join(dir, 'demo.mp4'), video);
writeFileSync(join(dir, 'demo.webm'), video);
mkdirSync(join(root, project, 'artifacts', other));
writeFileSync(join(root, project, 'artifacts', other, 'demo.png'), image);
symlinkSync(join(dir, 'demo.png'), join(dir, 'link.png'));
const large = openSync(join(dir, 'large.png'), 'w'); ftruncateSync(large, 50_000_001); closeSync(large);
const medium = openSync(join(dir, 'medium.png'), 'w'); ftruncateSync(medium, 10_000_001); closeSync(medium);
const ref = path => `artifact:${thread}/${path}`;
assert.equal(loadTelegramMedia(join(root, project), ref('medium.png')).method, 'sendDocument');
for (const path of ['../project.json', 'missing.png', 'link.png', 'large.png', '%2e%2e/no', '/etc/passwd', 'a\\b']) assert.throws(() => loadTelegramMedia(join(root, project), ref(path)));
assert.equal(extractTelegramMedia('`![example](x)`\n```\n![code](y)\n```').media.length, 0);
assert.equal(extractTelegramMedia('\uE0000\uE001').markdown, '0');
for (const fence of ['```', '~~~']) assert.equal(extractTelegramMedia(`${fence}\n![example](${ref('demo.png')})`).media.length, 0);
let fault = null, sends = [], attempts = [], id = 0;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const method = req.url.split('/').at(-1);
  const bytes = Buffer.concat(chunks);
  const multipart = req.headers['content-type']?.startsWith('multipart/form-data');
  let input;
  if (multipart) {
    const data = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    input = Object.fromEntries(data);
    if (input.caption) { input.caption = input.caption.replaceAll('\r\n', '\n'); assert(Array.from(htmlToPlain(input.caption)).length <= 1024); }
    if (method === 'sendMediaGroup') {
      input.media = JSON.parse(input.media);
      input.files = await Promise.all(input.media.map(async item => {
        const file = input[item.media.slice('attach://'.length)];
        return { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, name: file.name };
      }));
    } else {
      const file = input.photo ?? input.video ?? input.document;
      input.file = { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, name: file.name };
    }
  } else input = JSON.parse(bytes.toString());
  const reply = value => { res.writeHead(value.ok ? 200 : value.error_code ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (method === 'getUpdates') return reply({ ok: true, result: [] });
  attempts.push({ method, input });
  // TDLib check_message_group_message_contents requires uniform placement even on items without captions.
  if (method === 'sendMediaGroup' && new Set(input.media.map(item => item.show_caption_above_media ?? false)).size > 1) return reply({ ok: false, error_code: 400, description: 'Bad Request: Parameter show_caption_above_media must be the same for all messages' });
  if (fault?.method === method) {
    const code = fault.code; fault = null;
    if (code === 0) return req.socket.destroy();
    if (code === 200) return reply({ ok: true, result: [] });
    return reply({ ok: false, error_code: code, description: 'test rejection' });
  }
  const message_ids = Array.from({ length: method === 'sendMediaGroup' ? input.media.length : 1 }, () => ++id);
  sends.push({ method, input, message_id: message_ids[0], message_ids });
  reply({ ok: true, result: method === 'sendMediaGroup' ? message_ids.map(message_id => ({ message_id })) : { message_id: message_ids[0] } });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.PI_PROJECTS_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
const statePath = join(root, 'telegram.json');
const seed = () => writeFileSync(statePath, JSON.stringify({ version: 1, token: null, bot: null, owner: { chatId: 1, name: 'Test' }, pairing: null, offset: 0, sentSeq: 0, route: null, keys: {}, messages: {}, lastError: null, lastPollAt: null }));
let notices = [], bridge;
function start() {
  const state = JSON.parse(readFileSync(statePath)); state.token = 'fake-test-only'; writeFileSync(statePath, JSON.stringify(state));
  bridge = startTelegram({ receiveUpdates: false, dispatch: async input => { assert.equal(input.id, project); if (input.threadId !== thread) throw Error('unauthorized'); return {}; }, chats: async () => [], notifier: { seq: () => notices.length, feed: after => ({ items: notices.filter(n => n.seq > after) }) }, report: () => {} });
}
const notice = (seq, text) => ({ seq, at: 0, projectId: project, project: 'Test', chatId: 'main', chat: 'Main', kind: 'result', title: 'Finished', text });
const reset = text => { bridge?.close(); seed(); sends = []; attempts = []; fault = null; notices = [notice(1, text)]; };
const mapped = (expected = { projectId: project, chatId: 'main' }) => {
  const mappings = JSON.parse(readFileSync(statePath)).messages;
  for (const send of sends) for (const id of send.message_ids) assert.deepEqual(mappings[id], expected);
};
try {
  const mixedPlacementForm = telegramAlbumForm([loadTelegramMedia(join(root, project), ref('demo.png')), loadTelegramMedia(join(root, project), ref('demo.mp4'))], 1, '<b>Test · Main</b>\nDemo');
  const mixedPlacementItems = JSON.parse(mixedPlacementForm.body.get('media'));
  delete mixedPlacementItems[1].show_caption_above_media;
  mixedPlacementForm.body.set('media', JSON.stringify(mixedPlacementItems));
  const rejected = await fetch(`${process.env.PI_PROJECTS_TELEGRAM_API}/botfake-contract-only/sendMediaGroup`, { method: 'POST', body: mixedPlacementForm.body });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).description, 'Bad Request: Parameter show_caption_above_media must be the same for all messages');
  assert.equal(sends.length, 0);

  reset(`Before **bold** ![Image caption](${ref('demo.png')}) after`); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendPhoto']);
  assert.match(sends[0].input.caption, /^<b>Test · Main<\/b>\nFinished\n\nBefore <b>bold<\/b> Image caption after/);
  assert.match(sends[0].input.caption, /Reply to this message to write to this chat/);
  assert.equal(sends[0].input.parse_mode, 'HTML'); assert.equal(sends[0].input.show_caption_above_media, 'true');
  assert.equal(sends[0].input.reply_parameters, undefined);
  assert.deepEqual(sends[0].input.file.bytes, image); assert.equal(sends[0].input.file.mime, 'image/png'); mapped();
  await bridge.flush(); assert.equal(sends.length, 1); bridge.close(); start(); await bridge.flush(); assert.equal(sends.length, 1);

  reset(`Before ![Video caption](${ref('demo.mp4')}) after`); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendVideo']); assert.deepEqual(sends[0].input.file.bytes, video); assert.equal(sends[0].input.file.mime, 'video/mp4'); mapped();

  reset(`Question ![Image](${ref('demo.png')})`);
  notices[0] = { ...notices[0], kind: 'question', entryId: 'question-id', choices: ['yes', 'no'] };
  start(); await bridge.flush(); assert.equal(sends.length, 1); assert.equal(JSON.parse(sends[0].input.reply_markup).inline_keyboard.length, 2); assert.match(sends[0].input.caption, /Tap an answer/); mapped({ projectId: project, chatId: 'main', entryId: 'question-id' });

  reset(`Approval ![Attachment](${ref('Screenshot (1 (copy)).png')})`);
  notices[0] = { ...notices[0], kind: 'approval', operationId: randomUUID(), fingerprint: 'a'.repeat(64) };
  start(); await bridge.flush(); assert.deepEqual(sends.map(s => s.method), ['sendPhoto']); assert.equal(JSON.parse(sends[0].input.reply_markup).inline_keyboard[0].length, 2); mapped();

  reset(`![Fallback](${ref('demo.png')})`); fault = { method: 'sendPhoto', code: 400 }; start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendDocument']); assert(sends[0].input.file.bytes.equals(image)); assert.match(sends[0].input.caption, /Fallback/);

  reset(`Before ![Photo](${ref('demo.png')}) between ![Video](${ref('demo.mp4')}) after`); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendMediaGroup']);
  assert.deepEqual(sends[0].input.media.map(m => m.type), ['photo', 'video']);
  assert.match(sends[0].input.media[0].caption, /Before Photo between Video after/);
  assert(sends[0].input.media.every(item => item.show_caption_above_media === true));
  assert.equal(sends[0].input.media[0].parse_mode, 'HTML'); assert.equal(sends[0].input.media[1].caption, undefined);
  assert.deepEqual(sends[0].input.files.map(f => f.bytes), [image, video]); assert.deepEqual(sends[0].input.files.map(f => f.mime), ['image/png', 'video/mp4']); mapped();

  reset(Array.from({ length: 11 }, (_, i) => `![${i}](${ref('demo.png')})`).join(' ')); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendMediaGroup', 'sendPhoto']); assert.equal(sends[0].input.media.length, 10); assert.equal(sends[1].input.caption, ''); mapped();

  reset(`![Photo](${ref('demo.png')}) ![Video](${ref('demo.mp4')})`); fault = { method: 'sendMediaGroup', code: 400 }; start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendMediaGroup']); assert(sends[0].input.media.every(m => m.type === 'document' && m.show_caption_above_media === undefined)); mapped();

  reset(`Before ![Photo](${ref('demo.png')}) middle ![WebM](${ref('demo.webm')}) after`); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendPhoto', 'sendDocument']); assert.match(sends[0].input.caption, /Before Photo middle WebM after/); assert.equal(sends[1].input.caption, ''); mapped();

  reset(`![Photo](${ref('demo.png')}) ![Video](${ref('demo.mp4')})`); notices[0] = { ...notices[0], kind: 'approval', operationId: randomUUID(), fingerprint: 'a'.repeat(64) }; start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendPhoto', 'sendVideo']); assert.equal(sends[0].input.reply_markup, undefined); assert.equal(JSON.parse(sends[1].input.reply_markup).inline_keyboard[0].length, 2); mapped();

  reset('Metadata marker test'); notices[0].project = '\uE0000\uE001'; notices[0].chat = '\uE00099\uE001'; start(); await bridge.flush(); assert.equal(sends.length, 1);

  reset(`![Traversal](${ref('../project.json')}) ![Unknown](artifact:${other}/demo.png) ![Missing](${ref('missing.png')}) ![Large](${ref('large.png')}) ![URL](http://127.0.0.1/private)`); start(); await bridge.flush();
  assert.equal(sends.length, 5); assert(sends.every(s => s.method === 'sendMessage' && /unavailable/.test(s.input.text))); assert(sends.every(s => !s.input.text.includes('!Traversal')));

  reset(`${'x'.repeat(960)} ![](${ref('demo.png')})`); start(); await bridge.flush();
  assert.equal(sends.length, 1); assert(sends[0].input.caption.includes('x'.repeat(960))); assert.match(sends[0].input.caption, /Reply to chat/);

  for (const body of ['🟦'.repeat(600), '**' + '&'.repeat(900) + '**']) {
    reset(`${body} ![](${ref('demo.png')})`); start(); await bridge.flush(); assert.deepEqual(sends.map(s => s.method), ['sendPhoto']);
  }

  const exactBody = 'x'.repeat(1024 - Array.from('Test · Main\nFinished\n\n \n\nReply to this message to write to this chat.').length);
  reset(`${exactBody} ![](${ref('demo.png')})`); start(); await bridge.flush(); assert.equal(sends.length, 1); assert.equal(Array.from(htmlToPlain(sends[0].input.caption)).length, 1024);

  const body = 'long text '.repeat(700) + '🟦' + 'Z'.repeat(76);
  reset(`${body} ![Image](${ref('demo.png')}) tail`); start(); await bridge.flush();
  assert.equal(sends[0].method, 'sendPhoto');
  const all = [sends[0].input.caption, ...sends.slice(1).map(s => s.input.text)];
  assert.equal(all.map(htmlToPlain).join(''), `Test · Main\nFinished\n\n${body} Image tail\n\nReply to chat.`);
  assert(Array.from(htmlToPlain(all[0])).length <= 1024); assert(all.slice(1).every(t => htmlToPlain(t).length <= 4096));
  assert.equal(sends.length, 1 + Math.ceil((all.map(htmlToPlain).join('').length - 1024) / 4096));
  for (const send of sends.slice(1)) assert.equal(send.input.reply_parameters.message_id, sends[0].message_id); mapped();
  const unicode = splitTelegramCaption('<b>' + 'x'.repeat(1023) + '🟦&amp;</b>'); assert.equal(Array.from(htmlToPlain(unicode[0])).length, 1024); assert.equal(unicode.map(htmlToPlain).join(''), 'x'.repeat(1023) + '🟦&');
  assert.equal(splitTelegramCaption('<b>' + '&amp;'.repeat(1024) + '</b>').length, 1);

  reset(`${'a'.repeat(1800)} ![Photo](${ref('demo.png')}) ![Video](${ref('demo.mp4')}) end`); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendMediaGroup', 'sendMessage']); assert.equal((sends[0].input.media[0].caption + sends[1].input.text).match(/<b>Test · Main/g).length, 1); mapped();

  reset(`First ![Retry](${ref('demo.png')}) Last`); notices.push(notice(2, 'Next notice')); fault = { method: 'sendPhoto', code: 429 }; start(); await bridge.flush(); assert.equal(sends.length, 0); bridge.close(); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendPhoto', 'sendMessage']); assert.equal(sends.at(-1).input.reply_parameters, undefined);

  reset(`${'long '.repeat(500)} ![](${ref('demo.png')}) end`); fault = { method: 'sendMessage', code: 429 }; start(); await bridge.flush(); assert.equal(sends.length, 1); bridge.close(); start(); await bridge.flush();
  assert.equal(sends.length, 2); assert.equal(sends[1].input.reply_parameters.message_id, sends[0].message_id);

  reset(`![Photo](${ref('demo.png')}) ![Video](${ref('demo.mp4')})`); notices.push(notice(2, 'Next notice')); fault = { method: 'sendMediaGroup', code: 429 }; start(); await bridge.flush(); assert.equal(sends.length, 0); bridge.close(); start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendMediaGroup', 'sendMessage']); mapped();

  writeFileSync(join(dir, 'gone.png'), image);
  reset(`Before ![First](${ref('demo.png')}) ![Gone](${ref('gone.png')}) ![Last](${ref('demo.mp4')}) after`);
  fault = { method: 'sendMediaGroup', code: 429 }; start(); await bridge.flush(); assert.equal(sends.length, 0); bridge.close();
  unlinkSync(join(dir, 'gone.png')); fault = { method: 'sendVideo', code: 429 }; start(); await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendPhoto', 'sendMessage']); assert.match(sends[1].input.text, /unavailable/); bridge.close();
  start(); await bridge.flush(); assert.deepEqual(sends.map(s => s.method), ['sendPhoto', 'sendMessage', 'sendVideo']);
  assert.deepEqual(sends[2].input.file.bytes, video); assert.match(sends[0].input.caption, /Before First Gone Last after/); mapped();

  reset(`![Photo](${ref('demo.png')}) ![Video](${ref('demo.mp4')})`);
  fault = { method: 'sendMediaGroup', code: 400 };
  const forward = globalThis.fetch;
  let forwarded = false, guardedCalls = 0;
  const oldBackoff = process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS;
  process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = '1';
  globalThis.fetch = async (url, init) => {
    guardedCalls++;
    if (forwarded) throw new TelegramRequestNotSentError('One-write guard: follow-up NOT transmitted after confirmed 400 rejection; fake-test-only');
    forwarded = true; return forward(url, init);
  };
  try {
    start(); await bridge.flush();
    const state = JSON.parse(readFileSync(statePath));
    assert.equal(attempts.length, 1); assert.equal(sends.length, 0);
    assert.equal(state.sentPart.pendingMedia, undefined); assert.match(state.lastError, /NOT transmitted after confirmed 400/);
    assert(!state.lastError.includes('delivery is uncertain')); assert.equal(state.sentSeq, 0);
    assert(!state.lastError.includes('fake-test-only')); assert(state.lastError.includes('[token]'));
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(guardedCalls, 2);
  } finally { bridge.close(); globalThis.fetch = forward; process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = oldBackoff; }

  for (const code of [0, 200]) {
    reset(`![Photo](${ref('demo.png')}) ![Video](${ref('demo.mp4')})`); notices.push(notice(2, 'Must wait')); fault = { method: 'sendMediaGroup', code }; start(); await bridge.flush(); const before = attempts.length; await bridge.flush(); bridge.close(); start(); await bridge.flush(); assert.equal(attempts.length, before); assert(JSON.parse(readFileSync(statePath)).sentPart.pendingMedia);
  }
  reset(`Start ![Uncertain](${ref('demo.mp4')}) Stop`); fault = { method: 'sendVideo', code: 0 }; start(); await bridge.flush(); const before = attempts.length; bridge.close(); start(); await bridge.flush(); assert.equal(attempts.length, before); assert(JSON.parse(readFileSync(statePath)).sentPart.pendingMedia);
  reset(`Legacy partial ![Image](${ref('demo.png')})`);
  let legacy = JSON.parse(readFileSync(statePath)); legacy.sentPart = { seq: 1, parts: 1 }; writeFileSync(statePath, JSON.stringify(legacy));
  start(); await bridge.flush(); assert.equal(sends.length, 0); assert(JSON.parse(readFileSync(statePath)).sentPart.pendingMedia);
  reset('text-only '.repeat(700)); legacy = JSON.parse(readFileSync(statePath)); legacy.sentPart = { seq: 1, parts: 1 }; writeFileSync(statePath, JSON.stringify(legacy));
  start(); await bridge.flush(); assert.equal(sends.length, 1); assert.equal(sends[0].method, 'sendMessage'); assert(!sends[0].input.text.includes('Test · Main'));

  console.log('PASS one-message native caption/envelope/actions/routing; albums/overflow; byte/MIME/security/fallback; retry/order/restart/uncertainty');
} finally { bridge?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
