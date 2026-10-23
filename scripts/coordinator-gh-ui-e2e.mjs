// Browser check: the "Coordinator GitHub CLI (gh)" setting is shown, on by default, and saved off through settings-update.
import { createKit } from './lib/e2e-kit.mjs';
const kit = await createKit('coordinator-gh-ui');
const { check, rpc } = kit;
kit.initRepo();
await kit.run(async () => {
  const id = await kit.createProject('Mari');
  check('default is full access', (await rpc({ action: 'settings-snapshot', id })).values.githubCli === 'full');
  const page = await kit.openPage(await kit.webUrl(id, 'settings'));
  await page.waitFor(`document.querySelector('#settings-button')?.hidden === false`, 'settings button'); await page.evaluate(`document.querySelector('#settings-button').click()`);
  await page.waitFor(`!!document.querySelector('select[name="githubCli"]')`, 'gh setting rendered').catch(async e => { throw Error(e.message + ' ' + await page.evaluate('document.body.innerText.slice(0,800)')); });
  await page.evaluate(`document.querySelector('select[name="githubCli"]').closest('details').open = true; document.querySelector('select[name="githubCli"]').scrollIntoView({ block: 'center' })`);
  await page.viewport(1100, 1700, false); await kit.delay(500);
  check('toggle shows full access', await page.evaluate(`document.querySelector('select[name="githubCli"]').value === 'full'`));
  await page.shot('settings-gh-toggle');
  const snapshot = await rpc({ action: 'settings-snapshot', id });
  await kit.updateSettings(id, { githubCli: 'none' });
  check('off persists', (await rpc({ action: 'settings-snapshot', id })).values.githubCli === 'none');
});
