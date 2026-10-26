import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FAKE_MODEL, startFakeModel } from './fake-model.mjs';

// Runtime-level /reload: it applies a fresh skill catalog to one chat in a single commit, keeps tools and history, honours the saved
// exclusions, and a failed rebuild leaves the chat exactly as it was. A discovery failure never blocks a delegation.
const base = resolve('artifacts', `skill-reload-runtime-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(base, { recursive: true });
const fake = await startFakeModel(base);
process.env.PI_PROJECTS_HOME = join(base, 'state');
const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
const { openDurableProject } = await import('../src/durable-runtime.ts');
const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
const { projectDir, saveProject } = await import('../src/state.ts');
const id = randomUUID(), dir = projectDir(id), workspace = join(base, 'workspace');
const skill = (name, description) => { const folder = join(workspace, '.pi', 'skills', name); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBODY-${name}\n`); };
skill('first-skill', 'Present when the runtime opened.');
const model = FAKE_MODEL;
const project = { version: 1, id, runtime: 'durable', name: 'Skill reload', cwd: workspace, objective: 'Verify reload semantics', createdAt: new Date().toISOString(), model, models: { worker: model, scout: model, reviewer: model }, sessionFile: null, phase: 'ready', problem: null, runs: [] };
saveProject(project);
const checks = [], diagnostics = [];
const pass = name => { checks.push(name); process.stderr.write(`PASS ${name}\n`); };
let failing = false, runtime;
const discoverSkills = () => failing ? Promise.reject(new Error('skill directory unreadable')) : loadProjectResourceLoader(project);
const agentOf = () => runtime.withRoot(async root => { const agent = await root.agent(BACKGROUND_CONTEXT); return { instructions: agent.instructions, tools: agent.tools.map(tool => tool.name).sort(), extensions: agent.extensions.map(extension => extension.name).sort() }; });
const listed = instructions => [...instructions.matchAll(/^- ([\w-]+): /gm)].map(match => match[1]).sort();
try {
  runtime = await openDurableProject({ project, dir, configuredSkillLoader: await loadProjectResourceLoader(project), discoverSkills, onReport: value => diagnostics.push(value) });
  const answer = await runtime.say('Reply exactly BEFORE_RELOAD.', { requestId: 'before' });
  assert.match(answer.text, /BEFORE_RELOAD/);
  const before = await agentOf();
  assert.deepEqual(listed(before.instructions), ['first-skill']); pass('open-time prompt lists the open-time skills');

  skill('second-skill', 'Installed after the runtime opened.'); skill('third-skill', 'Also installed later.');
  assert.deepEqual(await agentOf(), before); pass('installing a skill does not change the running chat');

  failing = true;
  await assert.rejects(runtime.reload(), /unreadable/);
  assert.deepEqual(await agentOf(), before); pass('a failed rebuild leaves instructions, tools and extensions untouched');
  const delegated = randomUUID(); await runtime.plan({ work: [{ id: delegated, threadId: randomUUID(), role: 'worker', text: 'Reply exactly DONE_WORKER. FAKE-SAY DONE_WORKER' }] });
  for (let i = 0; i < 360; i++) { const work = (await runtime.planSnapshot()).work.find(item => item.id === delegated); if (work && ['completed', 'failed'].includes(work.status)) { assert.equal(work.status, 'completed'); break; } await sleep(500); }
  assert.ok(diagnostics.some(item => /unreadable/.test(String(item.message ?? item.error ?? JSON.stringify(item)))), 'discovery failure is reported'); pass('a failing catalog does not block delegation and is reported');

  failing = false;
  const result = await runtime.reload();
  const after = await agentOf();
  assert.equal(result.changed, true); assert.equal(result.chatId, 'main');
  assert.deepEqual(listed(after.instructions), ['first-skill', 'second-skill', 'third-skill']); pass('reload applies the fresh catalog to the chat prompt');
  assert.deepEqual(after.tools, before.tools); assert.deepEqual(after.extensions, before.extensions); pass('reload keeps the exact tool and extension bindings');
  assert.equal(after.instructions.replace(/\n\nSkills for your role[\s\S]*$/, ''), before.instructions.replace(/\n\nSkills for your role[\s\S]*$/, '')); pass('reload changes only the skill index of the prompt');
  assert.match((await runtime.say('Reply exactly AFTER_RELOAD.', { requestId: 'after' })).text, /AFTER_RELOAD/);
  const view = JSON.stringify(await runtime.snapshot());
  assert.ok(view.includes('BEFORE_RELOAD') && view.includes('AFTER_RELOAD')); pass('history survives the reload and the chat keeps answering');

  saveProject({ ...project, skillProfiles: { off: { coordinator: ['second-skill'] } } });
  assert.equal((await runtime.reload()).changed, true);
  assert.deepEqual(listed((await agentOf()).instructions), ['first-skill', 'third-skill']); pass('reload applies the owner\'s saved exclusions');
  assert.equal((await runtime.reload()).changed, false); pass('reload with nothing new reports no change');
  await assert.rejects(runtime.reload('00000000-0000-4000-8000-000000000000'), /Unknown chat/); pass('reload of an unknown chat is refused');
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: true, checks, diagnostics: diagnostics.length }, null, 2));
} catch (error) { writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: false, checks, error: String(error?.stack ?? error) }, null, 2)); throw error; }
finally { await runtime?.close(); fake.close(); process.stderr.write(`${join(base, 'report.json')}\n`); }
