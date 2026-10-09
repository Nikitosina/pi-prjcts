// Browser E2E: coordinator questions are answered in the chat transcript, not the sidebar. Fake model only.
// Failure cases: chat-questions-failures.md. Artifact: artifacts/chat-questions-<time>/ (report.json + screenshots).
import { createKit, call, say } from './lib/e2e-kit.mjs';
import { contrastLib } from './lib/contrast-scan.mjs';

const kit = await createKit('chat-questions', {
  handler: ({ role, user, results }) => {
    if (role !== 'coordinator' || user.startsWith('[Durable work')) return undefined;
    if (!results.length && /MARK-ASK-RICH/.test(user)) return call('projects_question', { question: 'MARK-RICH Which database should we use?\nPostgres gives **transactions**; SQLite is `zero-config`.\n\n- fast to start\n- <img src=x onerror="window.__xss=1">', choices: ['Postgres', 'SQLite', 'Something else'] });
    if (!results.length && /MARK-ASK-FREE/.test(user)) return call('projects_question', { question: 'MARK-FREE What should the release be called?' });
    if (!results.length && /MARK-ASK-OTHER/.test(user)) return call('projects_question', { question: 'MARK-OTHER Ship the other chat now?', choices: ['Ship', 'Wait'] });
    return say(`ACK ${user.replace(/\s+/g, ' ').slice(0, 160)}`);
  },
});
const { check, rpc } = kit;
kit.initRepo();

await kit.run(async () => {
  const id = await kit.createProject('Questions');
  const other = await rpc({ action: 'chat-create', id, title: 'Side chat' });
  await rpc({ action: 'message', id, text: 'Hello MARK-HI' }); await kit.delay(300); await kit.settle(id);
  await rpc({ action: 'message', id, text: 'MARK-ASK-RICH please' }); await kit.delay(300); await kit.settle(id);
  await rpc({ action: 'message', id, text: 'MARK-ASK-FREE please' }); await kit.delay(300); await kit.settle(id);
  await rpc({ action: 'message', id, chatId: other.id, text: 'MARK-ASK-OTHER please' }); await kit.delay(300); await kit.settle(id);
  const inbox = (await rpc({ action: 'show', id })).inbox.filter(item => !item.result);
  check('three questions recorded', inbox.length === 3, inbox.map(i => i.title));

  const page = await kit.openPage(await kit.webUrl(id, 'coordinator'));
  const ev = page.evaluate;
  const view = async (width, theme) => { await page.viewport(width, 1000, width < 600); await ev(`piTheme.set('${theme}')`); await kit.delay(500); };
  await page.waitFor(`document.querySelectorAll('#questions .question-card').length === 2`, 'two question cards in Main');
  await ev(`window.__xss = 0`);

  // Q1/Q2/Q3/Q11/Q12: location, order, other-chat banner, sidebar link, badge, composer hint.
  const state = await ev(`(() => { const t = document.querySelector('#transcript'), q = document.querySelector('#questions'), m = document.querySelector('#messages');
    return { letter: document.querySelector('#letter').innerText.trim(), after: !!(m.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING), inTranscript: t.contains(q),
      titles: [...q.querySelectorAll('.question-card .q-title')].map(n => n.innerText), banner: q.querySelector('.question-away')?.innerText ?? '', badge: document.querySelector('#needs-count').innerText,
      side: document.querySelector('#needs-questions').innerText, cardShown: !!document.querySelector('#needs-card').offsetParent, hint: !!document.querySelector('#question-hint').offsetParent,
      choices: [...q.querySelectorAll('.question-card:first-of-type .choices button')].map(b => b.innerText.replace(/\\s+/g, ' ')), textareas: q.querySelectorAll('.question-card textarea').length, xss: window.__xss, imgs: q.querySelectorAll('img').length, md: !!q.querySelector('.q-body strong') && !!q.querySelector('.q-body code') } })()`);
  check('Q1 sidebar letter has no question', state.letter === '', state);
  check('Q2 cards sit in the transcript after the messages', state.after && state.inTranscript, state);
  check('Q13 questions stack in asked order', state.titles[0].includes('MARK-RICH') && state.titles[1].includes('MARK-FREE'), state.titles);
  check('Q3 question of another chat shows an Open banner, no card', /Side chat/.test(state.banner) && /MARK-OTHER/.test(state.banner), state.banner);
  check('Q12 tab badge counts all three questions', state.badge === '3', state.badge);
  check('Q11 sidebar shows only a compact jump link for questions', state.cardShown && /2 questions in chat/.test(state.side) && /1 question in other chats/.test(state.side), state);
  check('Q10 composer hint points at the question', state.hint, state);
  check('Q5 free-text field always visible on every card', state.textareas === 2, state);
  check('Q4 choices show numbered pill buttons', state.choices.length === 3 && state.choices[0].includes('Postgres'), state.choices);
  check('Q9 markdown renders; markup in a question is inert', state.md && state.xss === 0 && state.imgs === 0, state);
  await view(1440, 'light'); await page.shot('01-pending-light');
  await view(1440, 'dark'); await page.shot('02-pending-dark');
  const scan = dark => ev(`window.__scan(${dark}, document.querySelector('#transcript'))`);
  await ev(contrastLib);
  for (const [theme, dark] of [['light', false], ['dark', true]]) {
    await view(1440, theme); const found = await scan(dark);
    check(`Q15 ${theme}: transcript contrast >= 4.5${dark ? ', no light surfaces' : ''}`, found.low.length === 0 && (!dark || found.bright.length === 0), found);
  }
  await view(420, 'light'); await page.shot('03-narrow-light');
  const overflow = await ev(`document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('#questions .question-card')].every(c => c.getBoundingClientRect().right <= innerWidth + 1)`);
  check('Q15 420 px: no horizontal overflow', overflow);
  await view(420, 'dark'); await page.shot('04-narrow-dark');
  await view(1440, 'light');

  // Q6: a draft survives polls and keeps focus; Q5: Shift+Enter is a newline; empty answers are not sent.
  await ev(`(() => { const t = document.querySelectorAll('#questions .question-card textarea')[1]; t.focus(); t.value = 'Orion'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await kit.delay(5000);
  const kept = await ev(`(() => { const t = document.querySelectorAll('#questions .question-card textarea')[1]; return { value: t.value, focused: document.activeElement === t }; })()`);
  check('Q6 draft and focus survive polling re-renders', kept.value === 'Orion' && kept.focused, kept);
  // Q10: normal composer message still works while questions are pending.
  await ev(`(() => { const t = document.querySelector('#compose textarea'); t.value = 'MARK-NORMAL still talking'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#compose').requestSubmit(); })()`);
  await page.waitFor(`document.querySelector('#messages').innerText.includes('MARK-NORMAL')`, 'normal message sent');
  await kit.settle(id);
  check('Q10 composer sends normal messages while a question is pending', (await ev(`document.querySelectorAll('#questions .question-card').length`)) === 2);
  await page.waitFor(`document.querySelectorAll('#questions .question-card').length === 2`, 'cards still there');

  // Q16: digits are ignored while typing in a textarea, pick a choice from the focused card.
  await ev(`(() => { const t = document.querySelectorAll('#questions .question-card textarea')[1]; t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); })()`);
  await kit.delay(400);
  check('Q16 digit typed in the textarea answers nothing', (await rpc({ action: 'show', id })).inbox.filter(i => !i.result).length === 3);

  // Free-text answer with Enter (Q5), via the real key handler.
  await ev(`(() => { const t = document.querySelectorAll('#questions .question-card textarea')[1]; t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })); })()`);
  check('Q5 Shift+Enter does not submit', (await rpc({ action: 'show', id })).inbox.filter(i => !i.result).length === 3);
  await ev(`document.querySelectorAll('#questions .question-card textarea')[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  const freeDone = await kit.eventually(async () => (await rpc({ action: 'show', id })).inbox.find(i => i.title.includes('MARK-FREE') && i.result), 'free answer not recorded', 100);
  check('Q5 Enter sends the free-text answer', freeDone.result.text === 'Orion', freeDone.result);
  await page.waitFor(`document.querySelectorAll('#questions .question-card').length === 1 && document.querySelector('#messages .question-done')?.innerText.includes('Orion')`, 'answered record in place');
  await kit.settle(id);

  // Q4/Q8: choice click answers once; the card becomes an in-place record; the coordinator is woken with the answer.
  await ev(`document.querySelector('#questions .choices button[data-choice="0"]').dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))`);
  await page.waitFor(`document.querySelectorAll('#questions .question-card').length === 0`, 'card answered by digit key');
  const rich = (await rpc({ action: 'show', id })).inbox.find(i => i.title.includes('MARK-RICH'));
  check('Q4/Q16 digit key on the card picks the matching choice exactly once', rich.result?.text === 'Postgres', rich.result);
  const delivered = await kit.eventually(async () => (await rpc({ action: 'show', id })).messages.find(m => m.role === 'user' && m.text.includes('MARK-RICH') && m.text.includes('Postgres')), 'answer not delivered');
  check('answer wakes the coordinator with question and answer', !!delivered);
  await kit.settle(id);
  const records = await ev(`[...document.querySelectorAll('#messages .question-done')].map(n => n.innerText.replace(/\\s+/g, ' '))`);
  check('Q8 answered records stay in the transcript', records.length === 2 && records.some(r => r.includes('Answered: Postgres')) && records.some(r => r.includes('Answered: Orion')), records);
  const order = await ev(`(() => { const kids = [...document.querySelectorAll('#messages > *')]; const at = text => kids.findIndex(n => n.innerText.includes(text)); return { hi: at('MARK-HI'), rich: kids.findIndex(n => n.classList.contains('question-done') && n.innerText.includes('Postgres')), normal: at('MARK-NORMAL') }; })()`);
  check('Q8 record sits where it was asked, before later messages', order.hi < order.rich && order.rich < order.normal, order);
  check('Q11 only the other-chat question remains: link opens it', await ev(`!document.querySelector('#questions .question-card') && /1 question in other chats/.test(document.querySelector('#needs-questions').innerText) && !document.querySelector('#question-hint').offsetParent`));
  await view(1440, 'light'); await page.shot('05-answered-light'); await view(1440, 'dark'); await page.shot('06-answered-dark');

  // Q3: the banner opens the other chat, where the card lives; digit-less choice click works there too.
  await ev(`document.querySelector('#questions .question-away button').click()`);
  await page.waitFor(`document.querySelectorAll('#questions .question-card').length === 1 && document.querySelector('#questions').innerText.includes('MARK-OTHER')`, 'card in the other chat');
  await view(1440, 'light'); await page.shot('07-other-chat-light'); await view(1440, 'dark'); await page.shot('08-other-chat-dark');
  await ev(`document.querySelector('#questions .choices button[data-choice-text="Ship"]').click()`);
  await page.waitFor(`document.querySelector('#messages .question-done')?.innerText.includes('Answered: Ship')`, 'answered in the other chat');
  check('Q3/Q4 other-chat question answered from its own chat', (await rpc({ action: 'show', id })).inbox.find(i => i.title.includes('MARK-OTHER')).result.text === 'Ship');
  await kit.settle(id);
  check('Q11 nothing pending: Needs you card hidden, badge gone', await ev(`!document.querySelector('#needs-card').offsetParent && document.querySelector('#needs-count').hidden`));
  await view(1440, 'light');
});
