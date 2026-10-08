import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FAKE_MODEL, startFakeModel } from './fake-model.mjs';

// Failure cases: blocked admission, duplicate/replayed messages, lost identities,
// cross-project submission access, unsafe storage, ignored memory denial, hidden mutation.
const base = resolve('artifacts', `durable-runtime-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(base, { recursive: true });
const fake = await startFakeModel(base); // offline: private SDK home with only the fake model
process.env.PI_PROJECTS_HOME = join(base, 'state');
const { openDurableProject } = await import('../src/durable-runtime.ts');
const { projectDir, saveProject, notes } = await import('../src/state.ts');
const { readKnowledge, writeKnowledge } = await import('../src/knowledge.ts');
const id = randomUUID(), dir = projectDir(id), workspace = join(base, 'workspace');
mkdirSync(workspace, { recursive: true });
const model = FAKE_MODEL;
const project = { version: 1, id, runtime: 'durable', name: 'Runtime E2E', cwd: workspace, objective: 'Verify local durable conversations safely', createdAt: new Date().toISOString(), model, models: { worker: model, scout: model, reviewer: model }, sessionFile: null, phase: 'ready', problem: null, runs: [] };
saveProject(project);
const checks = [], diagnostics = []; let runtime, workerContextSawSecret = false;
function pass(name) { checks.push(name); process.stderr.write(`PASS ${name}\n`); }
async function open() { return openDurableProject({ project, dir, onReport: value => diagnostics.push(value), onModelRequest: value => { if (secretForWorkerContext && JSON.stringify(value.messages).includes(secretForWorkerContext)) workerContextSawSecret = true; } }); }
async function until(predicate, timeout = 180000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const view = await runtime.snapshot(); writeFileSync(join(base, 'latest.json'), JSON.stringify(view, null, 2)); if (predicate(view)) return view; await sleep(500); } throw new Error('Timed out waiting for runtime state'); }
async function untilPlan(predicate, timeout = 180000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const view = await runtime.planSnapshot(); writeFileSync(join(base, 'latest-plan.json'), JSON.stringify(view, null, 2)); if (predicate(view)) return view; await sleep(500); } throw new Error('Timed out waiting for durable plan state'); }
let secretForWorkerContext; 
try {
  runtime = await open();
  await assert.rejects(open(), /owned/); pass('Concurrent storage ownership rejected');
  await assert.rejects(runtime.admit('test', { requestId: '' })); pass('Admission requires idempotency key');
  const started = Date.now(), first = await runtime.admit('Reply exactly ADAPTER_READY.', { requestId: 'first' });
  assert.ok(Date.now() - started < 5000); pass('Admission returns without waiting for a model');
  assert.equal((await runtime.admit('Reply exactly ADAPTER_READY.', { requestId: 'first' })).submissionId, first.submissionId); pass('Admission retry is deduplicated');
  const answer = await runtime.wait(first.submissionId); assert.equal(answer.status, 'done'); assert.match(answer.text, /ADAPTER_READY/); pass('Fake-model coordinator answers');
  await assert.rejects(runtime.result(99999999)); pass('Unknown submission rejected');
  const before = await runtime.snapshot(); await runtime.close(); runtime = await open();
  assert.deepEqual((await runtime.snapshot()).identities, before.identities); assert.equal((await runtime.result(first.submissionId)).text, answer.text); pass('Restart preserves identity and completed answer');
  const secret = `TOPIC_${randomUUID()}`; secretForWorkerContext = secret;
  await writeKnowledge({ dir, path: 'research/proof.md', text: secret, expectedRevision: null, author: 'owner' });
  const workerId = randomUUID(), workerThreadId = randomUUID(); await runtime.plan({ work: [{ id: workerId, threadId: workerThreadId, role: 'worker', text: 'Read research/proof.md using projects_knowledge_read and report its exact text. Do not mutate anything. FAKE-CALL projects_knowledge_read {"path":"research/proof.md"}' }] });
  const done = await untilPlan(view => view.work.some(work => work.id === workerId && work.status === 'completed'));
  assert.equal(done.work.find(work => work.id === workerId)?.threadId, workerThreadId); assert.ok(workerContextSawSecret, 'worker tool result was not present in a subsequent actual model request'); pass('UUID worker reads topic on demand and receives its tool result in context');
  await runtime.say('Record a note. FAKE-CALL projects_note {"text":"COORDINATOR_NOTE"} FAKE-SAY noted', { requestId: 'coordinator-note' });
  assert.ok(notes(dir).some(note => note.text === 'COORDINATOR_NOTE')); pass('Coordinator may record notes');
  const deniedId = randomUUID(); await runtime.plan({ work: [{ id: deniedId, threadId: randomUUID(), role: 'worker', text: 'Attempt projects_note once, observe the denial, do not retry. FAKE-CALL projects_note {"text":"FORBIDDEN_NOTE"} FAKE-SAY denied' }] });
  await untilPlan(view => view.work.some(work => work.id === deniedId && ['completed', 'failed'].includes(work.status)));
  assert.ok(!notes(dir).some(note => note.text === 'FORBIDDEN_NOTE')); pass('Read-only worker note mutation denied');
  const memory = await readKnowledge(dir, 'MEMORY.md'); writeFileSync(join(dir, 'knowledge', 'MEMORY.md'), 'x'.repeat(3001));
  const invalid = await runtime.say('Reply INVALID_SHOULD_NOT_RUN.', { requestId: 'invalid' });
  assert.ok(invalid.status === 'unanswered' || invalid.text?.includes('3000')); pass('Oversized memory blocks actual model request');
  const damaged = await readKnowledge(dir, 'MEMORY.md'); await writeKnowledge({ dir, path: 'MEMORY.md', text: memory.text, expectedRevision: damaged.revision, author: 'owner' });
  assert.match((await runtime.say('Reply exactly REPAIRED.', { requestId: 'repair' })).text, /REPAIRED/); pass('Repair restores the same conversation');
  await runtime.close(); runtime = undefined;
  const ownerPath = join(dir, 'durable-owner.sqlite'); rmSync(ownerPath); symlinkSync(join(workspace, 'outside'), ownerPath);
  await assert.rejects(open(), /symlink/); pass('Dangling storage symlink rejected');
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: true, checks, diagnostics }, null, 2));
} catch (error) { writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: false, checks, diagnostics, error: String(error) }, null, 2)); throw error; }
finally { await runtime?.close(); fake.close(); process.stderr.write(`${join(base, 'report.json')}\n`); }
