import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Roots and precedence of the SDK catalog Projects relies on, and that passive discovery never installs a package.
const base = resolve('artifacts', `skill-discovery-roots-${Date.now()}`);
const home = join(base, 'home'), agent = join(base, 'agent'), ws = join(base, 'ws'), bin = join(base, 'bin'), log = join(base, 'npm.log');
for (const dir of [home, agent, ws, bin]) mkdirSync(dir, { recursive: true });
writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> ${log}\nexit 1\n`); chmodSync(join(bin, 'npm'), 0o755);
Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${process.env.PATH}` });
delete process.env.PI_OFFLINE;
const skill = (dir, name, description) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`); };
const roots = { projectPi: join(ws, '.pi', 'skills'), projectAgents: join(ws, '.agents', 'skills'), homeAgents: join(home, '.agents', 'skills'), agentDir: join(agent, 'skills') };
for (const [label, dir] of Object.entries(roots)) { skill(dir, `only-${label}`, label); skill(dir, 'shared', label); }
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: ['npm:missing-skill-package-zz'] }));
const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
const passive = await loadProjectResourceLoader({ cwd: ws }, { passive: true });
const names = passive.getSkills().skills.map(item => item.name).sort();
for (const label of Object.keys(roots)) assert.ok(names.includes(`only-${label}`), `${label} root is discovered`);
const shared = passive.getSkills().skills.find(item => item.name === 'shared');
const installs = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => /install/.test(line)) : [];
assert.deepEqual(installs(), [], 'passive discovery must not install a package');
await loadProjectResourceLoader({ cwd: ws }).catch(() => {});
assert.ok(installs().some(line => line.includes('missing-skill-package-zz')), 'the opening load still installs, as before');
assert.equal(shared.description, 'projectPi', 'project .pi/skills wins a name collision');
console.log('ok');
