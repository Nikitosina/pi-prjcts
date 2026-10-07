import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = resolve('artifacts', `durable-migration-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(base, { recursive: true });
const modulePath = process.env.MIGRATION_MODULE ?? resolve('src/durable-migration.ts');
const { inspectLegacyProject, prepareLegacyMigration } = await import(pathToFileURL(modulePath).href);
const id = randomUUID(), workspace = join(base, 'workspace'), source = join(base, 'legacy', id), archive = join(base, 'archive');
mkdirSync(workspace, { recursive: true }); mkdirSync(source, { recursive: true });
const project = { version: 1, id, name: 'Migration E2E', cwd: workspace, objective: 'Preserve history without execution', createdAt: new Date().toISOString(), model: 'openai-codex/gpt-5.6-terra', models: { worker: 'openai-codex/gpt-5.6-terra', scout: 'openai-codex/gpt-5.6-terra', reviewer: 'openai-codex/gpt-5.6-terra' }, sessionFile: join(source, 'sessions', 'coordinator.jsonl'), phase: 'ready', problem: null, runs: [] };
function put(path, text) { const target = join(source, path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, text); }
function hashes(root, prefix = '') { return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => { const path = join(prefix, entry.name); return entry.isDirectory() ? Object.entries(hashes(root, path)) : [[path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]]; })); }
put('project.json', JSON.stringify(project));
put('sessions/coordinator.jsonl', '{"type":"session","id":"original"}\n{"type":"message","message":{"role":"user","content":"DO_NOT_EXECUTE_HISTORY"}}\n');
put('notes/original.json', '{"text":"original learned knowledge"}\n');
put('inbox/completed.json', '{"state":"done"}\n');
put('permissions.json', '{"publish":false}\n');
put('evidence/proof.data', 'immutable evidence\u0000bytes');
put('unknown-owner-file', 'KEEP');
const args = { legacyProjectDir: source, expectedProjectId: id, expectedCwd: workspace, confirmDisposable: true };
const checks = []; const pass = name => { checks.push(name); process.stderr.write(`PASS ${name}\n`); };
try {
  const before = hashes(source), inspected = inspectLegacyProject(args);
  assert.equal(inspected.files.length, Object.keys(before).length); pass('All legacy files discovered');
  const first = prepareLegacyMigration({ ...args, archiveDir: archive });
  assert.deepEqual(hashes(join(archive, 'originals')), before); assert.deepEqual(hashes(source), before); pass('Every original byte preserved, source unchanged');
  assert.equal(prepareLegacyMigration({ ...args, archiveDir: archive }).manifestSha256, first.manifestSha256); pass('Completed preparation is idempotent');
  rmSync(join(archive, 'complete.json'));
  assert.equal(prepareLegacyMigration({ ...args, archiveDir: archive }).manifestSha256, first.manifestSha256); pass('Interrupted completion safely recovers');
  assert.throws(() => inspectLegacyProject({ ...args, expectedProjectId: randomUUID() })); pass('Identity mismatch rejected');
  put('inbox/pending.json', '{"state":"queued"}'); assert.throws(() => inspectLegacyProject(args)); rmSync(join(source, 'inbox/pending.json')); pass('Queued legacy work blocks migration');
  symlinkSync(join(workspace, 'outside'), join(source, 'unsafe-link')); assert.throws(() => inspectLegacyProject(args)); rmSync(join(source, 'unsafe-link')); pass('Dangling source symlink rejected');
  writeFileSync(join(archive, 'originals', 'unknown-owner-file'), 'HUMAN_EDIT'); assert.throws(() => prepareLegacyMigration({ ...args, archiveDir: archive })); pass('Archive tampering is not overwritten');
  assert.deepEqual(hashes(source), before); pass('Negative checks preserve source');
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: true, checks, source, archive, modulePath }, null, 2));
} catch (error) {
  writeFileSync(join(base, 'report.json'), JSON.stringify({ ok: false, checks, error: String(error), source, archive, modulePath }, null, 2));
  throw error;
} finally { process.stderr.write(`${join(base, 'report.json')}\n`); }
