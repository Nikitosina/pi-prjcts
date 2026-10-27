import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, openSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTelegram } from '../src/telegram.ts';
import { loadTelegramMedia, extractTelegramMedia } from '../src/telegram-media.ts';

const root = mkdtempSync(join(tmpdir(), 'telegram-media-'));
process.env.PI_PROJECTS_HOME = root;
process.env.PI_PROJECTS_TELEGRAM_BACKOFF_MS = '60000';
const project = randomUUID(), thread = randomUUID(), other = randomUUID();
const dir = join(root, project, 'artifacts', thread);
mkdirSync(dir, { recursive: true });
writeFileSync(join(root, project, 'project.json'), JSON.stringify({ version: 1, id: project, name: 'Test', runtime: 'durable', cwd: root, objective: '', createdAt: new Date().toISOString(), model: 'test', models: {}, phase: 'ready', problem: null }));
// Generated blue PNG and a 0.4-second H.264 MP4. No private project content.
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAAACXBIWXMAAAABAAAAAQBPJcTWAAACKElEQVR4nO3TQQ3AIADAwJFMGW6wjRI88CFN7hT00zHX/oCm/3UAcM/AEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIO4ScBFsG++JpAAAAAElFTkSuQmCC', 'base64');
const video = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMybW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAZAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlx0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAZAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAGQAAAAAAABAAAAAAHUbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAEABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABf21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAT9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UlsBEAAAAMAQAAAAwKDxIllgAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAA5MAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAgAACAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAAs8AAAANAAAAFHN0Y28AAAAAAAAAAQAAA2IAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMQAAAAhmcmVlAAAC5G1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49NSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABpliIQAEP/+5sD5lloh44BQh2uGTrSLY593fQAAAAlBmiFsQ//+q4A=', 'base64');
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
    const file = input.photo ?? input.video ?? input.document;
    input.file = { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, name: file.name };
  } else input = JSON.parse(bytes.toString());
  const reply = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (method === 'getUpdates') return reply({ ok: true, result: [] });
  attempts.push({ method, input });
  if (fault?.method === method) {
    const code = fault.code; fault = null;
    if (code === 0) return req.socket.destroy();
    return reply({ ok: false, error_code: code, description: 'test rejection' });
  }
  sends.push({ method, input }); reply({ ok: true, result: { message_id: ++id } });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.PI_PROJECTS_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
const statePath = join(root, 'telegram.json');
const seed = () => writeFileSync(statePath, JSON.stringify({ version: 1, token: null, bot: null, owner: { chatId: 1, name: 'Test' }, pairing: null, offset: 0, sentSeq: 0, route: null, keys: {}, messages: {}, lastError: null, lastPollAt: null }));
let notices = [], bridge;
function start() {
  const state = JSON.parse(readFileSync(statePath)); state.token = 'fake-test-only'; writeFileSync(statePath, JSON.stringify(state));
  bridge = startTelegram({ dispatch: async input => { assert.equal(input.id, project); if (input.threadId !== thread) throw Error('unauthorized'); return {}; }, chats: async () => [], notifier: { seq: () => notices.length, feed: after => ({ items: notices.filter(n => n.seq > after) }) }, report: () => {} });
}
const notice = (seq, text) => ({ seq, at: 0, projectId: project, project: 'Test', chatId: 'main', chat: 'Main', kind: 'result', title: 'Finished', text });
try {
  seed(); notices = [notice(1, `Before ![Image caption](${ref('demo.png')}) between ![Video caption](${ref('demo.mp4')}) after ![Other format](${ref('demo.webm')}) End`)]; start();
  await bridge.flush();
  assert.deepEqual(sends.map(s => s.method), ['sendMessage', 'sendPhoto', 'sendMessage', 'sendVideo', 'sendMessage', 'sendDocument', 'sendMessage']);
  assert.deepEqual(sends[1].input.file.bytes, image); assert.equal(sends[1].input.file.mime, 'image/png'); assert.equal(sends[1].input.caption, 'Image caption');
  assert.deepEqual(sends[3].input.file.bytes, video); assert.equal(sends[3].input.file.mime, 'video/mp4'); assert.equal(sends[3].input.caption, 'Video caption');
  const count = sends.length; await bridge.flush(); assert.equal(sends.length, count); bridge.close(); start(); await bridge.flush(); assert.equal(sends.length, count); bridge.close();

  seed(); sends = []; fault = { method: 'sendPhoto', code: 400 }; notices = [notice(1, `![Fallback](${ref('demo.png')})`)]; start(); await bridge.flush();
  assert(sends.some(s => s.method === 'sendDocument' && s.input.file.bytes.equals(image))); bridge.close();

  seed(); sends = []; fault = { method: 'sendPhoto', code: 400 };
  notices = [{ ...notice(1, `![Approval attachment](${ref('Screenshot (1 (copy)).png')})`), kind: 'approval', operationId: randomUUID(), fingerprint: 'a'.repeat(64) }]; start(); await bridge.flush();
  const approval = sends.find(s => s.method === 'sendDocument');
  assert(approval); assert.equal(JSON.parse(approval.input.reply_markup).inline_keyboard[0].length, 2); bridge.close();
  seed(); sends = []; notices = [{ ...notice(1, 'Metadata marker test'), project: '\uE0000\uE001', chat: '\uE00099\uE001' }]; start(); await bridge.flush(); assert.equal(sends.length, 1); bridge.close();

  seed(); sends = []; notices = [notice(1, `![Traversal](${ref('../project.json')}) ![Unknown](artifact:${other}/demo.png) ![Missing](${ref('missing.png')}) ![Large](${ref('large.png')}) ![URL](http://127.0.0.1/private)`)]; start(); await bridge.flush();
  assert(sends.every(s => s.method === 'sendMessage')); assert(sends.filter(s => /unavailable/.test(s.input.text)).length === 5); assert(sends.every(s => !s.input.text.includes('!Traversal'))); bridge.close();

  seed(); sends = []; notices = [notice(1, `${'long text '.repeat(700)} ![${'C'.repeat(1100)}](${ref('demo.png')}) tail`)]; start(); await bridge.flush();
  assert(sends.filter(s => s.method === 'sendMessage').every(s => s.input.text.length <= 4096)); assert.equal(sends.find(s => s.method === 'sendPhoto').input.caption.length, 1024); assert(sends.some(s => s.input.text?.includes('C'.repeat(76)))); bridge.close();

  seed(); sends = []; notices = [notice(1, `First ![Retry](${ref('demo.png')}) Last`), notice(2, 'Next notice')]; fault = { method: 'sendPhoto', code: 429 }; start(); await bridge.flush(); assert.equal(sends.length, 1); bridge.close(); start(); await bridge.flush(); assert.equal(sends.filter(s => s.input.text?.includes('First')).length, 1); assert.equal(sends.filter(s => s.method === 'sendPhoto').length, 1); assert(sends.at(-1).input.text.includes('Next notice')); bridge.close();

  seed(); sends = []; notices = [notice(1, `Start ![Uncertain](${ref('demo.mp4')}) Stop`), notice(2, 'Must wait')]; fault = { method: 'sendVideo', code: 0 }; start(); await bridge.flush(); const attemptsBefore = attempts.length; await bridge.flush(); bridge.close(); start(); await bridge.flush(); assert.equal(attempts.length, attemptsBefore); assert(JSON.parse(readFileSync(statePath)).sentPart.pendingMedia); bridge.close();
  console.log('PASS Telegram multipart bytes/MIME/captions/photo/video/document, traversal/symlink/missing/unauthorized/size/URL, chunking, retry/order/restart, uncertain-delivery duplicate guard');
} finally { bridge?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
