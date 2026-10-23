// Parallel runner for the local e2e/unit scripts: npm run e2e -- [--jobs N] [--retry-failed-serially] [--list] [names|globs...]
// A name matches `scripts/<name>.mjs`, `<name>-e2e`, `<name>-unit` or `<name>-tdd`; globs (`durable-*`) match the script basename without `.mjs`.
// Each script already owns a private HOME, socket, port and Chrome profile, so scripts run side by side without further isolation.
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
// Scripts that reach real providers, plus the runner itself.
export const EXCLUDED = new Set(['claude-bridge-live-e2e', 'run-e2e']);
export const discover = () => readdirSync(join(repo, 'scripts')).filter(f => /(-e2e|-unit|-tdd|-check)\.mjs$/.test(f)).map(f => f.slice(0, -4)).filter(n => !EXCLUDED.has(n)).sort();
// Scripts that already fail on main (see "knownFailing" in e2e-manifest.json): reported as KNOWN-FAIL, they do not fail the run; one that starts passing is reported too.
const manifest = JSON.parse(readFileSync(join(repo, 'scripts/e2e-manifest.json'), 'utf8'));
const globToRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`);
export const select = (all, patterns) => {
  if (!patterns.length) return all;
  const picked = new Set();
  for (const pattern of patterns) {
    const bare = pattern.replace(/^scripts\//, '').replace(/\.mjs$/, '');
    const re = globToRegExp(bare);
    const hits = all.filter(n => re.test(n) || ['-e2e', '-unit', '-tdd', '-check'].some(s => n === bare + s));
    if (!hits.length) throw Error(`No script matches "${pattern}"`);
    hits.forEach(n => picked.add(n));
  }
  return all.filter(n => picked.has(n));
};

function parseArgs(argv) {
  const opts = { jobs: Math.max(1, Math.min(6, Math.floor(cpus().length / 2))), retry: false, list: false, timeout: 600, patterns: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jobs' || a === '-j') opts.jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (a.startsWith('--jobs=')) opts.jobs = Math.max(1, Number(a.slice(7)) || 1);
    else if (a === '--retry-failed-serially') opts.retry = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--timeout') opts.timeout = Number(argv[++i]) || 600;
    else if (a === '--') continue;
    else opts.patterns.push(a);
  }
  return opts;
}

function runScript(name, timeoutSec) {
  return new Promise(resolve => {
    const started = Date.now();
    let output = '';
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.PI_PACKAGE_DIR;
    const child = spawn(process.execPath, [join('scripts', `${name}.mjs`)], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const collect = part => { output += part; if (output.length > 400000) output = output.slice(-200000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { output += `\n[run-e2e] timed out after ${timeoutSec}s\n`; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutSec * 1000);
    child.on('close', code => { clearTimeout(timer); resolve({ name, ok: code === 0, code, ms: Date.now() - started, output }); });
  });
}

async function pool(names, jobs, onDone, timeout) {
  const results = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, async () => {
    while (next < names.length) { const result = await runScript(names[next++], timeout); results.push(result); onDone(result); }
  }));
  return results;
}

const fmt = ms => `${(ms / 1000).toFixed(1)}s`;
const tail = (text, lines = 40) => text.trimEnd().split('\n').slice(-lines).join('\n');

const durationsFile = join(repo, 'artifacts', 'e2e-durations.json');
const loadDurations = () => { try { return JSON.parse(readFileSync(durationsFile, 'utf8')); } catch { return {}; } };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const known = name => manifest.knownFailing.some(g => globToRegExp(g).test(name));
  const durations = loadDurations();
  // Longest first, so the slowest script does not start last and dominate the wall-clock.
  const names = select(discover(), opts.patterns).sort((a, b) => (durations[b] ?? 30000) - (durations[a] ?? 30000));
  if (opts.list) { console.log(names.join('\n')); return; }
  console.log(`Running ${names.length} script(s) with ${opts.jobs} job(s)`);
  const wall = Date.now(); let done = 0;
  const report = result => console.log(`[${++done}/${names.length}] ${result.ok ? (known(result.name) ? 'PASS (was known-failing)' : 'PASS') : known(result.name) ? 'KNOWN-FAIL' : 'FAIL'} ${result.name} (${fmt(result.ms)})`);
  const results = await pool(names, opts.jobs, report, opts.timeout);
  const failed = results.filter(r => !r.ok && !known(r.name)), knownFailed = results.filter(r => !r.ok && known(r.name));
  for (const r of failed) console.log(`\n--- ${r.name} (exit ${r.code}) output tail ---\n${tail(r.output)}`);
  const flaky = [];
  if (failed.length && opts.retry) {
    console.log(`\nRetrying ${failed.length} failed script(s) serially`);
    for (const r of failed) {
      const again = await runScript(r.name, opts.timeout);
      console.log(`  ${again.ok ? 'PASS (flaky under parallel load)' : 'FAIL (fails alone too)'} ${r.name} (${fmt(again.ms)})`);
      if (again.ok) { flaky.push(r.name); r.retriedOk = true; } else r.output = again.output;
    }
  }
  const hard = failed.filter(r => !r.retriedOk);
  const total = Date.now() - wall;
  const summary = { jobs: opts.jobs, total: names.length, passed: results.filter(r => r.ok || r.retriedOk).length, failed: hard.map(r => r.name), knownFailing: knownFailed.map(r => r.name), nowPassing: results.filter(r => r.ok && known(r.name)).map(r => r.name), flaky, wallMs: total, scripts: results.sort((a, b) => b.ms - a.ms).map(({ name, ok, code, ms }) => ({ name, ok, code, ms })) };
  const dir = join(repo, 'artifacts'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `e2e-summary-${new Date().toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  const merged = { ...durations }; for (const r of results) if (r.ok) merged[r.name] = r.ms;
  writeFileSync(durationsFile, JSON.stringify(merged, null, 2) + '\n');
  console.log(`\n${summary.passed}/${summary.total} passed in ${fmt(total)} (sum of script times ${fmt(results.reduce((s, r) => s + r.ms, 0))}); summary: ${file}`);
  if (knownFailed.length) console.log(`Known-failing on main (not counted): ${knownFailed.length}`);
  if (summary.nowPassing.length) console.log(`Known-failing but passing now (remove from knownFailing): ${summary.nowPassing.join(', ')}`);
  if (flaky.length) console.log(`Flaky under parallel load: ${flaky.join(', ')}`);
  if (hard.length) { console.log(`Failed: ${hard.map(r => r.name).join(', ')}`); process.exitCode = 1; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
