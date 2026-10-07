// Failure cases recorded in coordinator-knowledge-write-failures.md before implementation.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `coordinator-knowledge-write-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `coordinator-knowledge-write-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agent = join(root, 'agent');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error('Clear runtime overrides first');
for (const dir of [artifacts, root, home, workspace, agent]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], tools: [], errors: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const mutation = ['projects_knowledge_write', 'projects_note'];
let commands = [], host, hostExit;
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const model = createServer((req, res) => {
  req.setEncoding('utf8');
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body), msgs = input.messages;
    const system = msgs.filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    const coordinator = /persistent coordinator/.test(system) || msgs.some(m => /persistent coordinator/.test(m.content ?? ''));
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    const text = msgs[lastUser]?.content ?? '';
    const turnTools = msgs.slice(lastUser + 1).filter(m => m.role === 'tool');
    const available = (input.tools ?? []).map(t => t.function.name);
    result.calls.push({ coordinator, text: String(text).slice(0, 200), available, ...(coordinator ? { system } : {}) });
    for (const reply of coordinator && String(text).startsWith('CONTROL ') ? turnTools : []) if (!result.tools.some(t => t.callId === reply.tool_call_id)) result.tools.push({ callId: reply.tool_call_id, content: reply.content });
    let tool;
    if (coordinator && String(text).startsWith('CONTROL ')) tool = commands[turnTools.length];
    const write = !coordinator && String(text).match(/^WRITE (\S+)/);
    if (write && turnTools.length === 0) tool = { name: 'projects_knowledge_write', arguments: { path: write[1], text: `worker ${write[1]}`, expectedRevision: null } };
    if (tool && !available.includes(tool.name)) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(chunk({ role: 'assistant', content: `UNAVAILABLE ${tool.name}` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(tool
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
      : chunk({ role: 'assistant', content: coordinator ? 'CONTROL acknowledged' : `Worker answer ${turnTools.map(t => t.content).join(' ')}` }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
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
async function command(project, name, args = {}, expectError = false) {
  commands = [{ name, arguments: args }];
  const before = result.tools.length;
  const job = await rpc({ action: 'message', id: project.id, text: `CONTROL ${randomUUID()}` });
  await eventually(async () => { const view = await rpc({ action: 'show', id: project.id }); const state = view.jobs.find(j => j.id === job.id)?.state; if (state === 'failed') throw Error('Coordinator command failed'); return state === 'done'; }, `Coordinator did not finish ${name}`);
  const found = result.tools.slice(before).at(-1);
  assert(found, `Coordinator did not call ${name}`);
  let output;
  try { output = JSON.parse(found.content); } catch { output = { error: found.content }; }
  if (!expectError) assert(!output.error && !found.content.includes('Error:') && !/requires an explicit maintain grant/i.test(found.content), `${name}: ${found.content}`);
  return output;
}
async function create(name, knowledgeAccess) {
  const project = await rpc({ action: 'create', requestId: randomUUID(), name, cwd: workspace, objective: 'Disposable', model: 'fake/fake-model', ...(knowledgeAccess ? { knowledgeAccess } : {}) });
  const settings = await rpc({ action: 'settings-snapshot', id: project.id });
  await rpc({ action: 'settings-update', id: project.id, confirm: project.id, expectedRevision: settings.revision, changes: { models: { worker: 'fake/fake-model', scout: 'fake/fake-model', reviewer: 'fake/fake-model' } } });
  return project;
}
const knowledgeFile = (project, path) => join(home, project.id, 'knowledge', path);
const lastCoordinator = () => result.calls.findLast(c => c.coordinator);
async function delegateWrite(project, path) {
  const work = await command(project, 'projects_delegate', { task: `WRITE ${path}` });
  await eventually(async () => ['completed', 'failed'].includes((await rpc({ action: 'plan-snapshot', id: project.id })).work.find(w => w.id === work.workId)?.status), 'Worker did not settle');
  return result.calls.findLast(c => !c.coordinator && c.text.startsWith(`WRITE ${path}`));
}
try {
  await start();
  const ro = await create('Coordinator knowledge read-only fixture');
  await command(ro, 'projects_knowledge_list');
  const offered = lastCoordinator();
  assert(mutation.every(name => offered.available.includes(name)), `coordinator tools: ${offered.available}`);
  assert(/projects_knowledge_write/.test(offered.system), 'coordinator instructions do not mention knowledge writes');
  result.checks.push('K1 unset (read-only) project offers coordinator write/note and instructs it to maintain knowledge');

  const written = await command(ro, 'projects_knowledge_write', { path: 'research/product-overview.md', text: 'COORDINATOR_WRITE', expectedRevision: null });
  assert.equal(readFileSync(knowledgeFile(ro, 'research/product-overview.md'), 'utf8'), 'COORDINATOR_WRITE');
  const stale = await command(ro, 'projects_knowledge_write', { path: 'research/product-overview.md', text: 'STALE', expectedRevision: '0'.repeat(64) }, true);
  assert(/revision conflict/i.test(JSON.stringify(stale)), JSON.stringify(stale));
  assert.equal(readFileSync(knowledgeFile(ro, 'research/product-overview.md'), 'utf8'), 'COORDINATOR_WRITE');
  await command(ro, 'projects_knowledge_write', { path: 'research/product-overview.md', text: 'COORDINATOR_UPDATE', expectedRevision: written.revision });
  assert.equal(readFileSync(knowledgeFile(ro, 'research/product-overview.md'), 'utf8'), 'COORDINATOR_UPDATE');
  await command(ro, 'projects_note', { text: 'COORDINATOR_NOTE' });
  const notes = await command(ro, 'projects_notes');
  assert(JSON.stringify(notes).includes('COORDINATOR_NOTE'));
  result.checks.push('K2 coordinator write/note not blocked; revision CAS rejects stale write; file lands in project knowledge tree');

  const roWorker = await delegateWrite(ro, 'research/worker.md');
  assert(roWorker && mutation.every(name => !roWorker.available.includes(name)), `read-only worker tools: ${roWorker?.available}`);
  assert(!existsSync(knowledgeFile(ro, 'research/worker.md')));
  result.checks.push('K3 read-only worker still lacks write/note and cannot write');

  const maintain = await create('Coordinator knowledge maintain fixture', 'maintain');
  const mWorker = await delegateWrite(maintain, 'research/worker.md');
  assert(mutation.every(name => mWorker.available.includes(name)), `maintain worker tools: ${mWorker.available}`);
  assert.equal(readFileSync(knowledgeFile(maintain, 'research/worker.md'), 'utf8'), 'worker research/worker.md');
  result.checks.push('K4 maintain project workers keep write/note');

  const settings = await rpc({ action: 'settings-snapshot', id: maintain.id });
  await rpc({ action: 'settings-update', id: maintain.id, confirm: maintain.id, expectedRevision: settings.revision, changes: { knowledgeAccess: 'read-only' } });
  await command(maintain, 'projects_knowledge_write', { path: 'research/after-downgrade.md', text: 'AFTER', expectedRevision: null });
  assert(mutation.every(name => lastCoordinator().available.includes(name)));
  const downgraded = await delegateWrite(maintain, 'research/downgraded.md');
  assert(mutation.every(name => !downgraded.available.includes(name)), `downgraded worker tools: ${downgraded.available}`);
  assert(!existsSync(knowledgeFile(maintain, 'research/downgraded.md')));
  result.checks.push('K5 maintain → read-only keeps coordinator write, removes worker write for new threads');

  await rpc({ action: 'shutdown' }); await hostExit;
  // Simulate a pre-change coordinator only in the stopped, disposable fixture.
  const db = new DatabaseSync(join(home, ro.id, 'durable.sqlite'));
  try {
    const row = db.prepare("SELECT r.document_id, r.seq, r.content FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.kind=? AND d.owner_id=1 ORDER BY r.seq DESC LIMIT 1").get(JSON.stringify('pi.agent'));
    const stored = JSON.parse(row.content);
    stored.tools = stored.tools.filter(name => !mutation.includes(name));
    stored.instructions = 'You are the persistent coordinator. You may inspect maintained project knowledge.';
    db.prepare('UPDATE document_revisions SET content=? WHERE document_id=? AND seq=?').run(JSON.stringify(stored), row.document_id, row.seq);
  } finally { db.close(); }
  await start();
  await command(ro, 'projects_knowledge_write', { path: 'research/retained.md', text: 'RETAINED', expectedRevision: null });
  assert(mutation.every(name => lastCoordinator().available.includes(name)));
  assert.equal(readFileSync(knowledgeFile(ro, 'research/retained.md'), 'utf8'), 'RETAINED');
  result.checks.push('K6 retained pre-change coordinator gains write/note on reopen');
  result.status = 'passed'; save();
  console.log(JSON.stringify({ status: result.status, checks: result.checks, artifact: artifacts }, null, 2));
} catch (error) { result.status = 'failed'; result.errors.push(String(error.stack ?? error)); save(); throw error; }
finally {
  try { if (host?.exitCode === null && host?.signalCode === null) { await rpc({ action: 'shutdown' }); await hostExit; } } catch { host?.kill('SIGKILL'); }
  model.closeAllConnections(); model.close(); log.end(); save();
}
