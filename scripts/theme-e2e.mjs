// Browser E2E for the dark/light/system theme: isolated host, fake model, headless Chrome with emulated prefers-color-scheme.
// Failure cases recorded in theme-failures.md before implementation.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, delay } from './notify-kit.mjs';

const MD = 'MD-START\n\n## Heading\n\nA paragraph with `inline code` and a [link](https://example.invalid).\n\n```js\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n\n> quote text\n\n- item one\n- item two\n\nMD-END';
const k = await kit('theme', {}, ({ coordinator, marker, results, say, call }) => {
  if (!coordinator) return undefined;
  if (marker === 'MARK-MD') return say(MD);
  if (marker === 'MARK-SCOUT' && results.length === 0) return call('projects_delegate', { role: 'scout', task: 'MARK-SCOUTTASK survey' });
  return undefined;
});
const { result, rpc, evaluate, waitFor, shot, send } = k;
const scheme = (s, value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] }, s);
const theme = s => evaluate(`document.documentElement.dataset.theme`, s);
const reload = async s => { await send('Page.reload', {}, s); await waitFor(`document.readyState === 'complete' && !!document.querySelector('#title')?.innerText`, s, 'reload'); };
const must = (cond, message) => { if (!cond) throw Error(message); };
const ok = text => result.checks.push(text);
// Page-side helpers: parse colors, composite backgrounds up the tree, WCAG contrast.
const lib = `(() => {
  const parse = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const over = (top, bottom) => { const a = top.a + bottom.a * (1 - top.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a, g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a, b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a, a }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = el => { let color = { r: 0, g: 0, b: 0, a: 0 }; const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n); for (const n of chain) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg && bg.a > 0) { color = color.a === 0 ? bg : over(color, bg); if (color.a >= 0.999) break; } } return color.a >= 0.999 ? color : over(color, parse(getComputedStyle(document.documentElement).backgroundColor)); };
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0; };
  const label = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  // Elements whose background is deliberately light in dark (toast / popups invert) are listed here.
  const inverted = el => !!el.closest('#toast, .context-popup, img, video');
  window.__scan = (dark, root = document.body) => {
    const bright = [], low = []; let texts = 0;
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el) || inverted(el)) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      const bg = bgOf(el);
      if (dark && bg.a >= 0.999 && lum(bg) > 0.35 && el.getBoundingClientRect().width > 12) bright.push(label(el) + ' ' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b));
      if (own) { texts++; const fg = parse(getComputedStyle(el).color); const r = ratio(over(fg, bg), bg); const size = parseFloat(getComputedStyle(el).fontSize); if (r < (size >= 18 ? 3 : 4.5)) low.push(label(el) + ' ' + r.toFixed(2) + ' "' + el.textContent.trim().slice(0, 24) + '"'); }
    }
    return { bright: [...new Set(bright)], low: [...new Set(low)], texts };
  };
  window.__color = sel => { const el = document.querySelector(sel); const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, scheme: s.colorScheme }; };
})()`;
const scan = (s, dark) => evaluate(`window.__scan(${dark})`, s);
const open = async (tab, init = '') => {
  const web = new URL((await rpc({ action: 'web' })).url); web.searchParams.set('project', projectId); web.searchParams.set('tab', tab);
  return k.openPage(web.toString(), init);
};
let projectId;
const shots = {};
try {
  await k.startHost();
  projectId = await k.setup('Theme demo', k.gitRepo);
  await k.ask(projectId, 'main', 'MARK-MD show markdown');
  await k.ask(projectId, 'main', 'MARK-SCOUT survey the UI');
  await rpc({ action: 'knowledge-write', id: projectId, path: 'topic.md', text: '# Topic\n\nSome `knowledge` with a table\n\n| a | b |\n| - | - |\n| 1 | 2 |\n' }).catch(() => {});

  // T1/T3 first paint: the theme is already decided when <body> is first inserted, from the stored preference (never after).
  const probe = `window.__atBody = null; new MutationObserver(() => { if (document.body && window.__atBody === null) window.__atBody = document.documentElement.dataset.theme; }).observe(document, { childList: true, subtree: true });`;
  const s = await open('coordinator', `${lib};${probe}`);
  await waitFor(`!!document.querySelector('#title')?.innerText && document.querySelectorAll('#messages .msg').length > 2`, s, 'chat rendered');
  await scheme(s, 'light'); await delay(200);
  must(await theme(s) === 'light', 'System + light OS is not light');
  const lightBg = await evaluate(`__color('body')`, s);
  ok('T2 System with a light OS renders light');

  // T4 light look unchanged: original palette values.
  const lc = await evaluate(`({ root: getComputedStyle(document.documentElement).backgroundColor, card: __color('#skills-card').bg, side: __color('.side').bg, text: getComputedStyle(document.documentElement).color, primary: __color('button.primary').bg, line: getComputedStyle(document.querySelector('#skills-card')).borderTopColor, scheme: getComputedStyle(document.documentElement).colorScheme })`, s);
  const expected = { root: 'rgb(248, 245, 238)', card: 'rgb(255, 253, 247)', side: 'rgb(241, 237, 226)', text: 'rgb(41, 38, 27)', primary: 'rgb(194, 101, 58)', line: 'rgb(232, 227, 213)', scheme: 'light' };
  must(JSON.stringify(lc) === JSON.stringify(expected), 'Light palette changed: ' + JSON.stringify(lc));
  ok('T4 light palette is the original one (bg, card, sidebar, text, accent, borders)');
  const lightScan = await scan(s, false);
  result.light = { lc, lowContrast: lightScan.low };

  // T2 live system follow in both directions, no reload.
  await scheme(s, 'dark'); await waitFor(`document.documentElement.dataset.theme === 'dark'`, s, 'live switch to dark');
  must((await evaluate(`getComputedStyle(document.documentElement).colorScheme`, s)) === 'dark', 'color-scheme not dark');
  await scheme(s, 'light'); await waitFor(`document.documentElement.dataset.theme === 'light'`, s, 'live switch back');
  await scheme(s, 'dark'); await waitFor(`document.documentElement.dataset.theme === 'dark'`, s, 'live dark again');
  ok('T2 System follows prefers-color-scheme live in both directions without reload');

  // Tabs in dark: screenshots, no bright surfaces, contrast.
  const darkReport = {};
  async function sweep(tab, prep) {
    await evaluate(`document.querySelector('[data-tab=${tab}]').click()`, s); await delay(500);
    if (prep) await prep();
    await waitFor(`!document.querySelector('[data-panel=${tab}]').hidden`, s, tab);
    const dark = await scan(s, true);
    await shot(`dark-${tab}`, s); darkReport[tab] = dark;
    return dark;
  }
  const coordinator = await sweep('coordinator');
  must(await evaluate(`!!document.querySelector('#messages pre')`, s), 'markdown fixture missing code block');
  // code block + table + inline code + bubble colors must be dark surfaces
  const mdColors = await evaluate(`({ pre: __color('#messages pre').bg, bubble: __color('.msg.you .text').bg, textarea: __color('#compose textarea').bg, composer: __color('#compose').bg })`, s);
  await sweep('knowledge', async () => { await waitFor(`!!document.querySelector('#knowledge-inline')`, s, 'knowledge'); });
  await sweep('activity', async () => { await evaluate(`document.querySelector('.work-open')?.click()`, s); await delay(800); });
  await sweep('observability', async () => { await delay(800); });
  await sweep('settings', async () => { await waitFor(`!!document.querySelector('#skills-picker') && !/Reading/.test(document.querySelector('#skills-picker').innerText)`, s, 'skills picker').catch(() => {}); await delay(600); });
  await evaluate(`document.querySelector('#appearance-card').scrollIntoView()`, s); await shot('dark-settings-appearance', s);
  result.dark = darkReport; result.mdColors = mdColors;
  for (const [tab, r] of Object.entries(darkReport)) { must(!r.bright.length, `Bright surfaces in dark ${tab}: ${r.bright.slice(0, 8).join('; ')}`); must(!r.low.length, `Low contrast in dark ${tab}: ${r.low.slice(0, 8).join('; ')}`); must(r.texts > 5, `${tab} scan saw no text`); }
  ok('T5/T6 dark coordinator, knowledge, activity, observability and settings tabs: no light surfaces, all text contrast >= 4.5 (3 for large)');
  ok('T4 light look kept as designed (muted-text contrast below 4.5 in light is recorded in report.json, not changed)');

  // Overlays in dark: search dialog, project dialog, toast, skill menu, native widgets.
  await evaluate(`document.querySelector('[data-tab=coordinator]').click()`, s); await delay(300);
  await evaluate(`document.querySelector('#search-button').click()`, s);
  await waitFor(`document.querySelector('#dialog').open`, s, 'search dialog');
  await evaluate(`(() => { const i = document.querySelector('#dialog input'); if (i) { i.value = 'MD'; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`, s); await delay(1200);
  const dialogScan = await evaluate(`window.__scan(true, document.querySelector('#dialog'))`, s);
  const dialogBg = await evaluate(`__color('#dialog')`, s);
  await shot('dark-search-dialog', s);
  must(!dialogScan.bright.length && !dialogScan.low.length, 'Dialog in dark: ' + JSON.stringify(dialogScan) + JSON.stringify(await evaluate(`__color('#dialog mark')`, s)));
  must(dialogBg.scheme === 'dark', 'dialog color-scheme not dark');
  await evaluate(`document.querySelector('#dialog').close()`, s);
  await evaluate(`toast('Saved something'); document.querySelector('#toast').classList.add('visible')`, s); await delay(300);
  const toastScan = await evaluate(`window.__scan(false, document.querySelector('#toast').parentElement)`, s);
  must(!toastScan.low.length, 'Toast contrast: ' + toastScan.low.join('; '));
  await shot('dark-toast', s);
  await evaluate(`document.querySelector('#toast').classList.remove('visible')`, s);
  ok('T5/T7/T8 dark search dialog (top layer) and toast: dark scheme, no light surfaces, readable');

  // T3/T9 Settings control: pick Dark/Light/System, persisted per browser, applied on reload, instant.
  await evaluate(`document.querySelector('[data-tab=settings]').click()`, s);
  must(await evaluate(`document.querySelector('#appearance-card input[value=system]').checked`, s), 'System is not the default selection');
  await scheme(s, 'light');
  await evaluate(`document.querySelector('#appearance-card input[value=dark]').click()`, s);
  await waitFor(`document.documentElement.dataset.theme === 'dark'`, s, 'dark applied instantly despite light OS');
  must(await evaluate(`localStorage.getItem('pi-projects-theme') === 'dark'`, s), 'dark not stored');
  await reload(s);
  must(await theme(s) === 'dark', 'Dark not persisted over reload');
  await evaluate(`document.querySelector('[data-tab=settings]').click()`, s);
  must(await evaluate(`document.querySelector('#appearance-card input[value=dark]').checked`, s), 'Radio does not show the stored Dark');
  must((await evaluate(`window.__atBody`, s)) === 'dark', 'Theme not set before the body was parsed (flash): ' + await evaluate(`window.__atBody`, s));
  ok('T1 stored Dark is applied before <body> exists (no flash) and shown selected in Settings after reload, against a light OS');
  await evaluate(`document.querySelector('#appearance-card input[value=light]').click()`, s);
  await waitFor(`document.documentElement.dataset.theme === 'light'`, s, 'light override');
  await scheme(s, 'dark'); await delay(300);
  must(await theme(s) === 'light', 'Light override lost to the OS dark scheme');
  await shot('light-override-settings', s);
  ok('T2/T9 Light/Dark override the OS scheme instantly; choice persists');
  await evaluate(`document.querySelector('#appearance-card input[value=system]').click()`, s);
  await waitFor(`document.documentElement.dataset.theme === 'dark' && localStorage.getItem('pi-projects-theme') === null`, s, 'back to system');
  ok('T3 choosing System clears the stored preference and follows the OS again');
  await evaluate(`localStorage.setItem('pi-projects-theme', 'purple')`, s); await scheme(s, 'light'); await reload(s);
  must(await theme(s) === 'light' && await evaluate(`document.documentElement.dataset.themePref === 'system'`, s), 'Invalid stored value did not fall back to System');
  await evaluate(`localStorage.removeItem('pi-projects-theme')`, s);
  ok('T3 an invalid stored value falls back to System');

  // Screenshots of the same tabs in light for the artifact.
  for (const tab of ['coordinator', 'knowledge', 'activity', 'settings']) { await evaluate(`document.querySelector('[data-tab=${tab}]').click()`, s); await delay(700); await shot(`light-${tab}`, s); }

  // T7 native widgets: scrollbars/checkbox follow color-scheme via the root.
  await scheme(s, 'dark'); await waitFor(`document.documentElement.dataset.theme === 'dark'`, s, 'dark for widgets');
  must(await evaluate(`getComputedStyle(document.querySelector('#notify-browser')).colorScheme === 'dark'`, s), 'checkbox not dark scheme');
  ok('T7 native widgets inherit color-scheme: dark');

  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = String(error?.stack ?? error);
}
await k.finish(result.status);
