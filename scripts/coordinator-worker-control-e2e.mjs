// Failure cases recorded in coordinator-worker-control-failures.md before implementation.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `coordinator-worker-control-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `coordinator-worker-control-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agent = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agent]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], tools: [], errors: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
let commands = [], heldWorkers = true, host, hostExit;
const held = new Set();
const historyAnswer = 'HISTORY RESULT ' + '🧭漢'.repeat(12000);
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body), msgs = input.messages;
    const coordinator = msgs.some(m => /persistent coordinator/.test(m.content ?? ''));
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const text = msgs[lastUser]?.content ?? '';
    const turnTools = msgs.slice(lastUser + 1).filter(m => m.role === 'tool');
    const available = (input.tools ?? []).map(t => t.function.name);
    result.calls.push({ coordinator, text, available });
    for (const reply of coordinator && text.startsWith('CONTROL ') ? turnTools : []) if (!result.tools.some(t => t.callId === reply.tool_call_id)) result.tools.push({ callId: reply.tool_call_id, content: reply.content });
    let tool;
    if (coordinator && text.startsWith('CONTROL ')) tool = commands[turnTools.length];
    if (!coordinator && text.includes('HOLD') && heldWorkers) {
      if (turnTools.length === 0) tool = { name: 'projects_knowledge_list', arguments: {} };
      else { held.add(res); res.on('close', () => held.delete(res)); return; }
    }
    if (!coordinator && text === 'HISTORY-FIXTURE' && turnTools.length < 24) tool = { name: 'projects_knowledge_list', arguments: {} };
    if (tool && !available.includes(tool.name)) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk({ role: 'assistant', content: `UNAVAILABLE ${tool.name}` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(tool
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
      : chunk({ role: 'assistant', content: coordinator ? 'CONTROL acknowledged' : text === 'HISTORY-FIXTURE' ? historyAnswer : `Worker answer ${text}` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'wx', mode: 0o600 });
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 30000 }, res => {
      res.setEncoding('utf8');
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw Error(reply.error); resolve(reply.data); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('RPC timeout'))); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error(description);
}
async function start() {
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
  hostExit = new Promise(ok => host.once('exit', ok));
  await eventually(async () => { try { return (await rpc()).pid === host.pid; } catch { return false; } }, 'Owned host did not start');
}
let project;
const plan = () => rpc({ action: 'plan-snapshot', id: project.id });
async function command(name, args = {}, expectError = false) {
  commands = [{ name, arguments: args }];
  const before = result.tools.length;
  const job = await rpc({ action: 'message', id: project.id, text: `CONTROL ${randomUUID()}` });
  await eventually(async () => { const view = await rpc({ action: 'show', id: project.id }); const state = view.jobs.find(j => j.id === job.id)?.state; if (state === 'failed') throw Error('Coordinator command failed'); return state === 'done'; }, `Coordinator did not finish ${name}`);
  const found = result.tools.slice(before).at(-1);
  assert(found, `Coordinator did not call ${name}`);
  let output;
  try { output = JSON.parse(found.content); } catch { output = { error: found.content }; }
  if (!expectError) assert(!output.error && !found.content.includes('Error:'), `${name}: ${found.content}`);
  return output;
}
const control = (action, args = {}, expectError = false) => command('projects_worker_control', { action, ...args }, expectError);
try {
  await start();
  project = await rpc({ action: 'create', requestId: randomUUID(), name: 'Worker control fixture', cwd: workspace, objective: 'Disposable', model: 'fake/fake-model' });
  const settings = await rpc({ action: 'settings-snapshot', id: project.id });
  await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  await command('projects_workers');
  result.checks.push('T1 worker tools offered to coordinator');
  const a = await command('projects_delegate', { task: 'HOLD A' });
  const b = await command('projects_delegate', { role: 'scout', task: 'B' });
  await eventually(async () => (await plan()).work.find(w => w.id === a.workId)?.status === 'running', 'A did not run');
  assert.equal((await plan()).work.find(w => w.id === b.workId).status, 'queued');
  const listing = await command('projects_workers');
  assert.equal(listing.work.find(w => w.id === b.workId).role, 'scout');
  const history = await eventually(async () => { const page = await command('projects_worker_read', { threadId: a.threadId }); return page.items.some(m => m.kind === 'tool' && m.name === 'projects_knowledge_list') && page; }, 'Live tool history missing');
  result.history = history;
  assert(result.calls.filter(c => !c.coordinator).every(c => !c.available.includes('projects_worker_control')));
  result.checks.push('T2 queued work, frozen role and live tool activity visible; worker has no coordinator controls');
  const followId = randomUUID();
  const follow = await control('follow_up', { threadId: a.threadId, text: 'HOLD FOLLOW', requestId: followId });
  const duplicate = await control('follow_up', { threadId: a.threadId, text: 'HOLD FOLLOW', requestId: followId });
  assert.equal(follow.attemptId, duplicate.attemptId);
  await control('pause', { threadId: a.threadId });
  await eventually(async () => (await plan()).work.find(w => w.id === b.workId)?.status === 'completed', 'Worker pause did not free the slot');
  assert((await command('projects_workers')).threads.find(t => t.threadId === a.threadId).paused);
  assert.equal((await plan()).work.find(w => w.id === follow.attemptId).status, 'interrupted');
  result.checks.push('T3 deduplicated follow-up; individual pause preserves queued work, frees slot, leaves coordinator alive');
  await control('parallelism', { cap: 2 });
  await rpc({ action: 'shutdown' }); await hostExit;
  // Simulate a pre-feature coordinator only in the stopped, disposable fixture.
  const db = new DatabaseSync(join(home, project.id, 'durable.sqlite'));
  try {
    const row = db.prepare("SELECT r.document_id, r.seq, r.kind, r.content FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.kind=? AND d.owner_id=1 ORDER BY r.seq DESC LIMIT 1").get(JSON.stringify('pi.agent'));
    assert.equal(row.kind, 'base');
    const stored = JSON.parse(row.content);
    stored.tools = stored.tools.filter(name => !['projects_workers', 'projects_worker_read', 'projects_worker_control', 'projects_worker_plan'].includes(name));
    stored.extensions = stored.extensions.filter(name => name !== 'projects.coordinator-workers');
    stored.instructions = 'You are the persistent coordinator. You can only delegate.';
    db.prepare('UPDATE document_revisions SET content=? WHERE document_id=? AND seq=?').run(JSON.stringify(stored), row.document_id, row.seq);
  } finally { db.close(); }
  await start();
  assert.equal((await plan()).workerCap, 2);
  await rpc({ action: 'resume', id: project.id, confirm: project.id, recovery: 'leave-interrupted' });
  const frozen = await command('projects_workers');
  assert(frozen.threads.find(t => t.threadId === a.threadId).paused);
  assert.equal((await plan()).work.find(w => w.id === a.workId).status, 'interrupted');
  result.checks.push('T4 pre-feature coordinator gains tools; worker pause and parallelism survive restart/project resume');
  await control('resume', { threadId: a.threadId });
  await eventually(async () => (await plan()).work.find(w => w.id === a.workId)?.status === 'running', 'Individual resume did not preserve admission order');
  assert.equal((await plan()).work.find(w => w.id === follow.attemptId).status, 'queued');
  const steered = await control('steer', { threadId: a.threadId, text: 'REPLACEMENT', requestId: randomUUID() });
  await eventually(async () => (await plan()).work.find(w => w.id === steered.attemptId)?.status === 'completed', 'Steering failed');
  assert.equal((await plan()).work.find(w => w.id === follow.attemptId).status, 'stopped');
  result.checks.push('T5 steering drains old attempt and suppresses superseded queued work');
  await control('parallelism', { cap: 1 });
  const d = await command('projects_delegate', { task: 'HOLD D' });
  await eventually(async () => (await plan()).work.find(w => w.id === d.workId)?.status === 'running', 'D did not start');
  const e = await command('projects_delegate', { task: 'NEVER E' });
  await control('stop', { threadId: e.threadId });
  assert.equal((await plan()).work.find(w => w.id === e.workId).status, 'stopped');
  assert(!result.calls.some(c => !c.coordinator && c.text === 'NEVER E'));
  await control('pause', { threadId: d.threadId });
  await control('stop', { threadId: d.threadId });
  assert.equal((await plan()).work.find(w => w.id === d.workId).status, 'stopped');
  heldWorkers = false;
  const retryId = randomUUID();
  const retry = await control('retry', { workId: d.workId, requestId: retryId });
  const retryAgain = await control('retry', { workId: d.workId, requestId: retryId });
  assert.equal(retry.attemptId, retryAgain.attemptId);
  await eventually(async () => (await plan()).work.find(w => w.id === retry.attemptId)?.status === 'completed', 'Retry did not complete');
  assert.equal((await plan()).work.find(w => w.id === d.workId).status, 'stopped');
  result.checks.push('T6 queued/paused cancellation prevents execution; retry keeps terminal history and deduplicates');
  const historyWorker = await command('projects_delegate', { task: 'HISTORY-FIXTURE' });
  await eventually(async () => (await plan()).work.find(w => w.id === historyWorker.workId)?.status === 'completed', 'History fixture did not finish');
  const historyPages = [];
  for (const options of [{ limit: 100, textLimit: 16000 }, { limit: 50, textLimit: 7000 }, { limit: 100 }, { textLimit: 16000 }, {}, { limit: 100, textLimit: 1 }, { limit: 16, textLimit: 16000 }]) {
    const page = await command('projects_worker_read', { threadId: historyWorker.threadId, ...options });
    const expectedTextLimit = options.textLimit ?? 4000;
    const expectedLimit = Math.min(options.limit ?? 30, Math.floor(262144 / expectedTextLimit));
    assert.equal(page.limit, expectedLimit);
    assert.equal(page.textLimit, expectedTextLimit);
    assert(page.items.length <= expectedLimit);
    assert(page.limit * page.textLimit <= 262144);
    assert.equal(page.nextOffset, page.items.length < page.total ? page.items.length : null);
    for (const item of page.items) if (item.text !== undefined) assert(Array.from(item.text).length <= page.textLimit);
    const http = await rpc({ action: 'thread-history', id: project.id, threadId: historyWorker.threadId, ...options });
    assert.deepEqual(http.items, page.items);
    assert.equal(http.limit, page.limit);
    assert.equal(http.nextOffset, page.nextOffset);
    historyPages.push({ options, limit: page.limit, textLimit: page.textLimit, total: page.total, count: page.items.length, nextOffset: page.nextOffset });
  }
  const whole = await rpc({ action: 'thread-history', id: project.id, threadId: historyWorker.threadId, limit: 100, textLimit: 1 });
  const collected = [];
  for (let offset = 0; offset !== null;) {
    const page = await command('projects_worker_read', { threadId: historyWorker.threadId, offset, limit: 100, textLimit: 16000 });
    assert.equal(page.offset, offset);
    collected.push(...page.items);
    offset = page.nextOffset;
  }
  assert.deepEqual(collected.map(m => [m.id, m.kind ?? m.role]), whole.items.map(m => [m.id, m.kind ?? m.role]));
  const finalOffset = whole.total - 1;
  const textParts = [];
  for (let textOffset = 0; textOffset !== null;) {
    const page = await command('projects_worker_read', { threadId: historyWorker.threadId, offset: finalOffset, limit: 100, textLimit: 16000, textOffset });
    assert.equal(page.nextOffset, null);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].textOffset, textOffset);
    textParts.push(page.items[0].text);
    textOffset = page.items[0].nextTextOffset;
  }
  assert.equal(textParts.join(''), historyAnswer);
  const empty = await command('projects_worker_read', { threadId: historyWorker.threadId, offset: whole.total + 10, limit: 100, textLimit: 16000 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextOffset, null);
  await assert.rejects(rpc({ action: 'thread-history', id: project.id, threadId: historyWorker.threadId, limit: 101 }), /invalid|maximum/i);
  await assert.rejects(rpc({ action: 'thread-history', id: project.id, threadId: historyWorker.threadId, textLimit: 0 }), /invalid|minimum/i);
  result.historyPaging = { pages: historyPages, messageCount: collected.length, reconstructedCharacters: Array.from(textParts.join('')).length };
  result.checks.push('P1 exact oversized read requests and default combinations succeed through coordinator tools and HTTP');
  result.checks.push('P2 effective limits stay bounded; message/text continuation loses no items or Unicode; invalid inputs rejected');
  heldWorkers = true;
  const blocker = await command('projects_delegate', { task: 'HOLD BLOCKER' });
  await eventually(async () => (await plan()).work.find(w => w.id === blocker.workId)?.status === 'running', 'Blocker did not run');
  const work = [0, 1].map(n => ({ id: randomUUID(), threadId: randomUUID(), role: 'reviewer', text: `DEPENDENCY ${n}`, ...(n === 1 ? { dependsOn: [] } : {}) }));
  work[1].dependsOn = [work[0].id];
  const low = { id: '00000000-0000-0000-0000-000000000001', threadId: randomUUID(), role: 'worker', text: 'PRIORITY LOW' };
  const high = { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', threadId: randomUUID(), role: 'worker', text: 'PRIORITY HIGH' };
  work.push(low, high);
  await command('projects_worker_plan', { work });
  await control('priority', { workId: work[1].id, priority: 20 });
  await control('priority', { workId: high.id, priority: 100 });
  await control('parallelism', { cap: 2 });
  await eventually(async () => work.every(item => result.calls.some(c => !c.coordinator && c.text === item.text)), 'Dependency work did not dispatch');
  assert(result.calls.findIndex(c => !c.coordinator && c.text === high.text) < result.calls.findIndex(c => !c.coordinator && c.text === low.text));
  const p = await plan();
  assert(p.work.find(w => w.id === work[0].id).endedAt <= p.work.find(w => w.id === work[1].id).startedAt);
  assert.equal(p.work.find(w => w.id === blocker.workId).status, 'running');
  await control('parallelism', { cap: 1 });
  assert.equal((await plan()).work.find(w => w.id === blocker.workId).status, 'running');
  await control('stop', { threadId: blocker.threadId });
  result.checks.push('T7 batch dependencies, priority and live cap changes; lowering cap does not abort work');
  const unknown = await command('projects_worker_read', { threadId: randomUUID() }, true);
  assert(JSON.stringify(unknown).includes('Unknown durable thread'));
  const conflict = await control('follow_up', { threadId: a.threadId, text: 'DIFFERENT', requestId: followId }, true);
  assert(JSON.stringify(conflict).includes('Conflicting duplicate'));
  const retryConflict = await control('retry', { workId: e.workId, requestId: retryId }, true);
  assert(JSON.stringify(retryConflict).includes('Conflicting duplicate'));
  const cycle = [{ id: randomUUID(), threadId: randomUUID(), role: 'worker', text: 'cycle' }]; cycle[0].dependsOn = [cycle[0].id];
  const invalid = await command('projects_worker_plan', { work: cycle }, true);
  assert(JSON.stringify(invalid).includes('depend'));
  await rpc({ action: 'pause', id: project.id });
  const before = result.calls.length; await delay(500); assert.equal(result.calls.length, before);
  result.checks.push('T8 unknown thread, conflicting request IDs and cyclic plan rejected; project pause blocks dispatch');
  result.plan = await plan(); result.status = 'passed'; save();
  console.log(JSON.stringify({ status: result.status, checks: result.checks, artifact: artifacts }, null, 2));
} catch (error) { result.status = 'failed'; result.errors.push(String(error.stack ?? error)); save(); throw error; }
finally {
  for (const res of held) res.destroy();
  try { if (host?.exitCode === null && host?.signalCode === null) { await rpc({ action: 'shutdown' }); await hostExit; } } catch { host?.kill('SIGKILL'); }
  model.closeAllConnections(); model.close(); log.end(); save();
}
