#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';

const self = fileURLToPath(import.meta.url);
const started = Date.now();
const testEnd = started + 180_000;
const runEnd = started + 300_000;
const attempt = randomUUID();
const tempRoot = realpathSync(tmpdir());
const root = join(tempRoot, `pi-project-restore-host-tdd-${attempt}`);
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const requests = new Set();
const cleanupErrors = [];
const receipts = { attempt, root, home, workspace, projectId: null, socket: null, bindings: [], sharedPreflight: null, behavior: null, close: null, host: null };
let sourceRoot = null;
let host = null;
let exchangeFd = null;
let stdoutFd = null;
let stderrFd = null;
let exchangeBytes = 0;
let settingsBefore = [];
let sharedBefore = [];
let locksBefore = [];
let layoutBefore = [];
let sourcesBefore = [];
let installedBefore = [];
let permitBefore = null;
let rootReady = false;
let primary = null;

class Failure extends Error {
  constructor(kind, code, message) { super(message); this.name = 'Failure'; this.kind = kind; this.code = code; }
}

await main();

async function main() {
  const watchdog = setTimeout(() => {
    const deadlineFailure = fault(new Failure('infrastructure', 'RUN_DEADLINE', 'Whole-run deadline expired'));
    cleanupErrors.push(deadlineFailure);
    for (const request of requests) request.destroy(new Failure('infrastructure', 'RUN_DEADLINE', 'Whole-run deadline expired'));
    const signal = signalOwned('SIGKILL');
    const record = { status: 'BLOCKED', expectedRed: false, primaryError: primary, cleanupErrors: [...cleanupErrors], deadlineFailure, signal, receipts, host: hostReceipt() };
    if (rootReady) saveReceipt('deadline.json', record);
    process.stderr.write(JSON.stringify({ ...record, cleanupErrors: [...cleanupErrors] }) + '\n');
    process.exit(2);
  }, Math.max(1, runEnd - Date.now()));
  try {
    mkdirSync(root, { mode: 0o700 });
    rootReady = true;
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    guardLauncher();
    sourceRoot = realpathSync(join(dirname(self), '..'));
    const pkg = bindInstalled();
    sourcesBefore = [self, ...['src/client.ts', 'src/host.ts', 'src/durable-host.ts', 'src/state.ts', 'src/durable-runtime.ts', 'src/cli.ts', 'package.json'].map(path => join(sourceRoot, path))].map(image);
    need(sourcesBefore.every(value => value.bytes !== null), 'setup', 'SOURCE_MISSING', 'A required application source is missing');
    validatePermit([...sourcesBefore, ...installedBefore]);
    const appName = pkg.piConfig?.name || 'pi';
    const configDir = pkg.piConfig?.configDir || '.pi';
    need(appName === 'pi' && configDir === '.pi', 'setup', 'AGENT_CONFIG_UNREVIEWED', 'Installed agent-directory semantics differ from the reviewed manifest');
    const configured = process.env[`${appName.toUpperCase()}_CODING_AGENT_DIR`];
    need(!configured || isAbsolute(configured), 'setup', 'AMBIGUOUS_AGENT_DIR', 'Require the installed default or an existing absolute agent-directory override');
    const agentDir = configured || join(homedir(), configDir, 'agent');
    need(statSync(agentDir).isDirectory(), 'setup', 'AGENT_DIR_UNAVAILABLE', 'The normal installed agent directory must already exist');
    settingsBefore = [...new Set([join(agentDir, 'settings.json'), join(sourceRoot, '.pi', 'settings.json'), join(workspace, '.pi', 'settings.json')])].map(image);
    sharedBefore = ['auth.json', 'models.json', 'models-store.json'].map(name => image(join(agentDir, name)));
    locksBefore = [...new Set([join(agentDir, 'auth.json.lock'), join(agentDir, 'models-store.json.lock'), ...settingsBefore.map(value => `${value.path}.lock`)])].map(pathImage);
    mkdirSync(join(root, 'source'), { mode: 0o700 });
    for (let index = 0; index < sourcesBefore.length; index++) saveBytes(join('source', `${index}-${sourcesBefore[index].hash}.txt`), sourcesBefore[index].bytes);
    save('preimages.json', { settings: settingsBefore.map(publicImage), shared: sharedBefore.map(publicImage), locks: locksBefore, layout: layoutBefore, sources: sourcesBefore.map(publicImage), installed: installedBefore.map(publicImage), permit: publicImage(permitBefore) });
    receipts.sharedPreflight = { requiredPresent: false, locksAbsent: false, commandFreeStrictJson: false, migrationFree: false, classifications: [] };
    need(sharedBefore.filter(value => basename(value.path) !== 'models.json').every(value => value.bytes !== null), 'setup', 'SHARED_BACKING_MISSING', 'Required shared auth/model-store backing file is absent; refuse without creating it');
    receipts.sharedPreflight.requiredPresent = true;
    need(locksBefore.every(value => value.ancestors[0].exists === false), 'setup', 'SHARED_LOCK_PRESENT', 'A protected lexical lock exists; refuse without touching it');
    receipts.sharedPreflight.locksAbsent = true;
    for (const value of sharedBefore) classifyShared(value, receipts.sharedPreflight.classifications);
    receipts.sharedPreflight.commandFreeStrictJson = true;
    receipts.sharedPreflight.migrationFree = true;
    save('shared-preflight.json', receipts.sharedPreflight);
    verifyBeforeStartup();
    exchangeFd = openSync(join(root, 'exchanges.jsonl'), 'wx', 0o600);
    stdoutFd = openSync(join(root, 'host.stdout.log'), 'wx', 0o600);
    stderrFd = openSync(join(root, 'host.stderr.log'), 'wx', 0o600);
    process.env.PI_PROJECTS_HOME = home;
    const { socketPath } = await import('../src/state.ts');
    const socket = socketPath();
    receipts.socket = socket;
    need(!lexical(socket).exists, 'setup', 'SOCKET_ALREADY_EXISTS', 'Refuse a pre-existing UNIX socket path');
    verifyBeforeStartup();
    startHost(socket);
    const readyEnd = Math.min(testEnd, Date.now() + 30_000);
    await until(readyEnd, async () => {
      need(!host.spawnError && !host.exited && !host.closed && !host.logError, 'setup', 'HOST_START_FAILED', 'Owned host failed during readiness');
      try {
        const response = await http('GET', '/health', null, Math.min(readyEnd, Date.now() + 1_000));
        need(response.status === 200 && response.reply.ok === true, 'setup', 'HEALTH_REPLY', 'Health did not succeed');
        need(response.reply.data?.pid === host.child.pid && response.reply.data?.home === home, 'setup', 'FOREIGN_HOST', 'Health does not identify the exact owned PID/home');
        host.health = response.reply;
        host.socketPin = lexical(socket);
        need(host.socketPin.socket === true, 'setup', 'SOCKET_TYPE', 'Owned endpoint is not a UNIX socket');
        return true;
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') return false;
        throw error;
      }
    }, 'HOST_READINESS');
    const created = await ownerRequest({ action: 'create', name: `archive-${attempt}`, cwd: workspace });
    need(created.status === 200 && created.reply.ok === true, 'setup', 'CREATE_FAILED', 'Public owner creation failed');
    const project = created.reply.data;
    need(typeof project?.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(project.id), 'setup', 'CREATE_ID', 'Creation did not return a fresh UUID');
    need(project.runtime === 'durable' && project.cwd === workspace && project.name === `archive-${attempt}`, 'setup', 'CREATE_IDENTITY', 'Created project differs from the owned attempt');
    receipts.projectId = project.id;
    const initial = await show(project.id);
    need(initial.project.phase === 'ready' && initial.busy === false && jobIds(initial).length === 0 && Array.isArray(initial.messages) && initial.messages.length === 0, 'setup', 'INITIAL_NOT_READY', 'Fresh public project must be ready without admitted work');
    const beforeIds = jobIds(initial);
    const knowledgeBefore = await ownerRequest({ action: 'knowledge-read', id: project.id, path: 'preferences.md' });
    need(knowledgeBefore.status === 200 && knowledgeBefore.reply.ok === true && typeof knowledgeBefore.reply.data?.revision === 'string', 'setup', 'KNOWLEDGE_READ_FAILED', 'Owner knowledge must be readable before archive');
    const preservedText = '# Preferences\n\nArchive must preserve this owned document.\n';
    const written = await ownerRequest({ action: 'knowledge-write', id: project.id, path: 'preferences.md', text: preservedText, expectedRevision: knowledgeBefore.reply.data.revision });
    need(written.status === 200 && written.reply.ok === true && written.reply.data?.text === preservedText, 'setup', 'KNOWLEDGE_WRITE_FAILED', 'Owner must create a real managed knowledge update before archive');
    const paused = await ownerRequest({ action: 'archive', id: project.id });
    if (paused.status === 400 && paused.reply.ok === false && paused.reply.error.startsWith('Invalid data:')) throw new Failure('behavior', 'ARCHIVE_ROUTE_MISSING', 'Ready owned project rejects the public archive request');
    need(paused.status === 200 && paused.reply.ok === true, 'infrastructure', 'PAUSE_APPLICATION_ERROR', 'Unexpected pause application response, not the intended missing-route RED');
    need(paused.reply.data?.paused === true && paused.reply.data?.archived === true, 'behavior', 'ARCHIVE_ACK_STATE', 'Archive must acknowledge archived:true and paused:true');
    const publicPaused = await show(project.id);
    need(publicPaused.paused === true && publicPaused.project.archived === true, 'behavior', 'PUBLIC_ARCHIVED_STATE', 'Public show must preserve project identity and expose archived:true with paused:true');
    need(isDeepStrictEqual(jobIds(publicPaused), beforeIds), 'behavior', 'PAUSE_ADDED_JOB', 'Idle pause must not add public jobs');
    const refused = await ownerRequest({ action: 'message', id: project.id, text: `Denied new work ${attempt}. Do not run tools or delegate.` });
    const after = await show(project.id);
    receipts.behavior = { beforeJobIds: beforeIds, afterJobIds: jobIds(after), paused: after.paused, messageStatus: refused.status, messageReply: refused.reply };
    need(refused.status === 400 && refused.reply.ok === false && refused.reply.error === 'Project is archived; admission is denied', 'behavior', 'PAUSED_ADMISSION_NOT_REFUSED', 'Paused admission must return the agreed refusal');
    need(after.paused === true && isDeepStrictEqual(jobIds(after), beforeIds), 'behavior', 'REFUSAL_CHANGED_PUBLIC_JOBS', 'Refusal must preserve public paused state and job-ID membership');
    const knowledgeAfter = await ownerRequest({ action: 'knowledge-read', id: project.id, path: 'preferences.md' });
    need(knowledgeAfter.status === 200 && knowledgeAfter.reply.ok === true && knowledgeAfter.reply.data?.text === preservedText && knowledgeAfter.reply.data?.revision === written.reply.data.revision, 'behavior', 'ARCHIVE_LOST_KNOWLEDGE', 'Archive must preserve the public knowledge text and revision');
    const resumed = await ownerRequest({ action: 'resume', id: project.id });
    need(resumed.status === 400 && resumed.reply.ok === false && resumed.reply.error === 'Archived project must be restored before resume', 'behavior', 'ARCHIVE_RESUME_ALLOWED', 'Ordinary resume must not reactivate an archived project');
    const final = await show(project.id);
    receipts.behavior = { ...receipts.behavior, archived: final.project.archived, finalPaused: final.paused, finalJobIds: jobIds(final), knowledgeText: knowledgeAfter.reply.data.text, knowledgeRevision: knowledgeAfter.reply.data.revision, resumeStatus: resumed.status, resumeReply: resumed.reply };
    need(final.project.archived === true && final.paused === true && isDeepStrictEqual(jobIds(final), beforeIds), 'behavior', 'ARCHIVE_STATE_CHANGED', 'Rejected resume must preserve archived paused state and jobs');
    const restored = await ownerRequest({ action: 'restore', id: project.id });
    if (restored.status === 400 && restored.reply.ok === false && restored.reply.error.startsWith('Invalid data:')) throw new Failure('behavior', 'RESTORE_ROUTE_MISSING', 'Owned archived project rejects the public restore request');
    need(restored.status === 200 && restored.reply.ok === true, 'infrastructure', 'RESTORE_APPLICATION_ERROR', 'Unexpected restore application response, not intended missing-route RED');
    need(restored.reply.data?.archived === false && restored.reply.data?.paused === true, 'behavior', 'RESTORE_ACK_STATE', 'Restore must acknowledge archived:false while keeping paused:true');
    const publicRestored = await show(project.id);
    const restoredKnowledge = await ownerRequest({ action: 'knowledge-read', id: project.id, path: 'preferences.md' });
    need(restoredKnowledge.status === 200 && restoredKnowledge.reply.ok === true && restoredKnowledge.reply.data?.text === preservedText && restoredKnowledge.reply.data?.revision === written.reply.data.revision, 'behavior', 'RESTORE_LOST_KNOWLEDGE', 'Restore must preserve public knowledge text and revision');
    const stillRefused = await ownerRequest({ action: 'message', id: project.id, text: `Restore must not start new work ${attempt}.` });
    const afterRestore = await show(project.id);
    receipts.behavior = { ...receipts.behavior, restoreStatus: restored.status, restoreReply: restored.reply, restoredArchived: afterRestore.project.archived, restoredPaused: afterRestore.paused, afterRestoreJobIds: jobIds(afterRestore), restoredKnowledgeText: restoredKnowledge.reply.data.text, restoredMessageStatus: stillRefused.status, restoredMessageReply: stillRefused.reply };
    need(publicRestored.project.archived === false && afterRestore.project.archived === false && afterRestore.paused === true && afterRestore.busy === false && isDeepStrictEqual(jobIds(afterRestore), beforeIds) && afterRestore.messages.length === 0, 'behavior', 'RESTORE_STARTED_WORK', 'Restore must preserve project identity, clear archive and retain paused idle state');
    need(stillRefused.status === 400 && stillRefused.reply.ok === false && stillRefused.reply.error === 'Project plan is paused; admission is denied', 'behavior', 'RESTORE_ADMISSION_ALLOWED', 'Restore must not implicitly resume or admit work');
  } catch (error) { primary = fault(error); }
  finally {
    try { await closeHost(); } catch (error) { cleanupErrors.push(fault(error)); }
    const after = { settings: [], shared: [], sources: [], installed: [], permit: [], locks: [], layout: [], errors: [] };
    if (rootReady) {
      for (const [label, values] of [['settings', settingsBefore], ['shared', sharedBefore], ['sources', sourcesBefore], ['installed', installedBefore], ['permit', permitBefore ? [permitBefore] : []]]) {
        for (const before of values) {
          let current;
          try {
            current = image(before.path);
            after[label].push(publicImage(current));
            if (!sameImage(before, current)) after.errors.push({ kind: 'preservation', code: 'PREIMAGE_CHANGED', path: before.path });
          } catch (error) { after.errors.push({ path: before.path, ...fault(error) }); }
          finally { if (label === 'settings' || label === 'shared') current?.bytes?.fill(0); }
        }
      }
      for (const [label, values] of [['locks', locksBefore], ['layout', layoutBefore]]) {
        for (const before of values) {
          try {
            const current = pathImage(before.path);
            after[label].push(current);
            if (!isDeepStrictEqual(current, before)) after.errors.push({ kind: 'preservation', code: 'PROTECTED_PATH_CHANGED', path: before.path });
          } catch (error) { after.errors.push({ path: before.path, ...fault(error) }); }
        }
      }
      cleanupErrors.push(...after.errors);
      saveReceipt('preservation-after.json', after);
    }
    for (const value of [...settingsBefore, ...sharedBefore]) value.bytes?.fill(0);
    settingsBefore = [];
    sharedBefore = [];
    for (const [fd, name] of [[exchangeFd, 'exchanges.jsonl'], [stdoutFd, 'host.stdout.log'], [stderrFd, 'host.stderr.log']]) {
      if (fd === null) continue;
      try { closeSync(fd); chmodSync(join(root, name), 0o400); } catch (error) { cleanupErrors.push(fault(error)); }
    }
    if (host?.logError) cleanupErrors.push(fault(host.logError));
    receipts.host = hostReceipt();
    if (rootReady) saveReceipt('report.json', { scenario: 'Owner restores its archived idle project while retaining pause and knowledge', ...outcome(), primaryError: primary, cleanupErrors: [...cleanupErrors], elapsedMs: Date.now() - started, receipts });
    const result = outcome();
    process.stdout.write(JSON.stringify({ ...result, root, primaryError: primary, cleanupErrors: [...cleanupErrors] }) + '\n');
    process.exitCode = result.status === 'GREEN' ? 0 : result.status === 'RED' ? 1 : 2;
    clearTimeout(watchdog);
  }
}

function guardLauncher() {
  need(process.env.PI_PACKAGE_DIR === undefined || process.env.PI_PACKAGE_DIR === '', 'setup', 'PACKAGE_DIR_OVERRIDE', 'Refuse inherited nonempty PI_PACKAGE_DIR without clearing or aliasing it');
  need(process.env.NODE_OPTIONS === undefined || process.env.NODE_OPTIONS === '', 'setup', 'NODE_OPTIONS_UNREVIEWED', 'Parent must refuse nonempty NODE_OPTIONS before launching this driver');
  need(process.release?.name === 'node' && !process.versions.bun && isDeepStrictEqual(process.execArgv, ['--experimental-strip-types']), 'setup', 'LAUNCH_FLAGS_UNREVIEWED', 'Only the reviewed Node --experimental-strip-types launch is accepted');
}

function installedFile(path) {
  const prior = installedBefore.find(value => value.path === path);
  if (prior) return prior;
  const value = image(path);
  installedBefore.push(value);
  need(value.bytes !== null, 'setup', 'INSTALLED_SOURCE_MISSING', 'An exact installed source is missing; no fallback is allowed');
  return value;
}

function bindPackage(rootPath, name, version, keys) {
  const physicalRoot = realpathSync(rootPath);
  const manifest = installedFile(join(rootPath, 'package.json'));
  need(manifest.effective.path === join(physicalRoot, 'package.json'), 'setup', 'MANIFEST_PHYSICAL_LAYOUT', 'Installed manifest escapes its reviewed physical package root');
  const pkg = sourceJson(manifest.bytes);
  const entryExport = pkg.exports?.['.'];
  need(pkg.name === name && pkg.version === version && pkg.type === 'module', 'setup', 'INSTALLED_VERSION', 'Installed package identity/version differs from the approved baseline');
  need(plain(entryExport) && isDeepStrictEqual(Object.keys(entryExport), keys) && entryExport.import === './dist/index.js' && entryExport.types === './dist/index.d.ts', 'setup', 'IMPORT_EXPORT_UNREVIEWED', 'Installed root import export differs from the reviewed binding');
  if (keys.includes('source')) need(entryExport.source === './src/index.ts', 'setup', 'SOURCE_EXPORT_UNREVIEWED', 'Unexpected source-condition export');
  if (keys.includes('default')) need(entryExport.default === './dist/index.js', 'setup', 'DEFAULT_EXPORT_UNREVIEWED', 'Unexpected default export');
  const entry = installedFile(join(rootPath, 'dist/index.js'));
  need(entry.effective.path === join(physicalRoot, 'dist/index.js'), 'setup', 'ENTRY_PHYSICAL_LAYOUT', 'Installed entry escapes the reviewed physical package root');
  const binding = { name, version, root: rootPath, physicalRoot, manifest, entry, pkg };
  receipts.bindings.push({ name, version, root: rootPath, physicalRoot, manifestPath: manifest.path, entryPath: entry.path });
  return binding;
}

function absentModules(path) {
  const value = pathImage(path);
  layoutBefore.push(value);
  need(value.ancestors[0].exists === false, 'setup', 'CLOSER_DEPENDENCY_LAYOUT', 'A closer node_modules directory makes the reviewed exact binding ambiguous');
}

function samePackage(a, b) {
  need(a.physicalRoot === b.physicalRoot && samePhysicalFile(a.manifest, b.manifest) && samePhysicalFile(a.entry, b.entry), 'setup', 'DUPLICATE_SHARED_PACKAGE', 'SDK, Durable and application dependencies must share exact physical package identities');
}

function packageFile(binding, relativePath) {
  const value = installedFile(join(binding.root, relativePath));
  need(value.effective.path === join(binding.physicalRoot, relativePath), 'setup', 'INSTALLED_SOURCE_LAYOUT', 'Installed initialization source escapes its reviewed physical package root');
  return value;
}

function bindInstalled() {
  absentModules(join(sourceRoot, 'src/node_modules'));
  absentModules(join(sourceRoot, 'scripts/node_modules'));
  const sdk = bindPackage(join(sourceRoot, 'node_modules/@earendil-works/pi-coding-agent'), '@earendil-works/pi-coding-agent', '1.0.2', ['types', 'import']);
  const durable = bindPackage(join(sourceRoot, 'node_modules/@earendil-works/pi-durable'), '@earendil-works/pi-durable', '1.0.0', ['source', 'types', 'import', 'default']);
  need(durable.physicalRoot === realpathSync(join(sourceRoot, '.dependencies/durable/1.0.0/package')), 'setup', 'DURABLE_PHYSICAL_LAYOUT', 'Durable must use the reviewed official installed package location');
  for (const relative of ['dist', 'dist/core', 'dist/utils']) absentModules(join(sdk.physicalRoot, relative, 'node_modules'));
  for (const relative of ['', 'dist', 'dist/harness', 'dist/session', 'dist/storage', 'dist/storage/sqlite']) absentModules(join(durable.physicalRoot, relative, 'node_modules'));
  const sdkAi = bindPackage(join(sdk.physicalRoot, 'node_modules/@earendil-works/pi-ai'), '@earendil-works/pi-ai', '1.0.2', ['types', 'import']);
  const durableAi = bindPackage(join(dirname(durable.physicalRoot), 'node_modules/@earendil-works/pi-ai'), '@earendil-works/pi-ai', '1.0.2', ['types', 'import']);
  const rootAi = bindPackage(join(sourceRoot, 'node_modules/@earendil-works/pi-ai'), '@earendil-works/pi-ai', '1.0.2', ['types', 'import']);
  samePackage(sdkAi, durableAi);
  samePackage(sdkAi, rootAi);
  const sdkChord = bindPackage(join(sdk.physicalRoot, 'node_modules/@earendil-works/chord'), '@earendil-works/chord', '1.0.2', ['source', 'types', 'import']);
  const durableChord = bindPackage(join(dirname(durable.physicalRoot), 'node_modules/@earendil-works/chord'), '@earendil-works/chord', '1.0.2', ['source', 'types', 'import']);
  const rootChord = bindPackage(join(sourceRoot, 'node_modules/@earendil-works/chord'), '@earendil-works/chord', '1.0.2', ['source', 'types', 'import']);
  samePackage(sdkChord, durableChord);
  samePackage(sdkChord, rootChord);
  for (const binding of [sdk, durable, rootAi, rootChord]) need(fileURLToPath(import.meta.resolve(binding.name)) === binding.entry.effective.path, 'setup', 'ESM_BINDING_MISMATCH', 'Non-evaluating root ESM resolution disagrees with the exact reviewed import binding');
  for (const relative of ['dist/config.js', 'dist/utils/paths.js', 'dist/utils/text.js', 'dist/core/model-runtime.js', 'dist/core/auth-storage.js', 'dist/core/model-config.js', 'dist/core/models-store.js', 'dist/core/runtime-credentials.js', 'dist/core/resolve-config-value.js', 'dist/core/remote-catalog-provider.js', 'dist/core/settings-manager.js']) packageFile(sdk, relative);
  for (const relative of ['dist/models.js', 'dist/providers/radius.js', 'dist/providers/radius-config.js']) packageFile(sdkAi, relative);
  const lockRoot = join(sdk.physicalRoot, 'node_modules/proper-lockfile');
  const lockPhysical = realpathSync(lockRoot);
  const lockManifest = installedFile(join(lockRoot, 'package.json'));
  const lockPkg = sourceJson(lockManifest.bytes);
  need(lockPkg.name === 'proper-lockfile' && lockPkg.version === '4.1.2' && lockPkg.main === 'index.js' && !Object.hasOwn(lockPkg, 'exports'), 'setup', 'LOCKFILE_BINDING_UNREVIEWED', 'Unexpected proper-lockfile manifest/main binding');
  for (const relative of ['package.json', 'index.js', 'lib/lockfile.js']) need(installedFile(join(lockRoot, relative)).effective.path === join(lockPhysical, relative), 'setup', 'LOCKFILE_PHYSICAL_LAYOUT', 'proper-lockfile source escapes its physical package root');
  return sdk.pkg;
}

function validatePermit(required) {
  const path = process.env.PI_PROJECTS_TDD_APPROVED_PREIMAGES;
  need(typeof path === 'string' && isAbsolute(path), 'setup', 'APPROVED_PREIMAGES_REQUIRED', 'Require an absolute parent-approved source-preimage permit; no default is available');
  const control = dirname(path);
  const dirStat = lstatSync(control);
  const fileStat = lstatSync(path);
  need(basename(path) === 'approved-preimages.json' && /^pi-project-restore-host-control-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(basename(control)) && dirname(control) === tempRoot && realpathSync(control) === control, 'setup', 'PERMIT_LOCATION', 'Permit must be in the separately owned fresh physical temporary run-control directory');
  need(dirStat.isDirectory() && !dirStat.isSymbolicLink() && fileStat.isFile() && !fileStat.isSymbolicLink() && dirStat.uid === process.getuid() && fileStat.uid === process.getuid() && (dirStat.mode & 0o077) === 0 && (fileStat.mode & 0o077) === 0, 'setup', 'PERMIT_OWNERSHIP', 'Permit and control directory must be regular owner-only nonsymlink resources');
  permitBefore = image(path);
  const permit = sourceJson(permitBefore.bytes);
  need(plain(permit) && isDeepStrictEqual(Object.keys(permit).sort(), ['files', 'scenario', 'sourceRoot', 'version']) && permit.version === 1 && permit.scenario === 'durable-project-restore-host-tdd' && permit.sourceRoot === sourceRoot && Array.isArray(permit.files), 'setup', 'PERMIT_SCHEMA', 'Parent source-preimage permit has an unexpected schema');
  const expected = new Map(required.map(value => [value.path, publicImage(value)]));
  need(expected.size === required.length && permit.files.length === expected.size, 'setup', 'PERMIT_FILE_SET', 'Permit must contain exactly the required source/manifest/entry set');
  const seen = new Set();
  for (const value of permit.files) {
    need(plain(value) && typeof value.path === 'string' && expected.has(value.path) && !seen.has(value.path), 'setup', 'PERMIT_FILE_SET', 'Permit contains a missing, extra or duplicate source entry');
    seen.add(value.path);
    need(isDeepStrictEqual(value, expected.get(value.path)), 'setup', 'APPROVED_SOURCE_CHANGED', 'Protected source identity/hash differs from the parent-approved preimage');
  }
}

function classifyShared(value, results) {
  const result = { path: value.path, present: value.bytes !== null, strictJson: false, commandSource: null, possibleLegacyMigration: null, classified: false };
  results.push(result);
  if (value.bytes === null) {
    need(basename(value.path) === 'models.json', 'setup', 'SHARED_BACKING_MISSING', 'Required shared backing file is absent');
    result.classified = true;
    return;
  }
  let parsed;
  try {
    let text = value.bytes.toString('utf8');
    if (text.startsWith('\uFEFF')) text = text.slice(1);
    parsed = JSON.parse(text);
  } catch { throw new Failure('setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Shared configuration is not strict JSON; refuse without exposing content'); }
  need(plain(parsed), 'setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Shared configuration shape cannot be classified safely');
  result.strictJson = true;
  const pending = [parsed];
  let visited = 0;
  while (pending.length) {
    need(++visited <= 50_000, 'setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Shared configuration exceeds the bounded classification budget');
    const item = pending.pop();
    if (typeof item === 'string' && item.startsWith('!')) {
      result.commandSource = true;
      throw new Failure('setup', 'INITIALIZATION_COMMAND_SOURCE', 'Possible initialization command source; refuse SDK startup');
    }
    if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (key.startsWith('!')) {
          result.commandSource = true;
          throw new Failure('setup', 'INITIALIZATION_COMMAND_SOURCE', 'Possible initialization command source; refuse SDK startup');
        }
        if (key === 'gatewayConfig') {
          result.possibleLegacyMigration = true;
          throw new Failure('setup', 'INITIALIZATION_MIGRATION_SOURCE', 'Possible cache-only legacy model-store migration; refuse SDK startup');
        }
        pending.push(child);
      }
    }
  }
  if (basename(value.path) === 'models.json') need(plain(parsed.providers), 'setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Model configuration has an unfamiliar shape');
  if (basename(value.path) === 'auth.json') {
    for (const credential of Object.values(parsed)) {
      need(plain(credential) && (credential.type === 'api_key' || credential.type === 'oauth'), 'setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Credential configuration has an unfamiliar shape');
      if (credential.type === 'api_key') need((credential.key === undefined || typeof credential.key === 'string') && (credential.env === undefined || plain(credential.env) && Object.values(credential.env).every(entry => typeof entry === 'string')), 'setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Credential configuration has an unfamiliar shape');
      else need(typeof credential.access === 'string' && typeof credential.refresh === 'string' && Number.isFinite(credential.expires), 'setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Credential configuration has an unfamiliar shape');
    }
  }
  if (basename(value.path) === 'models-store.json') need(Object.values(parsed).every(entry => plain(entry) && Array.isArray(entry.models) && entry.models.every(model => plain(model) && typeof model.id === 'string' && typeof model.provider === 'string')), 'setup', 'SHARED_CONFIG_UNCLASSIFIED', 'Cached model store has an unfamiliar shape');
  result.commandSource = false;
  result.possibleLegacyMigration = false;
  result.classified = true;
}

function verifyBeforeStartup() {
  guardLauncher();
  for (const before of [...settingsBefore, ...sharedBefore, ...sourcesBefore, ...installedBefore, ...(permitBefore ? [permitBefore] : [])]) {
    let current;
    try { current = image(before.path); need(sameImage(before, current), 'setup', 'PRESTART_PREIMAGE_CHANGED', 'A protected preimage changed before SDK startup'); }
    finally { current?.bytes?.fill(0); }
  }
  for (const before of [...locksBefore, ...layoutBefore]) need(isDeepStrictEqual(pathImage(before.path), before), 'setup', 'PRESTART_PATH_CHANGED', 'A protected lock/layout path changed before startup');
}

function startHost(socket) {
  guardLauncher();
  const source = join(sourceRoot, 'src/host.ts');
  const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('PI_SUBAGENT') || key === 'PI_SESSION_FILE') delete env[key];
  const args = ['--experimental-strip-types', source];
  const child = spawn(process.execPath, args, { cwd: sourceRoot, env, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  host = { child, socket, source, args, health: null, socketPin: null, events: [], exited: false, closed: false, spawnError: null, exitCode: null, signalCode: null, logError: null, stdoutBytes: 0, stderrBytes: 0 };
  for (const [stream, fd, field] of [[child.stdout, stdoutFd, 'stdoutBytes'], [child.stderr, stderrFd, 'stderrBytes']]) {
    stream.on('data', chunk => {
      host[field] += chunk.length;
      if (host[field] > 1_048_576) { host.logError ||= new Failure('infrastructure', 'LOG_LIMIT', 'Host log exceeded 1 MiB'); return; }
      try { writeSync(fd, chunk); } catch (error) { host.logError ||= error; }
    });
    stream.on('error', error => { host.logError ||= error; });
  }
  child.on('error', error => { host.spawnError = fault(error); host.events.push({ at: Date.now(), type: 'error', error: fault(error) }); });
  child.on('exit', (code, signal) => { host.exited = true; host.exitCode = code; host.signalCode = signal; host.events.push({ at: Date.now(), type: 'exit', code, signal }); });
  child.on('close', (code, signal) => { host.closed = true; host.events.push({ at: Date.now(), type: 'close', code, signal }); });
}

function ownedActive() { return Boolean(host && Number.isInteger(host.child.pid) && host.child.pid > 0 && host.child.spawnfile === process.execPath && isDeepStrictEqual(host.child.spawnargs, [process.execPath, ...host.args]) && !host.exited && !host.closed && !host.spawnError && host.child.exitCode === null && host.child.signalCode === null); }
function signalOwned(signal) {
  if (!ownedActive()) return { at: Date.now(), signal, sent: false, reason: 'No confirmed active spawned child; no PID signal sent' };
  try { return { at: Date.now(), signal, pid: host.child.pid, sent: host.child.kill(signal) }; }
  catch (error) { return { at: Date.now(), signal, sent: false, error: fault(error) }; }
}
async function ownerRequest(input, end = Math.min(testEnd, Date.now() + 30_000)) {
  need(host.health?.data?.pid === host.child.pid && host.health?.data?.home === home && host.socketPin !== null && isDeepStrictEqual(lexical(host.socket), host.socketPin), 'infrastructure', 'SOCKET_OWNERSHIP_CHANGED', 'Refuse a missing, replaced or foreign host socket');
  return http('POST', '/api', input, end);
}
async function show(id) {
  const response = await ownerRequest({ action: 'show', id });
  need(response.status === 200 && response.reply.ok === true, 'setup', 'SHOW_FAILED', 'Public show failed');
  const value = response.reply.data;
  need(value?.project?.id === id && value.project.cwd === workspace && value.project.runtime === 'durable', 'setup', 'SHOW_IDENTITY', 'Public show returned a foreign identity');
  jobIds(value);
  return value;
}
function jobIds(view) {
  need(Array.isArray(view?.jobs) && view.jobs.every(job => typeof job?.id === 'string'), 'infrastructure', 'JOBS_SHAPE', 'Malformed public jobs');
  const ids = view.jobs.map(job => job.id).sort();
  need(new Set(ids).size === ids.length, 'infrastructure', 'DUPLICATE_JOB_IDS', 'Duplicate public job IDs');
  return ids;
}

function http(method, path, input, end) {
  const timeout = left(end);
  const at = Date.now();
  return new Promise((resolveReply, reject) => {
    let settled = false;
    let timer;
    let status = null;
    let body = '';
    const request = httpRequest({ socketPath: host.socket, method, path, headers: { 'content-type': 'application/json' } }, response => {
      status = response.statusCode;
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 262_144) request.destroy(new Failure('infrastructure', 'HTTP_BODY_LIMIT', 'Public response exceeds256KiB')); });
      response.on('error', error => request.destroy(error));
      response.on('aborted', () => request.destroy(new Failure('infrastructure', 'HTTP_ABORTED', 'Public response aborted')));
      response.on('end', () => {
        try {
          const reply = JSON.parse(body);
          need(reply && (reply.ok === true || reply.ok === false) && (reply.ok === true ? Object.hasOwn(reply, 'data') : typeof reply.error === 'string'), 'infrastructure', 'REPLY_SHAPE', 'Malformed host Reply envelope');
          finish(null, { status, reply });
        } catch (error) { finish(error); }
      });
    });
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      requests.delete(request);
      try { exchange({ at, elapsedMs: Date.now() - at, method, path, input, status, responseBody: body, error: error ? fault(error) : null }); }
      catch (recordError) { if (error) cleanupErrors.push(fault(error)); cleanupErrors.push({ ...fault(recordError), kind: 'artifact', artifact: 'exchanges.jsonl' }); reject(error || recordError); return; }
      error ? reject(error) : resolveReply(value);
    }
    requests.add(request);
    timer = setTimeout(() => request.destroy(new Failure('infrastructure', 'HTTP_DEADLINE', 'HTTP wall deadline expired')), timeout);
    request.once('error', error => finish(error));
    request.once('close', () => { if (!settled) finish(new Failure('infrastructure', 'HTTP_EARLY_CLOSE', 'HTTP closed without a complete reply')); });
    request.end(input === null ? undefined : JSON.stringify(input));
  });
}

async function closeHost() {
  if (!host) return;
  const errorStart = cleanupErrors.length;
  const end = Math.min(runEnd, Date.now() + 60_000);
  const close = { pid: host.child.pid ?? null, socket: host.socket, health: host.health, ack: null, signals: [], pidObservation: null, socketObservation: null, events: null, errors: [] };
  receipts.close = close;
  if (ownedActive() && host.health && host.socketPin) {
    try { const at = Date.now(); close.ack = await ownerRequest({ action: 'shutdown' }, Math.min(end, at + 5_000)); close.ack.elapsedMs = Date.now() - at; }
    catch (error) { cleanupErrors.push(fault(error)); }
  } else cleanupErrors.push({ kind: 'cleanup', code: 'NO_OWNED_SHUTDOWN_ACK', message: 'No confirmed owned endpoint for normal shutdown' });
  try { await until(Math.min(end, Date.now() + 20_000), () => host.closed, 'ACTUAL_CHILD_CLOSE'); }
  catch (error) {
    cleanupErrors.push(fault(error));
    close.signals.push(signalOwned('SIGTERM'));
    try { await until(Math.min(end, Date.now() + 10_000), () => host.closed, 'TERM_CHILD_CLOSE'); }
    catch (termError) {
      cleanupErrors.push(fault(termError));
      close.signals.push(signalOwned('SIGKILL'));
      try { await until(Math.min(end, Date.now() + 5_000), () => host.closed, 'KILL_CHILD_CLOSE'); }
      catch (killError) { cleanupErrors.push(fault(killError)); }
    }
  }
  if (Number.isInteger(host.child.pid) && host.child.pid > 0) {
    try {
      await until(Math.min(end, Date.now() + 5_000), () => {
        try { process.kill(host.child.pid, 0); close.pidObservation = { at: Date.now(), operation: 'process.kill(pid,0)', pid: host.child.pid, result: 'present' }; return false; }
        catch (error) { close.pidObservation = { at: Date.now(), operation: 'process.kill(pid,0)', pid: host.child.pid, error: fault(error) }; if (error.code === 'ESRCH') return true; throw error; }
      }, 'GENUINE_PID_ESRCH');
    } catch (error) { cleanupErrors.push(fault(error)); }
  }
  if (close.pidObservation?.error?.code === 'ESRCH') {
    try {
      await until(Math.min(end, Date.now() + 5_000), async () => {
        close.socketObservation = await rawSocket(Math.min(end, Date.now() + 1_000));
        return close.socketObservation.outcome === 'error' && ['ENOENT', 'ECONNREFUSED'].includes(close.socketObservation.error?.code);
      }, 'RAW_NONSTARTING_SOCKET_CLOSE');
    } catch (error) { cleanupErrors.push(fault(error)); }
  }
  close.events = [...host.events];
  if (!(close.ack?.status === 200 && close.ack.reply.ok === true && close.ack.reply.data?.stopping === true && close.ack.elapsedMs <= 5_000)) cleanupErrors.push({ kind: 'cleanup', code: 'SHUTDOWN_ACK', message: 'Normal shutdown ACK missing/invalid' });
  if (!(host.closed && host.exited && host.exitCode === 0 && host.signalCode === null && close.signals.length === 0)) cleanupErrors.push({ kind: 'cleanup', code: 'NORMAL_ZERO_EXIT_CLOSE', message: 'Require normal zero exit and actual close without fallback signals' });
  if (close.pidObservation?.error?.code !== 'ESRCH') cleanupErrors.push({ kind: 'cleanup', code: 'PID_NOT_GONE', message: 'Genuine ESRCH not observed' });
  if (!(close.socketObservation?.outcome === 'error' && ['ENOENT', 'ECONNREFUSED'].includes(close.socketObservation.error?.code))) cleanupErrors.push({ kind: 'cleanup', code: 'SOCKET_NOT_CLOSED', message: 'Raw nonstarting UNIX refusal not observed' });
  close.errors = cleanupErrors.slice(errorStart);
  saveReceipt('close.json', close);
}

function rawSocket(end) {
  const timeout = left(end);
  const at = Date.now();
  return new Promise(resolveProbe => {
    let done = false;
    let timer;
    const socket = connect({ path: host.socket });
    const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolveProbe({ at, elapsedMs: Date.now() - at, path: host.socket, ...value }); };
    socket.once('connect', () => finish({ outcome: 'connected' }));
    socket.once('error', error => finish({ outcome: 'error', error: fault(error) }));
    socket.once('close', () => { if (!done) finish({ outcome: 'closed-without-error' }); });
    timer = setTimeout(() => finish({ outcome: 'timeout' }), timeout);
  });
}
async function until(end, read, code) { for (;;) { left(end, code); if (await read()) return; await sleep(Math.min(100, left(end, code))); } }
function left(end, code = 'WAIT_DEADLINE') { const value = Math.min(end, runEnd) - Date.now(); if (value <= 0) throw new Failure('infrastructure', code, 'Bounded wait expired'); return Math.min(value, 120_000); }
function need(value, kind, code, message) { if (!value) throw new Failure(kind, code, message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fault(error) { return { kind: error?.kind || 'infrastructure', name: error?.name || 'Error', code: error?.code || null, message: error instanceof Error ? error.message : String(error) }; }
function sourceJson(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Failure('setup', 'METADATA_UNREADABLE', 'Source/permit JSON metadata cannot be classified'); } }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameImage(a, b) { return isDeepStrictEqual(publicImage(a), publicImage(b)) && (a.bytes === null || b.bytes === null ? a.bytes === b.bytes : a.bytes.equals(b.bytes)); }
function samePhysicalFile(a, b) { return a.effective.path === b.effective.path && a.effective.dev === b.effective.dev && a.effective.ino === b.effective.ino && a.hash === b.hash && a.bytes.equals(b.bytes); }
function outcome() { const expectedRed = primary?.kind === 'behavior' && primary.code === 'RESTORE_ROUTE_MISSING' && cleanupErrors.length === 0; const status = cleanupErrors.length || primary && primary.kind !== 'behavior' ? 'BLOCKED' : primary ? 'RED' : 'GREEN'; return { status, expectedRed }; }
function lexical(path) {
  try { const stat = lstatSync(path); return { path, exists: true, dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode, file: stat.isFile(), directory: stat.isDirectory(), socket: stat.isSocket(), symlink: stat.isSymbolicLink(), target: stat.isSymbolicLink() ? readlinkSync(path) : null }; }
  catch (error) { if (error.code === 'ENOENT') return { path, exists: false, code: 'ENOENT' }; throw error; }
}
function ancestors(path) { const values = []; let cursor = resolve(path); for (;;) { values.push(lexical(cursor)); const parent = dirname(cursor); if (parent === cursor) return values; cursor = parent; } }
function pathImage(path) { return { path, ancestors: ancestors(path) }; }
function image(path) {
  const lexicalAncestors = ancestors(path);
  let effective;
  let targetAncestors = [];
  let bytes = null;
  try {
    const physical = realpathSync(path);
    const stat = statSync(physical);
    need(stat.isFile() && stat.size <= 1_048_576, 'setup', 'PREIMAGE_FILE', 'Protected preimage must be a regular file at most1MiB');
    targetAncestors = ancestors(physical);
    bytes = readFileSync(physical);
    need(bytes.length <= 1_048_576, 'setup', 'PREIMAGE_LIMIT', 'Protected preimage grew beyond1MiB');
    effective = { path: physical, dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode, size: stat.size };
  } catch (error) { if (error.code === 'ENOENT') effective = { exists: false, code: 'ENOENT' }; else throw error; }
  return { path, ancestors: lexicalAncestors, targetAncestors, effective, bytes, length: bytes?.length ?? null, hash: bytes === null ? null : hash(bytes) };
}
function publicImage({ bytes, ...value }) { return value; }
function save(name, value) { saveBytes(name, Buffer.from(JSON.stringify(value, null, 2) + '\n')); }
function saveBytes(name, bytes) { const path = join(root, name); writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); chmodSync(path, 0o400); }
function saveReceipt(name, value) { try { save(name, value); } catch (error) { cleanupErrors.push({ ...fault(error), kind: 'artifact', artifact: name }); } }
function exchange(value) { const line = JSON.stringify(value) + '\n'; exchangeBytes += Buffer.byteLength(line); need(exchangeBytes <= 1_048_576, 'infrastructure', 'EXCHANGE_LIMIT', 'Public exchange log exceeded1MiB'); writeSync(exchangeFd, line); }
function hostReceipt() { return host ? { pid: host.child.pid ?? null, source: host.source, cwd: sourceRoot, argv: host.child.spawnargs, home, socket: host.socket, socketPin: host.socketPin, health: host.health, exitCode: host.exitCode, signalCode: host.signalCode, exited: host.exited, closed: host.closed, spawnError: host.spawnError, events: [...host.events], stdoutBytes: host.stdoutBytes, stderrBytes: host.stderrBytes } : null; }
