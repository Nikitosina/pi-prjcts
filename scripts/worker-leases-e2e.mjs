// E2E: host-wide resource leases, background commands and runbook instructions for workers.
// Fake model, git project, private HOME, no real arc/arcanum/CI. Failure cases: worker-leases-failures.md.
// Artifact: artifacts/worker-leases-<time>/report.json (+ summary.json with the key observed facts).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, delay } from './lib/e2e-kit.mjs';

// Coordinator: `MARK-J {args}` delegates, `MARK-W` reads projects_workers, `MARK-A {args}` archives.
// Worker: `T[tool|json]T` steps run in order of appearance; @@BG@@ in the json is the last background id seen in this turn's results.
const seenOnce = new Set();
const handler = ({ role, user, results, tools }) => {
  if (user.startsWith('[Durable work')) return say('Noted report.');
  if (role === 'coordinator') {
    if (results.length) return say('Noted.');
    const delegate = /MARK-J (\{[\s\S]+\})$/.exec(user)?.[1], archive = /MARK-A (\{[\s\S]+\})$/.exec(user)?.[1];
    if (delegate) return call('projects_delegate', JSON.parse(delegate));
    if (archive) return call('projects_worker_archive', JSON.parse(archive));
    if (user.includes('MARK-W')) return call('projects_workers', {});
    return undefined;
  }
  if (role !== 'worker') return undefined;
  const once = /ONCE-(\w+)/.exec(user)?.[1];
  if (once && !results.length) { if (seenOnce.has(once)) return say('resumed after restart'); seenOnce.add(once); }
  const step = [...user.matchAll(/T\[(\w+)\|(.*?)\]T/g)][results.length];
  if (!step) return undefined;
  const lastBg = results.join(' ').match(/bg-[a-f0-9]{8}/g)?.at(-1) ?? '';
  return call(step[1], JSON.parse(step[2].replaceAll('@@BG@@', lastBg)));
};
const kit = await createKit('worker-leases', { handler, env: { PI_PROJECTS_BG_LOG_MAX_BYTES: '200000', PI_PROJECTS_LEASE_SWEEP_MS: '300' } });
const { check, rpc, result } = kit;
kit.initRepo();
const summary = {};
const T = (name, args) => `T[${name}|${JSON.stringify(args)}]T`;
const acquire = (resource, ttlMinutes, waitSeconds) => T('projects_lease_acquire', { resource, ttlMinutes, ...(waitSeconds ? { waitSeconds } : {}) });
const release = resource => T('projects_lease_release', { resource });
const sleep = seconds => T('bash', { command: `sleep ${seconds}` });
const bgStart = (command, label = 'job') => T('projects_bg_start', { command, label });
const bgStatus = (id, tailLines) => T('projects_bg_status', { id, ...(tailLines === undefined ? {} : { tailLines }) });
const bgStop = id => T('projects_bg_stop', { id });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = (pid, what) => kit.eventually(() => !alive(pid), `${what} (pid ${pid}) is still alive`, 100);

await kit.run(async () => {
  const id = await kit.createProject('Leases', { workerCap: 8 });
  const work = async tag => (await kit.plan(id)).findLast(item => item.text.includes(tag));
  const run = tag => kit.lastCall('worker', tag);
  const out = (tag, index) => { const text = run(tag)?.results[index]; try { return JSON.parse(text); } catch { return text; } };
  // Starts a worker and returns once it exists; `done` waits for it to settle.
  const launch = async (tag, steps) => { await rpc({ action: 'message', id, text: `MARK-J ${JSON.stringify({ role: 'worker', task: `${tag} ${steps}` })}` }); return kit.eventually(() => work(tag), `${tag} was not admitted`); };
  const status = async (tag, wanted) => kit.eventually(async () => { const item = await work(tag); return item && wanted.includes(item.status) ? item : null; }, `${tag} never reached ${wanted}`, 300);
  const done = tag => status(tag, ['completed', 'failed', 'stopped']);
  const askCoordinator = async (marker, tag) => { await rpc({ action: 'message', id, text: `${tag} ${marker}` }); await kit.eventually(() => result.calls.findLast(c => c.role === 'coordinator' && c.user.includes(tag) && c.results.length), `coordinator never answered ${tag}`); return result.calls.findLast(c => c.role === 'coordinator' && c.user.includes(tag) && c.results.length).results.at(-1); };
  const artDir = threadId => execFileSync('/usr/bin/find', [kit.home, '-type', 'd', '-path', `*/artifacts/${threadId}`], { encoding: 'utf8' }).trim().split('\n')[0];
  const bgRecords = threadId => { const dir = join(artDir(threadId) || '/nonexistent', 'bg'); return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))) : []; };
  const holdsOf = async threadId => (await kit.plan(id)).find(item => item.threadId === threadId && item.status === 'running')?.holds;

  // ---- leases: contention, queue, release on settle ----
  const w1 = await launch('TAG-la1', `${acquire('sim', 5)} ${sleep(9)}`);
  const held = await kit.eventually(() => holdsOf(w1.threadId), 'plan snapshot never showed the lease held by w1');
  check('F8 plan snapshot (UI card source) lists the lease held by the running thread with an expiry', held.leases.length === 1 && held.leases[0].resource === 'sim' && Date.parse(held.leases[0].until) > Date.now() + 200000 && Date.parse(held.leases[0].until) < Date.now() + 301000, held);
  const workers = JSON.parse(await askCoordinator('MARK-W', 'LBL-w1'));
  const w1Thread = workers.threads.find(thread => thread.threadId === w1.threadId);
  check('F8 projects_workers shows the held lease on the thread', w1Thread?.holds?.leases[0]?.resource === 'sim', w1Thread);
  check('F9 the coordinator is not offered lease or background tools; the worker is', !kit.lastCall('coordinator', 'LBL-w1').tools.some(name => /^projects_(?:lease|bg)_/.test(name)) && ['projects_lease_acquire', 'projects_lease_release', 'projects_bg_start', 'projects_bg_status', 'projects_bg_stop'].every(name => run('TAG-la1').tools.includes(name)), run('TAG-la1').tools.filter(name => /lease|bg/.test(name)));

  const w2 = await launch('TAG-la2', `${acquire('sim', 1)} ${release('sim')}`);
  await done('TAG-la2');
  const denied = out('TAG-la2', 0);
  check('F1 a second worker is told who holds the resource and until when', denied.acquired === false && denied.heldBy.threadId === w1.threadId && denied.heldBy.projectId === id && Date.parse(denied.until) > Date.now(), denied);
  check('F5 releasing a lease held by another thread changes nothing', out('TAG-la2', 1).released === false && (await holdsOf(w1.threadId))?.leases[0]?.resource === 'sim', out('TAG-la2', 1));

  const w3 = await launch('TAG-la3', `${acquire('sim', 5, 60)} ${sleep(1)}`);
  await kit.eventually(async () => (await work('TAG-la3'))?.status === 'running', 'w3 did not start');
  await delay(1500);
  check('F1 a waiting acquire is queued: no answer while the holder runs', run('TAG-la3').results.length === 0 && (await work('TAG-la1')).status === 'running', run('TAG-la3').results);
  const w1End = await done('TAG-la1'), w3End = await done('TAG-la3');
  const granted = out('TAG-la3', 0);
  check('F1/F2 the queued worker is granted after the holder settles, without the holder releasing', w1End.status === 'completed' && w3End.status === 'completed' && granted.acquired === true && w3End.endedAt >= w1End.endedAt, { granted, w1End: w1End.endedAt, w3End: w3End.endedAt });
  await launch('TAG-la4', acquire('sim', 1, 10));
  await done('TAG-la4');
  await launch('TAG-la5', acquire('sim', 1, 10));
  await done('TAG-la5');
  check('F2 a lease left unreleased is freed when its work settles (next worker gets it)', out('TAG-la4', 0).acquired === true && out('TAG-la5', 0).acquired === true, [out('TAG-la4', 0), out('TAG-la5', 0)]);
  check('F8 settled threads show no holds', (await kit.plan(id)).every(item => !item.holds));

  // ---- TTL expiry grants the next waiter while the holder still runs; holder renewal ----
  const t1 = await launch('TAG-lb1', `${acquire('ttl-res', 0.03)} ${acquire('ttl-res', 0.03)} ${sleep(9)}`);
  const t2 = await launch('TAG-lb2', acquire('ttl-res', 1, 30));
  const t2End = await done('TAG-lb2');
  const t1Now = await work('TAG-lb1');
  check('F3 TTL expiry frees the resource and grants the waiter while the holder is still running', out('TAG-lb1', 0).acquired === true && out('TAG-lb1', 1).acquired === true && out('TAG-lb2', 0).acquired === true && t1Now.status === 'running', { a: out('TAG-lb1', 0), b: out('TAG-lb2', 0), t1: t1Now.status });
  await done('TAG-lb1');

  // ---- waiter stopped while queued must not receive the lease ----
  const c1 = await launch('TAG-lc1', `${acquire('q-res', 5)} ${sleep(6)} ${release('q-res')} ${sleep(9)}`);
  await kit.eventually(() => holdsOf(c1.threadId), 'c1 never held q-res');
  const c2 = await launch('TAG-lc2', acquire('q-res', 5, 120));
  await kit.eventually(async () => (await work('TAG-lc2'))?.status === 'running', 'c2 did not start');
  await delay(800);
  await rpc({ action: 'thread-stop', id, threadId: c2.threadId });
  check('F4 the queued worker was stopped', (await done('TAG-lc2')).status === 'stopped');
  await kit.eventually(() => run('TAG-lc1').results.length >= 3, 'c1 never released q-res');
  await launch('TAG-lc3', acquire('q-res', 1));
  await done('TAG-lc3');
  check('F4 after the holder releases, a stopped waiter did not take the lease: a new worker gets it at once', out('TAG-lc3', 0).acquired === true && out('TAG-lc1', 2).released === true, [out('TAG-lc3', 0), out('TAG-lc1', 2)]);
  await done('TAG-lc1');

  // ---- stop frees the lease ----
  const d1 = await launch('TAG-ld1', `${acquire('s-res', 5)} ${sleep(60)}`);
  await kit.eventually(() => holdsOf(d1.threadId), 'd1 never held s-res');
  await rpc({ action: 'thread-stop', id, threadId: d1.threadId });
  await launch('TAG-ld2', acquire('s-res', 1, 10));
  await done('TAG-ld2');
  check('F2 stopping the holder frees its lease for the next worker', out('TAG-ld2', 0).acquired === true, out('TAG-ld2', 0));

  // ---- schema abuse ----
  await launch('TAG-le1', `${acquire('../etc/passwd', 1)} ${acquire('x', 99999)} ${acquire('', 1)}`);
  await done('TAG-le1');
  check('F6 path-like resource, absurd TTL and empty name are rejected', [0, 1, 2].every(index => !/"acquired":true/.test(run('TAG-le1').results[index] ?? '') && /resource|ttlMinutes|pattern|maximum|minimum|invalid|must/i.test(run('TAG-le1').results[index] ?? '')), run('TAG-le1').results);

  // ---- background commands ----
  await launch('TAG-bg1', `${bgStart("printf 'line%s\\n' 1 2 3 4 5; sleep 1; echo FINISHED; exit 3", 'build')} ${sleep(3)} ${T('projects_bg_status', { id: '@@BG@@', tailLines: 2 })}`);
  await done('TAG-bg1');
  const started = out('TAG-bg1', 0), finished = out('TAG-bg1', 2);
  check('F17 start returns an id at once (running, no command echo); status reports exit code and the capped tail', /^bg-[a-f0-9]{8}$/.test(started.id) && started.state === 'running' && !('command' in started) && finished.state === 'exited' && finished.code === 3 && finished.tail === 'line5\nFINISHED' && finished.tailTruncated === true, { started, finished });
  const bg1Thread = (await work('TAG-bg1')).threadId;
  check('F12 output went to a log file under the thread artifacts', readFileSync(join(artDir(bg1Thread), 'bg', `${started.id}.log`), 'utf8').startsWith('line1\nline2') && finished.log === `artifact:${bg1Thread}/bg/${started.id}.log`, finished.log);

  // survives its worker's turn; foreign thread cannot touch it; stop kills the group.
  await launch('TAG-bg2', bgStart(`echo $$ > ${kit.root}/leader.pid; sleep 200 & echo $! > ${kit.root}/child.pid; wait`, 'server'));
  const bg2 = await done('TAG-bg2'), server = out('TAG-bg2', 0);
  await delay(400);
  const leader = Number(readFileSync(join(kit.root, 'leader.pid'), 'utf8')), child = Number(readFileSync(join(kit.root, 'child.pid'), 'utf8'));
  check('F15 the command keeps running after its worker turn settled', bg2.status === 'completed' && alive(leader) && alive(child), { leader, child });
  await launch('TAG-bg3', `${bgStatus(server.id)} ${bgStop(server.id)}`);
  await done('TAG-bg3');
  check('F13 another thread cannot read or stop the command', /Unknown background command/.test(run('TAG-bg3').results[0]) && /Unknown background command/.test(run('TAG-bg3').results[1]) && alive(leader), run('TAG-bg3').results);
  await rpc({ action: 'thread-send', id, threadId: bg2.threadId, text: `TAG-bg4 ${bgStatus(server.id)} ${bgStop(server.id)} ${bgStop(server.id)} ${bgStatus(server.id, 0)}`, requestId: crypto.randomUUID() });
  await delay(400); await kit.settle(id);
  check('F15 a later turn of the same thread polls the running command', JSON.parse(run('TAG-bg4').results[0]).state === 'running', run('TAG-bg4').results[0]);
  const stopped = JSON.parse(run('TAG-bg4').results[1]);
  await gone(leader, 'leader'); await gone(child, 'child');
  check('F14 stop kills the whole process group (leader and its child); a second stop is harmless; state is killed', stopped.state === 'killed' && JSON.parse(run('TAG-bg4').results[2]).state === 'killed' && JSON.parse(run('TAG-bg4').results[3]).state === 'killed', run('TAG-bg4').results);

  // policy
  await launch('TAG-bg5', `${bgStart('git push origin HEAD:main', 'push')} ${bgStart('echo ok', 'fine')}`);
  const bg5 = await done('TAG-bg5');
  check('F10 a policy-denied command is rejected, nothing spawned and no record written; an allowed one still starts', /Blocked by worker Git policy/.test(run('TAG-bg5').results[0]) && !/bg-[a-f0-9]{8}/.test(run('TAG-bg5').results[0]) && bgRecords(bg5.threadId).length === 1, { first: run('TAG-bg5').results[0], records: bgRecords(bg5.threadId).length });

  // cap + finished do not count + archive kills
  await launch('TAG-bg6', `${bgStart('sleep 111', 'a')} ${bgStart('sleep 112', 'b')} ${bgStart('sleep 113', 'c')} ${bgStart('sleep 114', 'd')} ${T('projects_bg_stop', { id: '@@BG@@' })}`);
  const bg6 = await done('TAG-bg6');
  const sleepers = [0, 1, 2].map(i => out('TAG-bg6', i));
  check('F11 a fourth running command is rejected with the cap named', /At most 3 background commands/.test(run('TAG-bg6').results[3]), run('TAG-bg6').results[3]);
  // @@BG@@ above resolves to the last id seen (c): stop c, then a fourth may start.
  await rpc({ action: 'thread-send', id, threadId: bg6.threadId, text: `TAG-bg7 ${bgStart('sleep 115', 'e')}`, requestId: crypto.randomUUID() });
  await delay(400); await kit.settle(id);
  const e = JSON.parse(run('TAG-bg7').results[0]);
  check('F11 stopping one frees a slot', e.state === 'running', e);
  const pids = [sleepers[0].pid, sleepers[1].pid, e.pid];
  check('F15 all of them survive the settled turns', pids.every(alive), pids);
  await askCoordinator(`MARK-A ${JSON.stringify({ workIds: (await kit.plan(id)).filter(item => item.threadId === bg6.threadId).map(item => item.id) })}`, 'LBL-arch');
  for (const pid of pids) await gone(pid, 'archived thread command');
  check('F15 archiving the thread\'s work kills its background commands', true);

  // stop kills; log cap
  const j1 = await launch('TAG-bg8', `${bgStart('sleep 150', 'long')} ${sleep(40)}`);
  const longCmd = await kit.eventually(() => { const text = run('TAG-bg8')?.results[0]; return text ? JSON.parse(text) : null; }, 'bg8 never started its command');
  check('F8 the running thread shows its background command on the plan snapshot', (await holdsOf(j1.threadId))?.background?.[0]?.id === longCmd.id);
  await rpc({ action: 'thread-stop', id, threadId: j1.threadId });
  await gone(longCmd.pid, 'command of a stopped thread');
  check('F15 stopping the thread kills its background command', (await work('TAG-bg8')).status === 'stopped');
  await launch('TAG-bg9', `${bgStart('yes', 'flood')} ${sleep(2)} ${T('projects_bg_status', { id: '@@BG@@', tailLines: 10 })}`);
  const bg9 = await done('TAG-bg9'), flood = out('TAG-bg9', 2);
  check('F12 a runaway command is cut off at the log cap; the tail stays small', flood.state === 'killed' && flood.reason === 'log-limit' && flood.logBytes <= 200100 && flood.tail.length <= 20000 && statFlood(bg9.threadId, flood.id) <= 200200, { state: flood.state, reason: flood.reason, logBytes: flood.logBytes, tail: flood.tail.length });
  function statFlood(threadId, bgId) { return readFileSync(join(artDir(threadId), 'bg', `${bgId}.log`)).length; }

  // ---- restart cleanup (hard kill) ----
  const r1 = await launch('TAG-ll1 ONCE-r', `${acquire('r-res', 5)} ${bgStart('sleep 300', 'orphan')} ${bgStart('sleep 301', 'reused-pid')} ${sleep(60)}`);
  await kit.eventually(() => run('TAG-ll1')?.results.length >= 3, 'll1 did not start its commands');
  const orphan = out('TAG-ll1', 1), reused = out('TAG-ll1', 2);
  const reusedFile = join(artDir(r1.threadId), 'bg', `${reused.id}.json`);
  writeFileSync(reusedFile, JSON.stringify({ ...JSON.parse(readFileSync(reusedFile, 'utf8')), lstart: 'Thu Jan  1 00:00:00 1970' }));
  process.kill((await rpc()).pid, 'SIGKILL');
  await kit.eventually(async () => { try { await rpc(); return false; } catch { return true; } }, 'host did not die');
  check('F16 the crash left the orphan running', alive(orphan.pid) && alive(reused.pid), [orphan.pid, reused.pid]);
  await delay(1500); // let the harness see the old host exit before it tracks the new one
  kit.startHost(); await kit.waitHost();
  await kit.eventually(async () => { try { await kit.plan(id); return true; } catch { return false; } }, 'project did not reopen');
  await gone(orphan.pid, 'orphan after restart');
  const after = Object.fromEntries(bgRecords(r1.threadId).map(record => [record.id, record]));
  check('F16 on restart the orphan with a matching start time is killed and marked lost', after[orphan.id].state === 'lost' && after[orphan.id].reason === 'host-restart', after[orphan.id]);
  check('F16 a record whose pid start time differs (reused pid) is marked lost but its process is left alone', alive(reused.pid) && after[reused.id].state === 'lost', after[reused.id]);
  process.kill(reused.pid, 'SIGKILL');
  await rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  await launch('TAG-ll2', acquire('r-res', 1));
  await done('TAG-ll2');
  check('F7 no lease survives the restart', out('TAG-ll2', 0).acquired === true, out('TAG-ll2', 0));

  // ---- runbook / usage instruction text ----
  const system = run('TAG-ll2').system, coordinator = kit.lastCall('coordinator', 'LBL-w1').system;
  check('F19 worker and coordinator instructions point at runbooks/ and the lease and bg tools', /runbooks\//.test(system) && /projects_bg_start/.test(system) && /projects_lease_acquire/.test(system) && /runbooks\/ with projects_knowledge_write/.test(coordinator) && /projects_lease_acquire/.test(coordinator), { worker: system.length, coordinator: coordinator.length });

  summary.leases = { denied, granted, ttl: out('TAG-lb2', 0), restart: out('TAG-ll2', 0) };
  summary.background = { started, finished, stopped, flood: { state: flood.state, reason: flood.reason, logBytes: flood.logBytes }, orphanRecord: after[orphan.id], reusedPidRecord: after[reused.id] };
  writeFileSync(join(kit.artifacts, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
});
