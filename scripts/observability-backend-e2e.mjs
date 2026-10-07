#!/usr/bin/env node
import { mkdirSync, writeFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = resolve(`artifacts/observability-backend-${stamp}`);
const home = join(realpathSync(tmpdir()), `projects-observability-${randomUUID()}`);
const workspace = join(home, 'workspace');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
process.env.PI_PROJECTS_HOME = join(home, 'home');
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true, mode: 0o700 });
const results = [];
let primaryError;
try {
  const { request } = await import('../src/client.ts');
  const project = await request({ action: 'create', name: 'Observability E2E', cwd: workspace });
  const plan = await request({ action: 'plan-snapshot', id: project.id });
  const usage = await request({ action: 'usage-snapshot', id: project.id });
  const owner = await request({ action: 'owner-setup-snapshot', id: project.id });
  if (!Array.isArray(plan.work)) throw new Error('plan-snapshot did not return work');
  if (!Array.isArray(usage.workers)) throw new Error('usage-snapshot did not return workers');
  if (!Array.isArray(owner.profiles) || !Array.isArray(owner.grants)) throw new Error('owner setup profile/grant status missing');
  results.push('plan-snapshot', 'usage-snapshot', 'owner-setup-snapshot');
  await request({ action: 'shutdown' }, false);
} catch (error) {
  primaryError = error instanceof Error ? error.message : String(error);
} finally {
  const log = join(process.env.PI_PROJECTS_HOME, 'host.log');
  if (existsSync(log)) copyFileSync(log, join(artifacts, 'host.log'));
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ status: primaryError ? 'failed' : 'passed', actions: results, error: primaryError ?? null, home, workspace }, null, 2));
}
if (primaryError) {
  process.stderr.write(`${primaryError}\nArtifact: ${artifacts}\n`);
  process.exitCode = 1;
} else process.stdout.write(`PASS ${results.join(', ')}\nArtifact: ${artifacts}\n`);
