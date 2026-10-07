#!/usr/bin/env node
import { mkdirSync, writeFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = resolve(`artifacts/observability-toolcalls-${stamp}`);
const home = join(realpathSync(tmpdir()), `projects-toolcalls-${randomUUID()}`);
const workspace = join(home, 'workspace');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
process.env.PI_PROJECTS_HOME = join(home, 'home');
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true, mode: 0o700 });
let primaryError;
let checked = [];
try {
  const { request } = await import('../src/client.ts');
  const project = await request({ action: 'create', name: 'Toolcalls E2E', cwd: workspace });
  const snapshot = await request({ action: 'show', id: project.id });
  const messages = snapshot.messages;
  if (!Array.isArray(messages)) throw new Error('Coordinator messages are missing');
  for (const item of messages) {
    if (item.role === 'user' || item.role === 'assistant') {
      if (typeof item.text !== 'string' || typeof item.at !== 'number' || typeof item.id !== 'number') throw new Error('Text transcript item shape changed');
    } else if (item.kind === 'tool' && item.role === 'tool') {
      if (typeof item.name !== 'string' || typeof item.argsPreview !== 'string' || item.argsPreview.length > 500 || !['ok', 'error', 'pending'].includes(item.status) || typeof item.resultPreview !== 'string' || item.resultPreview.length > 500) throw new Error('Tool transcript item shape or preview bound is invalid');
    } else throw new Error('Unknown transcript item kind');
  }
  if (messages.some(item => item.kind === 'tool')) throw new Error('Unexpected tool item without model execution');
  checked = ['coordinator transcript item compatibility', 'no tool items without model execution'];
  await request({ action: 'shutdown' }, false);
} catch (error) {
  primaryError = error instanceof Error ? error.message : String(error);
} finally {
  const log = join(process.env.PI_PROJECTS_HOME, 'host.log');
  if (existsSync(log)) copyFileSync(log, join(artifacts, 'host.log'));
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ status: primaryError ? 'failed' : 'passed', checks: checked, error: primaryError ?? null, home, workspace }, null, 2));
}
if (primaryError) {
  process.stderr.write(`${primaryError}\nArtifact: ${artifacts}\n`);
  process.exitCode = 1;
} else process.stdout.write(`PASS ${checked.join(', ')}\nArtifact: ${artifacts}\n`);
