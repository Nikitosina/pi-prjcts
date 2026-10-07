#!/usr/bin/env node
import { mkdirSync, writeFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = resolve(`artifacts/observability-usage-schedule-${stamp}`);
const home = join(realpathSync(tmpdir()), `projects-usage-schedule-${randomUUID()}`);
const workspace = join(home, 'workspace');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
process.env.PI_PROJECTS_HOME = join(home, 'home');
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true, mode: 0o700 });
let errorText;
try {
  const { request } = await import('../src/client.ts');
  const project = await request({ action: 'create', name: 'Usage schedule E2E', cwd: workspace });
  const usage = await request({ action: 'usage-snapshot', id: project.id });
  const history = await request({ action: 'schedule-history', id: project.id, kind: 'intents' });
  for (const row of [usage.coordinator, ...usage.workers]) {
    if (!row.timeBuckets || !Array.isArray(row.timeBuckets.hourly) || !Array.isArray(row.timeBuckets.daily) || typeof row.timeBuckets.truncated !== 'boolean') throw new Error('Usage timeline fields are missing');
    for (const bucket of [...row.timeBuckets.hourly, ...row.timeBuckets.daily]) {
      if (!Number.isSafeInteger(bucket.at) || !Number.isFinite(bucket.totalTokens) || !Number.isFinite(bucket.cost.total)) throw new Error('Usage timeline contains invalid bucket values');
    }
  }
  if (!Array.isArray(history.routines) || history.routines.length !== 0) throw new Error('Empty project should have no routine outcomes');
  await request({ action: 'shutdown' }, false);
} catch (error) {
  errorText = error instanceof Error ? error.message : String(error);
} finally {
  const log = join(process.env.PI_PROJECTS_HOME, 'host.log');
  if (existsSync(log)) copyFileSync(log, join(artifacts, 'host.log'));
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ status: errorText ? 'failed' : 'passed', error: errorText ?? null, home, workspace }, null, 2));
}
if (errorText) {
  process.stderr.write(`${errorText}\nArtifact: ${artifacts}\n`);
  process.exitCode = 1;
} else process.stdout.write(`PASS usage buckets and empty schedule outcomes\nArtifact: ${artifacts}\n`);
