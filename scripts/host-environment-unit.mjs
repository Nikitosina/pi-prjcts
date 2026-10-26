import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeHostEnvironment, readShellEnvironment } from '../src/host-environment.ts';

if (process.platform !== 'darwin') { console.log('SKIP macOS zsh host startup integration'); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'host-shell-'));
const env = { HOME: root, ZDOTDIR: root, PATH: '/usr/bin:/bin', PI_PROJECTS_HOME: join(root, 'projects'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_PROJECTS_HOST: '1', PI_PROJECTS_LAUNCHD: '1', DROP_IN_SHELL: 'old' };
const checks = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
const rc = text => writeFile(join(root, '.zshrc'), text);
const rejects = async (name, action, expected) => {
  let message = '';
  try { await action(); } catch (error) { message = error.message; }
  check(name, message === `Shell environment import failed: ${expected}`);
};
try {
  await writeFile(join(root, '.zprofile'), 'export STARTUP_ORDER=profile\n');
  await writeFile(join(root, '.zlogin'), 'export STARTUP_ORDER="${STARTUP_ORDER}:login"\n');
  await rc(`export STARTUP_ORDER="\${STARTUP_ORDER}:rc"
export EXPORTED_SECRET=$'fixture-private-first\\nsecond=quoted unicode-λ'
local_only=not-exported
export EMPTY_EXPORTED=''
unset DROP_IN_SHELL
print -r -- "startup stdout $EXPORTED_SECRET"
print -ru2 -- "startup stderr $EXPORTED_SECRET"
export PATH="/fixture/bin:$PATH"
export PI_PROJECTS_HOME=/wrong-store PI_CODING_AGENT_DIR=/wrong-agent HOME=/wrong-home
export PI_PROJECTS_LAUNCHD=0 PI_PROJECTS_HOST=0 PI_PROJECTS_NOTIFY_TICK_MS=1
export PI_SUBAGENT_PARENT_ID=wrong PI_SESSION_FILE=/wrong-session
export NODE_OPTIONS='--require /wrong-preload' NODE_PATH=/wrong-modules PI_PACKAGE_DIR=/wrong-package
export PI_ARTIFACTS_DIR=/wrong-artifacts TMPDIR=/wrong-tmp
export NODE_DEBUG=http NODE_DEBUG_NATIVE=http
`);
  const shell = await readShellEnvironment({ env });
  check('interactive startup exports preserve multiline, equals and Unicode', shell.EXPORTED_SECRET === 'fixture-private-first\nsecond=quoted unicode-λ');
  check('non-exported locals stay private and empty exports survive', !('local_only' in shell) && shell.EMPTY_EXPORTED === '');
  check('login profile precedes interactive rc', shell.STARTUP_ORDER?.startsWith('profile:rc'));
  const merged = mergeHostEnvironment({ inherited: env, shell });
  check('launcher identity and store roots win over shell overrides', Object.keys(env).filter(k => k.startsWith('PI_') || k === 'HOME').every(k => merged[k] === env[k]));
  check('unset inherited exports stay unset', !('DROP_IN_SHELL' in merged));
  check('shell PATH is imported', merged.PATH?.startsWith('/fixture/bin:') && merged.PATH.includes('/usr/bin'));
  check('shell cannot add host controls, preloads, package roots, artifact roots or agent context', ['PI_PROJECTS_NOTIFY_TICK_MS', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'TMPDIR', 'PI_PACKAGE_DIR', 'PI_ARTIFACTS_DIR', 'PI_SUBAGENT_PARENT_ID', 'PI_SESSION_FILE'].every(k => !(k in merged)));
  const inheritedControls = { ...env, NODE_OPTIONS: '--no-warnings', PI_PACKAGE_DIR: '/launcher-package', PI_ARTIFACTS_DIR: '/launcher-artifacts' };
  const preserved = mergeHostEnvironment({ inherited: inheritedControls, shell });
  check('inherited launcher controls remain unchanged', ['NODE_OPTIONS', 'PI_PACKAGE_DIR', 'PI_ARTIFACTS_DIR'].every(k => preserved[k] === inheritedControls[k]));
  const child = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify({ inherited: process.env.EXPORTED_SECRET === 'fixture-private-first\\nsecond=quoted unicode-λ', store: process.env.PI_PROJECTS_HOME === ${JSON.stringify(env.PI_PROJECTS_HOME)} }))`], { env: merged, encoding: 'utf8' });
  const childResult = JSON.parse(child.stdout);
  check('children inherit exports and the pinned store, without dumping env', child.status === 0 && childResult.inherited && childResult.store);
  await rc('export STARTUP_ORDER="${STARTUP_ORDER}:rc"\n');
  const ordered = await readShellEnvironment({ env });
  check('normal login/interactive startup order includes zlogin', ordered.STARTUP_ORDER === 'profile:rc:login');
  await rc('print -r -- fixture-private-failure; print -ru2 -- fixture-private-failure; exit 9\n');
  await rejects('failure never includes startup output', () => readShellEnvironment({ env }), 'zsh exited unsuccessfully');
  const host = spawnSync(process.execPath, ['src/host.ts'], { env, encoding: 'utf8', timeout: 20000 });
  check('host entry fails before opening its store and does not disclose startup output', host.status !== 0 && !existsSync(env.PI_PROJECTS_HOME) && !`${host.stdout}${host.stderr}`.includes('fixture-private-failure') && host.stderr.includes('Shell environment import failed'));
  await rc('print -ru3 -- "fixture-private-invalid"\n');
  await rejects('malformed export pipe is rejected without its content', () => readShellEnvironment({ env }), 'invalid export data');
  await rc("printf '%03000000d' 1 >&3\n");
  await rejects('export pipe size is bounded', () => readShellEnvironment({ env }), 'export size limit');
  await rc('/bin/sleep 30 &\nprint -r -- $! > "$ZDOTDIR/sleeper.pid"\nwait\n');
  const start = Date.now();
  await rejects('startup timeout is bounded, even with a child holding the pipe', () => readShellEnvironment({ env, timeout: 1000 }), 'timeout');
  check('timeout returns promptly', Date.now() - start < 5000);
  const pid = Number(await readFile(join(root, 'sleeper.pid'), 'utf8'));
  const status = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  check('timed-out startup child is gone or reaped as a zombie', !status || status.startsWith('Z'));
  await rejects('missing shell has a fixed non-sensitive error', () => readShellEnvironment({ env, shell: join(root, 'missing-zsh') }), 'could not start zsh');
  console.log(JSON.stringify({ status: 'passed', checks }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
