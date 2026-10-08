// Browser E2E: worker watchdog (C12). Isolated host, local fake model (with token usage), headless Chrome, 6 s interval via env.
// A looping worker is steered at one check, then stopped and redispatched at the next; a healthy worker is left alone.
// Failure cases: scripts/watchdog-failures.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, delay, randomUUID } from './notify-kit.mjs';

const EVERY = 6000;
const chunk = (delta, finish, usage) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
const usage = { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 };
const callU = (tool, args) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls', usage) + 'data: [DONE]\n\n';
const sayU = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop', usage) + 'data: [DONE]\n\n';

const brain = { turns: [], actions: [], healthySteps: 0, loopCalls: 0 };
const blocks = text => text.split('\n- ').slice(1).map(block => ({ thread: /thread ([0-9a-f-]{36})/.exec(block)?.[1], text: block }));
const respond = async ({ coordinator, userText, results, msgs }) => {
  if (coordinator) {
    if (/MARK-WD\b/.test(userText)) {
      if (results.length === 0) return callU('projects_delegate', { role: 'worker', task: 'WD-LOOP investigate the flaky test' });
      if (results.length === 1) return callU('projects_delegate', { role: 'worker', task: 'WD-HEALTHY implement the progress feature' });
      return sayU('');
    }
    if (/MARK-WD2\b/.test(userText) || /MARK-WD3\b/.test(userText)) return results.length === 0 ? callU('projects_delegate', { role: 'worker', task: `WD-LOOP${/MARK-WD(\d)/.exec(userText)[1]} spin` }) : sayU('');
    if (userText.startsWith('[Owner-local event worker.watchdog]')) {
      // Decide once per check (first stage), then run the planned actions in order.
      let turn = brain.turns.find(item => item.text === userText && item.open);
      if (!turn) {
        turn = { at: Date.now(), text: userText, open: true, plan: [] };
        for (const block of blocks(userText)) {
          const looping = /repeated identical calls since the last check: (?!none)/.test(block.text);
          if (!looping) continue;
          if (/not steered/.test(block.text)) turn.plan.push(['projects_worker_control', { action: 'steer', threadId: block.thread, text: 'WD-NUDGE Stop re-reading README.md; open src/ and fix the assertion.', requestId: randomUUID() }]);
          else if (/STEER/.test(block.text)) { turn.plan.push(['projects_worker_control', { action: 'stop', threadId: block.thread }]); turn.plan.push(['projects_delegate', { role: 'worker', task: 'WD-REDO rescoped: only fix the assertion in src/' }]); }
        }
        brain.turns.push(turn);
      }
      if (results.length < turn.plan.length) { const [tool, args] = turn.plan[results.length]; brain.actions.push({ at: Date.now(), tool, ...args, turn: brain.turns.indexOf(turn) }); return callU(tool, args); }
      turn.open = false; turn.results = results;
      return sayU(brain.turns.indexOf(turn) === 1 ? 'WD-QUIET-TEXT' : '');
    }
    return undefined;
  }
  const first = msgs.find(m => m.role === 'user')?.content, task = typeof first === 'string' ? first : JSON.stringify(first ?? '');
  if (/WD-LOOP|WD-NUDGE/.test(task) || /WD-NUDGE/.test(userText)) { await delay(500); brain.loopCalls++; return callU('bash', { command: 'cat README.md' }); }
  if (/WD-HEALTHY/.test(task)) { await delay(600); if (results.length < 24) { brain.healthySteps++; return callU('bash', { command: `echo step-${results.length} > progress-${results.length}.txt` }); } return sayU('HEALTHY-DONE'); }
  if (/WD-REDO/.test(task)) return results.length === 0 ? callU('bash', { command: 'echo fixed > fix.txt' }) : sayU('REDO-DONE');
  return undefined;
};
const k = await kit('watchdog', { PI_PROJECTS_WATCHDOG_MS: String(EVERY), PI_PROJECTS_WATCHDOG_TICK_MS: '400' }, respond);
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, send } = k;
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };

try {
  await k.startHost();
  const id = await k.setup('Watch', k.gitRepo), other = await k.setup('Other');
  const otherSnap = await rpc({ action: 'automation-snapshot', id: other });
  const auto = JSON.parse(readFileSync(join(k.home, other, 'automations.json'), 'utf8'));
  check('D6 default: watchdog on, every 15 minutes', auto.watchdog?.enabled === true && auto.watchdog?.everyMs === 900000 && otherSnap.watchdog.enabled === true, auto.watchdog);
  const snap = await rpc({ action: 'owner-setup-snapshot', id });
  await rpc({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision });
  const rev = async () => (await rpc({ action: 'settings-snapshot', id })).revision;
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: await rev(), changes: { workerCap: 4 } });
  const ops = await rpc({ action: 'chat-create', id, title: 'Ops' });
  await rpc({ action: 'automation-update', id, change: { eventChat: ops.id } });
  const wd = async () => (await rpc({ action: 'automation-snapshot', id })).watchdog;
  check('D1 idle project: not armed, no checks', (await wd()).armedAtMs === null && (await wd()).ticks === 0);

  await rpc({ action: 'message', id, text: 'MARK-WD start the two tasks' });
  const work = async () => (await rpc({ action: 'plan-snapshot', id })).work;
  await eventually(async () => (await work()).some(w => /WD-REDO/.test(w.text) && w.status === 'completed'), 'looper was never stopped and redispatched', 900);
  await eventually(async () => (await work()).some(w => /WD-HEALTHY/.test(w.text) && w.status !== 'running'), 'healthy worker did not finish', 900);
  const plan = await work();
  const loop = plan.find(w => /WD-LOOP investigate/.test(w.text)), healthy = plan.find(w => /WD-HEALTHY/.test(w.text));
  const loopItems = plan.filter(w => w.threadId === loop.threadId), healthyItems = plan.filter(w => w.threadId === healthy.threadId);
  result.actions = brain.actions; result.turns = brain.turns.map(t => ({ at: t.at, plan: t.plan.map(([tool, args]) => `${tool}:${args.action ?? args.task}`), text: t.text.slice(0, 2500) }));
  const loopActions = brain.actions.filter(a => a.threadId === loop.threadId);
  check('D19 the looping worker was steered first (concrete nudge), not stopped', loopActions[0]?.action === 'steer' && /WD-NUDGE/.test(loopActions[0].text), loopActions);
  check('D20 at a later check the still-looping worker was stopped and a rescoped worker dispatched', loopActions[1]?.action === 'stop' && loopActions[1].turn > loopActions[0].turn && brain.actions.some(a => a.tool === 'projects_delegate' && /WD-REDO/.test(a.task) && a.turn === loopActions[1].turn), loopActions);
  check('D20 the loop thread ends stopped; its steer replacement is marked', loopItems.some(w => w.steering) && loopItems.every(w => ['stopped', 'completed', 'failed'].includes(w.status)) && loopItems.at(-1).status === 'stopped', loopItems.map(w => ({ s: w.status, steering: w.steering })));
  check('D21 the healthy worker was never steered or stopped and completed', !brain.actions.some(a => a.threadId === healthy.threadId) && healthyItems.length === 1 && healthyItems[0].status === 'completed', healthyItems.map(w => w.status));
  const firstCheck = brain.turns.find(t => t.text.includes(healthy.threadId) && t.text.includes(loop.threadId));
  const block = thread => blocks(firstCheck.text).find(b => b.thread === thread)?.text ?? '';
  const lb = block(loop.threadId), hb = block(healthy.threadId);
  result.firstCheck = firstCheck.text;
  check('D7 the digest has runtime, last tool calls, repeats, errors, tokens since the last check and files changed', [/running \d+s/, /last tool calls \(oldest first\): bash cat README\.md \| bash cat README\.md/, /repeated identical calls since the last check: bash \{"command":"cat README\.md"\} ×\d+/, /errors since the last check: 0/, /tokens since the last check: [\d,]+ \(thread total [\d,]+\)/, /files changed in its worktree: none uncommitted/].every(re => re.test(lb)), lb);
  check('D9/D11 healthy worker: no repeats; its worktree changes are listed', /repeated identical calls since the last check: none/.test(hb) && /files changed in its worktree: \d+ \(\?\? progress-/.test(hb), hb);
  const secondLoop = brain.turns.map(t => blocks(t.text).find(b => b.thread === loop.threadId)?.text).filter(Boolean)[1] ?? '';
  const tokens = text => [/tokens since the last check: ([\d,]+)/.exec(text)?.[1], /thread total ([\d,]+)/.exec(text)?.[1]].map(v => Number(String(v).replaceAll(',', '')));
  const [since2, total2] = tokens(secondLoop);
  check('D10 tokens are per interval (second check: since-last < thread total, > 0)', since2 > 0 && since2 < total2, { since2, total2 });
  check('D13 the second check says the run is already a steer', /STEER you sent/.test(secondLoop), secondLoop);
  check('D16 the check carries the escalation policy and asks for no text', /steer it once with a concrete nudge/.test(firstCheck.text) && /stop it .* redispatch/.test(firstCheck.text) && /leave it alone/.test(firstCheck.text) && /End this turn with no text/.test(firstCheck.text) && /final report or through a needs-you/.test(firstCheck.text));
  check('D8 the digest is bounded (≤ 7 lines per worker, < 32 KB)', brain.turns.every(t => t.text.length < 32000 && blocks(t.text).every(b => b.text.split('\n').length <= 7)));

  // Delivery: the events chat (Ops), never Main; quiet; no "Finished" notice.
  const opsView = await rpc({ action: 'show', id, chatId: ops.id }), mainView = await rpc({ action: 'show', id });
  const isCheck = m => m.role === 'user' && /^\[Owner-local event worker\.watchdog\]/.test(m.text ?? '');
  check('D17 checks go to the events chat, not Main', opsView.messages.filter(isCheck).length >= 2 && !mainView.messages.some(isCheck), { ops: opsView.messages.filter(isCheck).length });
  await delay(1500);
  const feed = existsSync(join(k.home, 'notifications.json')) ? JSON.parse(readFileSync(join(k.home, 'notifications.json'), 'utf8')).feed : [];
  check('D14 watchdog turns never notify ("Finished"), even when the coordinator wrote text', !feed.some(n => /WD-QUIET-TEXT/.test(n.text)) && brain.turns.length >= 2, feed.map(n => `${n.kind}:${n.title}:${n.text.slice(0, 60)}`));
  check('D15 checks are not worker reports', !opsView.messages.some(m => isCheck(m) && /^\[Durable work/.test(m.text)));

  // D1: once nothing runs, no more checks.
  await eventually(async () => (await work()).every(w => !['running', 'queued'].includes(w.status)), 'work did not settle');
  await delay(800);
  const idleTicks = (await wd()).ticks;
  await delay(EVERY * 2.5);
  const afterIdle = await wd();
  check('D1 no checks while no worker runs (disarmed)', afterIdle.ticks === idleTicks && afterIdle.armedAtMs === null, afterIdle);

  // D3: one check per interval: no duplicates, consecutive checks ≥ 0.9 interval apart.
  const checks = (await rpc({ action: 'show', id, chatId: ops.id })).messages.filter(isCheck);
  const gaps = checks.slice(1).map((m, i) => m.at - checks[i].at);
  check('D3 one check per interval, none duplicated', checks.length === afterIdle.ticks && new Set(checks.map(m => m.text)).size === checks.length && gaps.every(g => g >= EVERY * 0.9), { ticks: afterIdle.ticks, checks: checks.length, gaps });

  // D2: paused project does not tick.
  await rpc({ action: 'message', id, text: 'MARK-WD2 one more' });
  await eventually(async () => (await wd()).armedAtMs !== null, 'watchdog did not arm for the new worker');
  await rpc({ action: 'pause', id });
  const pausedTicks = (await wd()).ticks;
  await delay(EVERY * 2.5);
  check('D2 no checks while the project is paused', (await wd()).ticks === pausedTicks);
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });

  // D4: restart keeps the clock (last check, count); no check fires just because the host restarted.
  await eventually(async () => (await work()).every(w => !['queued', 'running'].includes(w.status)), 'work still active after resume');
  const before = await wd();
  await k.stopHost(); await k.startHost();
  const after = await wd();
  check('D4 the watchdog clock survives a restart', after.ticks === before.ticks && after.lastTickAtMs === before.lastTickAtMs && after.lastTickAtMs !== null, { before, after });

  // D22: resume + restart + send. Settled work: always admitted (looped). Work still active at the restart: recovery re-pauses
  // the project (durable-runtime open), so a send is denied until an explicit resume; this is by design, never a flake.
  const settle = async () => { for (const w of (await work()).filter(w => ['queued', 'running'].includes(w.status))) await rpc({ action: 'thread-stop', id, threadId: w.threadId }).catch(() => {}); await eventually(async () => (await work()).every(w => !['queued', 'running'].includes(w.status)), 'race: work did not settle'); };
  const raceLog = [];
  for (let i = 0; i < 3; i++) {
    await rpc({ action: 'message', id, text: `MARK-WD2 race ${i}` });
    await eventually(async () => (await work()).some(w => w.status === 'running'), 'race: looper did not start');
    await rpc({ action: 'pause', id });
    await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
    await settle();
    await k.stopHost(); await k.startHost();
    const accepted = await rpc({ action: 'message', id, text: `ping after settled restart ${i}` }).then(() => true, error => error.message);
    raceLog.push({ i, settled: accepted });
    if (accepted !== true) break;
  }
  check('D22 resume + settle + restart + send is admitted, 3 times in a row', raceLog.length === 3 && raceLog.every(r => r.settled === true), raceLog);
  await rpc({ action: 'message', id, text: 'MARK-WD2 active at restart' });
  await eventually(async () => (await work()).some(w => w.status === 'running'), 'race: looper did not start');
  await rpc({ action: 'pause', id });
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  await k.stopHost(); await k.startHost();
  const denied = await rpc({ action: 'message', id, text: 'ping while recovered paused' }).then(() => null, error => error.message);
  check('D22 work active at the restart: recovery re-pauses, send denied (by design)', /paused; admission is denied/.test(denied ?? ''), denied);
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id }); await settle();
  check('D22 explicit resume + settle: send admitted again', await rpc({ action: 'message', id, text: 'ping after explicit resume' }).then(() => true, error => error.message) === true);
  result.raceLog = raceLog;

  // D5: Settings card shows the watchdog and turns it off; no checks while off even with a running worker.
  const web = await rpc({ action: 'web' }), url = new URL(web.url);
  url.searchParams.set('project', id); url.searchParams.set('tab', 'settings');
  const s = await openPage(url.toString());
  await waitFor(`!!document.querySelector('#watchdog-enabled')`, s, 'watchdog settings');
  check('D5 Settings shows the watchdog: on, last check and count', await evaluate(`document.querySelector('#watchdog-enabled').checked && /Checks\\s*${after.ticks}/.test(document.querySelector('#watchdog').innerText)`, s), await evaluate(`document.querySelector('#watchdog').innerText`, s));
  await evaluate(`document.querySelector('#watchdog').scrollIntoView()`, s); await delay(300);
  await shot('01-settings-watchdog', s);
  await evaluate(`(() => { document.querySelector('#watchdog-enabled').checked = false; document.querySelector('[data-action="automation-save"]').click(); })()`, s);
  await eventually(async () => (await wd()).enabled === false, 'watchdog not turned off from the UI');
  check('D5 off switch saved from Settings (no restart)', JSON.parse(readFileSync(join(k.home, id, 'automations.json'), 'utf8')).watchdog.enabled === false);
  const offTicks = (await wd()).ticks;
  await rpc({ action: 'message', id, text: 'MARK-WD3 spin again' });
  await eventually(async () => (await work()).some(w => /WD-LOOP3/.test(w.text) && w.status === 'running'), 'third looper did not start');
  await delay(EVERY * 2.5);
  check('D5 no checks while the watchdog is off, even with a running worker', (await wd()).ticks === offTicks);
  await rpc({ action: 'automation-update', id, change: { watchdog: { enabled: true } } });
  await eventually(async () => (await wd()).ticks > offTicks, 'turning the watchdog back on did not resume checks', 400);
  check('D5 turning it back on resumes checks', true);
  await rpc({ action: 'pause', id });

  // The Ops chat shows the checks as compact cards.
  const chatUrl = new URL(web.url); chatUrl.searchParams.set('project', id); chatUrl.searchParams.set('chat', ops.id);
  await send('Page.navigate', { url: chatUrl.toString() }, s);
  await delay(1500);
  const cards = await evaluate(`[...document.querySelectorAll('.event-card.watchdog')].map(c => c.querySelector('summary').innerText)`, s);
  result.cards = cards;
  if (cards.length) { await shot('02-ops-watchdog-cards', s); check('UI watchdog checks render as compact "Watchdog check" cards', cards.every(text => /Watchdog check/.test(text))); }
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = k.redact(error?.stack ?? error);
}
await k.finish(result.status);
