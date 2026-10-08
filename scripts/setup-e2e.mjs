// E2E for one-command setup on a fresh checkout: `scripts/link-durable.mjs` (Pi Durable + unpdf) against the installed Pi, run in a
// disposable copy so the live checkout's node_modules are never touched. Failure cases: scripts/offline-setup-failures.md (6-11).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const repo = process.cwd();
const artifacts = join(repo, 'artifacts', `setup-${new Date().toISOString().replaceAll(':', '-')}`);
const root = join(realpathSync(tmpdir()), `setup-${randomUUID()}`);
mkdirSync(artifacts, { recursive: true }); mkdirSync(root, { recursive: true });
const result = { root, checks: [], runs: [] };
const check = (label, ok, detail) => { if (!ok) throw Error(`${label}${detail ? `: ${detail}` : ''}`); result.checks.push(label); };
const run = (label, cwd, script, env = {}) => {
  const out = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  result.runs.push({ label, status: out.status, stdout: out.stdout.trim(), stderr: out.stderr.trim().split('\n').filter(line => /Error|error/.test(line)).slice(0, 3) });
  return out;
};
// A fresh checkout: tracked files only, no node_modules or .dependencies.
const checkout = dir => { execFileSync('git', ['clone', '-q', repo, dir]); cpSync(join(repo, 'scripts', 'link-durable.mjs'), join(dir, 'scripts', 'link-durable.mjs')); cpSync(join(repo, 'package.json'), join(dir, 'package.json')); };
try {
  const pi = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works', 'pi-coding-agent');
  result.installedPi = JSON.parse(readFileSync(join(pi, 'package.json'), 'utf8')).version;

  // Red: the pre-fix script against the installed Pi.
  const old = join(root, 'old'); execFileSync('git', ['clone', '-q', repo, old]);
  writeFileSync(join(old, 'scripts', 'link-durable.mjs'), execFileSync('git', ['show', '086a480:scripts/link-durable.mjs'], { cwd: repo }));
  const red = run('red: old script', old, 'scripts/link-durable.mjs');
  result.red = { status: red.status, message: /Error: (.*)/.exec(red.stderr)?.[1] };

  const fresh = join(root, 'fresh'); checkout(fresh);
  check('package.json has one setup command covering Durable and unpdf', /link-durable\.mjs/.test(JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8')).scripts.setup ?? ''));
  const first = run('fresh', fresh, 'scripts/link-durable.mjs');
  check('fresh checkout links against the installed Pi', first.status === 0, first.stderr);
  for (const [name, dir] of [['@earendil-works/pi-durable', 'durable'], ['unpdf', 'unpdf']]) {
    const link = join(fresh, 'node_modules', name);
    check(`${name} is a symlink into .dependencies`, lstatSync(link).isSymbolicLink() && readlinkSync(link).startsWith(join(fresh, '.dependencies', dir)));
    const receipt = JSON.parse(readFileSync(join(fresh, '.dependencies', dir, readlinkSync(link).split('/').at(-2), 'receipt.json'), 'utf8'));
    check(`${name} receipt records the pinned sha512`, /^sha512-/.test(receipt.integrity));
  }
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/chord', 'typebox', 'diff']) check(`Durable resolves ${name} to the installed Pi copy`, readlinkSync(join(fresh, '.dependencies', 'durable', '1.0.0', 'node_modules', name)) === join(pi, 'node_modules', name));
  const imports = spawnSync(process.execPath, ['--input-type=module', '-e', "const d = await import('@earendil-works/pi-durable'); const u = await import('unpdf'); console.log(JSON.stringify({ durable: Object.keys(d).length, unpdf: typeof u.extractText }))"], { cwd: fresh, encoding: 'utf8' });
  check('both packages import from the fresh checkout', imports.status === 0 && /"unpdf":"function"/.test(imports.stdout), imports.stderr);
  result.imports = imports.stdout.trim();

  const tgz = join(fresh, '.dependencies', 'durable', '1.0.0', 'earendil-works-pi-durable-1.0.0.tgz'), mtime = statSync(tgz).mtimeMs;
  check('second run is idempotent and does not download again', run('again', fresh, 'scripts/link-durable.mjs').status === 0 && statSync(tgz).mtimeMs === mtime);

  // Pi 2.x is refused.
  const pi2 = join(root, 'pi2'); mkdirSync(pi2); writeFileSync(join(pi2, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  const two = run('pi 2.0', fresh, 'scripts/link-durable.mjs', { PI_PROJECTS_PI_ROOT: pi2 });
  check('a Pi 2.x host is refused', two.status !== 0 && /needs an installed Pi 1\.x/.test(two.stderr));
  // A Pi 1.x whose shared library does not satisfy Durable's range is refused, naming it.
  const pi19 = join(root, 'pi19'); mkdirSync(join(pi19, 'node_modules', '@earendil-works'), { recursive: true });
  writeFileSync(join(pi19, 'package.json'), JSON.stringify({ version: '1.9.0' }));
  symlinkSync(join(pi, 'node_modules', 'semver'), join(pi19, 'node_modules', 'semver'));
  for (const name of ['@earendil-works/pi-ai', 'typebox', 'diff']) symlinkSync(join(pi, 'node_modules', name), join(pi19, 'node_modules', name));
  mkdirSync(join(pi19, 'node_modules', '@earendil-works', 'chord')); writeFileSync(join(pi19, 'node_modules', '@earendil-works', 'chord', 'package.json'), JSON.stringify({ version: '0.9.0' }));
  const bad = run('pi 1.9 old chord', fresh, 'scripts/link-durable.mjs', { PI_PROJECTS_PI_ROOT: pi19 });
  check('an unsatisfied shared library range is refused by name', bad.status !== 0 && /@earendil-works\/chord 0\.9\.0 \(needs \^1\.0\.0\)/.test(bad.stderr), bad.stderr);
  check('a refused run leaves the existing links alone', readlinkSync(join(fresh, '.dependencies', 'durable', '1.0.0', 'node_modules', '@earendil-works', 'chord')) === join(pi, 'node_modules', '@earendil-works', 'chord'));

  // Tampered receipt and a non-symlink in node_modules are refused.
  const tampered = join(root, 'tampered'); checkout(tampered); cpSync(join(fresh, '.dependencies'), join(tampered, '.dependencies'), { recursive: true });
  const receiptPath = join(tampered, '.dependencies', 'durable', '1.0.0', 'receipt.json');
  writeFileSync(receiptPath, readFileSync(receiptPath, 'utf8').replace(/sha512-[^"]+/, 'sha512-AAAA'));
  const tamper = run('tampered receipt', tampered, 'scripts/link-durable.mjs');
  check('an unpacked package with a wrong integrity receipt is refused', tamper.status !== 0 && /Unexpected unpacked @earendil-works\/pi-durable/.test(tamper.stderr));
  const blocked = join(root, 'blocked'); checkout(blocked); cpSync(join(fresh, '.dependencies'), join(blocked, '.dependencies'), { recursive: true });
  mkdirSync(join(blocked, 'node_modules', 'unpdf'), { recursive: true });
  const block = run('non-symlink unpdf', blocked, 'scripts/link-durable.mjs');
  check('a real directory at node_modules/unpdf is never replaced', block.status !== 0 && /Refusing to replace non-symlink/.test(block.stderr) && !lstatSync(join(blocked, 'node_modules', 'unpdf')).isSymbolicLink());
  check('red run (pre-fix script) failed on the installed Pi', result.red.status !== 0 || result.installedPi === '1.0.0', JSON.stringify(result.red));
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.failure = String(error?.stack ?? error); }
writeFileSync(join(artifacts, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, checks: result.checks.length, failure: result.failure, red: result.red, artifact: artifacts }, null, 2));
process.exit(result.status === 'passed' ? 0 : 1);
