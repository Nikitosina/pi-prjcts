// Real isolated coordinator, worker artifact store, notifier and Telegram bridge. Only the model and Bot API are fake.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, say, call } from './lib/e2e-kit.mjs';
import { image, video } from './telegram-media-fixtures.mjs';
import { htmlToPlain } from '../src/telegram-html.ts';

const updates = [], sends = [];
let nextUpdate = 1, nextMessage = 1, rejectPhoto = true;
const owner = { id: 1234567, type: 'private', first_name: 'Fixture owner' };
const incoming = (text, reply) => updates.push({ update_id: nextUpdate++, message: { message_id: nextMessage++, chat: owner, from: { id: owner.id }, text, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } });
const api = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks), method = req.url.split('/').at(-1);
  const multipart = req.headers['content-type']?.startsWith('multipart/form-data');
  let input;
  if (multipart) {
    input = Object.fromEntries(await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData());
    if (method === 'sendMediaGroup') {
      input.media = JSON.parse(input.media);
      input.files = await Promise.all(input.media.map(async item => {
        const file = input[item.media.slice('attach://'.length)];
        return { mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
      }));
    } else {
      const file = input.photo ?? input.video ?? input.document;
      input.file = { mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
      input.caption = input.caption.replaceAll('\r\n', '\n');
    }
    if (input.reply_parameters) input.reply_parameters = JSON.parse(input.reply_parameters);
  } else input = JSON.parse(bytes.toString());
  const reply = data => { res.writeHead(data.ok ? 200 : data.error_code ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (method === 'getUpdates') {
    const ready = updates.filter(u => u.update_id >= input.offset);
    if (!ready.length) await new Promise(resolve => setTimeout(resolve, 100));
    return reply({ ok: true, result: ready });
  }
  if (method === 'sendMediaGroup' && new Set(input.media.map(item => item.show_caption_above_media ?? false)).size > 1) return reply({ ok: false, error_code: 400, description: 'Bad Request: parameter show_caption_above_media must be the same for all messages' });
  if (method === 'sendMediaGroup' && rejectPhoto) { rejectPhoto = false; return reply({ ok: false, error_code: 429, description: 'Fixture rate limit', parameters: { retry_after: 1 } }); }
  assert(['sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendMediaGroup'].includes(method));
  const message_ids = Array.from({ length: method === 'sendMediaGroup' ? input.media.length : 1 }, () => nextMessage++);
  const message = { method, input, message_id: message_ids[0], message_ids };
  sends.push(message); reply({ ok: true, result: method === 'sendMediaGroup' ? message_ids.map(message_id => ({ message_id })) : { message_id: message.message_id } });
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
let output, fixtureThread;
const k = await createKit('telegram-media', {
  env: { PI_PROJECTS_TELEGRAM_API: `http://127.0.0.1:${api.address().port}`, PI_PROJECTS_TELEGRAM_BACKOFF_MS: '200', PI_PROJECTS_NOTIFY_TICK_MS: '100' },
  handler: ({ role, user, results }) => {
    if (role === 'coordinator') {
      if (user.includes('MARK-MEDIASINGLE')) return say(`COORDINATOR-SINGLE before ![Image](artifact:${fixtureThread}/image.png) after.`);
      if (user.includes('MARK-MEDIAVIDEO')) return say(`COORDINATOR-VIDEO before ![Video](artifact:${fixtureThread}/video.mp4) after.`);
      if (user.includes('MARK-MEDIALONG')) return say(`COORDINATOR-LONG ${'long text '.repeat(650)} ![Image](artifact:${fixtureThread}/image.png) TAIL-PRESERVED`);
      if (/MARK-MEDIA\b/.test(user) && !user.startsWith('[Durable work')) return results.length ? say('Waiting for fixture work.') : call('projects_delegate', { role: 'worker', task: 'MEDIA-FIXTURE save generated attachments' });
      if (user.startsWith('[Durable work') && user.includes('MEDIA-FIXTURE')) {
        const thread = fixtureThread = /; thread ([a-f0-9-]{36})\]/.exec(user)?.[1];
        output = `COORDINATOR-MEDIA before.\n\n![Generated image](artifact:${thread}/image.png)\n\nCOORDINATOR-MEDIA between.\n\n![Generated video](artifact:${thread}/video.mp4)\n\nCOORDINATOR-MEDIA after.`;
        return say(output);
      }
      if (user.includes('MARK-MEDIAREPLY')) return say('MEDIA-REPLY-ACK');
    }
    if (role === 'worker' && user.includes('MEDIA-FIXTURE')) {
      if (!results.length) return call('bash', { command: `node -e 'const fs=require("node:fs"), p=process.env.PI_ARTIFACTS_DIR; fs.writeFileSync(p+"/image.png",Buffer.from("${image.toString('base64')}","base64"));fs.writeFileSync(p+"/video.mp4",Buffer.from("${video.toString('base64')}","base64")); console.log("Saved generated fixtures");'` });
      return say('MEDIA-FIXTURE-DONE saved image.png and video.mp4');
    }
    return undefined;
  },
});
await k.run(async () => {
  try {
    k.initRepo();
    const project = await k.createProject('Media envelope');
    const chat = await k.rpc({ action: 'chat-create', id: project, title: 'Attachment context' });
    await k.stopHost();
    writeFileSync(join(k.home, 'telegram.json'), JSON.stringify({ version: 1, token: 'fake-media-envelope-only', bot: { id: 123, username: 'fixture' }, owner: { chatId: owner.id, name: 'Fixture owner' }, pairing: null, offset: 0, sentSeq: 0, route: { projectId: project, chatId: chat.id }, keys: {}, messages: {}, lastError: null, lastPollAt: null }));
    k.startHost(); await k.waitHost();
    incoming('MARK-MEDIA please produce an illustrated coordinator result');
    const album = await k.eventually(() => sends.find(s => s.method === 'sendMediaGroup'), 'Coordinator album not delivered');
    const caption = album.input.media[0].caption;
    assert.match(caption, /^<b>Media envelope · Attachment context<\/b>\nFinished\n\nCOORDINATOR-MEDIA before/);
    assert.match(caption, /COORDINATOR-MEDIA between/); assert.match(caption, /COORDINATOR-MEDIA after/); assert.match(caption, /Reply to this message to write to this chat/);
    assert.deepEqual(album.input.files.map(f => f.bytes), [image, video]); assert.deepEqual(album.input.files.map(f => f.mime), ['image/png', 'video/mp4']);
    assert.deepEqual(album.input.media.map(m => m.type), ['photo', 'video']); assert(album.input.media.every(m => m.show_caption_above_media === true)); assert.equal(album.input.media[1].caption, undefined);
    assert.equal(album.input.reply_parameters, undefined);
    assert.equal(sends.filter(s => s.input.text?.includes('COORDINATOR-MEDIA')).length, 0);
    const feed = JSON.parse(readFileSync(join(k.home, 'notifications.json'), 'utf8')).feed;
    assert(feed.some(n => n.text === output && n.chatId === chat.id && n.projectId === project));
    const state = JSON.parse(readFileSync(join(k.home, 'telegram.json'), 'utf8'));
    for (const id of album.message_ids) assert.deepEqual(state.messages[id], { projectId: project, chatId: chat.id });
    k.check('Real coordinator/worker artifacts -> notifier -> ONE mixed photo/video album call with shared normal caption and routing on every item', true);
    k.check('429 album retry produces no duplicate wrapper or media', !rejectPhoto && sends.filter(s => s.method === 'sendMediaGroup').length === 1);

    incoming('MARK-MEDIASINGLE single native coordinator reply');
    const photo = await k.eventually(() => sends.find(s => s.method === 'sendPhoto' && s.input.caption.includes('COORDINATOR-SINGLE')), 'Single photo reply absent');
    assert.match(photo.input.caption, /<b>Media envelope · Attachment context<\/b>/); assert.match(photo.input.caption, /before Image after/); assert.match(photo.input.caption, /Reply to this message/);
    assert.equal(sends.filter(s => s.input.text?.includes('COORDINATOR-SINGLE')).length, 0);
    incoming('MARK-MEDIAVIDEO single native video reply');
    const videoSend = await k.eventually(() => sends.find(s => s.method === 'sendVideo' && s.input.caption.includes('COORDINATOR-VIDEO')), 'Single video reply absent');
    assert.equal(videoSend.input.reply_parameters, undefined);
    k.check('Single image and video replies each use exactly one media call with normal envelope/body/footer, no wrapper messages', true);

    incoming('MARK-MEDIALONG preserve the entire response');
    await k.eventually(() => sends.some(s => s.input.text?.includes('TAIL-PRESERVED')), 'Long response was truncated');
    const longMedia = sends.find(s => s.method === 'sendPhoto' && s.input.caption.includes('COORDINATOR-LONG'));
    const longParts = sends.filter(s => s === longMedia || s.input.reply_parameters?.message_id === longMedia.message_id);
    assert.deepEqual(longParts.map(s => s.method), ['sendPhoto', 'sendMessage', 'sendMessage']);
    const whole = longParts.map(s => htmlToPlain(s.input.caption ?? s.input.text)).join('');
    assert(whole.includes('long text '.repeat(650))); assert(whole.includes('TAIL-PRESERVED'));
    assert.equal((whole.match(/Media envelope · Attachment context/g) ?? []).length, 1);
    k.check('Long actual coordinator result survives notifier intact and uses one caption plus only the two required text spillovers', true);
    incoming('/chat 1');
    await k.eventually(() => sends.some(s => s.input.text?.includes('Now talking to') && s.input.text.includes('Main')), 'Inbound route did not switch');
    incoming('MARK-MEDIAREPLY reply to the attachment, not the current route', photo.message_id);
    await k.eventually(async () => (await k.rpc({ action: 'show', id: project, chatId: chat.id })).jobs.some(j => j.text.startsWith('MARK-MEDIAREPLY')), 'Reply to photo lost originating coordinator chat');
    assert(!(await k.rpc({ action: 'show', id: project })).jobs.some(j => j.text.startsWith('MARK-MEDIAREPLY')));
    const beforeReply = (await k.rpc({ action: 'show', id: project, chatId: chat.id })).jobs.length;
    incoming('MARK-ALBUMREPLY reply to second album item', album.message_ids[1]);
    await k.eventually(async () => (await k.rpc({ action: 'show', id: project, chatId: chat.id })).jobs.length > beforeReply, 'Reply to album item lost originating chat');
    k.check('Replies to native photo and second album item route to the original coordinator chat after inbound route changes', true);
    await k.settle(project);
    const before = sends.filter(s => s.method !== 'sendMessage').length;
    await k.restartHost();
    incoming('/status');
    await k.eventually(() => sends.some(s => s.input.text?.startsWith('Text goes to')), 'Restart poll did not resume');
    assert.equal(sends.filter(s => s.method !== 'sendMessage').length, before);
    k.check('Normal notifier/bridge restart does not replay media', true);
  } finally { api.closeAllConnections(); api.close(); }
});
