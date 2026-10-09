// E2E: the projects host loads model providers from the owner's Pi packages/extensions (fake ones, private agent dir, fake model server).
// Failure cases: provider-extensions-failures.md. Artifacts: artifacts/provider-extensions-*/ (report.json, host logs, picker.json).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call } from './lib/e2e-kit.mjs';

const kit = await createKit('provider-extensions', {
  env: { PI_PROJECTS_EXTENSION_TIMEOUT_MS: '2500' },
  handler: ({ role, user, results }) => role === 'coordinator' && !results.length && user.includes('EXT-DELEGATE') ? call('projects_delegate', { role: 'worker', task: 'EXT-WORKTASK edit' }) : role === 'coordinator' && !results.length && user.includes('SCOUTME') ? call('projects_delegate', { role: 'scout', task: 'EXT-SCOUTTASK read' }) : undefined,
});
const { rpc, agentDir, repo } = kit; const check = kit.check;
const base = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')).providers.fake.baseUrl.replace('/v1', '');
const write = (rel, text) => { const path = join(agentDir, rel); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const model = (id, name = id) => ({ id, name, reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096 });
const provider = (name, prefix, models) => `pi.registerProvider(${JSON.stringify(name)}, { baseUrl: ${JSON.stringify(base + prefix)}, apiKey: 'fake', api: 'openai-completions', models: ${JSON.stringify(models)} });`;

// 1. Good global extension: provider with plain, thinking-suffix target and "@256k:fast"-style ids.
write('extensions/ext-ok.js', `export default function (pi) { ${provider('extfake', '/ext/v1', [model('ext-one', 'Ext One'), model('ext-two', 'Ext Two'), model('grok-x@256k:fast', 'Grok X Fast')])} }`);
// 2. Leaky extension: also registers a provider, but tries to add a tool, command, flag, shortcut and agent event handlers.
write('extensions/ext-leaky.js', `export default function (pi) { ${provider('extleaky', '/leaky/v1', [model('leak-one')])}
  pi.registerTool({ name: 'leak_tool', label: 'leak', description: 'LEAK-MARKER tool', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'leak' }] }; } });
  pi.registerCommand('leakcmd', { description: 'LEAK-MARKER', handler: async () => {} });
  pi.registerFlag('leakflag', { type: 'boolean' });
  pi.on('before_agent_start', async () => ({ systemPrompt: 'LEAK-MARKER system' }));
  pi.on('context', async () => { throw new Error('LEAK handler ran'); }); }`);
// 3. Broken extensions: factory throws, missing import, never resolves.
write('extensions/ext-throw.js', `export default function () { throw new Error('boom from factory'); }`);
write('extensions/ext-import.js', `import 'definitely-not-installed-pkg'; export default function () {}`);
write('extensions/ext-hang.js', `export default async function () { await new Promise(() => {}); }`);
// 4. Packages from settings: a good local one, a broken one, and one whose entry is a file of this repo (must be skipped, never imported).
write('pkgs/good/package.json', JSON.stringify({ name: 'pi-fake-good', pi: { extensions: ['./index.js'] } }));
write('pkgs/good/index.js', `export default function (pi) { ${provider('pkgprov', '/pkg/v1', [model('pkg-one', 'Pkg One')])} }`);
write('pkgs/bad/package.json', JSON.stringify({ name: 'pi-fake-bad', pi: { extensions: ['./index.js'] } }));
write('pkgs/bad/index.js', `export default function (pi) { ${provider('halfbad', '/half/v1', [model('half-one')])} throw new Error('bad package after registering'); }`);
write('pkgs/self/package.json', JSON.stringify({ name: 'pi-fake-self', pi: { extensions: [join(repo, 'src/provider-extensions.ts')] } }));
const settingsFile = join(agentDir, 'settings.json');
// 5. Credentials that live only in auth.json (oauth and api_key entries, fake values): custom providers without apiKey, and the built-in openai-codex.
const modelsFile = join(agentDir, 'models.json'), modelsJson = JSON.parse(readFileSync(modelsFile, 'utf8'));
for (const name of ['credoauth', 'credkey', 'nocred']) modelsJson.providers[name] = { baseUrl: base + '/cred/v1', api: 'openai-completions', models: [model(`${name}-m`)] };
writeFileSync(modelsFile, JSON.stringify(modelsJson));
const oauth = { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 86400000 * 365 };
writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ 'openai-codex': oauth, credoauth: oauth, credkey: { type: 'api_key', key: 'fake-key' } }));
const scope = ['extfake/ext-one:high', 'extfake/grok-x@256k:fast', 'pkgprov/*', 'halfbad/half-one', 'extleaky/leak-one', 'extfake/nope'];
writeFileSync(settingsFile, JSON.stringify({ packages: [join(agentDir, 'pkgs/good'), join(agentDir, 'pkgs/bad'), join(agentDir, 'pkgs/self')], enabledModels: scope }));
for (const key of Object.keys(kit.hostEnv)) if (/(API_KEY|_TOKEN|SECRET)/i.test(key)) delete kit.hostEnv[key];
kit.initRepo();

await kit.run(async () => {
  const picker = await rpc({ action: 'model-picker-snapshot' });
  writeFileSync(join(kit.artifacts, 'picker.json'), JSON.stringify({ scoped: picker.scoped, extensionErrors: picker.extensionErrors, extensionModels: picker.items.filter(m => /^(extfake|pkgprov|extleaky|halfbad)\//.test(m.reference)) }, null, 2));
  const find = ref => picker.items.find(m => m.reference === ref);
  check('extension provider models appear in the picker, configured by their apiKey', ['extfake/ext-one', 'extfake/ext-two', 'extfake/grok-x@256k:fast', 'pkgprov/pkg-one', 'extleaky/leak-one'].every(ref => find(ref)?.configured === true), picker.items.filter(m => /ext|pkg/.test(m.reference)));
  check('scoped list resolves extension entries incl. :thinking and @256k:fast ids, drops misses', ['extfake/ext-one', 'extfake/grok-x@256k:fast', 'pkgprov/pkg-one', 'extleaky/leak-one'].every(ref => picker.scoped.includes(ref)) && !picker.scoped.some(ref => ref.includes('nope')), picker.scoped);
  check('built-in providers are still listed', picker.items.some(m => m.reference.startsWith('openai')) || picker.items.some(m => m.reference === 'fake/fake-model'));
  const failed = name => picker.extensionErrors.find(e => e.extension.includes(name));
  check('broken extensions are reported with their error: throw, missing import, hang timeout, bad package', /boom from factory/.test(failed('ext-throw')?.error) && failed('ext-import') && /timed out/.test(failed('ext-hang')?.error) && /bad package after registering/.test(failed('pkgs/bad')?.error ?? failed('pi-fake-bad')?.error ?? failed('bad')?.error), picker.extensionErrors);
  check('failed extension leaves no partial registrations', !find('halfbad/half-one') && !picker.scoped.includes('halfbad/half-one'));
  check('healthy extensions are not listed as failed; an entry inside this repo is skipped, never imported', !failed('ext-ok') && !failed('ext-leaky') && !failed('pkgs/good') && /never loads itself/.test(failed('provider-extensions.ts')?.error ?? failed('self')?.error ?? '') && !JSON.stringify(picker.extensionErrors).includes('LEAK handler'), picker.extensionErrors);

  check('stored credentials count as configured: oauth built-in (openai-codex), oauth custom, api_key custom; no credential stays unconfigured',
    picker.items.some(m => m.reference.startsWith('openai-codex/') && m.configured) && picker.items.filter(m => m.reference.startsWith('openai-codex/')).every(m => m.configured) && find('credoauth/credoauth-m')?.configured === true && find('credkey/credkey-m')?.configured === true && find('nocred/nocred-m')?.configured === false, picker.items.filter(m => /^(openai-codex|cred|nocred)/.test(m.reference)).slice(0, 8));

  // Settings validation and running sessions share the same registry.
  const id = await kit.createProject('Ext', { workerCap: 2 });
  await kit.updateSettings(id, { model: 'extfake/ext-one', models: { worker: 'extfake/ext-two', scout: 'pkgprov/pkg-one', reviewer: 'extfake/grok-x@256k:fast' } });
  const values = (await rpc({ action: 'settings-snapshot', id })).values;
  check('settings-update accepts extension models for coordinator and every role', values.model === 'extfake/ext-one' && values.models.worker === 'extfake/ext-two' && values.models.scout === 'pkgprov/pkg-one' && values.models.reviewer === 'extfake/grok-x@256k:fast', values);
  const codex = picker.items.find(m => m.reference.startsWith('openai-codex/')).reference;
  await kit.updateSettings(id, { models: { scout: 'credoauth/credoauth-m', reviewer: 'credkey/credkey-m', worker: codex } });
  const saved = (await rpc({ action: 'settings-snapshot', id })).values.models;
  check('settings-update saves models whose credentials exist only in auth.json (oauth built-in, oauth custom, api_key custom)', saved.scout === 'credoauth/credoauth-m' && saved.reviewer === 'credkey/credkey-m' && saved.worker === codex, saved);
  check('a provider with no credential is still rejected', /nocred\/nocred-m/.test(await kit.rejects({ action: 'settings-update', id, confirm: id, expectedRevision: (await rpc({ action: 'settings-snapshot', id })).revision, changes: { model: 'nocred/nocred-m' } })));
  await kit.updateSettings(id, { models: { scout: 'pkgprov/pkg-one', reviewer: 'extfake/grok-x@256k:fast', worker: 'extfake/ext-two' } });
  const rejected = await kit.rejects({ action: 'settings-update', id, confirm: id, expectedRevision: (await rpc({ action: 'settings-snapshot', id })).revision, changes: { model: 'halfbad/half-one' } });
  check('model of a failed extension is rejected, naming the failed extensions', /halfbad\/half-one/.test(rejected) && /failed to load/.test(rejected), rejected);

  // Coordinator turn and a worker actually run on extension models; the fake server sees the extension endpoints.
  await kit.ask(id, 'EXT-DELEGATE please');
  const coordinator = kit.result.calls.find(c => c.role === 'coordinator' && c.user.includes('EXT-DELEGATE'));
  check('coordinator turn ran on the extension model through the extension provider URL', coordinator?.model === 'ext-one' && coordinator.url === '/ext/v1/chat/completions', coordinator);
  const worker = kit.result.calls.find(c => c.role === 'worker' && c.user.includes('EXT-WORKTASK'));
  check('delegated worker ran on its own extension model', worker?.model === 'ext-two' && worker.url === '/ext/v1/chat/completions', worker);
  const plan = await kit.plan(id);
  check('worker completed', plan.some(w => w.status === 'completed' || w.status === 'done' || w.status === 'succeeded'), plan.map(w => w.status));
  await kit.ask(id, 'SCOUTME please');
  const scout = kit.result.calls.find(c => c.role === 'scout' && c.user.includes('EXT-SCOUTTASK'));
  check('delegated scout ran on its own extension model (package provider)', scout?.model === 'pkg-one' && scout.url === '/pkg/v1/chat/completions', scout);
  check('all agent calls went to extension endpoints only', kit.result.calls.filter(c => c.role !== 'other').every(c => /^\/(ext|pkg)\/v1\//.test(c.url)), kit.result.calls.map(c => [c.role, c.url]));

  // Nothing the leaky extension registered reaches project agents.
  const agentCalls = kit.result.calls.filter(c => c.role !== 'other');
  check('no extension tool, command text or system-prompt hook reaches coordinators or workers', agentCalls.length >= 2 && agentCalls.every(c => !c.tools.includes('leak_tool') && !c.system.includes('LEAK-MARKER') && !c.user.includes('LEAK')), agentCalls.map(c => [c.role, c.tools.filter(t => /leak/.test(t))]));

  // Picker response survives a restart with the same result (loaded once per host start).
  await kit.restartHost();
  const again = await rpc({ action: 'model-picker-snapshot' });
  check('after restart the host is up, extension models still resolve and errors still reported', again.scoped.includes('extfake/ext-one') && again.extensionErrors.length === picker.extensionErrors.length, again.extensionErrors);
  const logs = readFileSync(join(kit.artifacts, 'host-2.log'), 'utf8');
  check('host log records the provider-extensions load', /"event":"provider-extensions"/.test(logs));
});
