import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createKit } from './lib/e2e-kit.mjs';

if (process.platform !== 'darwin') { console.log('SKIP macOS zsh host startup integration'); process.exit(0); }
const k = await createKit('host-environment');
k.initRepo();
k.hostEnv.ZDOTDIR = k.userHome;
delete k.hostEnv.ELIZA_TOKEN;
delete k.hostEnv.PI_PROJECTS_LAUNCHD;
const reference = 'eliza-openrouter/moonshotai/kimi-k3.1-pro';
const config = JSON.parse(readFileSync(join(k.agentDir, 'models.json'), 'utf8'));
config.providers['eliza-openrouter'] = {
  api: 'openai-completions', baseUrl: config.providers.fake.baseUrl,
  apiKey: '${ELIZA_TOKEN}', authHeader: false, headers: { Authorization: 'Bearer ${ELIZA_TOKEN}' },
  models: [{ ...config.providers.fake.models[0], id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro (Eliza)' }],
};
writeFileSync(join(k.agentDir, 'models.json'), JSON.stringify(config));
writeFileSync(join(k.agentDir, 'settings.json'), JSON.stringify({ enabledModels: [reference] }));
const wrongStore = join(k.root, 'wrong-store'), wrongAgent = join(k.root, 'wrong-agent');
writeFileSync(join(k.userHome, '.zshrc'), `export ELIZA_TOKEN='fixture-shell-private-value'
export UNRELATED_EXPORTED_VARIABLE='also-private'
local_only=not-exported
print -r -- "startup stdout $ELIZA_TOKEN"
print -ru2 -- "startup stderr $ELIZA_TOKEN"
export PI_PROJECTS_HOME=${JSON.stringify(wrongStore)} PI_CODING_AGENT_DIR=${JSON.stringify(wrongAgent)}
export PI_PROJECTS_HOST=0 PI_PROJECTS_LAUNCHD=1
export PI_SUBAGENT_PARENT_ID=wrong PI_SESSION_FILE=/wrong-session
export NODE_OPTIONS='--require /wrong-preload' PI_PACKAGE_DIR=/wrong-package TMPDIR=/wrong-tmp
export NODE_DEBUG=http NODE_DEBUG_NATIVE=http
`);
await k.run(async () => {
  const health = await k.rpc();
  k.check('existing host.ts launcher keeps the intended project store', health.home === k.home && !existsSync(wrongStore));
  k.check('shell cannot redirect Pi agent root', !existsSync(wrongAgent));
  const data = await k.rpc({ action: 'model-picker-snapshot' });
  k.check('zshrc credentials configure the intended model before SDK discovery', data.items.find(m => m.reference === reference)?.configured && data.scoped.includes(reference) && !data.unavailableScoped.includes(reference));
  k.check('browser metadata contains no exported secrets or variable values', !JSON.stringify(data).includes('fixture-shell-private-value') && !JSON.stringify(data).includes('also-private'));
  const id = await k.createProject('Shell provider environment');
  await k.updateSettings(id, { model: reference });
  await k.ask(id, 'Resolve shell configured provider');
  k.check('provider resolution dispatches the exact model id', k.result.calls.at(-1)?.model === 'moonshotai/kimi-k3.1-pro');
  k.check('launcher ownership flag cannot be injected by zshrc', (await k.rpc({ action: 'remote-status' })).launchd === false);
  const log = readFileSync(join(k.artifacts, 'host-1.log'), 'utf8');
  k.check('startup logs only counts, never shell output or credential values', log.includes('host-shell-environment') && !log.includes('fixture-shell-private-value') && !log.includes('also-private') && !log.includes('startup stdout') && !log.includes('startup stderr'));
  await k.stopHost();
  try {
    const cli = spawnSync(process.execPath, ['src/cli.ts', 'list'], { cwd: k.repo, env: k.hostEnv, encoding: 'utf8', timeout: 35000 });
    k.check('detached CLI launcher reaches the shell-initialized host', cli.status === 0);
    k.check('detached host retains its private store', (await k.rpc()).home === k.home);
    const detached = await k.rpc({ action: 'model-picker-snapshot' });
    k.check('detached launcher also configures the intended provider from zshrc', detached.items.find(m => m.reference === reference)?.configured === true);
    const detachedLog = readFileSync(join(k.home, 'host.log'), 'utf8');
    k.check('detached startup has no shell output or credential disclosure', !`${cli.stdout}${cli.stderr}${detachedLog}`.includes('fixture-shell-private-value') && !detachedLog.includes('also-private'));
  } finally { await k.rpc({ action: 'shutdown' }).catch(() => {}); }
});
