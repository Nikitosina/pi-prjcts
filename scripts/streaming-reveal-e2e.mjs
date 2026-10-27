// Real host/browser regression. Only the provider cadence is a controlled fixture.
import { createKit, delay } from './lib/e2e-kit.mjs';

const chunk = (text, finish = null) => `data: ${JSON.stringify({ id: 'reveal', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finish }] })}\n\n`;
const intro = '# Smooth stream\n\nAn earlier paragraph stays readable and never fades again.\n\n```js\nconst ready = true;\n```\n\n';
const bursts = ['New text arrives in a burst. '.repeat(100), 'Later words keep the same paragraph alive. '.repeat(100), '\n\n```sh\nprintf "complete code\\n"\n```\n\nFinal readable paragraph.'];
const gates = [], release = [];
for (let i = 0; i < 7; i++) gates.push(new Promise(resolve => { release.push(resolve); }));
const cancelled = 'Cancellation keeps the latest received preview safe. '.repeat(80);
const formatStart = 'Earlier stable phrase **unfinished';
const formatEnd = ' bold** and new words.';
const k = await createKit('streaming-reveal', { handler: async ({ user, role }) => {
  if (role !== 'coordinator') return;
  if (user.includes('MARK-SMOOTH')) return (async function* () {
    yield chunk(intro);
    for (let i = 0; i < bursts.length; i++) { await gates[i]; yield chunk(bursts[i]); }
    await gates[3]; yield chunk('', 'stop') + 'data: [DONE]\n\n';
  })();
  if (user.includes('MARK-FORMAT')) return (async function* () {
    yield chunk(formatStart); await gates[5]; yield chunk(formatEnd);
    await gates[6]; yield chunk('', 'stop') + 'data: [DONE]\n\n';
  })();
  if (user.includes('MARK-CANCEL')) return (async function* () {
    yield chunk(cancelled); await gates[4]; yield chunk('', 'stop') + 'data: [DONE]\n\n';
  })();
} });
await k.run(async () => {
  const id = await k.createProject('Smooth reveal', { grant: false });
  const page = await k.openPage(await k.webUrl(id, 'coordinator'));
  await page.waitFor(`document.querySelector('#title')?.textContent === 'Smooth reveal' && view?.chatId === 'main' && !document.querySelector('#compose textarea').disabled`, 'project and composer ready');
  const send = async text => {
    await page.evaluate(`document.querySelector('#compose textarea').focus()`);
    await page.cdp('Input.insertText', { text });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  await send('MARK-SMOOTH');
  await page.waitFor(`liveRenderedText === ${JSON.stringify(intro)}`, 'initial reveal caught up');
  await delay(250);
  await page.evaluate(`(() => {
    window.__oldParagraph = document.querySelector('#live-reply p:not(.thought)');
    window.__smooth = { starts: [], received: [], paints: [] };
    document.querySelector('#live-reply').addEventListener('animationstart', e => {
      if (e.animationName !== 'stream-in') return;
      window.__smooth.starts.push({ t: performance.now(), old: window.__oldParagraph.contains(e.target), opacity: +getComputedStyle(e.target).opacity, text: e.target.textContent.length });
    });
    window.__apply = applyLive;
    applyLive = async frame => { window.__smooth.received.push({ t: performance.now(), length: frame.text.length }); return window.__apply(frame); };
    window.__paint = new MutationObserver(() => window.__smooth.paints.push({ t: performance.now(), length: liveRenderedText?.length }));
    window.__paint.observe(document.querySelector('#live-reply .text'), { childList: true, subtree: true, characterData: true });
  })()`);
  release[0]();
  await page.waitFor(`liveRenderedText === ${JSON.stringify(intro + bursts[0])}`, 'burst caught up');
  const first = await page.evaluate(`(() => {
    const s = window.__smooth, received = s.received.find(r => r.length > ${intro.length});
    const paints = s.paints.filter(p => p.t >= received.t && p.length > ${intro.length});
    window.__growingParagraph = [...document.querySelectorAll('#live-reply .text p')].at(-1);
    return { animations: s.starts, paints, lag: paints.find(p => p.length === ${intro.length + bursts[0].length})?.t - received.t, oldConnected: window.__oldParagraph.isConnected };
  })()`);
  k.check('S1 provider burst reveals in several paints and catches up within 200ms', new Set(first.paints.map(p => p.length)).size >= 2 && first.lag < 200, first);
  k.check('S2 only new text fades; earlier paragraph is retained and never reanimated', first.oldConnected && first.animations.length > 0 && first.animations.every(a => !a.old) && first.animations.some(a => a.opacity < .95 && a.opacity > 0), first);

  await page.evaluate(`(() => { const t = document.querySelector('#transcript'), p = window.__oldParagraph; t.scrollTop += p.getBoundingClientRect().top - t.getBoundingClientRect().top - 25; t.dispatchEvent(new Event('scroll')); window.__oldTop = p.getBoundingClientRect().top; })()`);
  await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  release[1]();
  await page.waitFor(`liveRenderedText === ${JSON.stringify(intro + bursts[0] + bursts[1])}`, 'reduced motion immediate reveal');
  const reduced = await page.evaluate(`(() => { const s=window.__smooth, r=s.received.at(-1), paints=s.paints.filter(p=>p.t>=r.t); return { retained:window.__growingParagraph.isConnected, text:window.__oldParagraph.textContent, top:window.__oldParagraph.getBoundingClientRect().top, before:window.__oldTop, animations:document.querySelector('#live-reply').getAnimations({subtree:true}).filter(a=>a.animationName==='stream-in').length, lengths:[...new Set(paints.map(p=>p.length))] }; })()`);
  k.check('S3 reduced motion has no fades or paced backlog and retains growing paragraph and older reading anchor', reduced.animations === 0 && reduced.retained && Math.abs(reduced.top - reduced.before) < 2 && reduced.lengths.length <= 1, reduced);
  await page.cdp('Emulation.setEmulatedMedia', { features: [] });

  // Exercise the visibility handler with independent document visibility, not a window resize.
  await page.evaluate(`Object.defineProperty(document, 'hidden', { configurable:true, value:true }); document.dispatchEvent(new Event('visibilitychange'))`);
  release[2]();
  const expected = intro + bursts.join('');
  await page.waitFor(`liveRenderedText === ${JSON.stringify(expected)}`, 'hidden tab receives full latest preview');
  await page.evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
  k.check('S4 background/resume flushes latest text without animation or pending reveal', await page.evaluate(`liveRenderedText === liveFrame.text && liveRenderFrame === null && document.querySelectorAll('#live-reply .stream-fragment').length === 0`));
  await page.evaluate(`liveStream.controller.abort()`);
  await page.waitFor(`liveStream === null`, 'stream abort settled');
  k.check('S5 stream abort and resume keep the last valid snapshot visible and clear reveal work', await page.evaluate(`(() => { document.dispatchEvent(new Event('visibilitychange')); return !document.querySelector('#live-reply').hidden && liveRenderedText === liveFrame.text && liveRenderFrame === null; })()`));
  await page.evaluate(`ensureLive()`);
  await page.waitFor(`liveStream !== null`, 'reconnected stream');
  const side = await k.rpc({ action: 'chat-create', id, title: 'Other' });
  await page.waitFor(`!!document.querySelector('[data-chat="${side.id}"]')`, 'other chat');
  await page.evaluate(`document.querySelector('[data-action="chat-select"][data-chat="${side.id}"]').click()`);
  await page.waitFor(`document.querySelector('#live-reply').hidden && liveRenderFrame === null`, 'switch clears live reveal');
  k.check('S6 chat switch cannot leak buffered text or fades into the other transcript', await page.evaluate(`!document.querySelector('#messages').innerText.includes('New text arrives') && !document.querySelector('#live-reply .stream-fragment')`));
  await page.evaluate(`document.querySelector('[data-action="chat-select"][data-chat="main"]').click()`);
  await page.waitFor(`liveRenderedText === ${JSON.stringify(expected)}`, 'main live preview restores');
  const selected = await page.evaluate(`(() => { const p=document.querySelector('#live-reply .text p'), range=document.createRange(); range.selectNodeContents(p); const s=getSelection();s.removeAllRanges();s.addRange(range);return s.toString(); })()`);
  release[3]();
  await page.waitFor(`document.querySelector('#live-reply').hidden && document.querySelector('#messages').innerText.includes('Final readable paragraph.')`, 'completion flush');
  const host = (await k.rpc({ action:'show', id })).messages.findLast(m=>m.role==='assistant')?.text;
  const final = await page.evaluate(`(() => { const root=[...document.querySelectorAll('#messages .msg.them .text')].at(-1), e=document.createElement('div'); e.innerHTML=renderMarkdown(${JSON.stringify(expected)}); return { equal:root.innerHTML===e.innerHTML, selected:getSelection().toString(), pending:liveRenderFrame }; })()`);
  k.check('S7 completion is exact, retains selection and leaves no reveal queue', host === expected && final.equal && final.selected === selected && final.pending === null, final);
  await page.evaluate(`getSelection().removeAllRanges()`);
  await send('MARK-FORMAT');
  await page.waitFor(`liveRenderedText === ${JSON.stringify(formatStart)}`, 'unfinished inline markdown');
  await delay(250);
  await page.evaluate(`(() => {
    window.__formatText = document.querySelector('#live-reply .text p').firstChild;
    window.__formatRefades = 0;
    document.querySelector('#live-reply').addEventListener('animationstart', e => { if(e.animationName === 'stream-in' && e.target.textContent.includes('Earlier stable phrase')) window.__formatRefades++; });
  })()`);
  release[5]();
  await page.waitFor(`liveRenderedText === ${JSON.stringify(formatStart + formatEnd)}`, 'inline markdown closes');
  await delay(200);
  k.check('S8 closing inline markdown preserves earlier text nodes without re-fading old words', await page.evaluate(`window.__formatText.isConnected && window.__formatText.data === 'Earlier stable phrase ' && window.__formatRefades === 0 && document.querySelector('#live-reply strong')?.textContent === 'unfinished bold'`));
  release[6]();
  await page.waitFor(`document.querySelector('#live-reply').hidden`, 'formatting reply committed');
  await send('MARK-CANCEL');
  await page.waitFor(`liveFrame?.text === ${JSON.stringify(cancelled)}`, 'cancellable live reply');
  await page.evaluate(`document.querySelector('#project-pause').click()`);
  await page.waitFor(`!!document.querySelector('[data-action="confirm-pause"]')`, 'pause confirmation');
  await page.evaluate(`document.querySelector('[data-action="confirm-pause"]').click()`);
  await page.waitFor(`document.querySelector('#live-reply').hidden && liveRenderFrame === null`, 'cancellation clears live reveal');
  release[4]();
  await delay(250);
  k.check('S9 cancellation clears queued reveal and no animation resurrects the bubble', await page.evaluate(`document.querySelector('#live-reply').hidden && liveRenderFrame === null && !document.querySelector('#live-reply .stream-fragment')`));
  const cancelHost = (await k.rpc({ action: 'show', id })).messages.findLast(m => m.role === 'assistant')?.text;
  const cancelBrowser = await page.evaluate(`document.querySelector('#messages').innerText`);
  k.check('S10 cancellation retains the received partial text in storage and the transcript', cancelHost === cancelled && cancelBrowser.includes(cancelled.trim()), { hostLength: cancelHost?.length, expectedLength: cancelled.length });
  k.result.measurements = { first, reduced, final, responseLength: expected.length, cancelledLength: cancelHost.length };
});
