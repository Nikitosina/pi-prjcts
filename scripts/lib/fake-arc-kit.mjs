// Fixture for the Arc suites: a fake Arcadia mount (a git repo with `.arc/`), fake arc / arc-wt (/ arcanum-go) wrappers and their state.
// Every path lives under `root`; nothing here can reach a real Arcadia, mount, Arcanum or CI.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const scripts = new URL('..', import.meta.url).pathname;
export const SUBPATH = 'mobile/nlp/ios/keyboard';

export function fakeArcadia(root, { login = 'e2euser' } = {}) {
  const dir = join(root, 'fake-arc'), bin = join(root, 'fake-bin'), arcadia = join(root, 'arcadia'), wtBase = join(root, 'arcadia-wt'), stores = join(root, 'arc-stores'), objects = join(root, 'arc-objects');
  for (const path of [dir, bin, arcadia, wtBase, stores, objects]) mkdirSync(path, { recursive: true });
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } }).trim();
  git(arcadia, 'init', '-b', 'trunk');
  git(arcadia, 'config', 'core.excludesFile', '/dev/null');
  writeFileSync(join(arcadia, '.git', 'info', 'exclude'), '.arc\n');
  mkdirSync(join(arcadia, '.arc'));
  const put = (path, text) => { mkdirSync(join(arcadia, path, '..'), { recursive: true }); writeFileSync(join(arcadia, path), text); };
  put('.arcadia.root', '');
  put('a.yaml', 'service: arcadia\n');
  put(`${SUBPATH}/AGENTS.md`, '# Keyboard rules\nSUBDIR-STANDING-MARKER: use arc, never git.\n');
  put(`${SUBPATH}/.xcodebuildmcp/config.yaml`, 'schemeName: Keyboard\n');
  put(`${SUBPATH}/Sources/Keys.swift`, 'let keys = 1\n');
  git(arcadia, 'add', '-A'); git(arcadia, 'commit', '-qm', 'trunk base');
  const trunkHead = git(arcadia, 'rev-parse', 'trunk');
  // The owner's mount sits on a feature branch with one extra commit, so "base = trunk" is distinguishable from "base = current HEAD".
  git(arcadia, 'checkout', '-qb', 'owner-feature'); put('owner-wip.txt', 'wip\n'); git(arcadia, 'add', '-A'); git(arcadia, 'commit', '-qm', 'owner wip');
  const config = { worktrees_base_path: wtBase, stores_base_path: stores, object_store_path: objects, trunk_path: arcadia, default_repo: 'arcadia', default_base: 'trunk', default_mode: 'mount-shared', default_mount_flags: '[]', post_create_hook: null, pre_remove_hook: null };
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ login, repository: 'arcadia' }, null, 2));
  writeFileSync(join(dir, 'wt.json'), JSON.stringify({ config, entries: [], tick: 0 }, null, 2));
  writeFileSync(join(dir, 'calls.jsonl'), '');
  git(dir, 'init', '--bare', '-q', join(dir, 'server.git'));
  const wrap = (name, script) => { const path = join(bin, name); writeFileSync(path, `#!/bin/sh\nFAKE_ARC_DIR='${dir}' exec '${process.execPath}' '${join(scripts, script)}' "$@"\n`); chmodSync(path, 0o755); return path; };
  const arc = wrap('arc', 'fake-arc.mjs'), arcWt = wrap('arc-wt', 'fake-arc-wt.mjs');
  const ya = wrap('ya', 'fake-ya.mjs');
  const arcanum = existsSync(join(scripts, 'fake-arcanum.mjs')) ? wrap('arcanum-go', 'fake-arcanum.mjs') : null;
  const calls = () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    dir, bin, arcadia, serverRefs: () => execFileSync('/usr/bin/git', ['--git-dir', join(dir, 'server.git'), 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => line.split(' ')), subdir: join(arcadia, SUBPATH), wtBase, stores, objects, login, trunkHead, featureHead: git(arcadia, 'rev-parse', 'HEAD'), git, calls,
    wt: () => JSON.parse(readFileSync(join(dir, 'wt.json'), 'utf8')),
    // Environment seams for the host (and the PATH worker shells see): the fakes shadow any real arc.
    env: { PI_PROJECTS_ARC_CLI: arc, PI_PROJECTS_ARC_WT_CLI: arcWt, PI_PROJECTS_YA_CLI: ya, ...(arcanum ? { PI_PROJECTS_ARCANUM_CLI: arcanum } : {}), PATH: `${bin}:${process.env.PATH}` },
  };
}
/** Fails when any fake call touched a path outside `root` or forced a removal. */
export function assertFakeOnly(fake, root, check) {
  const calls = fake.calls();
  // arc-wt runs without a cwd (the host's), so its safety is in the paths it was given; arc runs inside a checkout.
  const outside = calls.filter(call => (call.tool === 'arc' && !call.cwd.startsWith(root)) || call.argv.some((arg, at) => arg.startsWith('/') && !arg.startsWith(root) && call.argv[at - 1] !== '--path'));
  check('fakes only: every arc call ran under the temp root and every path argument is inside it', outside.length === 0, outside.slice(0, 3));
  check('fakes only: no real Arcadia path was used', !JSON.stringify(calls).includes('/Users/nikitarat/arcadia'));
  check('arc-wt --force is never used', calls.every(call => !call.forced));
}
