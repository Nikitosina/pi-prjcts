// Save-path regression: an isolated host and local fake provider return real HTTP quota errors.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID, waitFor } from './lib/e2e-kit.mjs';

const quota = { status: 429, body: { error: { message: 'Quota exceeded: session limit reached', type: 'insufficient_quota', code: 'insufficient_quota' } } };
const roles = ['worker', 'scout', 'reviewer'];
const kit = await createKit('worker-quota-live-roles', {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: '60000', PI_PROJECTS_QUOTA_SWEEP_MS: '100' },
  handler: ({ role, model, user, results }) => {
    if (role === 'coordinator') {
      if (results.length || user.startsWith('[Durable work')) return say('Noted.');
      const plan = /^PLAN (\{.*\})$/.exec(user)?.[1];
      if (plan) return call('projects_worker_plan', JSON.parse(plan));
    }
    if (roles.includes(role)) return model === 'fake-model' ? quota : say('Recovered.');
  },
});
const { rpc, result } = kit;
await kit.run(async () => {
  const path = join(kit.agentDir, 'models.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  for (const role of roles) config.providers.fake.models.push({ ...config.providers.fake.models[0], id: `${role}-fallback`, name: `${role} fallback` });
  writeFileSync(path, JSON.stringify(config));
  kit.initRepo();
  const id = await kit.createProject('Live role fallback', { workerCap: 3 });
  const scopeId = (await rpc({ action: 'workspace-catalog', id })).find(scope => scope.wholeRepository).id;
  const items = roles.map(role => ({ id: randomUUID(), threadId: randomUUID(), role, text: `LIVE_${role} preserve this request`, ...(role === 'worker' ? { workspaceScopeId: scopeId } : {}) }));
  await rpc({ action: 'message', id, text: `PLAN ${JSON.stringify({ work: items })}` });
  const rows = () => kit.plan(id);
  await waitFor(async () => { const current = await rows(); return items.every(item => current.some(row => row.id === item.id && row.status === 'queued' && row.blocker?.startsWith('quota_reset_wait:'))); }, 'all roles enter quota wait', { timeout: 20000 });
  const before = await rows();
  const initial = Object.fromEntries(roles.map(role => [role, result.calls.find(entry => entry.role === role)]));
  await kit.updateSettings(id, { fallbackModels: Object.fromEntries(roles.map(role => [role, `fake/${role}-fallback`])) });
  await waitFor(async () => { const current = await rows(); return items.every(item => current.some(row => row.id === item.id && row.status === 'completed')); }, 'saved role fallbacks recover waiting work', { timeout: 15000 });
  const after = await rows();
  for (const item of items) {
    const old = before.find(row => row.id === item.id), row = after.find(row => row.id === item.id);
    const calls = result.calls.filter(entry => entry.role === item.role);
    const resumed = calls.find(entry => entry.model === `${item.role}-fallback`);
    kit.check(`${item.role} selects its own saved fallback on the original thread`, row.threadId === item.threadId && row.role === item.role && row.attempt.model === `fake/${item.role}-fallback` && row.attempt.modelTransitions?.some(t => t.from === 'fake/fake-model' && t.reason === 'quota_exceeded'), row);
    kit.check(`${item.role} preserves instructions and tool permissions`, resumed && initial[item.role] && resumed.system === initial[item.role].system && JSON.stringify(resumed.tools) === JSON.stringify(initial[item.role].tools) && row.attempt.instructions === old.attempt.instructions && JSON.stringify(row.attempt.toolNames) === JSON.stringify(old.attempt.toolNames), { old, row, calls });
  }
});
