// Browser proof for per-role quota fallback settings on an isolated host with two fake models.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit } from './lib/e2e-kit.mjs';

const kit = await createKit('worker-quota-settings-ui');
await kit.run(async () => {
  const modelPath = join(kit.agentDir, 'models.json'), config = JSON.parse(readFileSync(modelPath, 'utf8'));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: 'fallback-model', name: 'Fallback fake' });
  writeFileSync(modelPath, JSON.stringify(config));
  kit.initRepo();
  const id = await kit.createProject('Quota settings');
  const page = await kit.openPage(await kit.webUrl(id, 'settings'));
  await page.waitFor(`document.querySelector('#settings-button')?.hidden === false && document.querySelector('#settings-button').getBoundingClientRect().width > 0`, 'project settings loaded');
  await page.evaluate(`document.querySelector('#settings-button').click()`);
  await page.waitFor(`document.querySelectorAll('#dialog [data-settings-form] .mp').length === 7`, 'quota settings form');
  kit.check('settings explain reset waiting and explicit per-role fallback', (await page.evaluate(`document.querySelector('#dialog').innerText`)).includes('Paused or stopped workers never restart automatically'));
  await page.shot('01-quota-settings-before', { force: true });

  await page.evaluate(`(() => {
    const picker = document.querySelector('.mp[data-role="worker-fallback"]');
    picker.querySelector('.mp-current').click();
    const search = picker.querySelector('.mp-search');
    search.value = 'Fallback fake'; search.dispatchEvent(new Event('input', { bubbles: true }));
    picker.querySelector('.mp-row[data-ref="fake/fallback-model"]').click();
    document.querySelector('[data-settings-form]').requestSubmit();
  })()`);
  await page.waitFor(`document.querySelector('#dialog h2')?.textContent === 'Save these changes?'`, 'fallback review');
  kit.check('review names the exact fallback change', (await page.evaluate(`document.querySelector('#dialog').innerText`)).includes('Worker quota fallback') && (await page.evaluate(`document.querySelector('#dialog').innerText`)).includes('fake/fallback-model'));
  await page.shot('02-quota-settings-review', { force: true });
  await page.evaluate(`document.querySelector('[data-settings-confirm] button[type="submit"]').click()`);
  await page.waitFor(`!document.querySelector('#dialog').open`, 'settings saved');
  const saved = await kit.rpc({ action: 'settings-snapshot', id });
  kit.check('read-only host proof contains only the selected fallback', saved.values.fallbackModels.worker === 'fake/fallback-model' && saved.values.models.worker === 'fake/fake-model' && saved.values.fallbackModels.scout === undefined);
  writeFileSync(join(kit.artifacts, 'host-settings-proof.json'), JSON.stringify(saved, null, 2));

  await page.evaluate(`document.querySelector('#settings-button').click()`);
  await page.waitFor(`document.querySelector('.mp[data-role="worker-fallback"][data-value="fake/fallback-model"]')`, 'saved fallback visible');
  await page.shot('03-quota-settings-saved', { force: true });
  const status = await kit.rpc({ action: 'plan-snapshot', id });
  writeFileSync(join(kit.artifacts, 'host-plan-proof.json'), JSON.stringify(status, null, 2));
});
