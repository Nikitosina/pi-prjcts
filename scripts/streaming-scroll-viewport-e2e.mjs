// Browser regression for streaming paint cadence, transcript anchoring and the mobile viewport shell.
// Isolated host, deterministic local fake model and real Chrome/CDP input. Mobile metrics are not Safari proof.
import { createKit, delay } from './lib/e2e-kit.mjs';

const burstText = Array.from({ length: 32 }, (_, i) => `Burst paragraph ${i}: ${'readable text '.repeat(8)}`).join('\n\n');
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
let finishSelectionStream;
const selectionGate = new Promise(resolve => { finishSelectionStream = resolve; });
const selectionText = 'Select this live paragraph while the reply is still running.';
const longBlock = i => `## Stable section ${i}\n\nReading marker ${i}. ${'Keep this paragraph readable while later output arrives. '.repeat(8)}\n\n\`\`\`sh\nprintf 'stable code ${i}\\n'\nnpm run check\n\`\`\`\n\n`;
const longPrefix = Array.from({ length: 10 }, (_, i) => longBlock(i)).join('');
const longMiddle = Array.from({ length: 20 }, (_, i) => longBlock(i + 10)).join('') + '```text\n' + 'growing code line '.repeat(2200) + '\n```\n\n';
const longExtra = Array.from({ length: 20 }, (_, i) => longBlock(i + 70)).join('');
const longText = longPrefix + longMiddle + longExtra;
let continueLong, extendLong, finishLong;
const longGates = [new Promise(r => { continueLong = r; }), new Promise(r => { extendLong = r; }), new Promise(r => { finishLong = r; })];
const k = await createKit('streaming-scroll-viewport', { handler: async ({ role, user }) => {
  if (role !== 'coordinator') return undefined;
  if (user.includes('MARK-LONG')) return (async function* () {
    yield chunk({ role: 'assistant', content: longPrefix });
    await longGates[0];
    for (let at = 0; at < longMiddle.length; at += 2000) {
      yield chunk({ content: longMiddle.slice(at, at + 2000) });
      await delay(120);
    }
    await longGates[1];
    yield chunk({ content: longExtra });
    await longGates[2];
    yield chunk({}, 'stop') + 'data: [DONE]\n\n';
  })();
  if (user.includes('MARK-SELECTION')) return (async function* () {
    yield chunk({ role: 'assistant', content: selectionText });
    await selectionGate;
    yield chunk({ content: ' The final paragraph arrived.' });
    yield chunk({}, 'stop') + 'data: [DONE]\n\n';
  })();
  if (user.includes('MARK-BURST')) {
    // Deliberately deliver the entire sequence as one bursty HTTP response.
    return chunk({ role: 'assistant', content: '' }) + burstText.split(/(?<= )/).map(content => chunk({ content })).join('') + chunk({}, 'stop') + 'data: [DONE]\n\n';
  }
  if (user.includes('MARK-FILL')) return undefined;
  return undefined;
} });
const { result } = k;
const metrics = async page => page.evaluate(`(() => {
  const v = visualViewport, composer = document.querySelector('#compose').getBoundingClientRect();
  const status = document.querySelector('#limits-bar').getBoundingClientRect();
  const send = document.querySelector('#compose button[type="submit"]').getBoundingClientRect();
  return { width: innerWidth, height: innerHeight, visualWidth: v?.width, visualHeight: v?.height,
    visualTop: v?.offsetTop, composerBottom: composer.bottom, sendInside: send.right <= composer.right + 1 && send.bottom <= composer.bottom + 1, statusTop: status.top, statusBottom: status.bottom,
    bodyScroll: document.scrollingElement.scrollTop, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
})()`);
const anchored = async page => page.evaluate(`(() => {
  const t = document.querySelector('#transcript'), box = t.getBoundingClientRect();
  const row = [...t.querySelectorAll('[data-index]')].find(n => { const r = n.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
  return row ? { index: row.dataset.index, offset: row.getBoundingClientRect().top - box.top, top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight } : null;
})()`);
const readOlder = async page => {
  await page.evaluate(`(() => { const t = document.querySelector('#transcript'); t.scrollTop = Math.min(180, t.scrollHeight - t.clientHeight - 80); t.dispatchEvent(new Event('scroll')); })()`);
  await delay(150);
  return anchored(page);
};

await k.run(async () => {
  const id = await k.createProject('Streaming and viewport', { grant: false });
  for (let i = 0; i < 34; i++) await k.ask(id, `MARK-FILL ${i}`);
  const url = new URL(await k.webUrl(id, 'coordinator')); url.searchParams.set('e2e', '1');
  const page = await k.openPage(url.toString());
  await page.waitFor(`document.querySelectorAll('#messages .msg').length >= 20`, 'seeded transcript');
  await page.shot('01-desktop', { force: true });
  result.measurements = {};

  // A trailing user message used to re-enable following on every refresh. Real polling must not do that.
  const beforePoll = await readOlder(page);
  await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 20, y: 20 });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 20, y: 20 });
  await page.evaluate(`document.querySelector('#refresh').click()`);
  await delay(400);
  const afterPoll = await anchored(page);
  k.check('R1 polling preserves the older-message anchor instead of jumping to a trailing user message', beforePoll.index === afterPoll.index && Math.abs(beforePoll.offset - afterPoll.offset) < 2 && afterPoll.gap > 100, { beforePoll, afterPoll });
  result.measurements.polling = { beforePoll, afterPoll };

  // Selection is content, not a disposable side effect of a polling render.
  const selection = await page.evaluate(`(() => {
    const text = [...document.querySelectorAll('#messages .msg.them .text p')].find(n => n.getBoundingClientRect().bottom > document.querySelector('#transcript').getBoundingClientRect().top);
    const range = document.createRange(); range.selectNodeContents(text); const s = getSelection(); s.removeAllRanges(); s.addRange(range); return s.toString();
  })()`);
  await page.evaluate(`document.querySelector('#refresh').click()`); await delay(400);
  k.check('R2 polling preserves text selection and its DOM range', await page.evaluate(`getSelection().toString()`) === selection && await page.evaluate(`getSelection().anchorNode.isConnected`), selection.slice(0, 100));
  await page.evaluate(`getSelection().removeAllRanges()`);

  // Late image/markdown growth above the reader must retain the same visible message and offset.
  const beforeMedia = await anchored(page);
  await page.evaluate(`(() => {
    const first = document.querySelector('#messages .msg .text'); const img = document.createElement('img');
    img.alt = 'late deterministic media'; img.style.cssText = 'display:block;width:120px;height:1px'; first.prepend(img);
    requestAnimationFrame(() => { img.style.height = '220px'; });
  })()`);
  await delay(250);
  const afterMedia = await anchored(page);
  k.check('R3 late media sizing preserves the reading anchor', beforeMedia.index === afterMedia.index && Math.abs(beforeMedia.offset - afterMedia.offset) < 2, { beforeMedia, afterMedia });
  result.measurements.lateMedia = { beforeMedia, afterMedia };

  // Compaction/history pagination inserts above the reader and must retain the same message too.
  const firstText = await page.evaluate(`document.querySelector('#messages .earlier-messages')?.textContent ?? ''`);
  k.check('R4 history pagination is available in the long fixture', /Show earlier/.test(firstText), firstText);
  const beforePage = await anchored(page);
  await page.evaluate(`document.querySelector('#messages .earlier-messages').click()`);
  await page.waitFor(`!document.querySelector('#messages .earlier-messages')`, 'older page inserted');
  await delay(150);
  const afterPage = await anchored(page);
  k.check('R5 history pagination preserves the reading anchor', beforePage.index === afterPage.index && Math.abs(beforePage.offset - afterPage.offset) < 2, { beforePage, afterPage });
  result.measurements.pagination = { beforePage, afterPage };

  // Send through real input/click from an unfollowed reading position. Sending, not scrolling first,
  // must opt back into following. The response is a burst, not a slowed-down fake stream.
  const beforeSend = await anchored(page);
  k.check('R5S send starts from a genuinely unfollowed reading position', beforeSend.gap > 100, beforeSend);
  const composer = await page.evaluate(`(() => { const r = document.querySelector('#compose textarea').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 20 }; })()`);
  await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...composer });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...composer });
  await page.cdp('Input.insertText', { text: 'MARK-BURST' });
  await page.evaluate(`(() => {
    window.__paintBursts = 0; window.__paintObserver = new MutationObserver(() => { window.__paintBursts++; });
    window.__paintObserver.observe(document.querySelector('#live-reply'), { childList: true, subtree: true });
    window.__burstStarted = performance.now();
  })()`);
  const send = await page.evaluate(`(() => { const r = document.querySelector('#compose button[type="submit"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...send });
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...send });
  await page.waitFor(`document.querySelector('#messages').innerText.includes('Burst paragraph 31') && document.querySelector('#live-reply').hidden`, 'immediate final burst text');
  const burst = await page.evaluate(`(() => { window.__paintObserver.disconnect(); const last = [...document.querySelectorAll('#messages .msg.them')].at(-1); return { renders: window.__paintBursts, elapsed: performance.now() - window.__burstStarted, text: last.innerText, bodyText: last.querySelector('.text').innerText }; })()`);
  k.check('R6 bursty SSE is frame-batched rather than one full markdown replacement per delta', burst.renders > 0 && burst.renders <= 8, burst);
  k.check('R7 final text is committed immediately, without added streaming latency', burst.elapsed < 5000 && /Burst paragraph 31/.test(burst.text), burst);
  const finalHost = await k.rpc({ action: 'show', id });
  const hostText = finalHost.messages.findLast(m => m.role === 'assistant')?.text;
  k.check('R8 browser final exactly matches host transcript', hostText === burstText && burst.bodyText === hostText, { elapsed: burst.elapsed, hostLength: hostText?.length, browserLength: burst.bodyText.length });
  const afterSend = await anchored(page);
  k.check('R8S sending from scrolled-up state resumes following', afterSend.gap < 40, { beforeSend, afterSend });
  result.measurements.burst = burst;

  // Hold only this test stream open so selection happens before the real SSE completion.
  await page.evaluate(`document.querySelector('#compose textarea').focus()`);
  await page.cdp('Input.insertText', { text: 'MARK-SELECTION' });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.waitFor(`!document.querySelector('#live-reply').hidden && document.querySelector('#live-reply .text p')?.textContent === ${JSON.stringify(selectionText)}`, 'live selection paragraph');
  await page.evaluate(`(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#live-reply .text p'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  })()`);
  finishSelectionStream();
  await page.waitFor(`document.querySelector('#live-reply').hidden && document.querySelector('#messages').innerText.includes('The final paragraph arrived.')`, 'selected stream commits');
  const settledSelection = await page.evaluate(`(() => {
    const s = getSelection();
    return { expected: ${JSON.stringify(selectionText)}, hidden: document.querySelector('#live-reply').hidden, selected: s.toString(), connected: s.anchorNode?.isConnected === true, inFinal: document.querySelector('#messages').contains(s.anchorNode) };
  })()`);
  const selectedHost = (await k.rpc({ action: 'show', id })).messages.findLast(m => m.role === 'assistant')?.text;
  const selectedBrowser = await page.evaluate(`[...document.querySelectorAll('#messages .msg.them .text')].at(-1).innerText`);
  k.check('R8T selected stream final browser text exactly matches host', selectedHost === selectionText + ' The final paragraph arrived.' && selectedBrowser === selectedHost, { selectedHost, selectedBrowser });
  k.check('R8L streaming completion moves selection into the matching committed message', settledSelection.hidden && settledSelection.selected === settledSelection.expected && settledSelection.connected && settledSelection.inFinal, { ...settledSelection, expected: settledSelection.expected.slice(0, 100), selected: settledSelection.selected.slice(0, 100) });
  await page.evaluate(`getSelection().removeAllRanges()`);

  // Read an early code block while a >4,000-character reply grows past the bounded preview.
  await page.evaluate(`(() => {
    window.__liveBudget = { frames: 0, maxText: 0, maxBytes: 0, parses: 0, maxParseMs: 0 };
    window.__originalApplyLive = applyLive; window.__originalMarkdown = renderMarkdown;
    applyLive = async frame => { const b = window.__liveBudget; b.frames++; b.maxText = Math.max(b.maxText, frame.text.length); b.maxBytes = Math.max(b.maxBytes, new TextEncoder().encode(JSON.stringify(frame)).length); return window.__originalApplyLive(frame); };
    renderMarkdown = (...args) => { const start = performance.now(), result = window.__originalMarkdown(...args), b = window.__liveBudget; if (String(args[0]).startsWith('## Stable section 0')) { b.parses++; b.maxParseMs = Math.max(b.maxParseMs, performance.now() - start); } return result; };
    document.querySelector('#compose textarea').focus();
  })()`);
  await page.cdp('Input.insertText', { text: 'MARK-LONG' });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.waitFor(`document.querySelector('#live-reply .text')?.innerText.includes('Stable section 9')`, 'long prefix visible');
  const beforeLong = await page.evaluate(`(() => {
    const t = document.querySelector('#transcript'), code = document.querySelector('#live-reply pre');
    t.scrollTop += code.getBoundingClientRect().top - t.getBoundingClientRect().top - 35; t.dispatchEvent(new Event('scroll'));
    window.__readingCode = code;
    return { text: code.textContent, top: code.getBoundingClientRect().top, gap: t.scrollHeight - t.scrollTop - t.clientHeight };
  })()`);
  k.check('L1 reading starts inside a >4000-character live reply and is unfollowed', longPrefix.length > 4000 && beforeLong.gap > 100, beforeLong);
  continueLong();
  await page.waitFor(`!document.querySelector('#live-reply .live-limit')?.hidden`, 'bounded preview reached');
  const duringLong = await page.evaluate(`(() => {
    const code = window.__readingCode;
    return { text: code.textContent, top: code.getBoundingClientRect().top, connected: code.isConnected, stillFirst: document.querySelector('#live-reply pre') === code, budget: { ...window.__liveBudget }, visible: code.getBoundingClientRect().top >= document.querySelector('#transcript').getBoundingClientRect().top };
  })()`);
  k.check('L2 long stream keeps the same visible code text, DOM node and position, not just scrollTop', duringLong.connected && duringLong.stillFirst && duringLong.visible && duringLong.text === beforeLong.text && Math.abs(duringLong.top - beforeLong.top) < 2, { beforeLong, duringLong });
  extendLong();
  await delay(1000);
  const capped = await page.evaluate(`({ ...window.__liveBudget })`);
  k.check('L3 preview bounds transport and skips markdown parsing after the cap', capped.maxText === 32768 && capped.maxBytes < 40000 && capped.parses === duringLong.budget.parses && capped.maxParseMs < 100, { during: duringLong.budget, capped });
  const cappedSelection = await page.evaluate(`(() => {
    const range = document.createRange(); range.selectNodeContents(window.__readingCode);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    return { selected: s.toString(), lastCode: document.querySelector('#live-reply .text pre:last-child')?.textContent.slice(-40) };
  })()`);
  k.check('L3C fixture caps the preview inside an unfinished code line', cappedSelection.lastCode && !cappedSelection.lastCode.endsWith('\\n'), cappedSelection);
  finishLong();
  await page.waitFor(`document.querySelector('#live-reply').hidden && document.querySelector('#messages').innerText.includes('Stable section 89')`, 'full long reply committed');
  const restoredCode = await page.evaluate(`(() => { const s = getSelection(), root = [...document.querySelectorAll('#messages .msg.them .text')].at(-1); return { selected: s.toString(), inFinal: root.contains(s.anchorNode) }; })()`);
  k.check('L3S selected early code survives completion when the preview cap cuts a later code line', restoredCode.selected === cappedSelection.selected && restoredCode.inFinal, { cappedSelection, restoredCode });
  await page.evaluate(`getSelection().removeAllRanges()`);
  const longHost = (await k.rpc({ action: 'show', id })).messages.findLast(m => m.role === 'assistant')?.text;
  const finalLong = await page.evaluate(`(() => { const last = [...document.querySelectorAll('#messages .msg.them .text')].at(-1), expected = document.createElement('div'); expected.innerHTML = window.__originalMarkdown(${JSON.stringify(longText)}); return { html: last.innerHTML, expected: expected.innerHTML, text: last.textContent }; })()`);
  k.check('L4 full long reply is stored exactly and browser matches complete rendered host markdown', longHost === longText && finalLong.html === finalLong.expected && finalLong.text.includes('Stable section 0') && finalLong.text.includes('Stable section 89'), { hostLength: longHost?.length, expectedLength: longText.length, browserLength: finalLong.text.length });
  result.measurements.longStream = { beforeLong, duringLong, capped, hostLength: longHost.length };
  await page.evaluate(`applyLive = window.__originalApplyLive; renderMarkdown = window.__originalMarkdown`);

  // Explicit chat switches intentionally open at newest and must replace selected old-chat content.
  await page.evaluate(`(() => { const text = [...document.querySelectorAll('#messages .msg.them .text p')].at(-1); const r = document.createRange(); r.selectNodeContents(text); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  const side = await k.rpc({ action: 'chat-create', id, title: 'Side' });
  await page.waitFor(`!!document.querySelector('[data-action="chat-select"][data-chat="${side.id}"]')`, 'side chat');
  await page.evaluate(`document.querySelector('[data-action="chat-select"][data-chat="${side.id}"]').click()`);
  await page.waitFor(`document.querySelector('#chat-list .chat.on')?.dataset.chat === '${side.id}'`, 'side selected');
  await page.waitFor(`getSelection().isCollapsed && !document.querySelector('#messages').innerText.includes('Burst paragraph 31')`, 'old selected transcript replaced');
  k.check('R9S explicit chat switch clears selection and never retains old-chat messages', await page.evaluate(`getSelection().isCollapsed && !document.querySelector('#messages').innerText.includes('Burst paragraph 31')`));
  await page.evaluate(`document.querySelector('#compose textarea').focus()`);
  await page.cdp('Input.insertText', { text: 'MARK-SIDE-DESTINATION' });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.waitFor(`document.querySelector('#messages').innerText.includes('DONE coordinator')`, 'side reply');
  const sideHost = await k.rpc({ action: 'show', id, chatId: side.id });
  const mainHost = await k.rpc({ action: 'show', id, chatId: 'main' });
  k.check('R9D selected chat and send destination agree after switching selected text', sideHost.messages.some(m => m.text === 'MARK-SIDE-DESTINATION') && !mainHost.messages.some(m => m.text === 'MARK-SIDE-DESTINATION') && await page.evaluate(`document.querySelector('#chat-list .chat.on')?.textContent.includes('Side')`), { sideChat: sideHost.chatId, mainChat: mainHost.chatId });
  await page.evaluate(`document.querySelector('[data-action="chat-select"][data-chat="main"]').click()`);
  await page.waitFor(`document.querySelector('#messages').innerText.includes('Burst paragraph 31')`, 'main selected');
  const switched = await anchored(page);
  k.check('R9 chat switches follow newest intentionally', switched.gap < 40, switched);

  // Chrome viewport regressions: composer and the separate limits bar both stay in the visual viewport.
  await page.viewport(390, 844, true); await delay(150);
  const phone = await metrics(page);
  k.check('V1 phone composer and status bar fit the visual viewport', phone.composerBottom <= phone.visualTop + phone.visualHeight - 27 && Math.abs(phone.statusBottom - (phone.visualTop + phone.visualHeight)) < 2 && !phone.horizontalOverflow, phone);
  await page.shot('02-phone', { force: true });
  await page.viewport(390, 500, true); await delay(150);
  const keyboardSized = await metrics(page);
  k.check('V2 keyboard-sized viewport reanchors both bottom surfaces', keyboardSized.composerBottom <= keyboardSized.visualTop + keyboardSized.visualHeight - 27 && Math.abs(keyboardSized.statusBottom - (keyboardSized.visualTop + keyboardSized.visualHeight)) < 2, keyboardSized);
  await page.viewport(844, 390, true); await delay(150);
  const landscape = await metrics(page);
  k.check('V3 orientation-sized viewport keeps both bars anchored without overflow', landscape.composerBottom <= landscape.visualTop + landscape.visualHeight - 27 && landscape.sendInside && Math.abs(landscape.statusBottom - (landscape.visualTop + landscape.visualHeight)) < 2 && !landscape.horizontalOverflow, landscape);
  await page.shot('03-landscape', { force: true });
  await page.viewport(1024, 768, true); await delay(150);
  const tablet = await metrics(page);
  k.check('V4 tablet viewport shell remains anchored', tablet.composerBottom <= tablet.visualTop + tablet.visualHeight - 27 && Math.abs(tablet.statusBottom - (tablet.visualTop + tablet.visualHeight)) < 2, tablet);
  await page.shot('04-tablet', { force: true });

  // Override only VisualViewport geometry and dispatch its real resize event. The layout viewport
  // deliberately stays unchanged, reproducing keyboard shrink independently of window resize.
  await page.viewport(900, 768, true); await delay(100);
  const independent = await page.evaluate(`(async () => {
    const before = { width: innerWidth, height: innerHeight }; const v = visualViewport;
    Object.defineProperties(v, { height: { configurable: true, value: 430 }, offsetTop: { configurable: true, value: 40 } });
    v.dispatchEvent(new Event('resize')); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const composer = document.querySelector('#compose').getBoundingClientRect(), status = document.querySelector('#limits-bar').getBoundingClientRect();
    return { before, after: { width: innerWidth, height: innerHeight }, visualBottom: v.offsetTop + v.height, composerBottom: composer.bottom, statusBottom: status.bottom };
  })()`);
  k.check('V5 independent visual viewport shrink keeps tablet composer visible without layout resize', independent.before.width === independent.after.width && independent.before.height === independent.after.height && independent.composerBottom <= independent.visualBottom - 27 && Math.abs(independent.statusBottom - independent.visualBottom) < 2, independent);
  await page.evaluate(`(() => { const v = visualViewport; delete v.height; delete v.offsetTop; v.dispatchEvent(new Event('resize')); })()`);

  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.viewport(1180, 820, true); await delay(150);
  const wideTablet = await page.evaluate(`(() => { const v = visualViewport; Object.defineProperty(v, 'height', { configurable: true, value: 500 }); v.dispatchEvent(new Event('resize')); return { coarse: matchMedia('(pointer: coarse)').matches, layoutWidth: innerWidth }; })()`);
  await delay(100);
  const wideMetrics = await metrics(page);
  k.check('V6 coarse-pointer landscape tablet above 1024px follows visual viewport', wideTablet.coarse && wideTablet.layoutWidth === 1180 && wideMetrics.composerBottom <= wideMetrics.visualTop + wideMetrics.visualHeight - 27 && Math.abs(wideMetrics.statusBottom - (wideMetrics.visualTop + wideMetrics.visualHeight)) < 2, { wideTablet, wideMetrics });
  await page.shot('05-wide-tablet', { force: true });
  await page.evaluate(`delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize'))`);
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.viewport(1440, 1000, false); await delay(150);
  const desktop = await metrics(page);
  k.check('V7 fine-pointer desktop retains its layout and visible composer', await page.evaluate(`!matchMedia('(pointer: coarse)').matches && getComputedStyle(document.querySelector('.app')).position !== 'fixed'`) && desktop.composerBottom <= 973 && !desktop.horizontalOverflow, desktop);
  result.measurements.viewports = { phone, keyboardSized, landscape, tablet, independent, wideTablet: { ...wideTablet, ...wideMetrics }, desktop };

  await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  k.check('A1 reduced motion disables live and layout animation', await page.evaluate(`getComputedStyle(document.querySelector('.live-dot')).animationName === 'none' && getComputedStyle(document.querySelector('.app')).transitionDuration === '0s'`));
  result.browser = 'Chrome with CDP device metrics; this is not iOS Safari verification';
});
