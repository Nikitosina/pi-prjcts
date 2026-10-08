import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FAKE_MODEL, pinFakeRoles, startFakeModel } from './fake-model.mjs';

// Gates before host implementation: new projects must use Durable; old records
// must not switch silently; admission must remain responsive; restart must retain
// completed conversations without replay. Only this disposable host may stop.
const base = resolve('artifacts', `durable-host-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(base, { recursive: true });
const fake = await startFakeModel(base); // offline: private SDK home with only the fake model
process.env.PI_PROJECTS_HOME = join(base, 'state');
const { ensureHost, request, health } = await import('../src/client.ts');
const workspace = join(base, 'workspace'); mkdirSync(workspace, { recursive: true });
const checks = []; let pid;
function pass(name) { checks.push(name); process.stderr.write(`PASS ${name}\n`); }
async function until(id, predicate) { const deadline = Date.now() + 180000; while (Date.now() < deadline) { const view = await request({ action: 'show', id }); writeFileSync(join(base, 'latest.json'), JSON.stringify(view, null, 2)); if (predicate(view)) return view; await sleep(500); } throw new Error('Host view did not settle'); }
try {
  await ensureHost(); pid = (await health()).pid;
  const project = await request({ action: 'create', name: 'Durable host E2E', cwd: workspace, model: FAKE_MODEL });
  await pinFakeRoles(request, project.id);
  assert.equal(project.runtime, 'durable'); pass('New projects select official Durable');
  const started = Date.now(), job = await request({ action: 'message', id: project.id, text: 'Reply exactly HOST_READY.' });
  assert.ok(Date.now() - started < 10000); pass('Host message admits without waiting for a model');
  const before = await until(project.id, view => view.jobs.some(item => item.id === job.id && item.state === 'done'));
  assert.ok(before.messages.some(message => message.text.includes('HOST_READY'))); pass('Existing client snapshot shows the model answer');
  await request({ action: 'shutdown' }, false); await sleep(1500); pid = undefined;
  await ensureHost(); pid = (await health()).pid;
  const after = await request({ action: 'show', id: project.id });
  assert.ok(after.messages.some(message => message.text.includes('HOST_READY'))); assert.equal(after.project.id, project.id); pass('Host restart preserves project and conversation');
  assert.equal(after.jobs.filter(item => item.id === job.id).length, 1); pass('Restart does not duplicate completed work');
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: true, checks, projectId: project.id }, null, 2));
} catch (error) { writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: false, checks, error: String(error) }, null, 2)); throw error; }
finally { fake.close(); if (pid) { try { await request({ action: 'shutdown' }, false); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } } process.stderr.write(`${join(base, 'report.json')}\n`); }
