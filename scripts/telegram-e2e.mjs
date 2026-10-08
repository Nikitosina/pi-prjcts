// Browser E2E for Telegram two-way: isolated host, fake model, and a local fake Telegram Bot API server (PI_PROJECTS_TELEGRAM_API). Never real Telegram.
// Failure cases recorded in telegram-failures.md before implementation.
import { createServer } from 'node:http';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, delay, randomUUID } from './notify-kit.mjs';

// Fake Bot API: two bots, a retained update log (getUpdates returns updates with id >= offset, long-polling), recorded sends, fault injection.
const TOKEN = '123456:AAFakeTokenForE2E_' + randomUUID().replaceAll('-', '');
const TOKEN2 = '654321:AAOtherBotTokenE2E_' + randomUUID().replaceAll('-', '');
const bots = { [TOKEN]: { id: 123456, username: 'pi_fake_bot' }, [TOKEN2]: { id: 654321, username: 'pi_other_bot' } };
const tg = { updates: [], nextUpdate: 1000, sent: [], edits: [], answered: [], polls: [], waiters: new Set(), failPolls: 0, failSends: 0, revoked: new Set(), nextMessage: 1, refused: [] };
// Telegram's HTML parse_mode: only these tags, properly nested, entities limited to &lt; &gt; &amp; &quot; and numeric. `PARSEFAIL` forces a refusal.
const TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler', 'span']);
function htmlProblem(html) {
  if (html.includes('PARSEFAIL')) return 'forced by test';
  const stack = [];
  for (const [tag, close, name] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (!TAGS.has(name)) return `unsupported tag ${name}`;
    if (!close) stack.push(name); else if (stack.pop() !== name) return `unmatched end tag ${name}`;
  }
  if (stack.length) return `unclosed ${stack.join(',')}`;
  if (/<(?![a-z/])/.test(html) || /&(?!lt;|gt;|amp;|quot;|#\d+;)/.test(html)) return 'raw < or &';
  return null;
}
const visible = html => html.replace(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const MD = ['# Release notes', '', 'This is **bold**, *italic*, _also italic_, ~~gone~~ and `a < b && c`. Keep snake_case_name and 2*3*4 as is.', '', '- first item', '- second **item**', '  - nested', '1. one', '2. two', '', '> quoted **line**', '> second', '', '[Docs](https://example.com/a?b=1&c="x") and [bad](javascript:alert(1))', '', '```ts', 'const x = a < b && c > d;', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', 'Tail <script>alert(1)</script> & done.'].join('\n');
const BIG = 'Intro **bold** BIGMD\n```js\n' + Array.from({ length: 300 }, (_, i) => `l${String(i).padStart(3, '0')} a<b && c>d;`).join('\n') + '\n```\nafter';
const respond = ({ coordinator, marker, say }) => !coordinator ? undefined : marker === 'MARK-MD' ? say(MD) : marker === 'MARK-BIGMD' ? say(BIG) : marker === 'MARK-PARSEFAIL' ? say('**PARSEFAIL** plain *fallback* text') : undefined;
const OWNER = { id: 777001, first_name: 'Owner', type: 'private' }, STRANGER = { id: 888002, first_name: 'Mallory', type: 'private' }, GROUP = { id: -100500, title: 'Group', type: 'group' };
const wake = () => { for (const fn of tg.waiters) fn(); };
function push(update) { const item = { update_id: tg.nextUpdate++, ...update }; tg.updates.push(item); wake(); return item; }
const text = (chat, value, extra = {}) => push({ message: { message_id: tg.nextMessage++, date: Math.floor(Date.now() / 1000), chat, from: { id: chat.id > 0 ? chat.id : OWNER.id, is_bot: false, first_name: 'x' }, text: value, ...extra } });
const press = (chat, message, data) => push({ callback_query: { id: randomUUID(), from: { id: chat.id, is_bot: false, first_name: 'x' }, message: { message_id: message.message_id, chat, date: 0, text: message.text }, data } });
const api = createServer((req, res) => {
  let body = ''; req.setEncoding('utf8'); req.on('data', part => { body += part; });
  req.on('end', async () => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const token = match?.[1], bot = bots[token], method = match?.[2], input = body ? JSON.parse(body) : {};
    if (!bot || tg.revoked.has(token)) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    if (method === 'getMe') return reply(200, { ok: true, result: { id: bot.id, is_bot: true, first_name: 'Pi', username: bot.username } });
    if (method === 'getUpdates') {
      tg.polls.push({ at: Date.now(), token: token === TOKEN ? 1 : 2, offset: input.offset ?? 0, timeout: input.timeout });
      if (tg.failPolls > 0) { tg.failPolls--; return reply(502, { ok: false, error_code: 502, description: 'Bad Gateway' }); }
      const ready = () => token === TOKEN ? tg.updates.filter(u => u.update_id >= (input.offset ?? 0)) : [];
      if (!ready().length && input.timeout) await new Promise(ok => { const done = () => { tg.waiters.delete(done); clearTimeout(timer); ok(); }; const timer = setTimeout(done, input.timeout * 1000); tg.waiters.add(done); req.on('close', done); });
      if (res.destroyed) return;
      return reply(200, { ok: true, result: ready().slice(0, 100) });
    }
    if (method === 'sendMessage') {
      if (tg.failWhen?.(input)) { tg.failWhen = null; return reply(502, { ok: false, error_code: 502, description: 'Bad Gateway' }); }
      if (tg.failSends > 0) { tg.failSends--; return reply(502, { ok: false, error_code: 502, description: 'Bad Gateway' }); }
      if (String(input.text ?? '').length > 4096) return reply(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' });
      if (input.parse_mode === 'HTML') { const problem = htmlProblem(input.text); if (problem) { tg.refused.push({ text: input.text, problem }); return reply(400, { ok: false, error_code: 400, description: `Bad Request: can't parse entities: ${problem}` }); } }
      const message = { message_id: tg.nextMessage++, chat: { id: input.chat_id }, text: input.text, parse_mode: input.parse_mode, reply_markup: input.reply_markup, at: Date.now(), bot: bot.username };
      tg.sent.push(message); return reply(200, { ok: true, result: message });
    }
    if (method === 'answerCallbackQuery') { tg.answered.push(input); return reply(200, { ok: true, result: true }); }
    if (method === 'editMessageReplyMarkup' || method === 'editMessageText') { tg.edits.push({ method, ...input }); return reply(200, { ok: true, result: true }); }
    return reply(404, { ok: false, error_code: 404, description: 'Not Found: method' });
  });
});
await new Promise(ok => api.listen(0, '127.0.0.1', ok));
const k = await kit('telegram', { PI_PROJECTS_TELEGRAM_API: `http://127.0.0.1:${api.address().port}`, PI_PROJECTS_TELEGRAM_POLL_S: '20', PI_PROJECTS_TELEGRAM_BACKOFF_MS: '200' }, respond);
k.secrets.push(TOKEN, TOKEN2);
const { result, rpc, eventually, evaluate, waitFor, shot, send } = k;
const toOwner = () => tg.sent.filter(m => m.chat.id === OWNER.id);
const sentTo = id => tg.sent.filter(m => m.chat.id === id);
const lastTo = async (pattern, label, from = 0) => eventually(async () => toOwner().slice(from).findLast(m => pattern.test(m.text)), `no Telegram message: ${label}`, 300);
const buttons = message => (message.reply_markup?.inline_keyboard ?? []).flat();
const settingsUrl = async id => { const url = new URL((await rpc({ action: 'web' })).url); url.searchParams.set('project', id); url.searchParams.set('tab', 'settings'); return url.toString(); };
const jobs = async (id, chatId) => (await rpc({ action: 'show', id, ...(chatId && chatId !== 'main' ? { chatId } : {}) })).jobs;
try {
  await k.startHost();
  const a = await k.setup('Alpha', k.gitRepo), b = await k.setup('Beta');
  const two = await rpc({ action: 'chat-create', id: a, title: 'Two' });
  await k.ask(a, 'main', 'MARK-BEFORE history before pairing');

  // T1/T2: token in Settings; a wrong token is refused; the token never comes back.
  const web = new URL((await rpc({ action: 'web' })).url); web.searchParams.set('project', a); web.searchParams.set('tab', 'settings');
  const s = await k.openPage(web.toString());
  await waitFor(`!!document.querySelector('#telegram-token')`, s, 'telegram card');
  await evaluate(`(() => { document.querySelector('#telegram-token').value = '999:WrongTokenWrongTokenWrongToken123'; document.querySelector('[data-action="telegram-save"]').click(); })()`, s);
  await waitFor(`/rejected|unauthorized/i.test(document.querySelector('#telegram').innerText + document.querySelector('#error').innerText)`, s, 'wrong token refused');
  if ((await rpc({ action: 'telegram-snapshot' })).configured) throw Error('Wrong token saved');
  await evaluate(`(() => { document.querySelector('#telegram-token').value = ${JSON.stringify(TOKEN)}; document.querySelector('[data-action="telegram-save"]').click(); })()`, s);
  await waitFor(`document.querySelector('#telegram').innerText.includes('@pi_fake_bot')`, s, 'bot connected');
  const snap1 = await rpc({ action: 'telegram-snapshot' });
  const file = join(k.home, 'telegram.json');
  if (JSON.stringify(snap1).includes(TOKEN) || (await evaluate(`document.documentElement.outerHTML`, s)).includes(TOKEN) || (statSync(file).mode & 0o077) !== 0 || !readFileSync(file, 'utf8').includes(TOKEN)) throw Error('Token leaked or stored with wrong mode');
  result.checks.push('T1/T2 a wrong token is refused via getMe; the right one is stored 0600 and never returned to the page or the snapshot');

  // T4: before pairing nobody is heard.
  text(STRANGER, 'MARK-STRANGER hello'); text(OWNER, 'MARK-EARLY hello');
  await delay(1500);
  if (tg.sent.length || (await jobs(a)).some(j => /STRANGER|EARLY/.test(j.text))) throw Error('Unpaired chat was heard');
  result.checks.push('T4 before pairing, messages are ignored and nothing is admitted');

  // T5/T6: pairing code; wrong-code cap; private chats only; code not reusable.
  await evaluate(`document.querySelector('[data-action="telegram-pair"]').click()`, s);
  await waitFor(`/\\/pair \\d{6}/.test(document.querySelector('#telegram').innerText)`, s, 'pair code');
  let code = /\/pair (\d{6})/.exec(await evaluate(`document.querySelector('#telegram').innerText`, s))[1];
  for (let i = 0; i < 5; i++) text(STRANGER, `/pair ${String((Number(code) + 1 + i) % 1000000).padStart(6, '0')}`);
  await eventually(async () => !(await rpc({ action: 'telegram-snapshot' })).pairing, 'wrong-code cap did not cancel pairing', 100);
  text(STRANGER, `/pair ${code}`);
  await delay(1000);
  if ((await rpc({ action: 'telegram-snapshot' })).paired) throw Error('Cancelled code paired');
  await evaluate(`document.querySelector('[data-action="telegram-pair"]').click()`, s);
  await waitFor(`/\\/pair \\d{6}/.test(document.querySelector('#telegram').innerText) && !document.querySelector('#telegram').innerText.includes('/pair ${code}')`, s, 'second pair code');
  code = /\/pair (\d{6})/.exec(await evaluate(`document.querySelector('#telegram').innerText`, s))[1];
  await evaluate(`document.querySelector('#notify-card').scrollIntoView()`, s);
  await shot('01-settings-pairing', s);
  text(GROUP, `/pair ${code}`);
  await delay(1000);
  if ((await rpc({ action: 'telegram-snapshot' })).paired) throw Error('Group chat paired');
  text(OWNER, `/pair ${code}`);
  await lastTo(/paired/i, 'pair confirmation');
  text(STRANGER, `/pair ${code}`);
  await waitFor(`/paired/i.test(document.querySelector('#telegram').innerText) && document.querySelector('#telegram').innerText.includes('Owner')`, s, 'paired shown');
  const paired = await rpc({ action: 'telegram-snapshot' });
  if (!paired.paired || paired.pairing || sentTo(STRANGER.id).length || sentTo(GROUP.id).some(m => /paired/i.test(m.text))) throw Error('Pairing wrong: ' + JSON.stringify(paired));
  if (toOwner().some(m => m.text.includes('MARK-BEFORE'))) throw Error('History flooded after pairing');
  result.checks.push('T5/T6 a 6-digit code pairs the owner\'s private chat; 5 wrong codes cancel it; a group or a reused code does not pair; no history flood');

  // T13/T14: routing.
  let mark = toOwner().length;
  text(OWNER, 'MARK-NOROUTE hi');
  await lastTo(/\/projects?/, 'no-route hint', mark);
  text(OWNER, '/projects');
  const list = await lastTo(/Alpha/, 'project list', mark);
  if (!list.text.includes('Beta') || !buttons(list).some(btn => btn.text.includes('Alpha'))) throw Error('Project list wrong');
  text(OWNER, '/project Nope');
  await lastTo(/no project/i, 'unknown project', mark);
  press(OWNER, list, buttons(list).find(btn => btn.text.includes('Alpha')).callback_data);
  await lastTo(/Alpha.*Main/, 'project selected', mark);
  text(OWNER, '/chats');
  const chats = await lastTo(/Two/, 'chat list', mark);
  text(OWNER, '/chat Nope');
  await lastTo(/no chat/i, 'unknown chat', mark);
  press(OWNER, chats, buttons(chats).find(btn => btn.text.includes('Two')).callback_data);
  await lastTo(/Alpha.*Two/, 'chat selected', mark);
  const tg1 = text(OWNER, 'MARK-TGONE hello from Telegram');
  await lastTo(/Sent to Alpha · Two/, 'sent ack', mark);
  const result1 = await lastTo(/Done MARK-TGONE\./, 'result back', mark);
  if (!/Alpha · Two/.test(result1.text)) throw Error('Result header wrong: ' + result1.text);
  if ((await jobs(a, two.id)).filter(j => j.text.includes('MARK-TGONE')).length !== 1 || (await jobs(a)).some(j => /NOROUTE|TGONE/.test(j.text))) throw Error('Routing wrong');
  // Strangers after pairing.
  text(STRANGER, 'MARK-STRANGER2 hi'); press(STRANGER, list, buttons(list)[0].callback_data);
  await delay(1000);
  if (sentTo(STRANGER.id).length || (await jobs(a, two.id)).some(j => j.text.includes('STRANGER'))) throw Error('Stranger heard after pairing');
  result.checks.push('T13/T14/T7 /projects and /chats pick a target by button; unknown names are refused; text goes to that chat and the result comes back; strangers are ignored');

  // T17/T18: question with buttons.
  mark = toOwner().length;
  text(OWNER, 'MARK-ASK please ask');
  const question = await lastTo(/MARK-Q Pick a colour/, 'question notice', mark);
  if (!buttons(question).some(btn => btn.text === 'red') || !buttons(question).some(btn => btn.text === 'blue')) throw Error('Question buttons missing');
  press(OWNER, question, buttons(question).find(btn => btn.text === 'blue').callback_data);
  await lastTo(/ANSWER-ACK blue/, 'answer reached coordinator', mark);
  const entry = (await rpc({ action: 'show', id: a, chatId: two.id })).inbox.find(item => item.kind === 'question');
  if (entry.result?.text !== 'blue') throw Error('Answer not recorded: ' + JSON.stringify(entry));
  press(OWNER, question, buttons(question).find(btn => btn.text === 'red').callback_data);
  await lastTo(/already answered/i, 'stale button refused', mark);
  if ((await rpc({ action: 'show', id: a, chatId: two.id })).inbox.find(item => item.id === entry.id).result.text !== 'blue') throw Error('Stale button changed the answer');
  if (!tg.edits.some(e => e.message_id === question.message_id)) throw Error('Answered question buttons were not removed');
  result.checks.push('T17/T18 a needs-you question arrives with answer buttons; a press records the answer once and wakes the asking chat; a stale button is refused');

  // T19: approval.
  mark = toOwner().length;
  const record = await k.approval(a);
  const approvalMsg = await lastTo(/approval/i, 'approval notice', mark);
  press(OWNER, approvalMsg, buttons(approvalMsg).find(btn => /approve/i.test(btn.text)).callback_data);
  await lastTo(/approved/i, 'approved ack', mark);
  const decided = (await rpc({ action: 'operation-snapshot', id: a })).items.find(item => item.id === record.id);
  if (decided.status !== 'approved' || decided.executionApproved || decided.fingerprint !== record.fingerprint) throw Error('Approval wrong: ' + JSON.stringify(decided));
  result.checks.push('T19 an approval arrives with Approve/Reject; Approve records the exact pending record without execution consent');

  // Errors, long results, reply-to routing, paused project.
  mark = toOwner().length;
  text(OWNER, 'MARK-FAIL please');
  await lastTo(/error|failed/i, 'error notice', mark);
  text(OWNER, 'MARK-LONG please');
  const long = await lastTo(/LONG-START/, 'long result', mark);
  if (long.text.length > 4096) throw Error('Long message not clipped');
  result.checks.push('T17/T20 a coordinator error is sent; a 6000-character result is clipped under the Telegram limit');
  await k.ask(b, 'main', 'MARK-BETA hello');
  const betaResult = await lastTo(/Done MARK-BETA\./, 'beta result', mark);
  text(OWNER, 'MARK-REPLY via reply', { reply_to_message: { message_id: betaResult.message_id, chat: OWNER, date: 0, text: betaResult.text } });
  await lastTo(/Done MARK-REPLY\./, 'reply routed', mark);
  if ((await jobs(b)).filter(j => j.text.includes('MARK-REPLY')).length !== 1 || (await jobs(a, two.id)).some(j => j.text.includes('MARK-REPLY'))) throw Error('Reply-to did not route to Beta');
  result.checks.push('T16 reply-to a result routes to that project/chat');

  // T23-T28: Markdown is rendered as Telegram HTML.
  mark = toOwner().length;
  text(OWNER, 'MARK-MD render please');
  const md = await lastTo(/Release notes/, 'markdown result', mark);
  if (md.parse_mode !== 'HTML') throw Error('No parse_mode HTML: ' + JSON.stringify(md));
  const want = ['<b>Release notes</b>', '<b>bold</b>', '<i>italic</i>', '<i>also italic</i>', '<s>gone</s>', '<code>a &lt; b &amp;&amp; c</code>', 'snake_case_name', '2*3*4', '• first item', '• second <b>item</b>', '  • nested', '1. one', '<blockquote>quoted <b>line</b>\nsecond</blockquote>', '<a href="https://example.com/a?b=1&amp;c=%22x%22">Docs</a>', '<pre><code class="language-ts">const x = a &lt; b &amp;&amp; c &gt; d;</code></pre>', '<pre>| a | b |', 'Tail &lt;script&gt;alert(1)&lt;/script&gt; &amp; done.'];
  const missing = want.filter(part => !md.text.includes(part));
  if (missing.length || /href="javascript/i.test(md.text) || /\*\*|```|^#/m.test(md.text) || /<(h\d|ul|li|p|br)\b/.test(md.text)) throw Error('Rendered HTML wrong, missing ' + JSON.stringify(missing) + ': ' + md.text);
  result.renderedHtml = md.text;
  result.checks.push('T23-T28 a Markdown result is sent with parse_mode HTML: headings bold, bold/italic/strike/code, fenced code as <pre><code class>, lists as •/numbered lines, blockquote, safe links, tables in <pre>, <>& escaped, snake_case untouched');

  // T26/T29/T30: a long code-heavy result is split under 4096 with balanced tags; reply-to on the second part routes.
  mark = toOwner().length;
  tg.failWhen = input => String(input.text).startsWith('<pre>'); // part two fails once: the retry must not resend part one
  text(OWNER, 'MARK-BIGMD split please');
  await lastTo(/after|l\d{3}/, 'big markdown result', mark);
  await delay(1500);
  const parts = toOwner().slice(mark).filter(m => /BIGMD|l\d{3} a&lt;b/.test(m.text));
  const lines = parts.flatMap(m => visible(m.text).match(/l\d{3} a<b && c>d;/g) ?? []);
  if (parts.length < 2 || parts.some(m => m.parse_mode !== 'HTML' || m.text.length > 4096 || htmlProblem(m.text)) || !parts.slice(1).every(m => m.text.startsWith('<pre>'))) throw Error('Split wrong: ' + JSON.stringify(parts.map(m => ({ len: m.text.length, start: m.text.slice(0, 40), mode: m.parse_mode }))));
  if (new Set(lines).size !== lines.length || lines.length < 150) throw Error('Split lost or duplicated lines: ' + lines.length);
  text(OWNER, 'MARK-REPLY2 to part two', { reply_to_message: { message_id: parts[1].message_id, chat: OWNER, date: 0, text: parts[1].text } });
  await lastTo(/Done MARK-REPLY2\./, 'reply to part two routed', mark);
  result.split = parts.map(m => m.text.length);
  result.checks.push(`T26/T29/T30 a ${lines.length}-line escaped code result (clipped mid-fence by the feed) is split into ${parts.length} HTML parts under 4096 (${result.split.join(', ')}), each balanced, code reopened in <pre>, no line lost or repeated even though part two failed once and was retried; reply-to on part two routes`);
  if (tg.failWhen) throw Error('Part-two failure was not exercised');

  // T31: Telegram refuses the HTML: plain-text fallback, outbox not stuck.
  mark = toOwner().length;
  text(OWNER, 'MARK-PARSEFAIL please');
  const plain = await lastTo(/PARSEFAIL plain fallback text/, 'plain fallback', mark);
  if (plain.parse_mode || /<\/?b>|\*\*/.test(plain.text) || !tg.refused.some(item => item.problem === 'forced by test')) throw Error('Fallback wrong: ' + JSON.stringify(plain));
  text(OWNER, 'MARK-AFTERFAIL next');
  await lastTo(/Done MARK-AFTERFAIL\./, 'next notice after fallback', mark);
  result.checks.push('T31 a 400 "can\'t parse entities" falls back to plain text (markup stripped) once and the outbox moves on');
  const commands = toOwner().filter(m => /^Now talking to|^Projects:|^Chats in/.test(m.text));
  if (!commands.length || commands.some(m => m.parse_mode)) throw Error('Command replies must stay plain text');
  result.checks.push('T32 bot command replies stay plain text');

  // T21: outbox retries in order after Bot API failures.
  mark = toOwner().length;
  tg.failSends = 2;
  await k.ask(b, 'main', 'MARK-RETRY1 one');
  await k.ask(b, 'main', 'MARK-RETRY2 two');
  await lastTo(/Done MARK-RETRY2\./, 'retried notices', mark);
  const order = toOwner().slice(mark).map(m => m.text).filter(t => /MARK-RETRY/.test(t));
  if (order.length !== 2 || !order[0].includes('RETRY1')) throw Error('Outbox order/duplicates wrong: ' + JSON.stringify(order));
  result.checks.push('T21 notices that fail to send are retried in order, once each');

  // T10: getUpdates failures back off and recover.
  tg.failPolls = 5; const pollMark = tg.polls.length; wake();
  await eventually(async () => tg.polls.length >= pollMark + 6, 'polling did not retry', 300);
  const failing = await rpc({ action: 'telegram-snapshot' });
  const gaps = tg.polls.slice(pollMark, pollMark + 6).map((p, i, all) => i ? p.at - all[i - 1].at : 0).slice(1);
  if (!(gaps[3] > gaps[0] * 2) || gaps[0] < 150) throw Error('No backoff: ' + JSON.stringify(gaps));
  mark = toOwner().length;
  text(OWNER, 'MARK-RECOVER after outage');
  await lastTo(/Done MARK-RECOVER\./, 'recovered', mark);
  result.backoffGaps = gaps; result.checks.push(`T10 a failing Bot API backs off (${gaps.join(', ')} ms) and polling recovers${failing.lastError ? '; the error was visible meanwhile' : ''}`);

  // T8/T9/T17: restart with a rewound offset (crash before persist) replays updates without duplicate effects; no outbound duplicates.
  const before = { alpha: (await jobs(a, two.id)).length, beta: (await jobs(b)).length, sent: toOwner().length };
  const shutdownMs = await k.stopHost();
  if (shutdownMs > 8000) throw Error(`Shutdown waited on the long poll: ${shutdownMs} ms`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.offset = tg1.update_id; writeFileSync(file, JSON.stringify(saved, null, 2));
  text(OWNER, 'MARK-WHILEDOWN sent while host down');
  await k.startHost();
  await lastTo(/Done MARK-WHILEDOWN\./, 'update sent while down', before.sent);
  await delay(2500);
  const after = { alpha: (await jobs(a, two.id)).length, beta: (await jobs(b)).length };
  if (after.alpha !== before.alpha + 1 || after.beta !== before.beta) throw Error('Replayed updates admitted twice: ' + JSON.stringify({ before, after }));
  const resultsOnce = ['Done MARK-TGONE.', 'Done MARK-BETA.', 'Done MARK-REPLY.', 'Done MARK-WHILEDOWN.'].map(t => toOwner().filter(m => m.text.includes(t)).length);
  if (resultsOnce.some(n => n !== 1)) throw Error('Outbound duplicates across restart: ' + JSON.stringify(resultsOnce));
  if ((await rpc({ action: 'show', id: a, chatId: two.id })).inbox.find(item => item.id === entry.id).result.text !== 'blue') throw Error('Replay changed the answer');
  result.checks.push(`T8/T9/T11 shutdown does not wait for the long poll (${shutdownMs} ms); after a restart with a rewound offset, replayed updates admit nothing twice, the update sent while down arrives once, and no notice is sent twice`);

  // T15: text to a paused project gets the error back (after the replay check, so the replayed updates do not include it).
  mark = toOwner().length;
  await rpc({ action: 'pause', id: a });
  text(OWNER, 'MARK-PAUSED while paused');
  await lastTo(/paused/i, 'paused error back', mark);
  if ((await jobs(a, two.id)).some(j => j.text.includes('MARK-PAUSED'))) throw Error('Paused project admitted text');
  await rpc({ action: 'resume', id: a, recovery: 'leave-interrupted', confirm: a });
  result.checks.push('T15 text to a paused project is not admitted and the error comes back to Telegram');

  // T3/T2: switching bots resets pairing and offset; a revoked token stops polling with an error; removing the token stops polling.
  await evaluate(`window.__old = true`, s);
  await send('Page.navigate', { url: await settingsUrl(a) }, s);
  await waitFor(`!window.__old && document.readyState === 'complete' && !!document.querySelector('#telegram-token')`, s, 'card after restart');
  // The page left open across the restart polled the new host with its old token (401) until it was reopened with the new address.
  result.httpErrors = result.httpErrors.filter(e => e.status !== 401);
  await evaluate(`document.querySelector('#notify-card').scrollIntoView()`, s);
  await shot('02-settings-paired', s);
  tg.revoked.add(TOKEN); wake();
  await eventually(async () => /rejected|unauthorized/i.test((await rpc({ action: 'telegram-snapshot' })).lastError ?? ''), 'revoked token not surfaced', 300);
  const stopped = tg.polls.filter(p => p.token === 1).length; await delay(1500);
  if (tg.polls.filter(p => p.token === 1).length > stopped + 1) throw Error('Polling continued with a revoked token');
  tg.revoked.delete(TOKEN);
  await rpc({ action: 'telegram-token', token: TOKEN2 });
  const other = await rpc({ action: 'telegram-snapshot' });
  if (other.paired || other.botUsername !== 'pi_other_bot' || JSON.parse(readFileSync(file, 'utf8')).offset !== 0) throw Error('Bot switch kept pairing or offset: ' + JSON.stringify(other));
  await eventually(async () => tg.polls.some(p => p.token === 2), 'new bot not polled', 100);
  await rpc({ action: 'telegram-remove', confirm: 'remove' });
  const removedAt = tg.polls.length; await delay(1500);
  if (tg.polls.length > removedAt + 1 || (await rpc({ action: 'telegram-snapshot' })).configured || readFileSync(file, 'utf8').includes(TOKEN2)) throw Error('Polling continued or token kept after removal');
  result.checks.push('T2/T3/T11 a revoked token stops polling with a visible error; another bot resets pairing and offset; removing the bot stops polling and deletes the token');

  // T1: no token in logs; mobile layout.
  await k.stopHost();
  for (const log of k.logs) { const content = readFileSync(log, 'utf8'); if (content.includes(TOKEN) || content.includes(TOKEN2)) throw Error('Token in host log ' + log); }
  await k.startHost();
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await send('Page.navigate', { url: await settingsUrl(a) }, s);
  await waitFor(`!!document.querySelector('#telegram-token')`, s, 'mobile card');
  result.httpErrors = result.httpErrors.filter(e => e.status !== 401); // same restart window as above
  await evaluate(`document.querySelector('#notify-card').scrollIntoView()`, s);
  if (!await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s)) throw Error('Telegram card overflows at 390px');
  await shot('03-settings-mobile', s);
  result.checks.push('T1/T22 no host log contains a token; the card fits a 390 px screen');
  result.telegram = { sent: tg.sent.map(m => ({ to: m.chat.id, text: m.text.slice(0, 300), buttons: buttons(m).map(btn => btn.text) })), polls: tg.polls.length };
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = k.redact(error?.stack ?? error);
  result.telegram = { sent: tg.sent.map(m => ({ to: m.chat.id, text: m.text.slice(0, 300) })), polls: tg.polls.length };
}
api.closeAllConnections(); api.close();
await k.finish(result.status);
