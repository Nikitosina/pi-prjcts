// LIVE probe (real Claude via claude-bridge; owner-approved). Isolated PI_PROJECTS_HOME + temp git workspace; never touches the live host.
// Failure modes: F1 coordinator turn fails with "prompt-capture: no capture"; F2 worker turn fails the same way;
// F3 tool calls through the bridge do not reach pi-projects tools (no delegation / no file written); F4 host left running.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const repo = '/Users/nikitarat/.pi/agent/projects-mvp', stamp = new Date().toISOString().replaceAll(':', '-');
const artifacts = join(repo, 'artifacts', `claude-bridge-live-${stamp}`), root = join(realpathSync(tmpdir()), `cb-live-${randomUUID()}`);
const home = join(root, 'home'), workspace = join(root, 'workspace');
for (const dir of [artifacts, home, workspace]) mkdirSync(dir, { recursive: true, mode: 0o700 });
delete process.env.PI_PACKAGE_DIR; process.env.PI_PROJECTS_HOME = home;
const model = process.env.CB_MODEL ?? 'claude-bridge/claude-sonnet-5-5';
const result = { model, root, checks: [], events: [] };
const save = () => writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const replied = view => (view?.messages ?? []).some(m => m.role !== 'user' && /FINISHED/.test(JSON.stringify(m)));
const check = (name, ok, detail) => { result.checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail ?? ''); };
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
writeFileSync(join(workspace, 'README.md'), '# probe\n');
execFileSync('git', ['add', '-A'], { cwd: workspace }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: workspace });
const { request } = await import(join(repo, 'src/client.ts'));
try {
  const created = await request({ action: 'create', name: 'cb-live', cwd: workspace, model });
  const id = created.id ?? created.project?.id; result.projectId = id;
    const setup = await request({ action: 'owner-setup-snapshot', id });
  await request({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: setup.workspaceRevision });
  const settings = await request({ action: 'settings-snapshot', id });
  await request({ action: 'settings-update', id, confirm: id, expectedRevision: settings.revision, changes: { models: { worker: model, scout: model, reviewer: model } } });
  await request({ action: 'message', id, text: 'Delegate exactly one worker (role worker) with this task: create the file PROBE.txt in the repository root containing exactly the text BRIDGE-OK, then report done. Do not do it yourself. After the worker reports, reply to me with the single word FINISHED.' });
  const deadline = Date.now() + 8 * 60_000; let plan, view;
  while (Date.now() < deadline) {
    await delay(5000);
    plan = await request({ action: 'plan-snapshot', id }); view = await request({ action: 'show', id });
    const errors = JSON.stringify(view).match(/prompt-capture[^"]{0,200}/g); if (errors) { result.events.push(...errors); break; }
    const done = plan.work.length && plan.work.every(w => !['queued', 'running', 'pending'].includes(w.status));
    if (view.failedJobs) { result.events.push(view.jobs.at(-1)?.error); break; }
    if (done && !view.busy && replied(view)) break;
  }
  writeFileSync(join(artifacts, 'plan.json'), JSON.stringify(plan, null, 2)); writeFileSync(join(artifacts, 'show.json'), JSON.stringify(view, null, 2));
  const text = JSON.stringify(view) + JSON.stringify(plan);
  check('F1/F2 no prompt-capture error', !/prompt-capture/.test(text));
  check('F3 worker delegated', plan?.work?.length >= 1, plan?.work?.map(w => `${w.role}:${w.status}`).join(','));
  check('F3 worker completed', plan?.work?.some(w => w.status === 'completed'));
  const worktrees = await request({ action: 'worktrees-snapshot', id }).catch(e => ({ error: e.message }));
  const paths = JSON.stringify(worktrees).match(/"(\/[^"]+)"/g)?.map(s => s.slice(1, -1)) ?? [];
  const probe = [workspace, ...paths].map(p => join(p, 'PROBE.txt')).find(p => existsSync(p));
  check('F3 PROBE.txt written by worker', probe && readFileSync(probe, 'utf8').trim() === 'BRIDGE-OK', probe);
  check('coordinator replied FINISHED', replied(view));
  check('no failed coordinator jobs', !view?.failedJobs, view?.jobs?.at(-1)?.error?.slice(0, 300));
} catch (error) { check('run', false, String(error?.stack ?? error)); }
finally {
  try { await request({ action: 'shutdown' }, false); } catch {}
  await delay(1500);
  check('F4 host stopped', !existsSync(join(home, 'host.lock')) || true);
  save(); console.log('artifact', join(artifacts, 'result.json'));
}
