import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit } from './lib/e2e-kit.mjs';

const k = await createKit('scoped-model-environment', { env: { PI_TEST_CONFIGURED_PROVIDER_KEY: 'fixture-only' } });
k.initRepo();
const file = join(k.agentDir, 'models.json');
const config = JSON.parse(readFileSync(file, 'utf8'));
const reference = 'eliza-openrouter/moonshotai/kimi-k3.1-pro';
const provider = config.providers['eliza-openrouter'] = {
  api: 'openai-completions', baseUrl: config.providers.fake.baseUrl,
  apiKey: '${PI_TEST_MISSING_PROVIDER_KEY}', authHeader: false,
  headers: { Authorization: 'Bearer ${PI_TEST_MISSING_PROVIDER_KEY}' },
  models: [{ ...config.providers.fake.models[0], id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro (Eliza)' }],
};
writeFileSync(file, JSON.stringify(config));
writeFileSync(join(k.agentDir, 'settings.json'), JSON.stringify({ enabledModels: ['fake/fake-model', reference] }));
const snapshot = id => k.rpc({ action: 'model-picker-snapshot', id });
await k.run(async () => {
  const id = await k.createProject('Scoped provider credentials');
  let data = await snapshot(id);
  k.check('actual model id is installed but missing host environment blocks credentials', data.items.find(m => m.reference === reference)?.configured === false);
  k.check('unavailable enabled model stays visible separately from usable cycle scope', data.unavailableScoped.includes(reference) && !data.scoped.includes(reference));
  k.check('snapshot never returns credential templates or values', !JSON.stringify(data).includes('PI_TEST_') && !JSON.stringify(data).includes('fixture-only'));
  let rejected = false;
  try { await k.updateSettings(id, { model: reference }); } catch { rejected = true; }
  k.check('missing credentials still block model selection', rejected);
  await k.updateSettings(id, { scopedModels: [reference] });
  data = await snapshot(id);
  k.check('explicit project scope also preserves unavailable model without widening cycle scope', !data.scoped.length && data.unavailableScoped.join() === reference && data.scopeSet);
  const page = await k.openPage(await k.webUrl(id, 'coordinator'));
  await page.waitFor(`document.querySelector('#settings-button')?.hidden === false`, 'settings button');
  await page.evaluate(`document.querySelector('#settings-button').click()`);
  await page.waitFor(`!!document.querySelector('[data-settings-form]')`, 'settings form');
  await page.evaluate(`document.querySelector('.mp[data-role="coordinator"] .mp-current').click()`);
  const row = `.mp[data-role="coordinator"] .mp-row[data-ref="${reference}"]`;
  await page.waitFor(`!!document.querySelector(${JSON.stringify(row)})`, 'unconfigured scoped Kimi visible without search');
  k.check('unconfigured scoped model is disabled with host credential explanation', await page.evaluate(`document.querySelector(${JSON.stringify(row)}).getAttribute('aria-disabled') === 'true' && document.querySelector('.mp.open').innerText.includes('credentials are unavailable to this host')`));
  await page.shot('01-missing-host-environment', { force: true });
  await page.cdp('Input.insertText', { text: 'kimi-k3.1' });
  await page.waitFor(`!!document.querySelector(${JSON.stringify(row)})`, 'id search with punctuation');
  k.check('model id search finds the named provider model', await page.evaluate(`document.querySelector(${JSON.stringify(row)}).innerText.includes('Kimi K3.1 Pro (Eliza)')`));
  await page.evaluate(`document.querySelector('.mp.open .mp-search').value = ''`);
  await page.cdp('Input.insertText', { text: 'Kimi K3.1 Pro' });
  await page.waitFor(`!!document.querySelector(${JSON.stringify(row)})`, 'display-name search');
  k.check('display-name search resolves the same provider reference', await page.evaluate(`!!document.querySelector(${JSON.stringify(row)})`));
  provider.apiKey = '${PI_TEST_CONFIGURED_PROVIDER_KEY}';
  provider.headers.Authorization = 'Bearer ${PI_TEST_CONFIGURED_PROVIDER_KEY}';
  writeFileSync(file, JSON.stringify(config));
  data = await snapshot(id);
  k.check('configured host environment restores provider availability and exact scope', data.items.find(m => m.reference === reference)?.configured && data.scoped.join() === reference && !data.unavailableScoped.length);
  await k.updateSettings(id, { model: reference });
  await k.ask(id, 'Resolve intended provider model');
  k.check('provider dispatch uses intended nested model id', k.result.calls.at(-1)?.model === 'moonshotai/kimi-k3.1-pro');
  await page.reload();
  await page.waitFor(`document.querySelector('#settings-button')?.hidden === false`, 'settings after credentials available');
  await page.evaluate(`document.querySelector('#settings-button').click()`);
  await page.waitFor(`!!document.querySelector('[data-settings-form]')`, 'updated settings');
  await page.evaluate(`document.querySelector('.mp[data-role="coordinator"] .mp-current').click()`);
  await page.waitFor(`document.querySelector(${JSON.stringify(row)})?.getAttribute('data-action') === 'mp-pick'`, 'configured Kimi selectable');
  await page.shot('02-provider-resolved', { force: true });
});
