import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Failure paths of the verify-pi-prjcts helper: a launch that dies, a Chrome that never speaks CDP, and a recorded pid that was reused.
const verify = join(process.cwd(), '.agents/skills/verify-pi-prjcts/scripts/verify.mjs');
const base = mkdtempSync(join(tmpdir(), 'vsf-')), temp = [base];
const run = (args, env = {}) => spawnSync(process.execPath, [verify, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const json = file => JSON.parse(readFileSync(file, 'utf8'));
let scratch, sleeper;
try {
  // A. The host dies on start: launch exits 1, keeps logs (redacted) in evidence, removes scratch, leaves no provider.
  const fake = join(base, 'fake-repo'); mkdirSync(join(fake, 'src'), { recursive: true }); mkdirSync(join(fake, 'node_modules'));
  writeFileSync(join(fake, 'src/host.ts'), "console.error('boom token=abcdefghijklmnop1234'); process.exit(3);\n");
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']]) spawnSync('/usr/bin/git', ['-C', fake, ...args]);
  const evA = join(base, 'ev-a'), a = run(['launch', '--evidence', evA], { VERIFY_REPO: fake, VERIFY_CHROME: process.execPath });
  assert.equal(a.status, 1, a.stderr);
  const hostLog = readFileSync(join(evA, 'diagnostics/host.log'), 'utf8');
  assert.match(hostLog, /boom/); assert.doesNotMatch(hostLog, /abcdefghijklmnop1234/);
  const runA = json(join(evA, 'diagnostics/run.json'));
  assert.ok(!existsSync(runA.scratch), 'scratch removed after failed launch');
  for (const who of Object.values(runA.pids)) assert.ok(!alive(who.pid), 'no process left from failed launch');

  // B. A real launch whose "Chrome" never answers CDP: drive fails, writes its own report, and leaves no Chrome behind.
  const chrome = join(base, 'fake-chrome.sh'); writeFileSync(chrome, '#!/bin/sh\nsleep 600\n'); chmodSync(chrome, 0o755);
  const evB = join(base, 'ev-b'), b = run(['launch', '--evidence', evB], { VERIFY_CHROME: chrome });
  assert.equal(b.status, 0, b.stderr + b.stdout);
  scratch = JSON.parse(b.stdout).scratch;
  const d = run(['drive', '--run', scratch, 'message-coordinator'], { VERIFY_CHROME: chrome, VERIFY_CDP_TIMEOUT_MS: '1500' });
  assert.equal(d.status, 1);
  const folders = readdirSync(evB).filter(name => name.startsWith('drive-message-coordinator-'));
  assert.equal(folders.length, 1);
  const report = json(join(evB, folders[0], 'report.json'));
  assert.equal(report.ok, false); assert.match(report.problems[0], /CDP timeout/);
  const state = json(join(scratch, 'run.json'));
  assert.deepEqual(Object.keys(state.pids).sort(), ['fakeProvider', 'host'], 'Chrome entry removed once it exited');
  assert.equal(spawnSync('/usr/bin/pgrep', ['-f', chrome]).status, 1, 'fake Chrome process is gone');

  // C. A recorded pid whose start time no longer matches (pid reuse) is reported, never killed; real processes still stop.
  sleeper = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }); sleeper.unref();
  state.pids.reused = { pid: sleeper.pid, lstart: 'Mon Jan  1 00:00:00 2001', pgid: sleeper.pid };
  writeFileSync(join(scratch, 'run.json'), JSON.stringify(state));
  const c = run(['cleanup', '--run', scratch]);
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual(JSON.parse(c.stdout).skippedReusedPids, ['reused']);
  assert.ok(alive(sleeper.pid), 'reused pid left alone');
  assert.ok(!existsSync(scratch), 'scratch removed');
  assert.ok(!alive(state.pids.host.pid) && !alive(state.pids.fakeProvider.pid), 'host and provider stopped');
  assert.ok(existsSync(join(evB, 'diagnostics/host.log')) && existsSync(join(evB, folders[0], 'report.json')), 'evidence survives cleanup');
  scratch = undefined;
  console.log('ok');
} finally {
  if (scratch && existsSync(join(scratch, 'run.json'))) run(['cleanup', '--run', scratch]);
  if (sleeper) try { process.kill(sleeper.pid, 'SIGKILL'); } catch {}
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
}
