// Real isolated coordinator, worker artifact store, notifier and Telegram bridge. Only the model and Bot API are fake.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, say, call } from './lib/e2e-kit.mjs';
import { image, video } from './telegram-media-fixtures.mjs';

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
    const file = input.photo ?? input.video ?? input.document;
    input.file = { mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
    if (input.reply_parameters) input.reply_parameters = JSON.parse(input.reply_parameters);
  } else input = JSON.parse(bytes.toString());
  const reply = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (method === 'getUpdates') {
    const ready = updates.filter(u => u.update_id >= input.offset);
    if (!ready.length) await new Promise(resolve => setTimeout(resolve, 100));
    return reply({ ok: true, result: ready });
  }
  if (method === 'sendPhoto' && rejectPhoto) { rejectPhoto = false; return reply({ ok: false, error_code: 429, description: 'Fixture rate limit', parameters: { retry_after: 1 } }); }
  assert(['sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument'].includes(method));
  const message = { method, input, message_id: nextMessage++ };
  sends.push(message); reply({ ok: true, result: { message_id: message.message_id } });
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
let output;
const k = await createKit('telegram-media', {
  env: { PI_PROJECTS_TELEGRAM_API: `http://127.0.0.1:${api.address().port}`, PI_PROJECTS_TELEGRAM_BACKOFF_MS: '200', PI_PROJECTS_NOTIFY_TICK_MS: '100' },
  handler: ({ role, user, results }) => {
    if (role === 'coordinator') {
      if (/MARK-MEDIA\b/.test(user) && !user.startsWith('[Durable work')) return results.length ? say('Waiting for fixture work.') : call('projects_delegate', { role: 'worker', task: 'MEDIA-FIXTURE save generated attachments' });
      if (user.startsWith('[Durable work') && user.includes('MEDIA-FIXTURE')) {
        const thread = /; thread ([a-f0-9-]{36})\]/.exec(user)?.[1];
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
    await k.eventually(() => sends.find(s => s.method === 'sendVideo'), 'Coordinator video not delivered');
    await k.eventually(() => sends.find(s => s.input.text?.includes('COORDINATOR-MEDIA after.')), 'Surrounding text not delivered');
    const anchor = sends.find(s => s.input.text?.includes('COORDINATOR-MEDIA before.'));
    assert.match(anchor.input.text, /^<b>Media envelope · Attachment context<\/b>\nFinished\n\nCOORDINATOR-MEDIA before/);
    const photo = sends.find(s => s.method === 'sendPhoto'), videoSend = sends.find(s => s.method === 'sendVideo');
    assert.deepEqual(photo.input.file.bytes, image); assert.equal(photo.input.file.mime, 'image/png'); assert.equal(photo.input.caption, 'Generated image');
    assert.deepEqual(videoSend.input.file.bytes, video); assert.equal(videoSend.input.file.mime, 'video/mp4'); assert.equal(videoSend.input.caption, 'Generated video');
    const parts = sends.slice(sends.indexOf(anchor));
    assert.deepEqual(parts.map(s => s.method), ['sendMessage', 'sendPhoto', 'sendMessage', 'sendVideo', 'sendMessage']);
    assert.equal(anchor.input.reply_parameters, undefined);
    for (const part of parts.slice(1)) assert.equal(part.input.reply_parameters.message_id, anchor.message_id);
    assert.match(parts.at(-1).input.text, /Reply to this message to write to this chat/);
    const feed = JSON.parse(readFileSync(join(k.home, 'notifications.json'), 'utf8')).feed;
    assert(feed.some(n => n.text === output && n.chatId === chat.id && n.projectId === project));
    const state = JSON.parse(readFileSync(join(k.home, 'telegram.json'), 'utf8'));
    for (const part of parts) assert.deepEqual(state.messages[part.message_id], { projectId: project, chatId: chat.id });
    k.check('Owner Telegram input -> real coordinator/worker artifacts -> notifier -> ordered native multipart with one identity envelope and reply linkage', true);
    k.check('Explicit rate-limit retry kept the original envelope and did not duplicate header/photo', !rejectPhoto && sends.filter(s => s.method === 'sendPhoto').length === 1 && sends.filter(s => s.input.text?.includes('COORDINATOR-MEDIA before.')).length === 1);
    incoming('/chat 1');
    await k.eventually(() => sends.some(s => s.input.text?.includes('Now talking to') && s.input.text.includes('Main')), 'Inbound route did not switch');
    incoming('MARK-MEDIAREPLY reply to the attachment, not the current route', photo.message_id);
    await k.eventually(async () => (await k.rpc({ action: 'show', id: project, chatId: chat.id })).jobs.some(j => j.text.startsWith('MARK-MEDIAREPLY')), 'Reply to photo lost originating coordinator chat');
    assert(!(await k.rpc({ action: 'show', id: project })).jobs.some(j => j.text.startsWith('MARK-MEDIAREPLY')));
    k.check('Reply to native photo routes to its original coordinator chat after inbound route changes', true);
    await k.settle(project);
    const before = sends.filter(s => s.method !== 'sendMessage').length;
    await k.restartHost();
    incoming('/status');
    await k.eventually(() => sends.some(s => s.input.text?.startsWith('Text goes to')), 'Restart poll did not resume');
    assert.equal(sends.filter(s => s.method !== 'sendMessage').length, before);
    k.check('Normal notifier/bridge restart does not replay media', true);
  } finally { api.closeAllConnections(); api.close(); }
});
