// Real private host, fake provider, owned foreground child tests and background receipts.
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say } from './lib/e2e-kit.mjs';

const kit = await createKit('watchdog-owned-progress', { env: { PI_PROJECTS_WATCHDOG_MS: '3000', PI_PROJECTS_WATCHDOG_TICK_MS: '250' }, handler: async ({ role, user, results }) => {
  if (role === 'coordinator' && (user === 'START' || user === 'STALL') && !results.length) return call('projects_delegate', { task: user === 'START' ? 'OWNED-SUITE' : 'STALLED-SUITE' });
  if (role === 'coordinator' && user.startsWith('[Owner-local event worker.watchdog]')) {
    const threadId = /thread ([0-9a-f-]{36})/.exec(user)?.[1];
    if (threadId && !results.length) return call('projects_worker_control', { action: 'steer', threadId, text: 'Watchdog nudge', requestId: crypto.randomUUID() });
    return say('');
  }
  if (role === 'worker' && (user === 'OWNED-SUITE' || user === 'STALLED-SUITE')) {
    if (!results.length && user === 'STALLED-SUITE') return call('projects_bg_start', { label: 'stalled', command: 'sleep 25' });
    if (!results.length) return call('projects_bg_start', { label: 'suite', command: `node -e 'const {execFileSync}=require("child_process");for(let i=1;i<=18;i++){execFileSync(process.execPath,["-e","setTimeout(()=>{},600)"]);console.log("["+i+"/18] PASS child-e2e (0.6s)")}'` });
    const job = JSON.parse(results[0]);
    const last = JSON.parse(results.at(-1));
    if (last.state === 'exited') return say('SUITE-EXIT ' + last.code);
    return call('projects_bg_status', { id: job.id, waitSeconds: 1 });
  }
  return say('done');
} });
kit.initRepo();
await kit.run(async () => {
  const id = await kit.createProject('Owned suite');
  await kit.rpc({ action: 'message', id, text: 'START' });
  await kit.eventually(async () => (await kit.plan(id)).some(w => w.text === 'OWNED-SUITE' && !['queued','running'].includes(w.status)), 'suite did not settle', 600);
  const work = (await kit.plan(id)).find(w => w.text === 'OWNED-SUITE');
  const watchdog = kit.result.calls.filter(c => c.role === 'coordinator' && c.user.startsWith('[Owner-local event worker.watchdog]'));
  const workerCalls = kit.result.calls.filter(c => c.role === 'worker' && c.user === 'OWNED-SUITE');
  kit.check('owned advancing suite completed without watchdog steer', work.status === 'completed' && watchdog.length === 0, { work, watchdog });
  kit.check('suite actually completed all child tests with exit zero', workerCalls.some(c => c.results.some(r => { try { const v = JSON.parse(r); return v.state === 'exited' && v.code === 0 && v.tail.includes('[18/18] PASS'); } catch { return false; } })), workerCalls.at(-1));
  await kit.rpc({ action: 'message', id, text: 'STALL' });
  await kit.eventually(async () => (await kit.plan(id)).some(w => w.text === 'STALLED-SUITE' && w.status === 'stopped'), 'stalled suite was not steered', 600);
  kit.check('stalled owned polling is steered', kit.result.calls.some(c => c.role === 'coordinator' && c.user.startsWith('[Owner-local event worker.watchdog]') && c.user.includes('unproductive: repeated identical calls')));
  await kit.settle(id);
});
if (process.env.PI_ARTIFACTS_DIR) cpSync(kit.artifacts, join(process.env.PI_ARTIFACTS_DIR, 'watchdog-owned-progress'), { recursive: true });
