// Real verifier settlement under owner controls, frozen settings and final-revision races.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit, call, say, randomUUID } from './lib/e2e-kit.mjs';

const gates = new Map();
const gate = key => { if (!gates.has(key)) gates.set(key, { seen: false, release: Promise.withResolvers() }); return gates.get(key); };
const wait = async key => { const g = gate(key); g.seen = true; await g.release.promise; };
const observations = [];
const earlyJobs = new Map();
const alive = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
const kit = await createKit('verification-settlement', { env: { PI_PROJECTS_LEASE_SWEEP_MS: '20', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, handler: async ({ role, user, results, tools, msgs }) => {
  const marker = /CASE-[A-Z-]+/.exec(JSON.stringify(msgs))?.[0] ?? 'none';
  if (tools.includes('projects_verify_run')) {
    if (results.some(r => /already ended as/.test(r))) return say('Verdict already recorded; end without more commands.');
    if (results.length === 0) return call('projects_skill_file', { skill: 'mini-verify' });
    if (results.length === 1) return call('projects_lease_acquire', { resource: `verify-${marker}`, ttlMinutes: 5 });
    if (marker.startsWith('CASE-EARLY')) {
      if (results.length === 2) return call('projects_bg_start', { command: "node -e 'setInterval(()=>{},1000)'", label: 'held verifier job' });
      if (results.length === 3) { earlyJobs.set(marker, JSON.parse(results.at(-1))); return call('projects_verify_run', { command: 'node check.mjs' }); }
    } else if (results.length === 2) return call('projects_verify_run', { command: 'node check.mjs' });
    if (results.length === (marker.startsWith('CASE-EARLY') ? 4 : 3)) {
      const run = JSON.parse(results.at(-1)), status = marker.includes('BLOCKED') ? 'blocked' : run.exitCode === 0 ? 'pass' : 'fail';
      return call('projects_verification_verdict', { summary: `${marker} ${status}`, criteria: [{ id: 'c1', status, reason: `${marker} feature check ${status}`, evidence: [{ runId: run.runId }] }] });
    }
    return say('Verdict recorded.');
  }
  if (role !== 'worker') return say('Finished.');
  if (results.length) {
    if (marker.startsWith('CASE-FREEZE') && !user.startsWith('FOLLOWUP')) await wait(`${marker}-worker`);
    return say(`${marker} worker finished`);
  }
  if (user.startsWith('[Automatic verification failed]') && /CASE-(MODEL|UNAVAILABLE)/.test(marker)) await wait(`${marker}-repair`);
  const command = user.startsWith('FOLLOWUP') ? 'echo forbidden > followup-effect.txt' : (/CASE-(MODEL|UNAVAILABLE)/.test(marker) || marker === 'CASE-FREEZE-FAIL') && !user.startsWith('[Automatic verification failed]') ? 'echo broken > feature.txt' : 'echo done > feature.txt';
  return call('bash', { command });
} });
Object.assign(kit.hostEnv, { XDG_CONFIG_HOME: join(kit.userHome, '.config') });
Object.assign(process.env, kit.hostEnv);
const entered = key => kit.eventually(() => gate(key).seen, key);
const observe = (name, ok, detail) => { observations.push({ name, ok, detail }); if (ok) kit.check(name, true); };
await kit.run(async () => {
  const modelsPath = join(kit.agentDir, 'models.json'), catalog = JSON.parse(readFileSync(modelsPath, 'utf8'));
  catalog.providers.fake.models.push({ ...catalog.providers.fake.models[0], id: 'fake-judge', name: 'Frozen judge' });
  writeFileSync(modelsPath, JSON.stringify(catalog));
  kit.initRepo();
  mkdirSync(join(kit.workspace, '.agents/skills/mini-verify'), { recursive: true });
  writeFileSync(join(kit.workspace, '.agents/skills/mini-verify/SKILL.md'), '---\nname: mini-verify\ndescription: Run node check.mjs to check feature.txt\n---\nRun node check.mjs and record the criterion.\n');
  writeFileSync(join(kit.workspace, 'feature.txt'), 'done\n');
  writeFileSync(join(kit.workspace, 'check.mjs'), "import {readFileSync} from 'node:fs'; process.exit(readFileSync('feature.txt','utf8').trim()==='done'?0:1);\n");
  kit.git(kit.workspace, 'add', '.'); kit.git(kit.workspace, 'commit', '-qm', 'verification fixture');
  const markers = ['CASE-PARTIAL', 'CASE-FREEZE-PASS', 'CASE-FREEZE-FAIL', 'CASE-MODEL', 'CASE-UNAVAILABLE', 'CASE-LEASE-PASS', 'CASE-LEASE-STALE', 'CASE-LEASE-ERROR', 'CASE-LEASE-BLOCKED', 'CASE-LEASE-STOP', 'CASE-LEASE-RESUME', 'CASE-EARLY-PARENT', 'CASE-EARLY-VERIFIER', 'CASE-EARLY-ERROR'];
  const projects = new Map();
  for (const marker of markers) {
    const id = await kit.createProject(marker, { workerCap: 1 });
    await kit.updateSettings(id, { models: { verifier: 'fake/fake-judge' }, verification: { enabled: true, skill: 'mini-verify' } });
    projects.set(marker, id);
  }
  await kit.stopHost();
  const { openDurableProject } = await import('../src/durable-runtime.ts');
  const { DurablePlanning } = await import('../src/durable-planning.ts');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { loadProject, saveProject, projectDir } = await import('../src/state.ts');
  const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
  const { updateProjectSettings, projectSettings } = await import('../src/project-settings.ts');
  const { hostLeases } = await import('../src/resource-leases.ts');
  for (const marker of markers) {
    console.log(marker);
    const id = projects.get(marker), threadId = randomUUID(), workId = randomUUID(); let runtime, heldOnce = false, verifierSettlements = 0;
    const originalReleaseWhere = hostLeases.releaseWhere; let sweeps = 0;
    const scopeId = loadProject(id).workspaceAuthorization.scopes[0].id;
    if (marker === 'CASE-PARTIAL') { const p = loadProject(id); delete p.workspaceAuthorization.scopes[0].wholeRepository; saveProject(p); }
    const open = async () => {
      const project = loadProject(id), loader = await loadProjectResourceLoader(project);
      runtime = await openDurableProject({ project, dir: projectDir(id), configuredSkillLoader: loader, discoverSkills: () => loadProjectResourceLoader(loadProject(id)), testBeforeWorkSettlement: async wid => {
        if (marker.startsWith('CASE-EARLY')) {
          if ((await runtime.planSnapshot()).work.find(w => w.id === wid)?.role === 'verifier') await wait(`${marker}-before-drain`);
          return;
        }
        if (marker === 'CASE-LEASE-RESUME') {
          const work = (await runtime.planSnapshot()).work.find(w => w.id === wid);
          if (work?.role === 'verifier' && ++verifierSettlements === 2) await wait(`${marker}-resumed-settlement`);
          return;
        }
        if (!marker.startsWith('CASE-FREEZE') || heldOnce) return;
        const work = (await runtime.planSnapshot()).work.find(w => w.id === wid);
        if (work?.role === 'verifier') { heldOnce = true; await wait(`${marker}-settlement`); }
      }, testBeforeWorkerAbort: async () => {
        if (!marker.startsWith('CASE-EARLY')) return;
        await wait(`${marker}-abort`);
        if (marker.endsWith('ERROR')) throw Error('deterministic early abort failure');
      }, testBeforeVerifierRevision: async () => {
        if (!marker.startsWith('CASE-LEASE') && !marker.startsWith('CASE-EARLY')) return;
        await wait(`${marker}-revision`);
        if (marker.endsWith('ERROR')) throw Error('deterministic final revision read failure');
      } });
    };
    const cycle = async () => (await runtime.planSnapshot()).verification?.[threadId];
    const ended = () => kit.eventually(async () => { const c = await cycle(); return c && !c.open ? c : false; }, `${marker} cycle settlement`);
    const dispatchSettled = () => runtime.withRoot(root => kit.eventually(() => root.commit(async tx => {
      const state = await tx.doc(DurablePlanning, root.id);
      for (const taskId of state.dispatcherTaskIds) if ((await tx.task(taskId)).state.status !== 'terminal') return false;
      return true;
    }, BACKGROUND_CONTEXT), `${marker} dispatcher barrier`));
    try {
      await open();
      await runtime.plan({ work: [{ id: workId, threadId, role: 'worker', workspaceScopeId: scopeId, text: `${marker}\n\nAcceptance criteria:\n- feature.txt contains done` }] });
      if (marker === 'CASE-PARTIAL') {
        const c = await ended();
        observe('folder-limited worker is honestly blocked without any verifier shell', c.outcome === 'escalated' && c.attempts.length === 0 && /whole|shell|scope/.test(c.reason), c);
      } else if (marker.startsWith('CASE-FREEZE')) {
        await entered(`${marker}-worker`);
        const queued = marker.endsWith('FAIL') ? await runtime.followUp(threadId, 'FOLLOWUP queued before verification', { requestId: randomUUID() }) : null;
        gate(`${marker}-worker`).release.resolve();
        await entered(`${marker}-settlement`);
        const before = await cycle(), verifier = before.attempts[0].verifierThreadId;
        await runtime.pauseWorker(verifier);
        let refusal = null;
        if (marker.endsWith('PASS')) {
          try { await runtime.followUp(threadId, 'FOLLOWUP forbidden during interrupted verification', { requestId: randomUUID() }); } catch (e) { refusal = String(e); }
          observe(`${marker} interrupted verifier keeps admission frozen`, /tree is frozen/.test(refusal), { refusal, before });
        }
        await runtime.applyWorkerCap(2); await dispatchSettled();
        const view = await runtime.planSnapshot(), parent = view.work.find(w => w.id === workId), queuedWork = view.work.find(w => w.id === queued?.attemptId);
        if (queued) observe(`${marker} interrupted verifier keeps queued dispatch frozen`, queuedWork?.status === 'queued' && !existsSync(join(parent.attempt.cwd, 'followup-effect.txt')), { queuedWork, view });
        gate(`${marker}-settlement`).release.resolve();
        if (refusal || queuedWork?.status === 'queued') {
          if (marker.endsWith('PASS')) {
            await runtime.close(); await open();
            observe('restart retains interrupted verifier freeze', (await cycle()).open && (await runtime.planSnapshot()).work.some(w => w.threadId === verifier && w.status === 'interrupted'), await runtime.planSnapshot());
            await runtime.resumePlan(); await runtime.resumeWorker(verifier);
            await ended();
            observe('resume after verdict settles honestly and releases parent', !(await cycle()).open, await cycle());
          } else {
            await runtime.stop(threadId);
            observe('stop ends interrupted cycle honestly and releases its leases', (await cycle()).outcome === 'escalated' && !hostLeases.held(h => h.projectId === id).length, await cycle());
          }
        }
      } else if (/CASE-(MODEL|UNAVAILABLE)/.test(marker)) {
        await entered(`${marker}-repair`);
        const before = loadProject(id), changed = updateProjectSettings(before, { action: 'settings-update', id, confirm: id, expectedRevision: projectSettings(before).revision, changes: { verification: { enabled: false, skill: 'mini-verify' }, models: { verifier: null } } });
        if (marker === 'CASE-UNAVAILABLE') { const removed = structuredClone(catalog); removed.providers.fake.models = removed.providers.fake.models.filter(m => m.id !== 'fake-judge'); writeFileSync(modelsPath, JSON.stringify(removed)); }
        await runtime.applyModels(changed); saveProject(changed);
        if (marker === 'CASE-UNAVAILABLE') {
          await runtime.pauseWorker(threadId);
          gate(`${marker}-repair`).release.resolve();
          await runtime.close(); await open();
          await runtime.resumePlan(); await runtime.resumeWorker(threadId);
        } else gate(`${marker}-repair`).release.resolve();
        const c = await ended();
        observe(marker === 'CASE-MODEL' ? 'disable and clear keeps the installed frozen judge for the repair' : 'truly unavailable frozen judge escalates without fallback', marker === 'CASE-MODEL' ? c.outcome === 'verified' && c.model === 'fake/fake-judge' && c.attempts.length === 2 : c.outcome === 'escalated' && /unavailable|not.*(?:found|available|configured)|unknown|not in/i.test(c.reason) && c.attempts.length === 1, c);
      } else if (marker.startsWith('CASE-EARLY')) {
        await entered(`${marker}-before-drain`);
        const c = await cycle(), verifier = c.attempts[0].verifierThreadId, job = earlyJobs.get(marker), resource = `verify-${marker}`, contender = { projectId: id, threadId: 'other-holder' };
        hostLeases.releaseWhere = function(predicate) { const result = originalReleaseWhere.call(this, predicate); sweeps++; return result; };
        let stopDone = false;
        const stopping = runtime.stop(marker.endsWith('PARENT') ? threadId : verifier).then(() => ({ ok: true }), error => ({ error: String(error) })).finally(() => { stopDone = true; });
        await entered(`${marker}-abort`);
        await kit.eventually(() => sweeps >= 1, 'actual sweeper runs during early stop');
        const before = await hostLeases.acquire(resource, contender, 60000);
        observe(`${marker} retains lease before abort while job is active`, !before.acquired && alive(job.pid) && !gate(`${marker}-revision`).seen, { before, job });
        if (before.acquired) hostLeases.release(resource, contender);
        gate(`${marker}-abort`).release.resolve();
        await kit.eventually(() => !alive(job.pid) || stopDone, 'command drain or early stop result');
        observe(`${marker} drains commands even on early abort failure`, !alive(job.pid), { stopDone });
        await hostLeases.acquire(resource, { projectId: id, threadId: verifier }, 300000);
        const count = sweeps; await kit.eventually(() => sweeps >= count + 1, 'sweeper while pending settlement has not begun validation');
        const pending = await hostLeases.acquire(resource, contender, 60000);
        observe(`${marker} joins pending settlement before releasing`, !pending.acquired && !stopDone, { pending, stopDone });
        if (pending.acquired) hostLeases.release(resource, contender);
        gate(`${marker}-before-drain`).release.resolve(); await entered(`${marker}-revision`);
        const validating = await hostLeases.acquire(resource, contender, 60000);
        observe(`${marker} retains lease through actual final validation`, !validating.acquired && !stopDone, { validating, stopDone });
        if (validating.acquired) hostLeases.release(resource, contender);
        gate(`${marker}-revision`).release.resolve(); const result = await stopping;
        await kit.eventually(() => !hostLeases.held(h => h.projectId === id).length, 'early stop releases after all cleanup');
        const after = await hostLeases.acquire(resource, contender, 60000);
        const stopped = await runtime.withRoot(root => root.commit(async tx => Boolean((await tx.doc(DurablePlanning, root.id)).threads[verifier].stopping), BACKGROUND_CONTEXT));
        observe(`${marker} releases without leaking stop state or hiding errors`, after.acquired && !stopped && (marker.endsWith('ERROR') ? /deterministic early abort failure/.test(result.error) : result.ok), { after, stopped, result });
        hostLeases.release(resource, contender);
      } else {
        await entered(`${marker}-revision`);
        const c = await cycle(), verifier = c.attempts[0].verifierThreadId, resource = `verify-${marker}`, contender = { projectId: id, threadId: 'other-holder' };
        const attempt = await hostLeases.acquire(resource, contender, 60000);
        observe(`${marker} lease stays held through final validation`, !attempt.acquired, { attempt, c });
        if (attempt.acquired) hostLeases.release(resource, contender);
        if (marker.endsWith('STALE')) { const view = await runtime.planSnapshot(); writeFileSync(join(view.work.find(w => w.id === workId).attempt.cwd, 'feature.txt'), 'external drift\n'); }
        const stopping = marker.endsWith('STOP') ? runtime.stop(verifier) : null;
        if (stopping) await kit.eventually(async () => (await cycle()).outcome === 'escalated', 'stop committed before releasing validation');
        if (marker.endsWith('RESUME')) {
          const oldSettlement = await runtime.withRoot(root => root.commit(async tx => (await tx.scanTasks({ conversationId: root.id, kind: 'projects.plan-settlement' }, 100)).items.find(t => t.input.workId !== workId), BACKGROUND_CONTEXT));
          await runtime.pauseWorker(verifier); await runtime.resumeWorker(verifier);
          await entered(`${marker}-resumed-settlement`);
          gate(`${marker}-revision`).release.resolve();
          await runtime.withRoot(root => kit.eventually(() => root.commit(async tx => (await tx.task(oldSettlement.id)).state.status === 'terminal', BACKGROUND_CONTEXT), 'obsolete settlement terminal'));
          const resumed = await hostLeases.acquire(resource, contender, 60000);
          observe('obsolete settlement cannot release the resumed verifier lease', !resumed.acquired, resumed);
          if (resumed.acquired) hostLeases.release(resource, contender);
          gate(`${marker}-resumed-settlement`).release.resolve();
        } else gate(`${marker}-revision`).release.resolve();
        if (stopping) await stopping;
        const result = await ended();
        await kit.eventually(() => !hostLeases.held(h => h.projectId === id).length, `${marker} releases after settlement`);
        const after = await hostLeases.acquire(resource, contender, 60000);
        observe(`${marker} releases after honest settlement`, after.acquired && ((marker.endsWith('PASS') || marker.endsWith('RESUME')) ? result.outcome === 'verified' : result.outcome === 'escalated') && result.attempts[0].state === ((marker.endsWith('PASS') || marker.endsWith('RESUME')) ? 'pass' : marker.endsWith('STALE') ? 'stale' : 'blocked'), result);
        hostLeases.release(resource, contender);
      }
    } catch (e) { observations.push({ name: marker, ok: false, error: String(e?.stack ?? e) }); }
    finally {
      hostLeases.releaseWhere = originalReleaseWhere;
      for (const [key, g] of gates) if (key.startsWith(marker)) g.release.resolve();
      await runtime?.close(); hostLeases.releaseWhere(h => h.projectId === id);
      writeFileSync(modelsPath, JSON.stringify(catalog));
    }
  }
  kit.result.regressions = observations;
  kit.check('all verifier authority, freeze, model and lease regressions', observations.length === 36 && observations.every(x => x.ok), observations.filter(x => !x.ok));
});
