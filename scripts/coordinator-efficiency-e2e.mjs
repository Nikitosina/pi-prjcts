// Isolated host E2E with a local fake model. Failure cases: coordinator-efficiency-failures.md.
// Run: env -u PI_PACKAGE_DIR node scripts/coordinator-efficiency-e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp';
const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = join(repo, 'artifacts', `coordinator-efficiency-${stamp}`), root = join(realpathSync(tmpdir()), `coordinator-efficiency-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace'), agentDir = join(root, 'agent');
const result = { scope: 'Run-to-done briefs and capped worker/child reports with a full-result tool', root, home, checks: [], errors: [], httpErrors: [], modelCalls: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const redact = text => String(text).replace(/token=[^&#\s"]+/gi, 'token=[redacted]');
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error('Unsafe runtime override; refused without clearing');
mkdirSync(artifacts, { recursive: true, mode: 0o700 }); mkdirSync(root, { recursive: true, mode: 0o700 }); for (const dir of [home, workspace, agentDir]) mkdirSync(dir, { mode: 0o700 });


const big = Array.from({ length: 1200 }, (_, i) => `L${String(i).padStart(4, '0')} ${'abcdefghij'.repeat(1)}\n`).join('').slice(0, 20000);
const expectedFull = big.slice(0, 16000);
const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name, args, id) => chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const say = text => chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
result.systems = {}; result.reports = {}; result.toolResults = {}; result.firstUsers = {};
const model = createServer((req, res) => {
  let body = ''; req.on('data', part => { body += part; });
  req.on('end', () => {
    const input = JSON.parse(body), msgs = input.messages;
    const coordinator = msgs.some(m => /persistent coordinator/.test(m.content ?? ''));
    const system = msgs.find(m => m.role === 'system')?.content ?? '';
    const users = msgs.filter(m => m.role === 'user'), lastUser = users.at(-1)?.content ?? '', last = msgs.at(-1);
    const firstUser = users[0]?.content ?? '';
    const tools = (input.tools ?? []).map(t => t.function?.name);
    result.modelCalls.push({ coordinator, session: req.headers.session_id ?? null });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const toolsSince = msgs.slice(msgs.findLastIndex(m => m.role === 'user') + 1).filter(m => m.role === 'tool');
    if (coordinator) {
      result.systems.coordinator ??= system; result.coordinatorTools ??= tools;
      if (last.role === 'user' && /\[Durable work/.test(lastUser)) result.reports[/BIGTASK|SHORTTASK/.exec(lastUser)?.[0] ?? 'other'] = lastUser;
      if (last.role === 'user' && /MARK-BIG/.test(lastUser) && !/\[Durable work/.test(lastUser)) return res.end(call('projects_delegate', { role: 'scout', task: 'ROLE scout BIGTASK summarize everything', acceptance: ['A1 list every file', 'A2 cite evidence'] }, 'c-big'));
      if (last.role === 'user' && /MARK-SHORT/.test(lastUser) && !/\[Durable work/.test(lastUser)) return res.end(call('projects_delegate', { role: 'scout', task: 'ROLE scout SHORTTASK say hi' }, 'c-short'));
      if (/\[Durable work[^\]]*\][^]*BIGTASK/.test(lastUser) && !/MARK-PARENT/.test(lastUser)) {
        const workId = /projects_work_result \{"workId":"([^"]+)"/.exec(lastUser)?.[1];
        if (toolsSince.length === 0) return res.end(call('projects_work_result', { workId, limit: 16000 }, 'r1'));
        if (toolsSince.length === 1) { result.toolResults.full = toolsSince[0].content; return res.end(call('projects_work_result', { workId, offset: 15000, limit: 8000 }, 'r2')); }
        if (toolsSince.length === 2) { result.toolResults.tail = toolsSince[1].content; return res.end(call('projects_work_result', { workId, offset: 0, limit: 5000 }, 'r3')); }
        if (toolsSince.length === 3) { result.toolResults.page1 = toolsSince[2].content; return res.end(call('projects_work_result', { workId: randomUUID() }, 'r4')); }
        result.toolResults.unknown = toolsSince[3].content;
      }
      return res.end(say('SUMMARY ok'));
    }
    if (/MARK-PARENT/.test(firstUser)) {
      result.systems.parent ??= system; result.parentTools ??= tools;
      if (last.role === 'user' && /\[Child work/.test(lastUser)) { result.reports.child = lastUser; return res.end(call('projects_child_result', { workId: /projects_child_result \{"workId":"([^"]+)"/.exec(lastUser)?.[1], limit: 16000 }, 'p2')); }
      if (last.role === 'tool' && /\[Child work/.test(lastUser)) { result.toolResults.child = last.content; return res.end(say('PARENT done')); }
      if (last.role === 'user') return res.end(call('projects_delegate_child', { role: 'scout', task: 'CHILDBIG read it all' }, 'p1'));
      return res.end(say('waiting for the child'));
    }
    result.firstUsers[/BIGTASK|SHORTTASK|CHILDBIG/.exec(firstUser)?.[0] ?? 'other'] ??= firstUser; result.systems.scout ??= system;
    if (/BIGTASK|CHILDBIG/.test(firstUser)) return res.end(say(big));
    if (/SHORTTASK/.test(firstUser)) return res.end(say('short result ok'));
    return res.end(say('ok'));
  });
});
await new Promise(ok => model.listen(0, '127.0.0.1', ok));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fake-key', api: 'openai-completions', compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openai' }, models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));

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
const held = new Set();
const check = (name, ok, detail) => { result.checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) { result.errors.push({ name, detail }); } };
const waitFor = async (fn, what, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await delay(100); } throw Error(`Timed out: ${what}`); };
try {
  git('init', '-b', 'main'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'E2E');
  writeFileSync(join(workspace, 'README.md'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  let health;
  for (let i=0;i<150;i++) { try { health=await rpc(); break; } catch { await delay(200); } }
  if (health?.pid !== host.pid) throw Error('Owned host not ready');
  const project = await rpc({ action:'create', requestId:randomUUID(), name:'Efficiency', cwd:workspace, objective:'Disposable', model:'fake/fake-model' });
  result.projectId=project.id;
  const settings=await rpc({ action:'settings-snapshot',id:project.id });
  await rpc({ action:'settings-update', id:project.id, confirm:project.id, expectedRevision:settings.revision, changes:{ models:{worker:'fake/fake-model',scout:'fake/fake-model',reviewer:'fake/fake-model'}, workerCap:2 } });
  const setup=await rpc({action:'owner-setup-snapshot',id:project.id});
  await rpc({action:'workspace-quick-grant',id:project.id,confirm:project.id,expectedRevision:setup.workspaceRevision});
  result.scopeId=(await rpc({action:'workspace-catalog',id:project.id})).find(s=>s.wholeRepository).id;
  const summaries = async () => (await rpc({action:'show',id:project.id})).messages.filter(m=>m.role==='assistant'&&m.text.includes('SUMMARY')).length;

  await rpc({action:'message',id:project.id,text:'MARK-SHORT delegate a short scout'});
  await waitFor(async () => result.reports.SHORTTASK && await summaries() >= 1, 'short report summarized');
  await rpc({action:'message',id:project.id,text:'MARK-BIG delegate a big scout'});
  await waitFor(async () => result.toolResults.unknown && await summaries() >= 2, 'big report + tool reads');
  const R = result.reports, T = result.toolResults;
  check('E1 short report is unchanged: result text present, no cap note, no pointer', R.SHORTTASK.includes('short result ok') && !/chars omitted|projects_work_result/.test(R.SHORTTASK), R.SHORTTASK);
  check('E2 long (16000 stored of 20000) report injected capped to 3000 chars + "13000 chars omitted" + pointer naming workId', R.BIGTASK.includes(expectedFull.slice(0, 3000)) && !R.BIGTASK.includes(expectedFull.slice(0, 3100)) && /… 13000 chars omitted; read the full result with projects_work_result \{"workId":"[0-9a-f-]{36}"\}/.test(R.BIGTASK) && R.BIGTASK.length < 5000, R.BIGTASK.length);
  const parse = text => JSON.parse(text);
  check('E3 projects_work_result returns the exact stored result (16000 chars) in one page, nextOffset null', parse(T.full).text === expectedFull && parse(T.full).total === 16000 && parse(T.full).nextOffset === null, T.full?.slice(0, 200));
  check('E4 last page: offset 15000 returns exactly the 1000-char tail, nextOffset null', parse(T.tail).text === expectedFull.slice(15000) && parse(T.tail).nextOffset === null, T.tail?.slice(0, 200));
  check('E5 paging: limit 5000 gives nextOffset 5000 and the exact first page', parse(T.page1).text === expectedFull.slice(0, 5000) && parse(T.page1).nextOffset === 5000, T.page1?.slice(0, 200));
  check('E6 unknown workId is an error, not data', /Unknown work id/.test(T.unknown ?? ''), T.unknown);
  check('E7 the delegate brief carries appended acceptance criteria', /Acceptance criteria[^]*- A1 list every file\n- A2 cite evidence/.test(result.firstUsers.BIGTASK ?? '') && !/Acceptance criteria/.test(result.firstUsers.SHORTTASK ?? ''), result.firstUsers.BIGTASK);
  const sys = result.systems.coordinator ?? '';
  check('E8 coordinator instructions: brief with Goal/Acceptance criteria/Constraints/Stop conditions, no micro-milestones, follow-ups only for corrections/new info/failed acceptance, capped reports + tool', /Goal, Acceptance criteria[^]*Constraints and Stop conditions/.test(sys) && /Do not split one task into micro-milestones/.test(sys) && /follow-up only for an owner correction, new information or failed acceptance/.test(sys) && /capped at about 3000 characters/.test(sys) && /Do not micro-delegate/.test(sys), sys.slice(0, 300));
  check('E9 coordinator has projects_work_result; schema has acceptance', result.coordinatorTools?.includes('projects_work_result'), result.coordinatorTools);
  check('E10 worker/scout instructions: run to done, no hand-back after a sub-step, one-message blocker report', /Run to done: keep working until the acceptance criteria/.test(result.systems.scout ?? '') && /report in one message the blocker, what you tried and what is needed/.test(result.systems.scout ?? ''), (result.systems.scout ?? '').slice(0, 300));

  const parentThread = randomUUID();
  await rpc({action:'work-submit',id:project.id,threadId:parentThread,requestId:randomUUID(),workspaceScopeId:result.scopeId,text:'MARK-PARENT delegate a big child'});
  await waitFor(() => result.toolResults.child, 'parent read child result');
  const C = result.reports.child, parentChildId = /projects_child_result \{"workId":"([^"]+)"/.exec(C)?.[1];
  check('E11 child report to the parent is capped with a pointer to projects_child_result', C.includes(expectedFull.slice(0, 3000)) && !C.includes(expectedFull.slice(0, 3100)) && /13000 chars omitted/.test(C) && !!parentChildId, C.length);
  check('E12 parent reads the exact full child result; parent has the tool, coordinator-only tool is not given to it', parse(result.toolResults.child).text === expectedFull && result.parentTools.includes('projects_child_result') && !result.parentTools.includes('projects_work_result'), result.toolResults.child?.slice(0, 200));
  check('E13 worker instructions (scoped parent) contain run-to-done', /Run to done/.test(result.systems.parent ?? ''), (result.systems.parent ?? '').slice(0, 200));
  const plan = await rpc({action:'plan-snapshot',id:project.id});
  check('E14 stored work text/state untouched by cap (plan snapshot lists completed scout)', plan.work.filter(w => w.role === 'scout' && w.status === 'completed').length >= 3, plan.work.map(w => [w.role, w.status]));
  check('E15 coordinator never saw the parent-only tool; no model request without a session id', !result.coordinatorTools.includes('projects_child_result') && result.modelCalls.every(c => c.session), result.coordinatorTools);
  result.status = result.errors.length ? 'failed' : 'passed';
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
