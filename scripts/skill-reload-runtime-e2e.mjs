import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FAKE_MODEL, startFakeModel } from './fake-model.mjs';

// Runtime-level /reload: rebuilds one chat's prompt (saved project settings, repository AGENTS.md, skill catalog) and offered tools (saved grants, revocations) in a single commit.
// History, other chats and existing workers are untouched, a failed rebuild leaves the chat as it was, and a discovery failure never blocks a delegation.
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
const project = { version: 1, id, runtime: 'durable', context: { autoCompact: false, contextWindow: 20000, keepRecentTokens: 2000 }, name: 'Skill reload', cwd: workspace, objective: 'Verify reload semantics', createdAt: new Date().toISOString(), model, models: { worker: model, scout: model, reviewer: model }, sessionFile: null, phase: 'ready', problem: null, runs: [] };
writeFileSync(join(workspace, 'AGENTS.md'), 'STANDING-ONE: be terse.\n');
saveProject(project);
const checks = [], diagnostics = [];
const systemOf = (marker, role = 'persistent coordinator') => fake.requests.findLast(item => item.user.includes(marker) && item.system.includes(role))?.system ?? '';
const pass = name => { checks.push(name); process.stderr.write(`PASS ${name}\n`); };
let failing = false, runtime;
const discoverSkills = () => failing ? Promise.reject(new Error('skill directory unreadable')) : loadProjectResourceLoader(project);
const agentOf = () => runtime.withRoot(async root => { const agent = await root.agent(BACKGROUND_CONTEXT); return { instructions: agent.instructions, tools: agent.tools.map(tool => tool.name).sort(), extensions: agent.extensions.map(extension => extension.name).sort() }; });
const listed = instructions => [...instructions.matchAll(/^- ([\w-]+): /gm)].map(match => match[1]).sort();
try {
  runtime = await openDurableProject({ project, dir, configuredSkillLoader: await loadProjectResourceLoader(project), discoverSkills, onReport: value => diagnostics.push(value) });
  const say = async (text, chat) => {
    const requestId = randomUUID(), { submissionId } = await runtime.admit(text, { requestId, ...(chat && chat !== 'main' ? { chatId: chat } : {}) });
    if (!chat || chat === 'main') return runtime.wait(submissionId);
    for (let i = 0; i < 360; i++) { const found = (await runtime.chatSubmissions(chat)).find(item => item.requestId === requestId); if (found && ['done', 'failed'].includes(found.status)) return found; await sleep(500); }
    throw new Error('chat turn did not settle');
  };
  const chatB = await runtime.chatCreate('Other chat');
  await say('Reply exactly BEFORE_RELOAD.'); await say('Reply exactly OTHER_BEFORE.', chatB.id);
  const before = await agentOf(), otherBefore = systemOf('OTHER_BEFORE'), mainBefore = systemOf('BEFORE_RELOAD');
  assert.deepEqual(listed(before.instructions), ['first-skill']); assert.match(mainBefore, /STANDING-ONE/); pass('open-time prompt has the open-time skills and AGENTS.md');
  const workerId = randomUUID(), workerThread = randomUUID();
  await runtime.plan({ work: [{ id: workerId, threadId: workerThread, role: 'worker', text: 'Reply exactly WORKER_ONE. FAKE-SAY WORKER_ONE' }] });
  const waitWork = async (id, threadId) => { for (let i = 0; i < 360; i++) { const work = (await runtime.planSnapshot()).work.find(item => item.id === id); if (work && ['completed', 'failed'].includes(work.status)) return work; await sleep(500); } throw new Error('worker did not settle'); };
  assert.equal((await waitWork(workerId)).status, 'completed');
  const workerSystem = systemOf('WORKER_ONE', 'persistent background worker');
  assert.ok(workerSystem && !/second-skill/.test(workerSystem));

  // Things change on disk and in the saved project; nothing moves until /reload.
  skill('second-skill', 'Installed after the runtime opened.'); skill('third-skill', 'Also installed later.');
  writeFileSync(join(workspace, 'AGENTS.md'), 'STANDING-TWO: always run the tests.\n');
  const saved = { ...project, prompts: { coordinator: 'ROLE-PROMPT-TWO: coordinate carefully.' }, libraryAccess: 'coordinator', decisionAccess: 'coordinator', githubCli: 'none', skillProfiles: { off: { coordinator: ['third-skill'] } } };
  saveProject(saved);
  assert.deepEqual(await agentOf(), before); pass('edited files and saved settings do not change a running chat by themselves');

  failing = true;
  await assert.rejects(runtime.reload(), /unreadable/);
  assert.deepEqual(await agentOf(), before); pass('a failed skill rebuild leaves the chat untouched');
  failing = false;
  unlinkSync(join(workspace, 'AGENTS.md')); symlinkSync(join(workspace, 'elsewhere.md'), join(workspace, 'AGENTS.md'));
  await assert.rejects(runtime.reload(), /standing resource/);
  assert.deepEqual(await agentOf(), before); pass('an unreadable AGENTS.md fails the reload atomically');
  unlinkSync(join(workspace, 'AGENTS.md')); writeFileSync(join(workspace, 'AGENTS.md'), 'STANDING-TWO: always run the tests.\n');

  const result = await runtime.reload();
  const after = await agentOf();
  assert.equal(result.changed, true); assert.equal(result.chatId, 'main');
  assert.deepEqual(listed(after.instructions), ['first-skill', 'second-skill']); pass('reload applies the fresh catalog with the saved opt-outs');
  assert.match(after.instructions, /STANDING-TWO/); assert.doesNotMatch(after.instructions, /STANDING-ONE/); pass('reload re-reads the repository AGENTS.md');
  assert.match(after.instructions, /ROLE-PROMPT-TWO/); assert.match(after.instructions, /projects_question/); assert.match(after.instructions, /projects_library_read/); assert.doesNotMatch(after.instructions, /projects_gh runs any gh/); pass('reload rebuilds the prompt from the saved project (role prompt and grants)');
  for (const name of ['projects_library_list', 'projects_library_read', 'projects_question']) assert.ok(after.tools.includes(name) && !before.tools.includes(name), name);
  assert.ok(before.tools.includes('projects_gh') && !after.tools.includes('projects_gh')); pass('reload grants and revokes tool bindings from the saved project');
  assert.deepEqual(after.extensions, before.extensions);
  await say('Reply exactly OTHER_AFTER.', chatB.id);
  assert.equal(systemOf('OTHER_AFTER'), otherBefore); pass('another chat keeps its prompt');
  const readSecond = await say('Read it. FAKE-CALL projects_skill_file {"skill":"second-skill"}', 'main');
  const readOther = await say('Read it. FAKE-CALL projects_skill_file {"skill":"second-skill"}', chatB.id);
  assert.match(readSecond.text, /BODY-second-skill/); assert.match(readOther.text, /not in your role's skill set/); pass('only the reloaded chat may read the new skill');
  assert.match((await say('Reply exactly AFTER_RELOAD.')).text, /AFTER_RELOAD/);
  assert.match(systemOf('AFTER_RELOAD'), /STANDING-TWO/); assert.match(systemOf('AFTER_RELOAD'), /ROLE-PROMPT-TWO/); pass('the next turn really sends the rebuilt prompt to the model');
  const view = JSON.stringify(await runtime.snapshot());
  assert.ok(view.includes('BEFORE_RELOAD') && view.includes('AFTER_RELOAD')); pass('history survives the reload and the chat keeps answering');

  await runtime.followUp(workerThread, 'Reply exactly WORKER_TWO. FAKE-SAY WORKER_TWO', { requestId: randomUUID() });
  for (let i = 0; i < 360 && !(await runtime.planSnapshot()).work.some(w => w.threadId === workerThread && w.text.includes('WORKER_TWO') && w.status === 'completed'); i++) await sleep(500);
  assert.equal(systemOf('WORKER_TWO', 'persistent background worker'), workerSystem); pass('an existing worker keeps its frozen prompt');

  // The allow-list freezes names, not contents: an allowed name reads the skill as it is now (documented in WORKER-SKILLS.md).
  writeFileSync(join(workspace, '.pi', 'skills', 'first-skill', 'SKILL.md'), '---\nname: first-skill\ndescription: Present when the runtime opened.\n---\n\nBODY-first-skill-EDITED\n');
  assert.match((await say('Read it. FAKE-CALL projects_skill_file {"skill":"first-skill"}', 'main')).text, /BODY-first-skill-EDITED/); pass('an allowed skill name reads its current content, not a frozen copy');

  // A chat created after Main's reload inherits Main's prompt, tools and skill list together, not the open-time prompt.
  const chatC = await runtime.chatCreate('After reload');
  await say('Reply exactly C_FIRST.', chatC.id);
  const mainRequest = fake.requests.findLast(item => item.user.includes('AFTER_RELOAD') && item.system.includes('persistent coordinator')), cRequest = fake.requests.findLast(item => item.user.includes('C_FIRST'));
  assert.equal(cRequest.system, mainRequest.system); assert.deepEqual([...cRequest.tools].sort(), [...mainRequest.tools].sort());
  assert.match(cRequest.system, /STANDING-TWO/); assert.match(cRequest.system, /second-skill/);
  assert.match((await say('Read it. FAKE-CALL projects_skill_file {"skill":"second-skill"}', chatC.id)).text, /BODY-second-skill/); pass('a new chat after Main reload gets the same prompt, tools and skill list');
  const chatD = await runtime.chatCreate('Before second reload');

  // Admission paths that skip the owner lock (worker results, scheduled and background input) and automatic compaction: the swap itself refuses.
  const { configureWhenIdle } = await import('../src/durable-idle-configure.ts');
  const swapNow = () => runtime.withRoot(root => configureWhenIdle(root, root, { instructions: 'SWAPPED' }, BACKGROUND_CONTEXT));
  fake.hold.ms = 2500;
  const slow = await runtime.withRoot(root => root.submit({ type: 'input', content: 'Reply exactly RACE_TURN.', requestId: randomUUID(), whenBusy: 'followUp' }, BACKGROUND_CONTEXT));
  const beforeRace = await agentOf();
  await assert.rejects(swapNow(), /working/); await assert.rejects(runtime.reload(), /working/);
  assert.deepEqual(await agentOf(), beforeRace); pass('a turn admitted outside the owner lock blocks the swap and nothing changes');
  await runtime.withRoot(async root => { await (await slow).wait(BACKGROUND_CONTEXT); }); fake.hold.ms = 0;
  for (const n of [1, 2, 3]) await say(`Reply exactly PAD_${n}. ${'padding words '.repeat(900)}`);
  fake.hold.ms = 2500;
  let compactError; const compacting = runtime.compact('main').catch(error => { compactError = error; });
  let refused = false;
  for (let i = 0; i < 60 && !(await runtime.snapshot()).coordinator?.context?.compacting; i++) await sleep(50);
  if (!(await runtime.snapshot()).coordinator?.context?.compacting) { fake.hold.ms = 0; await compacting; assert.fail(`compaction never became visible (${compactError ?? 'no error'}; ${JSON.stringify(diagnostics.slice(-2).map(d => String(d?.message ?? d).slice(0, 300)))}; ${fake.requests.slice(-2).map(r => r.user.slice(0, 80)).join(' // ')})`); }
  try { await swapNow(); } catch (error) { refused = /compacting/.test(String(error)); }
  fake.hold.ms = 0; await compacting;
  for (let i = 0; i < 200 && (await runtime.snapshot()).coordinator?.context?.compacting; i++) await sleep(100);
  await agentOf();
  assert.ok(refused, `compaction must block the swap (${compactError ?? 'no compaction error'})`); pass('a running compaction blocks the swap');

  // Revocation: switching the grants off again removes the tools at the next reload.
  saveProject({ ...saved, libraryAccess: undefined, decisionAccess: undefined, githubCli: undefined });
  assert.equal((await runtime.reload()).changed, true);
  const revoked = await agentOf();
  for (const name of ['projects_library_list', 'projects_library_read', 'projects_question']) assert.ok(!revoked.tools.includes(name), name);
  assert.ok(revoked.tools.includes('projects_gh')); pass('revoked grants are removed at the next reload');
  const chatE = await runtime.chatCreate('After revocation');
  await say('Reply exactly E_FIRST.', chatE.id); await say('Reply exactly MAIN_REVOKED.');
  const eRequest = fake.requests.findLast(item => item.user.includes('E_FIRST')), mainRevoked = fake.requests.findLast(item => item.user.includes('MAIN_REVOKED'));
  assert.equal(eRequest.system, mainRevoked.system); assert.deepEqual([...eRequest.tools].sort(), [...mainRevoked.tools].sort());
  assert.ok(!eRequest.tools.includes('projects_library_read') && eRequest.tools.includes('projects_gh'));
  pass('a chat created after a revoking reload is offered exactly Main\'s reduced prompt and tools');
  assert.equal((await runtime.reload()).changed, false); pass('reload with nothing new reports no change');
  await assert.rejects(runtime.reload('00000000-0000-4000-8000-000000000000'), /Unknown chat/); pass('reload of an unknown chat is refused');
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: true, checks, diagnostics: diagnostics.length }, null, 2));
} catch (error) { writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: false, checks, error: String(error?.stack ?? error) }, null, 2)); throw error; }
finally { await runtime?.close(); fake.close(); process.stderr.write(`${join(base, 'report.json')}\n`); }
