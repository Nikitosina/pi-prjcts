// Isolated Chrome regression for follow intent at streaming completion.
// The fake provider gates completion so each scroll is exercised before the final commit.
import { createKit, delay } from './lib/e2e-kit.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const prefix = Array.from({ length: 24 }, (_, i) => `Paragraph ${i}: ${'streaming content '.repeat(12)}\n\n`).join('');
const suffix = '\n\nCompletion marker: the answer is complete.';
let release;
const k = await createKit('streaming-follow-intent', { handler: ({ role, user }) => {
  if (role !== 'coordinator' || !user.includes('FOLLOW-CASE')) return undefined;
  return (async function* () {
    for (let at = 0; at < prefix.length; at += 350) {
      yield chunk({ ...(at === 0 ? { role: 'assistant' } : {}), content: prefix.slice(at, at + 350) });
      await delay(80);
    }
    await new Promise(resolve => { release = resolve; });
    yield chunk({ content: suffix });
    yield chunk({}, 'stop') + 'data: [DONE]\n\n';
  })();
} });
const gap = page => page.evaluate(`(() => { const t = document.querySelector('#transcript'); return { top: t.scrollTop, gap: t.scrollHeight - t.clientHeight - t.scrollTop, height: t.scrollHeight }; })()`);

await k.run(async () => {
  const id = await k.createProject('Follow intent', { grant: false });
  await k.ask(id, 'Seed transcript');
  const url = new URL(await k.webUrl(id, 'coordinator')); url.searchParams.set('e2e', '1');
  const page = await k.openPage(url.toString());
  await page.waitFor(`document.querySelector('#messages')?.innerText.includes('Seed transcript') && !document.querySelector('#compose button[type="submit"]').disabled`, 'composer ready');
  const failures = [];
  for (const scenario of ['pinned', 'near-bottom-up', 'programmatic']) {
    release = undefined;
    const frames = join(k.artifacts, `frames-${scenario}`); mkdirSync(frames);
    const timestamps = [];
    let recording = true;
    const capture = (async () => {
      while (recording) {
        const started = Date.now();
        const measurement = await gap(page);
        const image = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
        const name = `${String(timestamps.length).padStart(5, '0')}.jpg`;
        writeFileSync(join(frames, name), Buffer.from(image.data, 'base64'));
        timestamps.push({ name, at: started, ...measurement });
        await delay(Math.max(0, 100 - (Date.now() - started)));
      }
    })();
    await page.evaluate(`document.querySelector('#compose textarea').focus()`);
    await page.cdp('Input.insertText', { text: `FOLLOW-CASE ${scenario}` });
    await page.evaluate(`document.querySelector('#compose').requestSubmit()`);
    await page.waitFor(`!document.querySelector('#live-reply').hidden && document.querySelector('#live-reply').innerText.includes('Paragraph 23')`, `${scenario} stream`);
    await k.waitFor(() => release, 'provider gate', { interval: 100 });
    await delay(300);
    let programmaticGap = null;
    if (scenario === 'near-bottom-up') {
      const point = await page.evaluate(`(() => { const r = document.querySelector('#transcript').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -20 });
      await delay(300);
    } else if (scenario === 'programmatic') {
      programmaticGap = await page.evaluate(`(() => { const t = document.querySelector('#transcript'); t.scrollTop -= 20; return t.scrollHeight - t.clientHeight - t.scrollTop; })()`);
      await delay(300);
    }
    const before = await gap(page);
    await delay(600); release();
    await page.waitFor(`document.querySelector('#live-reply').hidden && [...document.querySelectorAll('#messages .msg.them .text')].at(-1)?.innerText.includes('Completion marker:')`, `${scenario} completion`);
    await delay(1000);
    const after = await gap(page);
    if (scenario === 'pinned') {
      await page.evaluate(`(() => { const image = document.createElement('img'); image.alt = 'late layout fixture'; image.style.cssText = 'display:block;width:120px;height:1px'; document.querySelector('#messages .msg .text').prepend(image); requestAnimationFrame(() => { image.style.height = '180px'; }); })()`);
      await delay(300);
    }
    const afterLayout = await gap(page);
    recording = false; await capture;
    writeFileSync(join(k.artifacts, `${scenario}-trace.json`), JSON.stringify(timestamps, null, 2));
    const concat = timestamps.map((f, i) => `file '${join(frames, f.name)}'\nduration ${((timestamps[i + 1]?.at ?? Date.now()) - f.at) / 1000}\n`).join('') + `file '${join(frames, timestamps.at(-1).name)}'\n`;
    const list = join(k.artifacts, `${scenario}.concat`); writeFileSync(list, concat);
    const video = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vsync', 'vfr', '-pix_fmt', 'yuv420p', join(k.artifacts, `${scenario}.mp4`)], { encoding: 'utf8' });
    if (video.status !== 0) throw Error(`ffmpeg: ${video.stderr}`);
    const host = (await k.rpc({ action: 'show', id })).messages.findLast(m => m.role === 'assistant')?.text;
    const expected = prefix + suffix;
    const browserMatches = await page.evaluate(`(() => { const expected = document.createElement('div'); expected.innerHTML = renderMarkdown(${JSON.stringify(expected)}); return [...document.querySelectorAll('#messages .msg.them .text')].at(-1).innerHTML === expected.innerHTML; })()`);
    const fixture = scenario === 'pinned' ? before.gap < 2 : scenario === 'programmatic' ? programmaticGap > 5 && programmaticGap < 40 : before.gap > 5 && before.gap < 40;
    const follows = scenario === 'near-bottom-up' ? after.gap > 5 && Math.abs(after.top - before.top) < 3 : after.gap < 3;
    const ok = fixture && follows && (scenario !== 'pinned' || afterLayout.gap < 3) && host === expected && browserMatches;
    k.result.measurements ??= {}; k.result.measurements[scenario] = { before, after, afterLayout, programmaticGap, fixture, follows, hostMatches: host === expected, browserMatches, video: `${scenario}.mp4` };
    if (!ok) failures.push(scenario); else k.result.checks.push(`${scenario}: completion and follow intent`);
  }
  k.check('all follow intent cases', failures.length === 0, { failures, measurements: k.result.measurements });
});
