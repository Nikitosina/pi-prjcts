// E2E: scoped models, inherited role models, live coordinator model changes, default concurrency 5.
// Isolated host, local fake provider with three models, no real providers. Failure cases: scripts/scoped-models-failures.md.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kit, delay } from './notify-kit.mjs';

const brain = { held: null };
const respond = async ({ coordinator, marker, results, call, say, userText, request }) => {
  if (coordinator) {
    brain.control = request.tools?.find(tool => tool.function?.name === 'projects_worker_control');
    if (marker === 'MARK-BUSY') { await brain.held; return say('Busy turn done.'); }
    const role = { 'MARK-DELA': 'scout', 'MARK-DELB': 'scout', 'MARK-DELC': 'scout' }[marker];
    if (role && results.length === 0) return call('projects_delegate', { role, task: `${marker}TASK read-only look ${marker === 'MARK-DELA' ? 'MARK-HOLD' : ''}` });
    return undefined;
  }
  if (/MARK-HOLD/.test(userText)) { await brain.held; return say('Held worker done.'); }
  return undefined;
};
const k = await kit('scoped-models', {}, respond);
const { rpc, result, eventually, startHost, stopHost } = k;
const check = (name, ok, detail) => { if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`); result.checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const fails = async (fn, pattern) => { try { await fn(); return false; } catch (error) { return pattern.test(String(error.message)); } };

try {
  const agentModels = join(k.root, 'agent', 'models.json'), models = JSON.parse(readFileSync(agentModels, 'utf8'));
  const base = models.providers.fake.models[0];
  models.providers.fake.models = ['fake-model', 'fake-two', 'fake-three'].map(id => ({ ...base, id, name: id }));
  writeFileSync(agentModels, JSON.stringify(models));
  await startHost();

  const created = await rpc({ action: 'create', requestId: crypto.randomUUID(), name: 'Scoped', cwd: k.workspace, objective: 'Disposable scoped-model fixture', model: 'fake/fake-model' });
  const id = created.id;
  const settings = () => rpc({ action: 'settings-snapshot', id });
  const update = async changes => rpc({ action: 'settings-update', id, confirm: id, expectedRevision: (await settings()).revision, changes });
  const plan = () => rpc({ action: 'plan-snapshot', id });
  const show = chatId => rpc({ action: 'show', id, ...(chatId ? { chatId } : {}) });
  const modelsOf = role => result.calls.filter(call => call.coordinator === (role === 'coordinator')).map(call => call.model);

  let values = (await settings()).values;
  check('S1 a new project stores no role models (all inherit the coordinator)', JSON.stringify(values.models) === '{}', values.models);
  check('S2 a new project allows five workers at a time', values.workerCap === 5, values.workerCap);

  values = (await update({ models: { worker: 'fake/fake-two' } })).values;
  check('S3 an explicit role model is kept', values.models.worker === 'fake/fake-two', values.models);
  values = (await update({ models: { worker: null } })).values;
  check('S3 null returns a role to inherit', values.models.worker === undefined, values.models);

  const scoped = async () => (await rpc({ action: 'model-picker-snapshot', id })).scoped;
  check('S6 without an override the scope is Pi\'s (no enabledModels: empty)', (await scoped()).length === 0, await scoped());
  values = (await update({ scopedModels: ['fake/fake-model', 'fake/fake-two'] })).values;
  check('S6 a project scope narrows the picker', JSON.stringify(await scoped()) === JSON.stringify(['fake/fake-model', 'fake/fake-two']), await scoped());
  check('S7 an unknown model in the scope is refused when saved', await fails(() => update({ scopedModels: ['zzz/none'] }), /zzz\/none/));
  await update({ scopedModels: null });
  check('S8 null restores Pi\'s scope', (await scoped()).length === 0 && (await settings()).values.scopedModels === null, await settings());

  // Inherited scope comes from the selected project's Pi settings, not the host's cwd.
  mkdirSync(join(k.workspace, '.pi'), { recursive: true });
  writeFileSync(join(k.workspace, '.pi', 'settings.json'), JSON.stringify({ enabledModels: ['fake/fake-two'] }));
  check('S16 the inherited scope reads the project\'s own Pi settings', JSON.stringify(await scoped()) === JSON.stringify(['fake/fake-two']), await scoped());
  check('S16 the project-less picker keeps the host-wide scope', (await rpc({ action: 'model-picker-snapshot' })).scoped.length === 0);
  rmSync(join(k.workspace, '.pi'), { recursive: true });
  check('S17 an empty scope override is refused (null is how to inherit)', await fails(() => update({ scopedModels: [] }), /scopedModels|at least|minItems|must/i));
  check('S17 the refused empty override saved nothing', (await settings()).values.scopedModels === null);

  // Inheritance at admission; running workers keep their model through a live coordinator model change.
  let release; brain.held = new Promise(ok => { release = ok; });
  await rpc({ action: 'message', id, text: 'MARK-DELA delegate and hold' });
  await eventually(async () => (await plan()).work.some(work => work.status === 'running'), 'held scout never ran');
  const heldWork = (await plan()).work.find(work => work.status === 'running');
  check('S4 an inheriting scout gets the coordinator model at admission', heldWork.attempt.model === 'fake/fake-model', heldWork.attempt);
  values = (await update({ model: 'fake/fake-two' })).values;
  check('S9 the coordinator model changes while a worker runs (no reopen)', values.model === 'fake/fake-two' && (await plan()).work.some(work => work.status === 'running'), values.model);
  values = (await update({ workerCap: 2 })).values;
  check('S19 the worker limit changes while a worker runs, and it keeps running', values.workerCap === 2 && (await plan()).workerCap === 2 && (await plan()).work.some(work => work.id === heldWork.id && work.status === 'running'), await plan());
  values = (await update({ workerCap: 5 })).values;
  check('S19 the limit goes back up live', (await plan()).workerCap === 5 && values.workerCap === 5);
  check('S5 the running worker keeps its frozen model', (await plan()).work.find(work => work.id === heldWork.id).attempt.model === 'fake/fake-model');
  release();
  await eventually(async () => (await plan()).work.every(work => work.status !== 'running' && work.status !== 'queued'), 'held scout did not finish');

  await k.ask(id, 'main', 'MARK-DELB after the change');
  check('S4 a scout admitted after the change inherits the new coordinator model', (await plan()).work.find(work => /MARK-DELBTASK/.test(work.text))?.attempt.model === 'fake/fake-two', (await plan()).work);
  check('S11 the coordinator now requests the new model', modelsOf('coordinator').at(-1) === 'fake-two', modelsOf('coordinator'));
  const chat = await rpc({ action: 'chat-create', id, title: 'Second' });
  await k.ask(id, chat.id, 'MARK-PLAIN in the second chat');
  check('S11 a chat created later uses the new model', modelsOf('coordinator').at(-1) === 'fake-two');
  await update({ model: 'fake/fake-three' });
  await k.ask(id, chat.id, 'MARK-PLAIN again');
  await k.ask(id, 'main', 'MARK-PLAIN main');
  check('S11 both Main and the existing chat follow the change', modelsOf('coordinator').slice(-2).every(model => model === 'fake-three'), modelsOf('coordinator'));
  await update({ models: { scout: 'fake/fake-model' } });
  await k.ask(id, 'main', 'MARK-DELC with an explicit scout model');
  check('S3 an explicit scout model overrides inheritance', (await plan()).work.find(work => /MARK-DELCTASK/.test(work.text))?.attempt.model === 'fake/fake-model');

  // A turn in flight is never mutated.
  let free; brain.held = new Promise(ok => { free = ok; });
  await rpc({ action: 'message', id, text: 'MARK-BUSY hold this turn' });
  await eventually(async () => (await show()).busy, 'coordinator never became busy');
  check('S10 a model change is refused while a coordinator turn runs', await fails(() => update({ model: 'fake/fake-two' }), /idle coordinator/));
  check('S10 the refused change was not saved', (await settings()).values.model === 'fake/fake-three');
  free(); await eventually(async () => !(await show()).busy, 'busy turn did not finish');

  // Restart: the saved selection is what runs.
  await stopHost(); await startHost();
  check('S12 the model survives a host restart', (await settings()).values.model === 'fake/fake-three');
  await k.ask(id, 'main', 'MARK-PLAIN after restart');
  check('S12 the restarted coordinator requests the saved model', modelsOf('coordinator').at(-1) === 'fake-three', modelsOf('coordinator'));

  // The worker limit has one owner.
  const control = brain.control;
  check('S13 projects_worker_control no longer offers parallelism', !!control && !JSON.stringify(control).includes('parallelism'), control?.function?.parameters);


  // Browser: the model button cycles the scope; Settings offers inherit and a scope editor.
  await update({ models: { scout: null }, scopedModels: ['fake/fake-model', 'fake/fake-two', 'fake/fake-three'] });
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: (await settings()).revision, changes: { model: 'fake/fake-three' } });
  const web = await rpc({ action: 'web' }), url = new URL(web.url); url.searchParams.set('project', id);
  const { openPage, waitFor, evaluate, shot } = k;
  const page = await openPage(url.toString());
  await waitFor(`!!document.querySelector('#model-cycle') && !document.querySelector('#model-cycle').hidden`, page, 'model button');
  check('S14 the composer shows the coordinator model as a button', /fake-three/.test(await evaluate(`document.querySelector('#model-cycle').textContent`, page)));
  await evaluate(`document.querySelector('#model-cycle').click()`, page);
  await eventually(async () => (await settings()).values.model === 'fake/fake-model', 'button did not cycle forward with wrap-around');
  check('S14 the button cycles forward through the scope and wraps', true);
  await waitFor(`/fake-model/.test(document.querySelector('#model-cycle').textContent)`, page, 'button label');
  await evaluate(`document.querySelector('#compose textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`, page);
  await eventually(async () => (await settings()).values.model === 'fake/fake-three', 'Shift+Ctrl+P did not cycle backward');
  check('S14 Shift+Ctrl+P in the composer cycles backward', true);
  await evaluate(`document.querySelector('#compose textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }))`, page);
  await eventually(async () => (await settings()).values.model === 'fake/fake-model', 'Ctrl+P did not cycle forward');
  check('S14 Ctrl+P in the composer cycles forward', true);
  // A configured scope that resolves to nothing usable blocks cycling; it never widens to every configured model.
  const dead = (await rpc({ action: 'model-picker-snapshot' })).items.find(model => !model.configured)?.reference;
  check('S18 fixture has an installed model without credentials', !!dead, dead);
  const cycleOutcome = async () => {
    const before = (await settings()).values.model;
    await evaluate(`document.querySelector('#error').hidden = true; document.querySelector('#error').innerHTML = ''; document.querySelector('#model-cycle').click()`, page);
    await delay(1500);
    return { before, after: (await settings()).values.model, error: await evaluate(`document.querySelector('#error').hidden ? '' : document.querySelector('#error').innerText`, page) };
  };
  await update({ scopedModels: [dead] });
  let outcome = await cycleOutcome();
  check('S18 a project scope with no usable model blocks cycling with a clear message', outcome.after === outcome.before && /scoped/i.test(outcome.error), outcome);
  await update({ scopedModels: null });
  mkdirSync(join(k.workspace, '.pi'), { recursive: true });
  writeFileSync(join(k.workspace, '.pi', 'settings.json'), JSON.stringify({ enabledModels: ['zzz/none'] }));
  await evaluate(`location.reload()`, page);
  await waitFor(`!!document.querySelector('#model-cycle') && !document.querySelector('#model-cycle').hidden`, page, 'model button after reload');
  outcome = await cycleOutcome();
  check('S18 a Pi scope that resolves to nothing blocks cycling too', outcome.after === outcome.before && /scoped/i.test(outcome.error), outcome);
  rmSync(join(k.workspace, '.pi'), { recursive: true });
  await update({ scopedModels: ['fake/fake-model', 'fake/fake-two', 'fake/fake-three'] });
  await evaluate(`location.reload()`, page);
  await waitFor(`!!document.querySelector('#model-cycle') && !document.querySelector('#model-cycle').hidden`, page, 'model button restored');
  outcome = await cycleOutcome();
  check('S18 a usable scope cycles again', outcome.after !== outcome.before && outcome.error === '', outcome);
  await rpc({ action: 'settings-update', id, confirm: id, expectedRevision: (await settings()).revision, changes: { model: 'fake/fake-model' } });
  check('S14 the model button sits inside the composer and is visible', await evaluate(`(() => { const b = document.querySelector('#model-cycle').getBoundingClientRect(), c = document.querySelector('#compose').getBoundingClientRect(); return b.width > 20 && b.height > 10 && b.left >= c.left && b.right <= c.right && b.top >= c.top && b.bottom <= c.bottom; })()`, page));
  await evaluate(`document.querySelector('#proto-bar')?.remove()`, page); // throwaway Activity prototype overlay covers the composer
  await shot('01-composer-model-button', page);

  await evaluate(`document.querySelector('#settings-button').click()`, page);
  await waitFor(`!!document.querySelector('[data-settings-form]')`, page, 'settings form');
  await shot('02-settings-models', page);
  check('S15 worker, scout and reviewer default to inherit the coordinator', JSON.parse(await evaluate(`JSON.stringify(['worker','scout','reviewer'].map(role => { const mp = document.querySelector('.mp[data-role="' + role + '"]'); return [mp.dataset.value, /Inherit coordinator/.test(mp.innerText)]; }))`, page)).every(([value, label]) => value === '' && label));
  check('S15 the scope editor lists the project scope as checked', JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-scope-ref]')].filter(box => box.checked).map(box => box.dataset.scopeRef))`, page)).length === 3);
  await evaluate(`(() => { const box = document.querySelector('[data-scope-ref="fake/fake-two"]'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); })()`, page);
  await shot('03-settings-scope-editor', page);
  await evaluate(`document.querySelector('.mp[data-role="worker"] .mp-current').click()`, page);
  await waitFor(`!!document.querySelector('.mp[data-role="worker"] .mp-row[data-ref="fake/fake-two"]')`, page, 'worker rows');
  check('S15 the role list starts with Inherit coordinator', /Inherit coordinator/.test(await evaluate(`document.querySelector('.mp[data-role="worker"] .mp-row').innerText`, page)));
  await evaluate(`document.querySelector('.mp[data-role="worker"] .mp-row[data-ref="fake/fake-two"]').click()`, page);
  await evaluate(`document.querySelector('[data-settings-form]').requestSubmit()`, page);
  await waitFor(`!!document.querySelector('[data-settings-confirm]')`, page, 'review dialog');
  await evaluate(`document.querySelector('[data-settings-confirm]').requestSubmit()`, page);
  await eventually(async () => (await settings()).values.models.worker === 'fake/fake-two', 'worker model not saved from the dialog');
  values = (await settings()).values;
  check('S15 the dialog saves an explicit worker model and a narrowed scope', JSON.stringify(values.scopedModels) === JSON.stringify(['fake/fake-model', 'fake/fake-three']) && values.models.scout === undefined, values);
  await evaluate(`document.querySelector('#settings-button').click()`, page);
  await waitFor(`!!document.querySelector('[data-settings-form]')`, page, 'settings form again');
  await evaluate(`document.querySelector('.mp[data-role="worker"] .mp-current').click()`, page);
  await waitFor(`!!document.querySelector('.mp[data-role="worker"] .mp-row[data-ref=""]')`, page, 'inherit row');
  await evaluate(`document.querySelector('.mp[data-role="worker"] .mp-row[data-ref=""]').click()`, page);
  await evaluate(`document.querySelector('[data-settings-form]').requestSubmit()`, page);
  await waitFor(`!!document.querySelector('[data-settings-confirm]')`, page, 'review dialog 2');
  await evaluate(`document.querySelector('[data-settings-confirm]').requestSubmit()`, page);
  await eventually(async () => (await settings()).values.models.worker === undefined, 'worker did not return to inherit');
  check('S15 choosing Inherit coordinator removes the explicit model', true);

  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.failure = String(error?.stack ?? error);
} finally {
  await k.finish(result.status ?? 'failed');
}
