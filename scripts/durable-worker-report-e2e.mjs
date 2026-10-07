// Isolated host E2E with a local fake model. Failure cases: durable-worker-report-failures.md.
// Run: env -u PI_PACKAGE_DIR node scripts/durable-worker-report-e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp';
const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = join(repo, 'artifacts', `durable-worker-report-${stamp}`), root = join(realpathSync(tmpdir()), `durable-worker-report-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
const result = { scope: 'Coordinator-selected roles and worker completion reports', root, home, checks: [], errors: [], httpErrors: [], modelCalls: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error('Unsafe runtime override; refused without clearing');
mkdirSync(artifacts, { recursive: true, mode: 0o700 }); mkdirSync(root, { recursive: true, mode: 0o700 }); for (const dir of [home, workspace, agentDir]) mkdirSync(dir, { mode: 0o700 });

let hold = true, holdReports = false;
const held = new Set();
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const model = createServer((req, res) => {
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body);
    const coordinator = input.messages.some(m => /persistent coordinator/.test(m.content ?? ''));
    const marker = /MARK-[A-Z]+/.exec(body)?.[0] ?? 'none';
    const lastInput = input.messages.filter(m => m.role === 'user').at(-1)?.content ?? '';
    result.modelCalls.push({ at: Date.now(), marker, coordinator, reporting: coordinator && lastInput.includes('[Durable work') });
    if (holdReports && coordinator && lastInput.includes('[Durable work')) { held.add(res); res.on('close', () => held.delete(res)); return; }
    if (marker === 'MARK-FAIL' && !coordinator) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture worker failure', type: 'invalid_request_error' } })); return; }
    if (hold && marker === 'MARK-HOLD') { held.add(res); res.on('close', () => held.delete(res)); return; }
    const lastUser=input.messages.filter(m=>m.role==='user').at(-1)?.content??'';
    const stage=input.messages.filter(m=>m.role==='tool').length;
    let tool;
    const reporting=coordinator&&lastUser.includes('[Durable work');
    if(coordinator&&marker==='MARK-ROLES'&&!reporting){
      if(stage===0) tool={name:'projects_delegate',arguments:{role:'scout',task:'ROLE scout read the repo'}};
      if(stage===1) tool={name:'projects_delegate',arguments:{role:'reviewer',task:'ROLE reviewer inspect the repo'}};
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(tool
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + stage, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n'
      : chunk({ role: 'assistant', content: reporting ? 'SUMMARY received worker result' : '**Done** with `chat`.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake-key', api: 'openai-completions', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));

const socket = join(tmpdir(), `pi-projects-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
result.socket = socket;
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
const log = createWriteStream(join(artifacts, 'host.log'), { flags: 'wx', mode: 0o600 });
let host, hostExit, hostEnded = false;
function startHost() {
  hostEnded = false;
  host = spawn(process.execPath, [join(repo, 'src/host.ts')], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false }); host.stderr.pipe(log, { end: false });
  hostExit = new Promise(resolve => host.once('exit', (code, signal) => { hostEnded = true; result.hostExit = { code, signal }; save(); resolve(); }));
}
startHost();
function rpc(input) {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath: socket, method: input ? 'POST' : 'GET', path: input ? '/api' : '/health', headers: input ? { 'content-type': 'application/json' } : {}, timeout: 90000 }, response => {
      let text = ''; response.on('data', part => { text += part; });
      response.on('end', () => { try { const reply = JSON.parse(text); if (!reply.ok) throw new Error(reply.error); resolve(reply.data); } catch (e) { reject(e); } });
    });
    call.on('error', reject); call.end(input ? JSON.stringify(input) : undefined);
  });
}

const git = (...args) => execFileSync('/usr/bin/git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
try {
  git('init', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E');
  writeFileSync(join(workspace, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  let health;
  for (let i=0;i<150;i++) { try { health=await rpc(); break; } catch { await delay(200); } }
  if (health?.pid !== host.pid) throw Error('Owned host not ready');
  const project = await rpc({ action:'create', requestId:randomUUID(), name:'Worker reports', cwd:workspace, objective:'Disposable', model:'fake/fake-model' });
  result.projectId=project.id;
  const settings=await rpc({ action:'settings-snapshot',id:project.id });
  await rpc({ action:'settings-update', id:project.id, confirm:project.id, expectedRevision:settings.revision, changes:{ models:{worker:'fake/fake-model',scout:'fake/fake-model',reviewer:'fake/fake-model'}, workerCap:2 } });
  const setup=await rpc({action:'owner-setup-snapshot',id:project.id});
  await rpc({action:'workspace-quick-grant',id:project.id,confirm:project.id,expectedRevision:setup.workspaceRevision});
  result.scopeId=(await rpc({action:'workspace-catalog',id:project.id})).find(s=>s.wholeRepository).id;
  await rpc({action:'work-submit',id:project.id,threadId:randomUUID(),requestId:randomUUID(),workspaceScopeId:result.scopeId,text:'MARK-HOLD companion'});
  await rpc({action:'message',id:project.id,text:'MARK-ROLES delegate scout and reviewer'});
  for(let i=0;i<200;i++){
    const p=await rpc({action:'plan-snapshot',id:project.id});
    const v=await rpc({action:'show',id:project.id});
    if(p.work.filter(w=>['scout','reviewer'].includes(w.role)&&w.status==='completed').length===2 && v.messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length>=2) { result.plan=p;result.messages=v.messages;break; }
    await delay(100);
  }
  if(!result.plan) throw Error('Selected roles failed or coordinator did not receive reports while companion held');
  result.checks.push('R1 coordinator chooses read-only (unscoped) scout and reviewer');
  result.checks.push('R2 completed results wake coordinator without waiting for held sibling');
  const thread=result.plan.work.find(w=>w.role==='scout').threadId;
  await rpc({action:'thread-send',id:project.id,threadId:thread,requestId:randomUUID(),text:'Follow-up result'});
  for(let i=0;i<150;i++){ const v=await rpc({action:'show',id:project.id}); if(v.messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length===3){result.messages=v.messages;break;} await delay(100); }
  if(result.messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length!==3) throw Error('Follow-up report missing or duplicated');
  result.checks.push('R3 follow-up has independent report identity');
  holdReports = true;
  await rpc({action:'thread-send',id:project.id,threadId:thread,requestId:randomUUID(),text:'Result interrupted during coordinator summary'});
  for(let i=0;i<150;i++){ if(result.modelCalls.filter(c=>c.reporting).length>=4) break; await delay(100); }
  if(result.modelCalls.filter(c=>c.reporting).length<4) throw Error('Summary hold not reached');
  await rpc({action:'pause',id:project.id});
  const count=result.modelCalls.length; await delay(1000);
  if(result.modelCalls.length!==count) throw Error('Model dispatched while paused');
  result.checks.push('R4 pause blocks report dispatch');
  await rpc({action:'shutdown'}); await hostExit;
  startHost();
  for(let i=0;i<150;i++){ try{ const h=await rpc(); if(h.pid===host.pid) break; }catch{} await delay(100); }
  await rpc({action:'show',id:project.id}); await delay(500);
  if(result.modelCalls.length!==count) throw Error('Paused restart dispatched a report');
  result.checks.push('R5 paused host restart keeps reports deferred');
  holdReports=false; hold=false;
  await rpc({action:'resume',id:project.id,confirm:project.id,recovery:'leave-interrupted'});
  for(let i=0;i<150;i++){ const v=await rpc({action:'show',id:project.id}); if(v.messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length>=5){result.messages=v.messages;break;} await delay(100); }
  if(result.messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length!==5) throw Error('Resume lost or duplicated deferred/companion summaries');
  result.checks.push('R6 resume delivers deferred report and resumed companion once');
  const before=result.modelCalls.length;
  await rpc({action:'shutdown'}); await hostExit;
  startHost();
  for(let i=0;i<150;i++){ try{ const h=await rpc(); if(h.pid===host.pid) break; }catch{} await delay(100); }
  await rpc({action:'show',id:project.id}); await delay(1000);
  if(result.modelCalls.length!==before) throw Error('Restart replayed completed report');
  result.checks.push('R7 settled reports do not replay on restart');
  const failedThread=randomUUID();
  await rpc({action:'work-submit',id:project.id,threadId:failedThread,requestId:randomUUID(),workspaceScopeId:result.scopeId,text:'MARK-FAIL fail the worker'});
  for(let i=0;i<150;i++){ const p=await rpc({action:'plan-snapshot',id:project.id}); const v=await rpc({action:'show',id:project.id}); if(p.work.some(w=>w.threadId===failedThread&&w.status==='failed') && v.messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length===6){result.messages=v.messages;result.plan=p;break;} await delay(100); }
  if(!result.plan.work.some(w=>w.threadId===failedThread&&w.status==='failed') || result.messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length!==6) throw Error('Worker failure report missing');
  result.checks.push('R8 failed workers wake coordinator with failure');
  result.status='passed';
} catch (error) {
  result.status = 'failed'; result.failure = redact(error?.stack ?? error);
  try { result.diagnostic = { plan: await rpc({action:'plan-snapshot',id:result.projectId}), view: await rpc({action:'show',id:result.projectId}) }; } catch {}
} finally {
  save();
}
if (!hostEnded) { try { await rpc({ action: 'shutdown' }); } catch (e) { result.shutdownError = String(e); } await Promise.race([hostExit, delay(10000)]); }
if (!hostEnded) host.kill('SIGTERM');
for (const res of held) res.destroy();
model.close();
save(); log.end();
console.log(JSON.stringify({ status: result.status, checks: result.checks, failure: result.failure, errors: result.errors, httpErrors: result.httpErrors, artifact: artifacts }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
