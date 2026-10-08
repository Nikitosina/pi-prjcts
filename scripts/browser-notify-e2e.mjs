// Browser E2E for browser notifications: isolated host, fake model, headless Chrome. The page's Notification API and visibility are stubbed so the test can hide the tab and click a notification.
// Failure cases recorded in browser-notify-failures.md before implementation.
import { kit, delay } from './notify-kit.mjs';

const k = await kit('browser-notify');
const { result, rpc, eventually, evaluate, waitFor, shot, send } = k;
// Stub: records notifications; the permission answer (kept per origin like a browser) and visibility are controlled by the test.
const init = `(() => {
  window.__notes = []; window.__vis = 'visible'; window.__focus = true; window.__failFeed = false;
  Document.prototype.hasFocus = function () { return window.__focus; };
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => window.__failFeed && String(init?.body ?? '').includes('"notify-feed"') ? Promise.reject(new TypeError('Failed to fetch')) : realFetch(url, init); window.__perm = (() => { try { return localStorage.getItem('__perm') ?? 'default'; } catch { return 'default'; } })(); window.__permAnswer = 'denied';
  Object.defineProperty(Document.prototype, 'visibilityState', { get() { return window.__vis; }, configurable: true });
  Object.defineProperty(Document.prototype, 'hidden', { get() { return window.__vis === 'hidden'; }, configurable: true });
  class FakeNotification { constructor(title, options = {}) { this.title = title; this.body = options.body; this.tag = options.tag; this.onclick = null; window.__notes.push(this); } close() { this.closed = true; }
    static get permission() { return window.__perm; } static requestPermission() { window.__perm = window.__permAnswer; try { localStorage.setItem('__perm', window.__perm); } catch {} return Promise.resolve(window.__perm); } }
  window.Notification = FakeNotification;
  window.__setVisible = visible => { window.__vis = visible ? 'visible' : 'hidden'; window.__focus = visible; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event(visible ? 'focus' : 'blur')); };
  window.__setFocus = focus => { window.__focus = focus; window.dispatchEvent(new Event(focus ? 'focus' : 'blur')); };
})();`;
const notes = s => evaluate(`window.__notes.map(n => ({ title: n.title, body: n.body, tag: n.tag }))`, s);
const feedCalls = () => k.apiBodies.filter(item => item.body.includes('"notify-feed"')).length;
try {
  await k.startHost();
  const a = await k.setup('Alpha', k.gitRepo), b = await k.setup('Beta');
  const two = await rpc({ action: 'chat-create', id: a, title: 'Two' });
  const web = new URL((await rpc({ action: 'web' })).url); web.searchParams.set('project', a); web.searchParams.set('tab', 'settings');
  const s = await k.openPage(web.toString(), init);
  await waitFor(`!!document.querySelector('#notify-browser-state')?.innerText`, s, 'notifications card');

  // N4: off by default; denied permission keeps it off.
  if (await evaluate(`document.querySelector('#notify-browser').checked`, s)) throw Error('Browser notifications on by default');
  await evaluate(`document.querySelector('#notify-browser').click()`, s);
  await waitFor(`/blocked|denied/i.test(document.querySelector('#notify-browser-state').innerText)`, s, 'denied state');
  if (await evaluate(`document.querySelector('#notify-browser').checked || localStorage.getItem('pi-projects-notify') === '1'`, s)) throw Error('Denied permission left the toggle on');
  result.checks.push('N4 off by default; a denied permission request leaves it off and says so');
  await evaluate(`window.__perm = 'default'; window.__permAnswer = 'default'; document.querySelector('#notify-browser').click()`, s);
  await waitFor(`/dismissed/i.test(document.querySelector('#notify-browser-state').innerText) && !document.querySelector('#notify-browser').checked`, s, 'dismissed prompt explained');
  result.checks.push('N16 a dismissed permission prompt leaves it off and says why');

  // N8: no feed polling while off.
  await evaluate(`window.__setVisible(false)`, s);
  await k.ask(a, 'main', 'MARK-OFF while off');
  await delay(1500);
  if ((await notes(s)).length || feedCalls()) throw Error('Notified or polled while off: ' + feedCalls());
  result.checks.push('N8 while off nothing is shown and the feed is not polled');

  await evaluate(`window.__setVisible(true); window.__permAnswer = 'granted'; document.querySelector('#notify-browser').click()`, s);
  await waitFor(`document.querySelector('#notify-browser').checked && /on/i.test(document.querySelector('#notify-browser-state').innerText) && localStorage.getItem('pi-projects-notify') === '1'`, s, 'enabled state');
  await waitFor(`window.__notifyCursor !== undefined`, s, 'feed cursor');
  await evaluate(`document.querySelector('#notify-card').scrollIntoView()`, s);
  await shot('01-settings-notifications', s);
  result.checks.push('N4 turning it on asks for permission and shows it is on');

  // N1: visible tab gets no notifications.
  await k.ask(a, 'main', 'MARK-VISIBLE hello');
  await delay(4000);
  if ((await notes(s)).length) throw Error('Notified while visible: ' + JSON.stringify(await notes(s)));
  result.checks.push('N1 a result while the tab is visible shows no notification');

  // N17: a test notification proves delivery end to end.
  await evaluate(`document.querySelector('#notify-test').click()`, s);
  await waitFor(`window.__notes.some(n => /test/i.test(n.title + n.body))`, s, 'test notification');
  await evaluate(`window.__notes.length = 0`, s);
  result.checks.push('N17 "Send a test" shows a notification immediately');

  // N12: the window stays visible but another app has focus.
  await evaluate(`window.__setFocus(false)`, s);
  await k.ask(a, 'main', 'MARK-UNFOCUSED other app');
  await eventually(async () => (await notes(s)).some(n => n.body?.includes('Done MARK-UNFOCUSED.')), 'no notification while visible but unfocused', 300);
  await evaluate(`window.__setFocus(true); window.__notes.length = 0`, s);
  result.checks.push('N12 a result while the window is visible but another app is focused shows a notification');

  // N13/N15: polling stalls while away (throttled/frozen tab, or the feed failing); the backlog still notifies on return, and a failing feed is visible.
  await evaluate(`window.__failFeed = true; window.__setVisible(false)`, s);
  await k.ask(a, 'main', 'MARK-FROZEN while frozen');
  await waitFor(`/not receiving/i.test(document.querySelector('#notify-browser-state').innerText)`, s, 'feed failure shown');
  await evaluate(`document.querySelector('#notify-card').scrollIntoView()`, s);
  await shot('01b-feed-failing', s);
  await evaluate(`window.__setVisible(true); window.__failFeed = false`, s);
  await eventually(async () => (await notes(s)).some(n => n.body?.includes('Done MARK-FROZEN.')), 'backlog from while away was dropped on return', 300);
  await waitFor(`/^On\./.test(document.querySelector('#notify-browser-state').innerText)`, s, 'state recovers');
  await evaluate(`window.__notes.length = 0`, s);
  result.checks.push('N13/N15 notices that arrive while polling is stalled and the tab is away notify on return; a failing feed says "not receiving" until it recovers');

  // N2: hidden: results from another chat and another project, a question, an approval and an error.
  await evaluate(`window.__setVisible(false)`, s);
  await k.ask(a, two.id, 'MARK-TWO result please');
  await eventually(async () => (await notes(s)).some(n => n.body?.includes('Done MARK-TWO.')), 'no result notification for chat Two', 300);
  await k.ask(b, 'main', 'MARK-BETA other project');
  await eventually(async () => (await notes(s)).some(n => n.body?.includes('Done MARK-BETA.')), 'no result notification for project Beta', 300);
  await k.ask(a, 'main', 'MARK-ASK a question');
  await eventually(async () => (await notes(s)).some(n => /question/i.test(n.body) && n.body.includes('MARK-Q Pick a colour')), 'no question notification', 300);
  const record = await k.approval(a);
  await eventually(async () => (await notes(s)).some(n => /approval/i.test(n.body) && n.body.includes('merge')), 'no approval notification', 300);
  const failed = await k.ask(a, two.id, 'MARK-FAIL break');
  if (failed.state !== 'failed') throw Error('Fixture turn did not fail: ' + failed.state);
  await eventually(async () => (await notes(s)).some(n => /error|failed/i.test(n.body) && n.title.includes('Two')), 'no error notification', 300);
  const shown = await notes(s);
  const two1 = shown.find(n => n.body.includes('Done MARK-TWO.')), beta = shown.find(n => n.body.includes('Done MARK-BETA.'));
  if (!two1.title.includes('Alpha') || !two1.title.includes('Two') || !beta.title.includes('Beta')) throw Error('Titles wrong: ' + JSON.stringify(shown));
  if (shown.some(n => n.body.includes('MARK-VISIBLE') || n.body.includes('MARK-OFF'))) throw Error('Old notices replayed: ' + JSON.stringify(shown));
  if (new Set(shown.map(n => n.tag)).size !== shown.length) throw Error('Duplicate notifications: ' + JSON.stringify(shown));
  if (shown.some(n => n.body.length > 400)) throw Error('Body not clipped');
  result.checks.push('N2/N3/N7 while hidden: results from another chat and another project, a question, an approval and a coordinator error each show once, titled project · chat, clipped');
  result.notes = shown;
  if (record.status !== 'pending') throw Error('Approval fixture wrong');

  // N6: click focuses the right project/chat.
  await evaluate(`window.__notes.find(n => n.body.includes('Done MARK-BETA.')).onclick()`, s);
  await waitFor(`new URL(location.href).searchParams.get('project') === ${JSON.stringify(b)} && new URL(location.href).searchParams.get('tab') === 'coordinator' && document.querySelector('#messages').innerText.includes('Done MARK-BETA.')`, s, 'Beta opened');
  await evaluate(`window.__notes.find(n => n.body.includes('Done MARK-TWO.')).onclick()`, s);
  await waitFor(`new URL(location.href).searchParams.get('project') === ${JSON.stringify(a)} && new URL(location.href).searchParams.get('chat') === ${JSON.stringify(two.id)} && document.querySelector('#messages').innerText.includes('Done MARK-TWO.')`, s, 'Alpha Two opened');
  await shot('02-clicked-into-chat-two', s);
  result.checks.push('N6 clicking a notification opens its project and chat in the coordinator tab');

  // N3/N10: reload does not replay; host restart does not re-emit; a fast turn between scans is still caught.
  const feedBefore = (await rpc({ action: 'notify-feed', after: 0 })).items.length;
  const urlBefore = (await rpc({ action: 'web' })).url;
  await k.stopHost(); await k.startHost();
  await delay(2000);
  const feedAfter = (await rpc({ action: 'notify-feed', after: 0 })).items.length;
  if (feedAfter !== feedBefore) throw Error(`Restart re-emitted notices: ${feedBefore} → ${feedAfter}`);
  const web2 = new URL((await rpc({ action: 'web' })).url); web2.searchParams.set('project', a);
  if ((await rpc({ action: 'web' })).url !== urlBefore) throw Error('Host address or token changed across restart');
  // N14: the page left open across the restart keeps working: same port, same token.
  await evaluate(`window.__setVisible(false)`, s);
  await k.ask(a, 'main', 'MARK-SURVIVE across restart');
  await eventually(async () => (await notes(s)).some(n => n.body?.includes('Done MARK-SURVIVE.')), 'tab left open across a host restart stopped notifying', 300);
  if (result.httpErrors.some(e => e.status === 401)) throw Error('Open tab got 401 after restart');
  result.checks.push('N14 a tab left open across a host restart keeps its session and keeps notifying');
  await evaluate(`window.__setVisible(true); window.__notes.length = 0`, s);
  await send('Page.navigate', { url: web2.toString() }, s);
  await waitFor(`window.__notifyCursor !== undefined`, s, 'cursor after reload');
  await evaluate(`window.__setVisible(false)`, s);
  await delay(3500);
  if ((await notes(s)).length) throw Error('Reload replayed notices');
  await k.ask(a, 'main', 'MARK-AFTER restart');
  await eventually(async () => (await notes(s)).some(n => n.body.includes('Done MARK-AFTER.')), 'no notification after restart', 300);
  if ((await notes(s)).length !== 1) throw Error('Expected exactly one notification after reload: ' + JSON.stringify(await notes(s)));
  result.checks.push('N3/N10 a reload and a host restart replay nothing; the next result shows exactly once');

  // N5: persists across reload; turning off stops it.
  await evaluate(`window.__setVisible(true)`, s);
  const set = new URL(web2); set.searchParams.set('tab', 'settings');
  await send('Page.navigate', { url: set.toString() }, s);
  await waitFor(`document.querySelector('#notify-browser')?.checked === true`, s, 'toggle persisted');
  await evaluate(`document.querySelector('#notify-browser').click()`, s);
  await waitFor(`!document.querySelector('#notify-browser').checked && localStorage.getItem('pi-projects-notify') !== '1'`, s, 'toggle off');
  await evaluate(`window.__setVisible(false)`, s);
  const polls = feedCalls();
  await k.ask(a, 'main', 'MARK-OFF2 off again');
  await delay(4000);
  if ((await notes(s)).length || feedCalls() > polls + 1) throw Error('Notified or polled after turning off');
  result.checks.push('N5 the toggle persists across reloads; turning it off stops notifications and feed polling');

  // N9: the feed is bounded.
  const feed = await rpc({ action: 'notify-feed', after: 0 });
  if (!Array.isArray(feed.items) || feed.items.length > 200 || typeof feed.seq !== 'number') throw Error('Feed shape wrong');
  result.checks.push('N9 the host feed is a bounded list with a sequence cursor');

  // N11: Follow PRs "Project is paused" error is cleared on resume.
  const c = await k.setup('Gamma');
  await rpc({ action: 'automation-update', id: c, change: { follow: { enabled: true } } });
  await rpc({ action: 'pause', id: c });
  await rpc({ action: 'follow-poll', id: c }).then(() => { throw Error('Paused poll succeeded'); }, error => { if (!/paused/.test(error.message)) throw error; });
  if (!/paused/.test((await rpc({ action: 'automation-snapshot', id: c })).follow.lastError ?? '')) throw Error('Paused error not recorded');
  await rpc({ action: 'resume', id: c });
  const resumed = (await rpc({ action: 'automation-snapshot', id: c })).follow;
  if (/paused/.test(resumed.lastError ?? '')) throw Error('Paused error stayed after resume: ' + resumed.lastError);
  result.checks.push('N11 Follow PRs "Project is paused" is cleared when the project resumes');

  // Mobile layout.
  await evaluate(`window.__setVisible(true)`, s);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await evaluate(`window.__oldDocument = true`, s);
  await send('Page.navigate', { url: set.toString() }, s);
  await waitFor(`!window.__oldDocument && !!document.querySelector('#notify-browser')`, s, 'mobile card');
  await evaluate(`document.querySelector('#notify-card').scrollIntoView()`, s);
  if (!await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`, s)) throw Error('Notifications card overflows at 390px');
  await shot('03-settings-mobile', s);
  result.checks.push('the notifications card fits a 390 px screen');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = k.redact(error?.stack ?? error);
}
await k.finish(result.status);
