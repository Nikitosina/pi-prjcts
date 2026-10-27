import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, truncateSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureTarget, proofChanges } from '../src/verification-target.ts';

const root = mkdtempSync(join(tmpdir(), 'verification-target-'));
const git = (...args) => execFileSync('/usr/bin/git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const results = [];
const test = async (name, run) => { try { await run(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error) }); } };
try {
  git('init', '-q', '-b', 'main'); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/check.mjs'), 'process.exit(1)\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'scripts/check.mjs'), 'process.exit(0) // weakened\n'); git('add', '.'); git('commit', '-qm', 'weaken committed proof');
  writeFileSync(join(root, 'source.txt'), 'second unrelated commit'); git('add', '.'); git('commit', '-qm', 'source');
  await test('proof changes include committed weakening before the latest commit', async () => {
    const proof = await proofChanges(root, await captureTarget(root), base);
    assert.deepEqual(proof.paths, ['scripts/check.mjs']); assert.match(proof.diff, /weakened/);
  });
  await test('gitlinks refuse capture even when their directories are missing', async () => {
    git('update-index', '--add', '--cacheinfo', `160000,${base},module`);
    try { await assert.rejects(captureTarget(root), /gitlink|submodule|unsupported/i); } finally { git('update-index', '--force-remove', 'module'); }
  });
  await test('initialized gitlink directories refuse capture instead of ignoring nested changes', async () => {
    mkdirSync(join(root, 'module')); writeFileSync(join(root, 'module/nested.txt'), 'changed');
    git('update-index', '--add', '--cacheinfo', `160000,${base},module`);
    try { await assert.rejects(captureTarget(root), /gitlink|submodule|unsupported/i); } finally { git('update-index', '--force-remove', 'module'); rmSync(join(root, 'module'), { recursive: true }); }
  });
  await test('file size is checked against a tightened capture budget', async () => { await assert.rejects(captureTarget(root, 4), /byte limit|too large|GiB/i); });
  await test('actual streamed bytes enforce the aggregate capture budget', async () => {
    const manifest = await captureTarget(root);
    assert.equal(manifest.bytes, Buffer.byteLength('process.exit(0) // weakened\nsecond unrelated commit'));
    await assert.rejects(captureTarget(root, manifest.bytes - 1), /byte limit|too large|GiB/i);
    assert.equal((await captureTarget(root, manifest.bytes)).revision, manifest.revision);
  });
  await test('oversized sparse files refuse before any file stream opens', async () => {
    const huge = join(root, '000-huge'); writeFileSync(huge, ''); truncateSync(huge, 1024 ** 3 + 1);
    const original = fs.createReadStream; let opened = 0;
    fs.createReadStream = (...args) => { opened++; return original(...args); }; syncBuiltinESMExports();
    try { await assert.rejects(captureTarget(root), /byte limit/i); assert.equal(opened, 0); }
    finally { fs.createReadStream = original; syncBuiltinESMExports(); rmSync(huge); }
  });
  await test('growth after stat is rejected by the bounded streaming guard', async () => {
    const before = await captureTarget(root), original = fs.createReadStream;
    fs.createReadStream = (path, options) => { appendFileSync(path, 'growth'.repeat(20)); return original(path, options); }; syncBuiltinESMExports();
    try { await assert.rejects(captureTarget(root, before.bytes), /byte limit while reading/i); }
    finally { fs.createReadStream = original; syncBuiltinESMExports(); }
  });
  console.log(JSON.stringify({ results }, null, 2)); assert.ok(results.every(result => result.ok), 'all target regression cases');
} finally { rmSync(root, { recursive: true, force: true }); }
