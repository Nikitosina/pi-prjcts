// Browser E2E: MCP servers per profile (Settings picker, gateway tools, write guard, pool resilience, recovery). Fakes only:
// fake stdio MCP server, temp mcp.json via PI_PROJECTS_MCP_CONFIG, fake model, private HOME. Failure cases: mcp-failures.md.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, delay } from './lib/e2e-kit.mjs';

const handler = ({ role, user, results }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator' && results.length === 0) {
    const w = /MARK-W (.+)$/m.exec(user)?.[1], s = /MARK-S (.+)$/m.exec(user)?.[1];
    if (w) return call('projects_delegate', { role: 'worker', task: `W-TASK ${w}` });
    if (s) return call('projects_delegate', { role: 'scout', task: `S-TASK ${s}` });
  }
  if (role === 'coordinator' && results.length > 0 && /MARK-[WS]/.test(user)) return say('Noted.');
  if (results.length > 0) return undefined;
  const run = /MCP-CALL (\S+) (\S+)(?: (\{[^\n]*\}))?/.exec(user);
  if (run) return call('projects_mcp_call', { server: run[1], tool: run[2], arguments: run[3] ? JSON.parse(run[3]) : {} });
  const list = /MCP-TOOLS(?: ([A-Za-z][\w-]*))?/.exec(user);
  if (list) return call('projects_mcp_tools', list[1] ? { server: list[1] } : {});
  return undefined;
};
const kit = await createKit('mcp', { handler });
const { root, check, rpc, result } = kit;
const calls = join(root, 'mcp-calls.jsonl'), SECRET = 'SECRET-xyzzy-123';
const server = tag => ({ command: process.execPath, args: [join(kit.repo, 'scripts/fake-mcp-server.mjs')], env: { FAKE_MCP_TAG: tag, FAKE_MCP_CALLS: calls, FAKE_MCP_SECRET: SECRET }, timeout: 2, description: `Fake ${tag} server` });
const configPath = join(root, 'fake-mcp.json');
const config = { mcpServers: { 'fake-ci': server('ci'), 'fake-tracker': server('tracker'), 'fake-xcode': server('xcode'), 'fake-off': { ...server('off'), enabled: false }, 'fake-oauth': { url: 'http://127.0.0.1:9/mcp', oauth: {}, description: 'Needs a browser sign-in' } } };
writeFileSync(configPath, JSON.stringify(config)); writeFileSync(calls, '');
Object.assign(kit.hostEnv, { PI_PROJECTS_MCP_CONFIG: configPath });
// A decoy "real" config in the private HOME: it must never be read.
mkdirSync(join(kit.agentDir), { recursive: true }); writeFileSync(join(kit.agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'decoy-real': { command: '/bin/false' } } }));
kit.initRepo();
const serverLog = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

await kit.run(async () => {
  const id = await kit.createProject('MCP');
  const ask = text => kit.ask(id, text);
  let n = 0;
  const coord = async (text, marker = `#${++n}`) => { await ask(`${text} ${marker}`); return kit.toolResult('coordinator', marker); };
  const worker = async text => { const marker = `#${++n}`; await ask(`MARK-W ${marker} ${text}`); return kit.toolResult('worker', `W-TASK ${marker}`); };
  const scout = async text => { const marker = `#${++n}`; await ask(`MARK-S ${marker} ${text}`); return kit.toolResult('scout', `S-TASK ${marker}`); };

  // Catalog: config path override, statuses, no secrets.
  const catalog = await rpc({ action: 'mcp-catalog', id });
  const status = Object.fromEntries(catalog.servers.map(item => [item.name, item.status]));
  check('F1 the catalog reads only the overridden config (decoy ignored)', catalog.path === configPath && !('decoy-real' in status), catalog);
  check('F5 statuses: ready / disabled / needs-sign-in', status['fake-ci'] === 'ready' && status['fake-off'] === 'disabled' && status['fake-oauth'] === 'needs-sign-in' && catalog.servers.length === 5, status);
  check('F14 the catalog never carries env values', !JSON.stringify(catalog).includes(SECRET));
  const snapshot = await rpc({ action: 'settings-snapshot', id });
  check('F16 a project without MCP settings reports mcp = null', snapshot.values.mcp === null, snapshot.values.mcp);

  // Default: nothing enabled.
  const none = await coord('MCP-TOOLS');
  check('F3 by default no server is offered', /no MCP servers/i.test(none), none);
  const deniedDefault = await coord('MCP-CALL fake-ci launch_status {"id":"L0"}');
  check('F3 by default a call is refused', /not enabled for your role/i.test(deniedDefault) && serverLog().every(entry => entry.tool !== 'launch_status'), deniedDefault);
  check('F22 the coordinator prompt carries the MCP note, not tool schemas', /projects_mcp_tools/.test(kit.lastCall('coordinator', '#1').system) && !/launch_status/.test(kit.lastCall('coordinator', '#1').system));

  // Picker.
  const page = await kit.openPage(await kit.webUrl(id));
  await page.waitFor(`document.querySelectorAll('#mcp-picker [data-mcp-pick]').length === 5`, 'mcp picker lists five servers');
  const locked = await page.evaluate(`[...document.querySelectorAll('#mcp-picker [data-mcp-pick]')].filter(i => i.disabled).map(i => i.dataset.mcpPick).sort().join()`);
  check('F21 disabled and sign-in servers are locked in the picker', locked === 'fake-oauth,fake-off', locked);
  const tab = async role => { await page.evaluate(`document.querySelector('[data-action="mcp-tab"][data-role="${role}"]').click()`); await page.waitFor(`document.querySelector('[data-action="mcp-tab"][data-role="${role}"]').classList.contains('on')`, `${role} tab`); };
  const pick = name => page.evaluate(`document.querySelector('[data-mcp-pick="${name}"]').click()`);
  await tab('coordinator'); await pick('fake-ci'); await pick('fake-tracker');
  await tab('worker'); await pick('fake-xcode');
  await tab('all');
  await page.evaluate(`document.querySelector('#mcp-card').scrollIntoView()`); await page.shot('01-mcp-picker');
  await page.viewport(390, 844, true); await delay(300);
  await page.evaluate(`document.querySelector('#mcp-card').scrollIntoView()`);
  const narrow = await page.evaluate(`(() => { const c = document.querySelector('#mcp-card').getBoundingClientRect(); return { right: c.right, width: innerWidth, scroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
  await page.shot('02-mcp-picker-390');
  check('F21 the picker fits 390 px', !narrow.scroll && narrow.right <= narrow.width + 1, narrow);
  await page.viewport(1440, 1000);
  await page.evaluate(`document.querySelector('[data-action="mcp-save"]').click()`);
  await kit.eventually(async () => (await rpc({ action: 'settings-snapshot', id })).values.mcp !== null, 'mcp settings not saved', 100);
  const saved = (await rpc({ action: 'settings-snapshot', id })).values.mcp;
  check('F21 saving the picker persists the profiles', JSON.stringify(saved) === JSON.stringify({ all: [], coordinator: ['fake-ci', 'fake-tracker'], worker: ['fake-xcode'], scout: [], reviewer: [], writes: [] }), saved);
  check('F4 an MCP-only change needed no reopen (project still open and idle)', (await rpc({ action: 'show', id })).chats.every(chat => !chat.busy));

  // Role scoping.
  const listed = await coord('MCP-TOOLS');
  check('F2 the coordinator sees exactly its servers', /fake-ci/.test(listed) && /fake-tracker/.test(listed) && !/fake-xcode/.test(listed), listed);
  check('F14 no secret in listings or any prompt so far', !listed.includes(SECRET) && !result.calls.some(c => c.system.includes(SECRET) || c.user.includes(SECRET) || c.results.some(r => r.includes(SECRET))));
  const tools = await coord('MCP-TOOLS fake-tracker');
  const toolInfo = JSON.parse(tools);
  const flag = name => toolInfo.tools.find(item => item.name === name)?.write;
  check('F7 tool listing marks writes by annotation and heuristic', flag('ChangeIssueStatus') === true && flag('start_launch') === true && flag('purge') === true && flag('get_settings') === false && flag('list_hints') === false && flag('launch_status') === false, toolInfo.tools.map(item => [item.name, item.write]));
  check('F22 the listing carries input schemas on demand', toolInfo.tools.find(item => item.name === 'launch_status').inputSchema?.type === 'object');
  const ok = await coord('MCP-CALL fake-ci launch_status {"id":"L1"}');
  check('coordinator reads through fake-ci', /launch L1: PASSED/.test(ok), ok);
  const deniedX = await coord('MCP-CALL fake-xcode whoami');
  check('F2 the coordinator cannot call a worker-only server', /not enabled for your role/i.test(deniedX) && !serverLog().some(entry => entry.tag === 'xcode' && entry.event === 'call'), deniedX);
  const whoami = await worker('MCP-CALL fake-xcode whoami');
  const cwd = /cwd=(\S+)/.exec(whoami)?.[1] ?? '';
  check('F10 a worker call runs the server in the worker worktree', cwd.includes('/worktrees/') && cwd.startsWith(root) && cwd !== kit.workspace, { whoami });
  const workerList = await worker('MCP-TOOLS');
  check('F2 the worker lists only its own server', /fake-xcode/.test(workerList) && !/fake-ci/.test(workerList), workerList);
  check('F2 the worker cannot call the coordinator server', /not enabled for your role/i.test(await worker('MCP-CALL fake-ci launch_status {"id":"L2"}')));
  check('F2 a scout has no servers', /no MCP servers/i.test(await scout('MCP-TOOLS')) && /not enabled for your role/i.test(await scout('MCP-CALL fake-xcode whoami')));

  // Write guard.
  const before = serverLog().length;
  const blocked = [await coord('MCP-CALL fake-tracker ChangeIssueStatus {"key":"K-1","status":"Closed"}'), await coord('MCP-CALL fake-tracker start_launch {"id":"L3"}'), await coord('MCP-CALL fake-tracker purge')];
  check('F7/F8 writes are refused with guidance and never reach the server', blocked.every(text => /allow writes/i.test(text) && /owner/i.test(text)) && serverLog().slice(before).every(entry => !['ChangeIssueStatus', 'start_launch', 'purge'].includes(entry.tool)), blocked);
  check('F7 reads pass: unannotated get_settings and readOnlyHint list_hints', /get_settings ok/.test(await coord('MCP-CALL fake-tracker get_settings')) && /list_hints ok/.test(await coord('MCP-CALL fake-tracker list_hints')));
  await page.evaluate(`document.querySelector('[data-mcp-writes="fake-tracker"]').click()`);
  await page.evaluate(`document.querySelector('[data-action="mcp-save"]').click()`);
  await kit.eventually(async () => (await rpc({ action: 'settings-snapshot', id })).values.mcp.writes.includes('fake-tracker'), 'writes toggle not saved', 100);
  await page.evaluate(`document.querySelector('#mcp-card').scrollIntoView()`); await page.shot('03-mcp-writes');
  check('F9 with writes on for fake-tracker the change goes through, live', /ChangeIssueStatus ok/.test(await coord('MCP-CALL fake-tracker ChangeIssueStatus {"key":"K-1","status":"Closed"}')) && serverLog().some(entry => entry.tool === 'ChangeIssueStatus' && entry.tag === 'tracker'));
  const stillBlocked = await coord('MCP-CALL fake-ci ChangeIssueStatus {"key":"K-1","status":"Closed"}');
  check('F9 the writes toggle is per server', /allow writes/i.test(stillBlocked) && !serverLog().some(entry => entry.tool === 'ChangeIssueStatus' && entry.tag === 'ci'), stillBlocked);

  // Resilience.
  const pidOf = text => /pid=(\d+)/.exec(text)?.[1];
  const pid1 = pidOf(await coord('MCP-CALL fake-ci whoami'));
  const slow = await coord('MCP-CALL fake-ci slow {"ms":8000}');
  check('F11 a slow call times out with a clear error', /timed out|timeout/i.test(slow), slow);
  const pid2 = pidOf(await coord('MCP-CALL fake-ci whoami'));
  check('F11 the next call after a timeout works on a fresh connection', pid1 && pid2 && pid1 !== pid2, { pid1, pid2 });
  const crashed = await coord('MCP-CALL fake-ci crash');
  const pid3 = pidOf(await coord('MCP-CALL fake-ci whoami'));
  check('F12 a crash is reported and the next call reconnects', /error|closed|exit|failed/i.test(crashed) && pid3 && pid3 !== pid2, { crashed, pid3 });
  await coord('MCP-CALL fake-ci big', '#big');
  const bigLength = kit.lastCall('coordinator', '#big').resultLengths.at(-1);
  check('F13 oversized output is capped near 64 KiB', bigLength > 40_000 && bigLength < 70_000, bigLength);
  check('F1/F10 every server ran under the temp root', serverLog().filter(entry => entry.event === 'start').every(entry => entry.cwd.startsWith(root)) && serverLog().some(entry => entry.event === 'start'));
  check('F19 no cold-start duplicates: one start per connection', new Set(serverLog().filter(entry => entry.event === 'start').map(entry => entry.pid)).size === serverLog().filter(entry => entry.event === 'start').length);

  // Live settings change, unavailable servers, invalid settings.
  await kit.updateSettings(id, { mcp: { all: [], coordinator: ['fake-tracker'], worker: ['fake-xcode'], scout: [], reviewer: [], writes: ['fake-tracker'] } });
  check('F4 removing a server applies to the very next call', /not enabled for your role/i.test(await coord('MCP-CALL fake-ci launch_status {"id":"L4"}')));
  await kit.updateSettings(id, { mcp: { all: ['fake-off', 'fake-oauth', 'ghost'], coordinator: [], worker: [], scout: [], reviewer: [], writes: [] } });
  const unavailable = await coord('MCP-TOOLS');
  check('F5/F6 unavailable and stale servers are listed with a status, not offered', /fake-off/.test(unavailable) && /disabled/.test(unavailable) && /needs-sign-in/.test(unavailable) && /ghost/.test(unavailable) && /unknown/.test(unavailable), unavailable);
  check('F5 a call to a disabled server is refused', /disabled/i.test(await coord('MCP-CALL fake-off whoami')));
  check('F5 a call to a sign-in server is refused', /sign-in/i.test(await coord('MCP-CALL fake-oauth whoami')));
  check('F6 a call to a removed server says so', /unknown|unavailable/i.test(await coord('MCP-CALL ghost whoami')));
  const settings = await rpc({ action: 'settings-snapshot', id });
  check('F17 unknown role rejected', await kit.rejects({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { mcp: { all: [], coordinator: [], worker: [], scout: [], reviewer: [], writes: [], admin: [] } } }) !== null);
  check('F17 non-string names rejected', await kit.rejects({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { mcp: { all: [42], coordinator: [], worker: [], scout: [], reviewer: [], writes: [] } } }) !== null);
  await kit.updateSettings(id, { mcp: { all: [], coordinator: ['fake-ci'], worker: ['fake-xcode'], scout: [], reviewer: [], writes: [] } });

  // Probe action.
  const probe = await rpc({ action: 'mcp-probe', id, server: 'fake-ci' });
  check('probe reports the tool count', probe.ok === true && probe.tools === 10, probe);
  check('probe refuses unavailable servers', (await rpc({ action: 'mcp-probe', id, server: 'fake-oauth' })).ok === false);

  // Chats and recovery.
  const chat = await rpc({ action: 'chat-create', id, title: 'Second' });
  const chatId = chat.id ?? chat.chat?.id ?? chat.chatId;
  const job = await rpc({ action: 'message', id, chatId, text: `MCP-CALL fake-ci launch_status {"id":"L5"} #chat` });
  await kit.eventually(async () => (await rpc({ action: 'show', id, chatId })).jobs.find(j => j.id === job.id)?.state === 'done', 'chat job did not finish', 600);
  check('a second chat has the gateway too', /launch L5: PASSED/.test(kit.toolResult('coordinator', '#chat')), kit.toolResult('coordinator', '#chat'));
  await kit.restartHost();
  const afterRestart = await coord('MCP-CALL fake-ci launch_status {"id":"L6"}');
  check('F15 after a host restart the coordinator still has the gateway', /launch L6: PASSED/.test(afterRestart), afterRestart);
  check('F15 and a worker too', /cwd=/.test(await worker('MCP-CALL fake-xcode whoami')));

  result.serverStarts = serverLog().filter(entry => entry.event === 'start').length;
  result.pids = [...new Set(serverLog().map(entry => entry.pid))];
  kit.pids = result.pids;
});
if (kit.pids) {
  await delay(1500);
  const alive = kit.pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  result.orphans = alive;
  if (alive.length) { console.error('F20 orphan MCP servers after host stop', alive); process.exitCode = 1; }
  else console.log('F20 ok: no orphan MCP servers after host stop');
  kit.save();
}
