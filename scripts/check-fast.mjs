// `npm run check:fast`: typecheck plus only the e2e/unit scripts affected by files changed against origin/main (committed, staged, unstaged and untracked).
// Shared harness or core files (scripts/e2e-manifest.json "all") select every script. Flags: --base <ref>, --jobs N, --dry-run (print the selection, run nothing), --no-check.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, select } from './run-e2e.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name), value = name => args[args.indexOf(name) + 1];
const base = flag('--base') ? value('--base') : 'origin/main';
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);

const globRe = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')}$`);
const matches = (globs, file) => globs.some(g => globRe(g).test(file));

const manifest = JSON.parse(readFileSync(join(repo, 'scripts/e2e-manifest.json'), 'utf8'));
const changed = [...new Set([...git('diff', '--name-only', `${base}...HEAD`), ...git('diff', '--name-only', 'HEAD'), ...git('ls-files', '--others', '--exclude-standard')])].sort();
const all = discover();
const sources = Object.fromEntries(all.map(n => [n, readFileSync(join(repo, 'scripts', `${n}.mjs`), 'utf8')]));
const picked = new Set(), reasons = [];
const add = (names, why) => { for (const n of names) picked.add(n); if (names.length) reasons.push(`${why} -> ${names.length} script(s)`); };
const pick = patterns => { const usable = patterns.filter(p => all.some(n => globRe(p.replace(/^scripts\//, '')).test(n) || all.includes(p + '-e2e') || all.includes(p))); return usable.length ? select(all, usable) : []; };

let everything = false;
for (const file of changed) {
  if (matches(manifest.all, file)) { everything = true; reasons.push(`${file} is shared harness/core -> all scripts`); break; }
  const own = file.match(/^scripts\/(.+)\.mjs$/)?.[1];
  if (own && all.includes(own)) add([own], file);
  if (matches(manifest.browser, file)) add(all.filter(n => /Page\.navigate|openPage/.test(sources[n])), file);
  for (const [glob, scripts] of Object.entries(manifest.map)) if (matches([glob], file)) add(pick(scripts), `${file} (${glob})`);
  const module = file.match(/^src\/(.+)\.ts$/)?.[1];
  if (module) {
    const hits = all.filter(n => n.includes(module) || sources[n].includes(`${module}.ts`) || sources[n].includes(`/${module}'`) || sources[n].includes(`/${module}"`));
    if (!hits.length) reasons.push(`${file}: no script mentions it; only the smoke set covers it`);
    add(hits, file);
  }
}
const selected = everything ? all : all.filter(n => picked.has(n) || manifest.smoke.some(s => n === s || n === `${s}-e2e`));

console.log(`Changed vs ${base}: ${changed.length} file(s)`);
for (const r of reasons) console.log(`  ${r}`);
console.log(`Selected ${selected.length}/${all.length}: ${selected.join(' ')}`);
if (flag('--dry-run')) process.exit(0);
const run = (cmd, a) => spawnSync(cmd, a, { cwd: repo, stdio: 'inherit' }).status ?? 1;
if (!flag('--no-check') && run('npm', ['run', 'check'])) process.exit(1);
const jobs = flag('--jobs') ? ['--jobs', value('--jobs')] : [];
process.exit(run(process.execPath, [join('scripts', 'run-e2e.mjs'), ...jobs, '--retry-failed-serially', ...selected]));
