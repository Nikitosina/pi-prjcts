import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';

// Failure cases recorded before the helper: live/unsafe host locks; busy/queued and malformed/unknown legacy work;
// external receipts (must not be read); malformed archives/markers; altered archives; source swaps/edits;
// dangling links; atomic marker recovery and retry recovery.
const base = resolve('artifacts', `durable-switch-${new Date().toISOString().replaceAll(':', '-')}`);
process.env.PI_PROJECTS_HOME = join(base, 'state');
const workspace = join(base, 'workspace'); mkdirSync(workspace, { recursive: true });
const { projectDir, saveProject } = await import('../src/state.ts');
const { prepareLegacyMigration } = await import('../src/durable-migration.ts');
const { switchDisposableProject, rollbackDisposableProject } = await import('../src/durable-switch.ts');
const { openDurableProject } = await import('../src/durable-runtime.ts');
const id = randomUUID(), dir = projectDir(id), archive = join(base, 'archive'); mkdirSync(dir, { recursive: true });
const model = 'openai-codex/gpt-5.6-terra';
const project = { version: 1, id, name: 'Disposable switch E2E', cwd: workspace, objective: 'Answer SWITCH_READY only.', createdAt: new Date().toISOString(), model, models: { worker: model, scout: model, reviewer: model }, sessionFile: null, phase: 'ready', problem: null, runs: [] };
function put(path, contents) { const target = join(dir, path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, contents); }
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function tree(root, prefix = '') { return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? Object.entries(tree(root, join(prefix, entry.name))) : [[join(prefix, entry.name), sha(join(root, prefix, entry.name))]])); }
const checks = [], logs = []; const pass = name => { checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const args = { projectDir: dir, archiveDir: archive, expectedProjectId: id, expectedCwd: workspace, confirmDisposable: true };
let runtime;
try {
  // This is a real installed SessionManager session, created without an agent/session startup.
  const native = SessionManager.create(workspace, join(dir, 'sessions'));
  native.appendMessage({ role: 'user', content: 'ORIGINAL_NATIVE_HISTORY_DO_NOT_EXECUTE', timestamp: Date.now() });
  const nativePath = native.getSessionFile(); assert.ok(nativePath); project.sessionFile = nativePath;
  saveProject(project);
  const legacyNote = JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), author: 'legacy', text: 'preserve' }) + '\n';
  put('notes/legacy.json', legacyNote); put('inbox/decision.json', '{"state":"done","decision":"preserve"}\n');
  put('settings/permissions.json', '{"terminal":false}\n'); put('evidence/terminal/receipt.json', '{"tool":"terminal","result":"native-style receipt"}\n');
  put('evidence/blob.bin', Buffer.from([0, 1, 2, 255]));
  const original = tree(dir), originalProject = readFileSync(join(dir, 'project.json'));
  await assert.rejects(async () => switchDisposableProject({ ...args, confirmDisposable: false })); pass('Disposable acknowledgement is mandatory');
  put('inbox/queued.json', '{"state":"queued"}'); assert.throws(() => prepareLegacyMigration({ legacyProjectDir: dir, archiveDir: archive, expectedProjectId: id, expectedCwd: workspace, confirmDisposable: true })); rmSync(join(dir, 'inbox/queued.json')); pass('Queued work blocks preparation');
  put('runs/malformed/status.json', '{bad'); project.runs = [{ id: randomUUID(), role: 'worker', dir: 'runs/malformed', task: 'x', createdAt: new Date().toISOString(), receipt: 'runs/malformed' }]; saveProject(project); assert.throws(() => prepareLegacyMigration({ legacyProjectDir: dir, archiveDir: archive, expectedProjectId: id, expectedCwd: workspace, confirmDisposable: true })); project.runs = []; saveProject(project); pass('Malformed or unknown receipt blocks preparation');
  project.runs = [{ id: randomUUID(), role: 'worker', dir: 'runs/external', task: 'x', createdAt: new Date().toISOString(), receipt: join(base, 'external-receipt') }]; saveProject(project); assert.throws(() => prepareLegacyMigration({ legacyProjectDir: dir, archiveDir: archive, expectedProjectId: id, expectedCwd: workspace, confirmDisposable: true })); project.runs = []; saveProject(project); pass('External receipt blocks without reading external path');
  symlinkSync(join(base, 'missing'), join(dir, 'dangling')); assert.throws(() => switchDisposableProject(args)); rmSync(join(dir, 'dangling')); pass('Dangling source symlink rejected');
  mkdirSync(archive, { recursive: true }); writeFileSync(join(process.env.PI_PROJECTS_HOME, 'host.lock'), String(process.pid)); assert.throws(() => switchDisposableProject(args), /live host/); rmSync(join(process.env.PI_PROJECTS_HOME, 'host.lock')); pass('Live host ownership blocks switch');
  prepareLegacyMigration({ legacyProjectDir: dir, archiveDir: archive, expectedProjectId: id, expectedCwd: workspace, confirmDisposable: true });
  const manifestPath = join(archive, 'manifest.json'), manifestBytes = readFileSync(manifestPath);
  writeFileSync(manifestPath, 'null'); assert.throws(() => switchDisposableProject(args), /manifest/); assert.deepEqual(readFileSync(join(dir, 'project.json')), originalProject); writeFileSync(manifestPath, manifestBytes); pass('Malformed/null archive record fails without metadata write');
  writeFileSync(join(archive, 'originals', 'notes', 'legacy.json'), 'altered'); assert.throws(() => switchDisposableProject(args)); writeFileSync(join(archive, 'originals', 'notes', 'legacy.json'), legacyNote); pass('Altered archive is rejected');
  const markerPath = join(dir, '.durable-switch.json'), partialMarker = `${markerPath}.partial.tmp`;
  writeFileSync(partialMarker, '{'); assert.throws(() => switchDisposableProject(args), /marker/); assert.deepEqual(readFileSync(join(dir, 'project.json')), originalProject); rmSync(partialMarker); pass('Truncated interrupted marker fails closed without source loss');
  const durableBytes = Buffer.from(JSON.stringify({ ...project, runtime: 'durable' }, null, 2) + '\n');
  const stagedMarker = { format: 1, projectId: id, cwd: workspace, archiveDir: archive, originalProjectSha256: sha(join(dir, 'project.json')), durableProjectSha256: createHash('sha256').update(durableBytes).digest('hex'), switchedAt: new Date().toISOString() };
  const markerTemp = `${markerPath}.owned.tmp`; writeFileSync(markerTemp, JSON.stringify(stagedMarker, null, 2) + '\n');
  // Simulate a kill after the gate acquired its SQLite lease but before linking the marker.
  writeFileSync(join(dir, 'durable-owner.sqlite'), '');
  const switched = switchDisposableProject(args); assert.equal(switched.project.runtime, 'durable'); assert.ok(readFileSync(markerPath)); assert.throws(() => readFileSync(markerTemp)); pass('Owned marker staged before project atomically recovers after interruption');
  writeFileSync(join(dir, 'notes', 'legacy.json'), 'retry human edit'); assert.throws(() => switchDisposableProject(args)); writeFileSync(join(dir, 'notes', 'legacy.json'), legacyNote); pass('Retry refuses source edits even when metadata is already Durable');
  renameSync(join(dir, 'notes'), join(dir, 'notes-real')); symlinkSync(join(dir, 'notes-real'), join(dir, 'notes')); assert.throws(() => switchDisposableProject(args)); rmSync(join(dir, 'notes')); renameSync(join(dir, 'notes-real'), join(dir, 'notes')); pass('Source directory symlink swap is rejected on retry');
  assert.equal(switchDisposableProject(args).idempotent, true); pass('Interrupted/retried switch is idempotent');
  runtime = await openDurableProject({ project: switched.project, dir });
  const answer = await runtime.say('Reply exactly SWITCH_READY.', { requestId: 'real-coordinator' }); assert.equal(answer.status, 'done'); assert.match(answer.text ?? '', /SWITCH_READY/); logs.push({ answer });
  const durableMetadata = readFileSync(join(dir, 'project.json')); assert.throws(() => rollbackDisposableProject(args), /owned/); assert.deepEqual(readFileSync(join(dir, 'project.json')), durableMetadata); pass('Open direct Durable ownership lease blocks rollback without metadata change');
  await runtime.close(); runtime = undefined; pass('Real Durable coordinator responds using existing credentials');
  const markerBytes = readFileSync(markerPath); const forgedMarker = JSON.parse(markerBytes); forgedMarker.durableProjectSha256 = '0'.repeat(64); writeFileSync(markerPath, JSON.stringify(forgedMarker)); assert.throws(() => rollbackDisposableProject(args), /hashes/); writeFileSync(markerPath, markerBytes); pass('Forged marker hashes are rejected against archive-derived bytes');
  writeFileSync(join(dir, 'notes', 'legacy.json'), 'human edit'); assert.throws(() => rollbackDisposableProject(args)); writeFileSync(join(dir, 'notes', 'legacy.json'), legacyNote); pass('Human edits before rollback are refused');
  const rolled = rollbackDisposableProject(args); assert.equal(rolled.idempotent, false); assert.deepEqual(readFileSync(join(dir, 'project.json')), originalProject); assert.ok(readFileSync(join(dir, 'durable.sqlite')).length > 0); pass('Rollback restores exact metadata and keeps Durable evidence');
  const reopened = SessionManager.open(nativePath); assert.ok(reopened.getEntries().some(entry => JSON.stringify(entry).includes('ORIGINAL_NATIVE_HISTORY_DO_NOT_EXECUTE'))); pass('Original real SessionManager history remains inspectable');
  const after = tree(dir); for (const [path, digest] of Object.entries(original)) assert.equal(after[path], digest, `original hash changed: ${path}`); pass('Original IDs, permissions, sessions, notes, decisions, receipts, and evidence hashes are unchanged');
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: true, checks, logs, manifest: join(archive, 'manifest.json'), archive, dir }, null, 2));
} catch (error) {
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: false, checks, logs, error: String(error), archive, dir }, null, 2)); throw error;
} finally { await runtime?.close(); process.stderr.write(`${join(base, 'report.json')}\n`); }
