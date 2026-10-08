// Browser E2E: per-project context window / auto-compaction settings and "Compact now" (C8).
// Isolated host, local fake model (128k catalog window), headless Chrome. Failure cases: scripts/context-settings-failures.md.
import { kit, delay } from './notify-kit.mjs';

const brain = { summaries: [], hold: null, held: null };
const respond = async ({ coordinator, marker, userText, say }) => {
  if (/conversation to summarize/.test(userText)) {
    brain.summaries.push(userText);
    if (brain.hold) { await brain.hold; }
    return say(`SUMMARY-${brain.summaries.length} of the earlier conversation.`);
  }
  if (!coordinator) return undefined;
  if (marker === 'MARK-BUSY') { await brain.held; return say('Busy turn done.'); }
  if (marker === 'MARK-FILL') return say(`ok ${/FILL-\d+/.exec(userText)?.[0] ?? ''}`);
  return undefined;
};
const k = await kit('context-settings', {}, respond);
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, send } = k;
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const fails = async (fn, pattern) => { try { await fn(); return false; } catch (error) { return pattern.test(String(error.message)); } };

try {
  await k.startHost();
  const id = await k.setup('Ctx'), other = await k.setup('Other');
  const show = (chatId) => rpc({ action: 'show', id, ...(chatId ? { chatId } : {}) });
  let view = await show();
  check('baseline: catalog window 128000, no override', view.context.window === 128000 && view.context.catalogWindow === 128000, view.context);

  // X1/X6/X7: set the settings through the Settings card.
  const web = await rpc({ action: 'web' }), url = new URL(web.url);
  url.searchParams.set('project', id); url.searchParams.set('tab', 'settings');
  const s = await openPage(url.toString());
  await waitFor(`!!document.querySelector('#context-settings #context-window')`, s, 'context card');
  await evaluate(`(() => { const set = (q, v) => { document.querySelector(q).value = v; }; set('#context-window', '20000'); set('#context-threshold', '50'); set('#context-keep', '2000'); document.querySelector('#context-auto').checked = true; document.querySelector('[data-action="context-save"]').click(); })()`, s);
  await eventually(async () => (await rpc({ action: 'settings-snapshot', id })).values.context?.contextWindow === 20000, 'context settings not saved from the UI');
  const saved = (await rpc({ action: 'settings-snapshot', id })).values.context;
  check('X1 Settings card saves window, auto-compact, threshold and keep-recent', JSON.stringify(saved) === JSON.stringify({ autoCompact: true, contextWindow: 20000, thresholdPercent: 50, keepRecentTokens: 2000 }), saved);
  view = await show();
  check('X6/X7 the override applies at once (context meter window 20000, catalog kept)', view.context.window === 20000 && view.context.catalogWindow === 128000, view.context);
  check('X8 another project keeps the catalog window', (await rpc({ action: 'show', id: other })).context.window === 128000);
  await delay(400); await evaluate(`document.querySelector('#context-card').scrollIntoView()`, s); await delay(200);
  await shot('01-context-settings', s);
  check('X1 card summary shows window and threshold', /20,000 tokens · compacts at 50%/.test(await evaluate(`document.querySelector('#context-summary').innerText`, s)));

  // X2: invalid values refused.
  const rev = async () => (await rpc({ action: 'settings-snapshot', id })).revision;
  check('X2 threshold 100% refused by the schema', await fails(async () => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { context: { autoCompact: true, thresholdPercent: 100 } } }), /thresholdPercent|maximum|must be/i));
  check('X2 keep-recent above half the window refused', await fails(async () => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { context: { autoCompact: true, contextWindow: 20000, keepRecentTokens: 15000 } } }), /at most half/));
  check('X2 window below 4096 refused', await fails(async () => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { context: { autoCompact: true, contextWindow: 100 } } }), /contextWindow|minimum|must be/i));
  check('X5 a stale revision is refused', await fails(() => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: 'a'.repeat(64), changes: { context: null } }), /revision conflict/));

  // X3: context settings change while the coordinator is busy; other settings still need idle.
  let release; brain.held = new Promise(ok => { release = ok; });
  await rpc({ action: 'message', id, text: 'MARK-BUSY hold this turn' });
  await eventually(async () => (await show()).busy, 'coordinator never became busy');
  const busyChange = await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { context: { ...saved, keepRecentTokens: 3000 } } });
  check('X3 context settings save while the coordinator is busy (no reopen)', busyChange.values.context.keepRecentTokens === 3000 && (await show()).busy);
  check('X3 other settings still require an idle project', await fails(async () => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { workerCap: 2 } }), /idle coordinator/));
  release(); await eventually(async () => !(await show()).busy, 'busy turn did not finish');
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { context: saved } });

  // X10/X12: threshold compaction at 50% of the 20000 override, keeping the newest message verbatim.
  const fill = n => `MARK-FILL FILL-${n} ` + `${'lorem ipsum dolor sit amet '.repeat(480)}`;
  let n = 0;
  while (brain.summaries.length === 0 && n < 8) { n++; await k.ask(id, 'main', fill(n)); }
  const firstSummary = brain.summaries[0] ?? '';
  check('X10 auto-compaction ran once the context passed 50% of the 20000 window (default would wait for ~78k)', brain.summaries.length === 1 && n <= 5, { n, summaries: brain.summaries.length });
  check('X12 the summary covers older messages and keeps the newest verbatim', /FILL-1\b/.test(firstSummary) && !new RegExp(`FILL-${n}\\b`).test(firstSummary), { n, head: firstSummary.slice(0, 300) });
  view = await show();
  check('X10 context drops after compaction', view.context.tokens < 10000, view.context);
  result.afterAuto = view.context;

  // X11: auto-compact off: no more threshold compaction.
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { context: { ...saved, autoCompact: false } } });
  for (let i = 0; i < 3; i++) await k.ask(id, 'main', fill(100 + i));
  view = await show();
  check('X11 auto-compact off: past the threshold, nothing compacts', brain.summaries.length === 1 && view.context.tokens > 10000, { summaries: brain.summaries.length, context: view.context });

  // X14/X16/X17: Compact now from the context ring in the chat.
  const chatUrl = new URL(web.url); chatUrl.searchParams.set('project', id);
  await send('Page.navigate', { url: chatUrl.toString() }, s);
  await waitFor(`!!document.querySelector('#compose .context-popup [data-action="compact-now"]')`, s, 'compact button in the ring');
  await evaluate(`(() => { const meter = document.querySelector('#compose .context-meter'); meter.focus(); })()`, s); await delay(300);
  await shot('02-context-ring-compact', s);
  let open; brain.hold = new Promise(ok => { open = ok; });
  await evaluate(`document.querySelector('#compose .context-popup [data-action="compact-now"]').click()`, s);
  await eventually(async () => brain.summaries.length === 2, 'Compact now did not start a summary');
  check('X17 a second Compact now while compacting is refused', await fails(() => rpc({ action: 'compact', id }), /already compacting/));
  await waitFor(`/compacting/i.test(document.querySelector('#compose .context-popup').innerText)`, s, 'ring shows compacting');
  open(); brain.hold = null;
  await eventually(async () => { const c = (await show()).context; return !c.compacting && c.tokens < 10000; }, 'context did not drop after Compact now');
  check('X14/X16 Compact now (ring) summarizes the chat while auto-compact is off; the meter drops', brain.summaries.length === 2, (await show()).context);
  await waitFor(`!/compacting/i.test(document.querySelector('#compose .context-popup').innerText)`, s, 'ring idle again');

  // X15: paused project and archived/short chats.
  const chat = await rpc({ action: 'chat-create', id, title: 'Short' });
  const before = brain.summaries.length;
  const shortResult = await rpc({ action: 'compact', id, chatId: chat.id });
  await delay(1500);
  check('X15 Compact now on a short chat starts and finishes without a summary or error', shortResult.started === true && brain.summaries.length === before && !(await show(chat.id)).context.compacting);
  await rpc({ action: 'chat-update', id, chatId: chat.id, archived: true });
  check('X15 Compact now on an archived chat is refused', await fails(() => rpc({ action: 'compact', id, chatId: chat.id }), /archived/));
  await rpc({ action: 'pause', id });
  check('X15 Compact now while paused is refused', await fails(() => rpc({ action: 'compact', id }), /paus/i));
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });

  // X4/X9: restart keeps the settings; reset restores the catalog window.
  await k.stopHost(); await k.startHost();
  view = await show();
  check('X4 settings survive a host restart', view.context.window === 20000 && (await rpc({ action: 'settings-snapshot', id })).values.context?.autoCompact === false);
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { context: null } });
  view = await show();
  check('X9 reset restores the catalog window and defaults', view.context.window === 128000 && (await rpc({ action: 'settings-snapshot', id })).values.context === null, view.context);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = k.redact(error?.stack ?? error);
}
await k.finish(result.status);
