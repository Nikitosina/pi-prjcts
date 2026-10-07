#!/usr/bin/env node
import { mkdirSync, writeFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const artifacts = resolve(`artifacts/observability-host-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `projects-host-e2e-${randomUUID()}`);
const workspace = join(root, 'workspace');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
process.env.PI_PROJECTS_HOME = join(root, 'home');
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true, mode: 0o700 });
const actions = [];
let errorText = null;
try {
  const { request } = await import('../src/client.ts');
  const project = await request({ action: 'create', name: 'Host health E2E', cwd: workspace });
  const health = await request({ action: 'host-health', id: project.id });
  if (health.pid !== process.pid && (!Number.isInteger(health.pid) || health.pid < 1)) throw new Error('host-health returned invalid pid');
  if (health.node !== process.version || health.uptimeMs < 0 || health.paused !== false || health.busy !== false) throw new Error('host-health runtime values are inconsistent');
  if (health.macAwake !== null || typeof health.macAwakeReason !== 'string' || !health.macAwakeReason) throw new Error('unknown awake status lacks reason');
  actions.push('host-health');
  const page = await request({ action: 'event-log', id: project.id, offset: 0, limit: 10 });
  if (!Array.isArray(page.events) || page.offset !== 0 || page.limit !== 10 || page.total !== 0) throw new Error('new project should have an empty event log');
  actions.push('event-log');
  await request({ action: 'pause', id: project.id });
  const events = await request({ action: 'event-log', id: project.id });
  if (!events.events.some(event => event.kind === 'lifecycle' && event.source === 'host-observed' && event.detail === `paused:${project.id}`)) throw new Error('pause was not logged as a host-observed event');
  actions.push('event-log lifecycle');
  await request({ action: 'shutdown' }, false);
} catch (error) { errorText = error instanceof Error ? error.message : String(error); }
finally {
  const log = join(process.env.PI_PROJECTS_HOME, 'host.log');
  if (existsSync(log)) copyFileSync(log, join(artifacts, 'host.log'));
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ status: errorText ? 'failed' : 'passed', actions, error: errorText, root, workspace }, null, 2));
}
if (errorText) { process.stderr.write(`${errorText}\nArtifact: ${artifacts}\n`); process.exitCode = 1; }
else process.stdout.write(`PASS ${actions.join(', ')}\nArtifact: ${artifacts}\n`);
