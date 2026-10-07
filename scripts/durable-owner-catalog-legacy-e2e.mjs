#!/usr/bin/env node
// Legacy upgrade proof: a real baseline host creates the durable records, then the
// current host adds only the root workspace-catalog tool on reopen.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { applyImmutable } from '@earendil-works/chord/delta';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = resolve('.');
const base = resolve('artifacts', `owner-catalog-legacy-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
const oldRoot = join(base, 'old'), stateRoot = join(base, 'state'), workspace = join(base, 'workspace'), approved = join(base, 'approved');
mkdirSync(oldRoot, { recursive: true }); mkdirSync(stateRoot); mkdirSync(workspace); mkdirSync(approved);
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const sourceFiles = ['src/client.ts', 'src/host.ts', 'src/durable-runtime.ts', 'src/durable-planning.ts', 'src/workspace-authorization.ts'];
const sourceBefore = Object.fromEntries(sourceFiles.map(p => [p, sha(p)]));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const ownerGit = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
const oldEnv = { ...process.env, PI_PROJECTS_HOME: stateRoot };
// The archive is read-only; unpack it into this disposable source fixture.
execFileSync('sh', ['-c', `git archive 8605a268835af2fb01c3615c07440129b9ef0981 | tar -x -C ${JSON.stringify(oldRoot)}`], { cwd: repo });
symlinkSync(join(repo, 'node_modules'), join(oldRoot, 'node_modules'));
writeFileSync(join(workspace, 'README.txt'), 'legacy fixture\n'); ownerGit('init', '-b', 'main'); ownerGit('config', 'user.email', 'legacy@example.invalid'); ownerGit('config', 'user.name', 'Legacy E2E'); ownerGit('add', '.'); ownerGit('commit', '-m', 'fixture');
const baseRevision = ownerGit('rev-parse', 'HEAD');
const physical = path => { try { const s = lstatSync(path); return { exists: true, dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), uid: String(s.uid), gid: String(s.gid), size: s.size }; } catch (e) { return e?.code === 'ENOENT' ? { exists: false, error: 'ENOENT' } : (() => { throw e; })(); } };
const treeState = root => { const out = {}; const visit = dir => { for (const name of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, name.name); out[p] = { physical: physical(p), sha256: name.isFile() ? sha(p) : null }; if (name.isDirectory() && !name.isSymbolicLink()) visit(p); } }; visit(root); return out; };
const sourceTreeBefore = Object.fromEntries([...sourceFiles, 'scripts/durable-owner-catalog-legacy-e2e.mjs', 'package.json', 'package-lock.json'].filter(p => existsSync(p)).map(p => [p, { physical: physical(p), sha256: sha(p) }]));
const assertTaskTerminalSuccess = (row, label, requireResultStatus = false) => { assert.ok(row, `${label} missing`); assert.equal(row.status, 'terminal', `${label} must be terminal`); assert.equal(row.record?.id, row.id, `${label} row/record ID mismatch`); assert.equal(row.record?.conversationId, row.conversation_id, `${label} row/record conversation mismatch`); assert.equal(row.record?.kind, row.kind, `${label} row/record kind mismatch`); assert.equal(row.record?.state?.status, 'terminal', `${label}.record.state must be terminal`); const outcome = row.record?.state?.outcome; assert.ok(outcome, `${label}.record.state.outcome missing`); assert.equal(outcome.status, 'completed', `${label} outcome is not successful`); if (requireResultStatus) assert.equal(outcome.result?.status, 'completed', `${label} result is not successful`); return outcome; };
const assertSubmissionDone = (row, label) => { assert.ok(row, `${label} missing`); assert.equal(row.record?.id, row.id, `${label} row/record ID mismatch`); assert.equal(row.record?.conversationId, row.conversation_id, `${label} row/record conversation mismatch`); assert.equal(row.status, 'done', `${label} is not successful`); assert.equal(row.record?.status, 'done', `${label}.record is not successful`); };
const finiteId = (value, label) => { assert.ok(Number.isInteger(value) && value >= 0, `${label} must be a finite numeric ID`); return value; };
const jsonHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileState = paths => Object.fromEntries(paths.map(path => { try { const s = lstatSync(path); return [path, { exists: true, sha256: s.isFile() ? sha(path) : null, physical: physical(path) }]; } catch (e) { if (e.code === 'ENOENT') return [path, { exists: false, error: 'ENOENT' }]; throw e; } }));
const ownerPaths = () => [workspace, join(workspace, 'README.txt'), join(workspace, '.git'), join(workspace, 'durable.sqlite'), join(workspace, 'durable.sqlite-wal'), join(workspace, 'durable.sqlite-shm')];
const ownerBefore = { files: fileState(ownerPaths()), git: { head: baseRevision, status: ownerGit('status', '--porcelain=v1'), tree: ownerGit('rev-parse', 'HEAD^{tree}') } };
function folded(db) {
  const docs = db.prepare('select id, kind, owner_id, record from documents order by id').all();
  const revs = db.prepare('select document_id, seq, content from document_revisions order by document_id, seq').all();
  return docs.map(d => { let latest = null; for (const r of revs.filter(x => x.document_id === d.id)) { const c = JSON.parse(r.content); latest = Array.isArray(c) ? applyImmutable(latest, c) : c; } return { ...d, kind: d.kind.replaceAll('"', ''), latest }; });
}
function inspect(label) {
  const project = JSON.parse(readFileSync(join(stateRoot, projectId, 'project.json')));
  const path = join(stateRoot, projectId, 'durable.sqlite');
  const storage = fileState([path, `${path}-wal`, `${path}-shm`]);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
  const conversations = db.prepare('select id, owner_conversation_id, owner_task_id from conversations order by id').all();
  const submissions = db.prepare('select id, conversation_id, request_id, status, record from submissions order by id').all().map(r => ({ ...r, record: JSON.parse(r.record) }));
  const entries = db.prepare('select id, conversation_id, commit_seq, record from entries order by id').all().map(r => ({ ...r, record: JSON.parse(r.record) }));
  const documents = folded(db);
  const tasks = db.prepare('select id, conversation_id, kind, status, record from tasks order by id').all().map(r => { const actualRawSqlKind = r.kind; const kind = JSON.parse(actualRawSqlKind); assert.equal(typeof kind, 'string', 'task SQL kind must decode to a string'); return { ...r, kind, record: JSON.parse(r.record) }; });
  const calls = [], results = [];
  for (const e of entries) for (const m of e.record.model ?? []) {
    if (m.role === 'assistant') for (const p of m.content ?? []) if (p.type === 'toolCall') calls.push({ id: p.id, name: p.name, arguments: p.arguments, conversationId: e.conversation_id, commitSeq: e.commit_seq });
    if (m.role === 'toolResult') results.push({ toolCallId: m.toolCallId, name: m.toolName, isError: m.isError, text: (m.content ?? []).map(p => p.text ?? '').join(''), conversationId: e.conversation_id, commitSeq: e.commit_seq });
  }
  const planning = documents.find(d => d.kind === 'projects.durable-planning')?.latest ?? null;
  const identity = documents.find(d => d.kind === 'projects.durable-identity')?.latest ?? null;
  const agents = documents.filter(d => d.kind === 'pi.agent').map(d => ({ ownerId: d.owner_id, id: d.id, value: d.latest }));
  const delegate = calls.find(c => c.name === 'projects_delegate');
  const workId = delegate ? results.find(r => r.toolCallId === delegate.id && !r.isError)?.text : null;
  const workerReplies = entries.filter(e => e.conversation_id !== identity?.coordinatorConversationId).flatMap(e => (e.record.model ?? []).filter(m => m.role === 'assistant').flatMap(m => (m.content ?? []).filter(p => p.type === 'text').map(p => p.text ?? '')));
  const allocation = documents.find(d => d.kind === 'projects.workspace-isolation')?.latest ?? null;
  return { label, project, storage, conversations, entries, documents, agents, planning, identity, tasks, submissions, calls, results, delegate, workId, workerReplies, allocation };
  } finally { db.close(); }
}
let projectId, oldClient, currentClient, oldPid, currentPid;
async function loadClient(root) { return import(`file://${join(root, 'src/client.ts')}?${randomUUID()}`); }
async function stop(client, pid) {
  if (!pid) return { pid: null, stopping: true };
  const requestedAt = new Date().toISOString();
  const ack = await client.request({ action: 'shutdown' }, false);
  assert.deepEqual(ack, { stopping: true });
  const end = Date.now() + 20000;
  let esrchAt;
  while (Date.now() < end) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { esrchAt = new Date().toISOString(); break; } throw e; } await sleep(100); }
  assert.ok(esrchAt, `host ${pid} did not exit`);
  let serviceError;
  try { await client.health(); } catch (e) { serviceError = { code: e.code, name: e.name, message: String(e.message) }; }
  assert.ok(serviceError && ['ECONNREFUSED', 'ENOENT'].includes(serviceError.code), `unexpected post-close service result: ${JSON.stringify(serviceError)}`);
  return { stateRoot, pid, socketIdentity: { pid, projectId }, request: { action: 'shutdown', requestedAt }, ack, esrchAt, serviceError };
}
async function waitShow(client, predicate) { const end = Date.now() + 120000; let view; while (Date.now() < end) { view = await client.request({ action: 'show', id: projectId }); if (predicate(view)) return view; await sleep(500); } throw new Error(`timed out waiting for terminal state: ${JSON.stringify(view)}`); }
try {
  process.env.PI_PROJECTS_HOME = stateRoot;
  oldClient = await loadClient(oldRoot); await oldClient.ensureHost(); oldPid = (await oldClient.health()).pid;
  const made = await oldClient.request({ action: 'create', name: 'Legacy catalog upgrade', cwd: workspace, objective: 'Reply-only legacy migration fixture.', model: 'openai-codex/gpt-5.6-terra' });
  projectId = made.id;
  const prompt = 'You are the coordinator. Exactly once, call projects_delegate with arguments {"role":"worker","task":"Reply with exactly LEGACY_WORKER_REPLY. Do not use any tools or edit files.","workspaceScopeId": null, "requiredTools": []}. The worker task is reply-only: no implementation, owner tools, filesystem, VCS, network, Arc, or database actions. After the worker completes, reply briefly.';
  const job = await oldClient.request({ action: 'message', id: projectId, text: prompt });
  const oldView = await waitShow(oldClient, v => v.jobs.some(j => j.id === job.id && j.state === 'done') && !v.busy);
  let old = inspect('old');
  const planningDeadline = Date.now() + 120000;
  while (Date.now() < planningDeadline) {
    const delegated = old.delegate && old.results.find(r => r.toolCallId === old.delegate.id && !r.isError);
    const candidate = delegated ? old.planning.work[JSON.parse(delegated.text).workId] : null;
    if (candidate?.status === 'completed' && candidate.attempt?.startedAt && candidate.attempt?.endedAt) break;
    await sleep(500); await oldClient.request({ action: 'show', id: projectId }); old = inspect('old-settled');
  }
  assert.equal(oldView.jobs.find(j => j.id === job.id).state, 'done');
  assert.equal(old.calls.filter(c => c.name === 'projects_delegate').length, 1);
  assert.ok(old.workerReplies.some(text => text.includes('LEGACY_WORKER_REPLY')), 'actual old worker reply missing');
  assert.ok(old.submissions.length >= 2, `expected coordinator and worker submissions: ${JSON.stringify(old.submissions)}`);
  old.submissions.forEach((row, i) => assertSubmissionDone(row, `old submission ${i}`));
  old.tasks.forEach((row, i) => assertTaskTerminalSuccess(row, `old task ${i}`));
  const delegateCall = old.delegate; assert.ok(delegateCall); assert.equal(delegateCall.conversationId, old.identity.coordinatorConversationId);
  const delegateArguments = delegateCall.arguments; assert.equal(delegateArguments.role, 'worker'); assert.equal(delegateArguments.task, 'Reply with exactly LEGACY_WORKER_REPLY. Do not use any tools or edit files.');
  const delegateResult = old.results.find(r => r.toolCallId === delegateCall.id && !r.isError); assert.ok(delegateResult); assert.equal(delegateResult.conversationId, delegateCall.conversationId);
  const delegatePayload = JSON.parse(delegateResult.text); assert.ok(delegatePayload.workId); assert.ok(delegatePayload.threadId);
  const work = old.planning.work[delegatePayload.workId]; assert.ok(work && work.status === 'completed'); assert.equal(delegatePayload.workId, work.id); assert.equal(delegatePayload.threadId, work.threadId); assert.equal(work.requiredTools?.length ?? 0, 0); assert.equal(work.workspaceScopeId, null); assert.equal(work.role, delegateArguments.role); assert.equal(work.text, delegateArguments.task); assert.ok(work.attempt?.startedAt && work.attempt?.endedAt);
  assert.ok(work.conversationId && work.taskId, 'actual worker conversation/task correlation missing');
  assert.equal(old.planning.threads[work.threadId]?.conversationId, work.conversationId);
  const rootConversationId = finiteId(old.identity.coordinatorConversationId, 'root conversation ID');
  const dispatcherTaskId = finiteId(old.planning.dispatcherTaskIds?.[0], 'dispatcher task ID');
  const dispatcherTask = old.tasks.find(t => t.id === dispatcherTaskId); assertTaskTerminalSuccess(dispatcherTask, 'dispatcher task'); assert.equal(dispatcherTask.kind, 'projects.plan-dispatcher'); assert.equal(dispatcherTask.conversation_id, rootConversationId); assert.equal(dispatcherTask.record.conversationId, rootConversationId);
  const workerTask = old.tasks.find(t => t.record.input?.workId === delegatePayload.workId); assert.ok(workerTask); finiteId(workerTask.id, 'worker attempt task ID'); assert.equal(workerTask.kind, 'projects.plan-attempt'); assert.equal(workerTask.conversation_id, rootConversationId); assert.equal(workerTask.record.conversationId, rootConversationId); assert.equal(work.taskId, workerTask.id, 'work.taskId must equal actual attempt task ID');
  assert.equal(workerTask.record.input.planConversationId, rootConversationId); assert.equal(workerTask.record.input.workId, work.id); assert.equal(workerTask.record.input.conversationId, work.conversationId); assert.equal(workerTask.record.input.threadId, work.threadId); assert.equal(workerTask.record.input.role, work.role); assert.equal(workerTask.record.input.text, work.text); assertTaskTerminalSuccess(workerTask, 'worker attempt', true);
  const workerId = old.planning.threads[work.threadId].conversationId; finiteId(workerId, 'worker conversation ID'); assert.notEqual(workerId, rootConversationId);
  const workerSubmission = old.submissions.find(s => s.record.conversationId === workerId && s.record.requestId === workerTask.record.input.requestId); assert.ok(workerSubmission, 'worker submission missing'); finiteId(workerSubmission.id, 'worker submission ID'); assert.equal(workerSubmission.conversation_id, workerId); assert.equal(workerSubmission.record.conversationId, workerId);
  const workerInput = old.entries.find(e => e.id === workerSubmission.record.entry && e.conversation_id === workerId); assert.ok(workerInput, 'worker input entry missing'); finiteId(workerInput.id, 'worker input entry ID'); assert.equal(workerInput.record.id, workerInput.id); assert.equal(workerInput.record.conversationId, workerInput.conversation_id); assert.equal(workerInput.record.model?.[0]?.role, 'user'); assert.equal(workerInput.record.model?.[0]?.content, work.text);
  const workerGenerations = old.tasks.filter(t => t.conversation_id === workerId && t.record.kind === 'pi.generation'); assert.ok(workerGenerations.length > 0, 'worker generation missing'); workerGenerations.forEach((generation, i) => { finiteId(generation.id, `worker generation ${i} ID`); const outcome = assertTaskTerminalSuccess(generation, `worker generation ${i}`); const answerId = finiteId(outcome.result?.entryId, `worker generation ${i} answer entry ID`); assert.equal(answerId, workerSubmission.record.answer, 'worker answer must be generation result'); const answer = old.entries.find(e => e.id === answerId && e.conversation_id === workerId && e.record.byTaskId === generation.id); assert.ok(answer, 'worker answer entry correlation missing'); assert.equal(answer.record.id, answer.id); assert.equal(answer.record.conversationId, answer.conversation_id); const response = (answer.record.model ?? []).find(m => m.role === 'assistant'); assert.ok(response, 'worker final model response missing'); assert.equal(response.stopReason, 'stop'); assert.ok(!response.errorMessage, 'worker final model response failed'); const exactReply = (response.content ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join(''); assert.equal(exactReply, 'LEGACY_WORKER_REPLY', 'exact correlated worker reply mismatch'); });
  const workerAgent = old.agents.find(a => String(a.ownerId) === String(workerId)); const rootAgent = old.agents.find(a => String(a.ownerId) === String(old.identity.coordinatorConversationId)); assert.ok(workerAgent && rootAgent);
  assert.ok(!workerAgent.value.tools.some(name => String(name).startsWith('projects_workspace_'))); assert.equal(workerAgent.value.cwd, workspace); assert.equal(work.attempt.bindingRevision, 'no-worker-capabilities'); assert.ok(work.attempt.workspaceScopeId == null);
  const oldIdentity = old.identity, oldPlanning = old.planning, oldWorkerAgent = workerAgent.value, oldRootAgent = rootAgent.value;
  const ownerAfterOldWorker = { files: fileState(ownerPaths()), git: { head: ownerGit('rev-parse', 'HEAD'), status: ownerGit('status', '--porcelain=v1'), tree: ownerGit('rev-parse', 'HEAD^{tree}') } };
  assert.deepEqual(ownerAfterOldWorker, ownerBefore, 'legacy worker touched owner checkout');
  const oldPreReopen = JSON.parse(JSON.stringify(old));
  const oldClosure = await stop(oldClient, oldPid); oldPid = undefined;
  process.env.PI_PROJECTS_HOME = stateRoot;
  currentClient = await loadClient(repo); await currentClient.ensureHost(); currentPid = (await currentClient.health()).pid;
  const scope = await currentClient.request({ action: 'workspace-grant', id: projectId, repositoryId: 'legacy-owner', provider: 'github', ownerCheckout: workspace, approvedRoot: approved, fileOwnershipPrefix: 'README.txt', files: ['README.txt'], baseRevision });
  assert.equal(scope.provider, 'github'); assert.ok(scope.id);
  const reopenedInitial = await currentClient.request({ action: 'show', id: projectId });
  const after = inspect('current-before-message');
  const ownerAfterMigration = { files: fileState(ownerPaths()), git: { head: ownerGit('rev-parse', 'HEAD'), status: ownerGit('status', '--porcelain=v1'), tree: ownerGit('rev-parse', 'HEAD^{tree}') } };
  assert.deepEqual(ownerAfterMigration, ownerBefore, 'migration touched owner checkout');
  assert.deepEqual(after.identity, oldIdentity); assert.equal(after.identity.projectId, projectId); assert.deepEqual(after.project.id, old.project.id); assert.deepEqual(after.project.model, old.project.model);
  const afterWorker = after.agents.find(a => String(a.ownerId) === String(workerId)); const afterRoot = after.agents.find(a => String(a.ownerId) === String(old.identity.coordinatorConversationId)); assert.deepEqual(afterWorker.value, oldWorkerAgent); assert.deepEqual({ ...afterRoot.value, tools: undefined }, { ...oldRootAgent, tools: undefined }); assert.deepEqual(afterRoot.value.tools, [...oldRootAgent.tools, 'projects_workspace_catalog']); assert.equal(afterRoot.value.tools.filter(t => t === 'projects_workspace_catalog').length, 1);
  assert.deepEqual(after.conversations, old.conversations); assert.deepEqual(after.entries, old.entries);
  assert.equal(after.conversations.find(c => c.id === workerId).id, workerId); assert.deepEqual(after.planning.work[delegatePayload.workId], oldPlanning.work[delegatePayload.workId]);
  const catalogJob = await currentClient.request({ action: 'message', id: projectId, text: 'Call projects_workspace_catalog exactly once, then report its actual JSON result. Do not call any other tool.' });
  const currentView = await waitShow(currentClient, v => v.jobs.some(j => j.id === catalogJob.id && j.state === 'done') && !v.busy);
  const final = inspect('current');
  const ownerAfterCatalog = { files: fileState(ownerPaths()), git: { head: ownerGit('rev-parse', 'HEAD'), status: ownerGit('status', '--porcelain=v1'), tree: ownerGit('rev-parse', 'HEAD^{tree}') } };
  assert.deepEqual(ownerAfterCatalog, ownerBefore, 'catalog touched owner checkout');
  const catalogCall = final.calls.find(c => c.name === 'projects_workspace_catalog'); assert.ok(catalogCall); const catalogResult = final.results.find(r => r.toolCallId === catalogCall.id && !r.isError); assert.ok(catalogResult); assert.deepEqual(JSON.parse(catalogResult.text), { scopes: [scope] }); assert.equal(catalogCall.conversationId, old.identity.coordinatorConversationId); assert.equal(catalogResult.conversationId, catalogCall.conversationId);
  assert.deepEqual(final.identity, oldIdentity); assert.deepEqual(final.planning.work[delegatePayload.workId], oldPlanning.work[delegatePayload.workId]); assert.deepEqual(final.agents.find(a => String(a.ownerId) === String(workerId)).value, oldWorkerAgent); const finalRoot = final.agents.find(a => String(a.ownerId) === String(old.identity.coordinatorConversationId)); assert.deepEqual(finalRoot.value.tools, afterRoot.value.tools);
  const currentClosure = await stop(currentClient, currentPid); currentPid = undefined;
  currentClient = await loadClient(repo); await currentClient.ensureHost(); const reopenedPid = (await currentClient.health()).pid; currentPid = reopenedPid;
  const reopenedView = await currentClient.request({ action: 'show', id: projectId });
  const reopened = inspect('final-reopen');
  const ownerAfterReopen = { files: fileState(ownerPaths()), git: { head: ownerGit('rev-parse', 'HEAD'), status: ownerGit('status', '--porcelain=v1'), tree: ownerGit('rev-parse', 'HEAD^{tree}') } };
  assert.deepEqual(ownerAfterReopen, ownerBefore, 'reopen touched owner checkout');
  assert.deepEqual(reopened.identity, oldIdentity); assert.deepEqual(reopened.project, final.project); assert.deepEqual(reopened.documents, final.documents); assert.deepEqual(reopened.tasks, final.tasks); assert.deepEqual(reopened.submissions, final.submissions); assert.deepEqual(reopened.calls, final.calls); assert.deepEqual(reopened.results, final.results); assert.deepEqual(reopened.conversations, final.conversations); assert.deepEqual(reopened.entries, final.entries); assert.deepEqual(reopened.workerReplies, final.workerReplies); assert.deepEqual(reopened.agents.find(a => String(a.ownerId) === String(workerId)).value, oldWorkerAgent); assert.deepEqual(reopened.agents.find(a => String(a.ownerId) === String(old.identity.coordinatorConversationId)).value, finalRoot.value);
  assert.equal(reopenedView.busy, false);
  const finalReopenClosure = await stop(currentClient, reopenedPid); currentPid = undefined;
  const sourceAfter = Object.fromEntries(sourceFiles.map(p => [p, sha(p)])); assert.deepEqual(sourceAfter, sourceBefore);
  const sourceTreeAfter = Object.fromEntries(Object.keys(sourceTreeBefore).map(p => [p, { physical: physical(p), sha256: sha(p) }])); assert.deepEqual(sourceTreeAfter, sourceTreeBefore, 'full frozen source/index tree changed');
  const ownerAfter = { files: fileState(ownerPaths()), git: { head: ownerGit('rev-parse', 'HEAD'), status: ownerGit('status', '--porcelain=v1'), tree: ownerGit('rev-parse', 'HEAD^{tree}') } };
  assert.equal(ownerAfter.git.head, ownerBefore.git.head); assert.equal(ownerAfter.git.tree, ownerBefore.git.tree); assert.equal(ownerAfter.git.status, ownerBefore.git.status);
  const report = { ok: true, projectId, scope, coordinatorConversationId: old.identity.coordinatorConversationId, workerConversationId: workerId, workId: delegatePayload.workId, snapshots: { old, oldPreReopen, after, final, reopened }, closures: { old: oldClosure, current: currentClosure, finalReopen: finalReopenClosure }, old: { identity: oldIdentity, planning: oldPlanning, workerAgent: oldWorkerAgent, rootAgent: oldRootAgent }, current: { identity: final.identity, planning: final.planning, workerAgent: final.agents.find(a => String(a.ownerId) === String(workerId)).value, rootAgent: finalRoot.value, catalogCall, catalogResult: JSON.parse(catalogResult.text), view: currentView, reopenedView }, sourceBefore, sourceAfter, sourceTreeBefore, sourceTreeAfter, baseline: { commit: '8605a268835af2fb01c3615c07440129b9ef0981', archivedRoot: oldRoot }, ownerBefore, ownerAfter, ownerPhases: { oldWorker: ownerAfterOldWorker, migration: ownerAfterMigration, catalog: ownerAfterCatalog, reopen: ownerAfterReopen }, fixture: base, workspacePhysical: physical(workspace) };
  writeFileSync(join(base, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(join(base, 'report.json'));
} finally { if (oldPid) await stop(oldClient, oldPid).catch(() => {}); if (currentPid) await stop(currentClient, currentPid).catch(() => {}); }
