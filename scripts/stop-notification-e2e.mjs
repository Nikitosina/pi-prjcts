// A stopped worker or verifier reaches the coordinator model as one durable notice, after the drain, also when the coordinator
// is busy, the project is paused or the host restarts. Failure cases: scripts/stop-notification-failures.md. Owned host, fake model.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say } from './lib/e2e-kit.mjs';

const holds = new Map();
const hold = key => { if (!holds.has(key)) { let release; holds.set(key, { wait: new Promise(ok => { release = ok; }), release: () => release() }); } return holds.get(key); };
const markOf = text => /\bS\d[AB]?\b/.exec(text)?.[0];
const notices = [];
let kit;
kit = await createKit('stop-notification', { handler: async ({ role, user, results, tools }) => {
  if (role === 'coordinator') {
    if (user.startsWith('DELEGATE ') && !results.length) return call('projects_delegate', { task: `${user.slice(9)} task: write proof.txt`, acceptance: ['proof.txt says done'] });
    if (user === 'BUSY' && !results.length) { await hold('BUSY').wait; return say('Busy turn done.'); }
    // A host report on durable work: record what the coordinator model was given, and whether the drain had ended by then.
    if (user.startsWith('[Durable work ') && !results.length) notices.push({ at: Date.now(), user, drained: existsSync(join(kit.root, 'drained-S1')) ? Number(readFileSync(join(kit.root, 'drained-S1'), 'utf8')) : null });
    return;
  }
  const mark = markOf(user);
  if (tools.includes('projects_verify_run')) { if (!results.length) await hold(`verifier-${mark}`).wait; return say('Held verifier ended.'); }
  if (role !== 'worker') return;
  // S2 and S3 finish at once so their verifier starts; the others hold their turn until stopped.
  if (mark === 'S2' || mark === 'S3') return results.length ? say('Finished.') : call('bash', { command: 'echo done > proof.txt' });
  // S1 holds the drain with a background job that takes a second to exit on SIGTERM.
  if (mark === 'S1' && !results.length) return call('projects_bg_start', { label: 'drain barrier', command: `node -e "const fs=require('fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.argv[1],String(Date.now()));process.exit(0)},1000));fs.writeFileSync(process.argv[1]+'.ready','');setInterval(()=>{},1000)" ${join(kit.root, 'drained-S1')}` });
  await hold(`worker-${mark}`).wait; return say('Superseded.');
} });
kit.initRepo(); kit.git(kit.workspace, 'remote', 'add', 'origin', 'git@github.com:acme/stop-fixture.git');
mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Verify that proof.txt says done.\n---\nRun cat proof.txt.\n');

// Every regression is reported, not only the first, so a baseline run shows each defect.
const failures = [];
const expect = (label, ok, detail) => { try { kit.check(label, ok, detail); } catch (error) { failures.push(error.message); } };
const noticesOf = workId => notices.filter(n => n.user.startsWith(`[Durable work ${workId},`));
await kit.run(async () => {
  const id = await kit.createProject('Stop notification', { workerCap: 2 });
  await kit.updateSettings(id, { models: { verifier: 'fake/fake-model' }, verification: { enabled: true, skill: 'mini-verify' } });
  const plan = () => kit.plan(id);
  const delegate = async mark => { await kit.rpc({ action: 'message', id, text: `DELEGATE ${mark}` }); return kit.eventually(async () => (await plan()).find(w => w.role === 'worker' && w.text.startsWith(`${mark} task`)), `${mark} admitted`); };
  const running = (work, label) => kit.eventually(async () => (await plan()).find(w => w.id === work.id)?.status === 'running', label);
  const noticed = (work, label) => kit.eventually(() => noticesOf(work.id).length > 0 && noticesOf(work.id), label, 120).catch(() => []);
  const stop = threadId => kit.rpc({ action: 'thread-stop', id, threadId });
  const names = (work, got, reason) => got.length === 1 && got[0].user.includes(`thread ${work.threadId}`) && reason.test(got[0].user);

  // S1: an ordinary running worker; its notice comes once, after its drain barrier exited.
  const s1 = await delegate('S1'); await running(s1, 'S1 running');
  await kit.eventually(async () => existsSync(join(kit.root, 'drained-S1.ready')), 'S1 drain barrier ready');
  await stop(s1.threadId);
  const n1 = await noticed(s1, 'S1 notice');
  expect('S1 a stopped running worker sends the coordinator one notice with its work id, thread id and reason', names(s1, n1, /stopped/i) && /Stopped explicitly/.test(n1[0]?.user ?? ''), n1.map(n => n.user));
  expect('S1 the notice arrives only after the drain ended', n1.length === 1 && n1[0].drained !== null && n1[0].at >= n1[0].drained, n1.map(({ at, drained }) => ({ at, drained })));

  // S2: stopping a worker while its verifier runs: one notice on the worker's work, none for the verifier, no verifier success.
  const s2 = await delegate('S2');
  const v2 = await kit.eventually(async () => (await plan()).find(w => w.role === 'verifier' && w.parentThreadId === s2.threadId && w.status === 'running'), 'S2 verifier running');
  await stop(s2.threadId);
  const n2 = await noticed(s2, 'S2 notice');
  expect('S2 stopping a worker during verification sends one notice that names the stopped verification', names(s2, n2, /NOT VERIFIED/) && /verification was stopped before a verdict/.test(n2[0]?.user ?? '') && (await plan()).find(w => w.id === v2.id).status === 'stopped', n2.map(n => n.user));
  expect('S2 the verifier sends no notice and no verification success of its own', noticesOf(v2.id).length === 0 && !notices.some(n => n.user.includes(s2.threadId) && /\bVERIFIED\b(?! )/.test(n.user.replace(/NOT VERIFIED/g, ''))), noticesOf(v2.id).map(n => n.user));

  // S3: stopping the verifier directly ends the cycle; the coordinator hears it on the worker's work and the worker is not woken.
  const s3 = await delegate('S3');
  const v3 = await kit.eventually(async () => (await plan()).find(w => w.role === 'verifier' && w.parentThreadId === s3.threadId && w.status === 'running'), 'S3 verifier running');
  await stop(v3.threadId);
  const n3 = await noticed(s3, 'S3 notice');
  expect('S3 a directly stopped verifier sends one notice on the worker\'s work with the reason', names(s3, n3, /verifier .*stopped|stopped .*verifier/i) && /NOT VERIFIED/.test(n3[0]?.user ?? ''), n3.map(n => n.user));
  expect('S3 the waiting worker is not woken and the verifier reports nothing itself', (await plan()).filter(w => w.threadId === s3.threadId).length === 1 && noticesOf(v3.id).length === 0);

  // S4: cancelling queued work also reaches the coordinator.
  await kit.updateSettings(id, { workerCap: 1 });
  const s4a = await delegate('S4A'); await running(s4a, 'S4A running');
  const s4b = await delegate('S4B');
  expect('S4 the second worker waits queued', (await plan()).find(w => w.id === s4b.id).status === 'queued');
  await stop(s4b.threadId);
  const n4 = await noticed(s4b, 'S4B notice');
  expect('S4 cancelled queued work sends one notice', names(s4b, n4, /stopped/i), n4.map(n => n.user));
  await stop(s4a.threadId); await noticed(s4a, 'S4A notice');
  await kit.updateSettings(id, { workerCap: 2 });

  // S5: a busy coordinator gets the notice after its current turn, not never.
  const s5 = await delegate('S5'); await running(s5, 'S5 running');
  await kit.rpc({ action: 'message', id, text: 'BUSY' });
  await kit.eventually(async () => kit.result.calls.some(c => c.role === 'coordinator' && c.user === 'BUSY'), 'coordinator busy');
  await stop(s5.threadId); await kit.delay(1500);
  expect('S5 nothing interrupts the busy coordinator turn', noticesOf(s5.id).length === 0);
  hold('BUSY').release();
  expect('S5 the busy coordinator gets the notice once after its turn', (await noticed(s5, 'S5 notice')).length === 1);

  // S6: a paused project holds the notice through a restart and delivers it once after resume.
  const s6 = await delegate('S6'); await running(s6, 'S6 running');
  await kit.rpc({ action: 'pause', id });
  await stop(s6.threadId); await kit.delay(1500);
  expect('S6 a paused project delivers nothing yet', noticesOf(s6.id).length === 0);
  await kit.stopHost(); kit.startHost(); await kit.waitHost();
  await kit.rpc({ action: 'resume', id, recovery: 'leave-interrupted', confirm: id });
  expect('S6 after a restart and resume the notice arrives once', (await noticed(s6, 'S6 notice')).length === 1);

  // Stopping an idle thread again reports nothing new, and a restart replays nothing.
  await stop(s1.threadId);
  await kit.stopHost(); kit.startHost(); await kit.waitHost(); await kit.delay(2000);
  const counts = Object.fromEntries([s1, s2, s3, s4a, s4b, s5, s6].map(w => [w.text.split(' ')[0], noticesOf(w.id).length]));
  expect('every stop is delivered exactly once, also across restarts and a repeated stop of an idle thread', Object.values(counts).every(n => n === 1), counts);
  for (const value of holds.values()) value.release();
  if (failures.length) throw Error(`${failures.length} regression(s):\n${failures.join('\n')}`);
});
