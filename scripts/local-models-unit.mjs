import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'local-models-'));
Object.assign(process.env, { HOME: join(root, 'user'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_PROJECTS_HOME: join(root, 'projects') });
delete process.env.PI_OFFLINE;
let requests = 0;
globalThis.fetch = async () => { requests++; throw Error('Unexpected network'); };
try {
  for (const path of ['user', 'agent', 'projects']) await mkdir(join(root, path));
  const file = join(root, 'agent/models.json');
  const model = { id: 'one', name: 'One', input: ['text'], reasoning: false, contextWindow: 10000, maxTokens: 1000 };
  const config = { providers: { local: { api: 'openai-completions', apiKey: 'fake-unit-key', baseUrl: 'http://127.0.0.1:1/v1', models: [model] } } };
  const save = () => writeFile(file, JSON.stringify(config));
  await save();
  const { liveModelRuntime } = await import('../src/live-models.ts');
  const live = await liveModelRuntime();
  const old = live.models.getModel('local', 'one');
  assert.equal(old.contextWindow, 10000);
  config.providers.local.models = [{ ...model, id: 'two', contextWindow: 20000 }];
  await save();
  const update = await live.prepare();
  assert.equal(live.models.getModel('local', 'two'), undefined);
  assert.equal(update.candidate.getModel('local', 'two').contextWindow, 20000);
  update.commit();
  assert.equal(live.models.getModel('local', 'two').contextWindow, 20000);
  assert.equal(live.models.getModel('local', 'one'), old, 'already-resolved frozen references survive removal');
  await writeFile(file, '{ private-sentinel: invalid');
  await assert.rejects(live.refresh(), error => !error.message.includes('private-sentinel'));
  assert.equal(live.models.getModel('local', 'two').contextWindow, 20000);
  assert.equal(requests, 0, 'offline registry creation and refresh never fetch, even without PI_OFFLINE');
  console.log('PASS local SDK integration: staged swaps, frozen references, atomic failure, zero fetches');
} finally { await rm(root, { recursive: true, force: true }); }
