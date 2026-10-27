import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The repo-local pr-review, code-review, and ask-user skills override same-named global skills, and their local graph resolves.
const repo = resolve(import.meta.dirname, '..');
const local = name => join(repo, '.agents', 'skills', name);
const read = (name, file = 'SKILL.md') => readFileSync(join(local(name), file), 'utf8');
const description = text => { const value = text.match(/^description:\s*(.+)$/m)[1]; return value.startsWith('"') ? JSON.parse(value) : value; };

const base = resolve('artifacts', `repo-skill-overrides-${Date.now()}`);
const home = join(base, 'home'), agent = join(base, 'agent');
for (const name of ['pr-review', 'code-review', 'ask-user']) {
  const dir = join(home, '.agents', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: GLOBAL ${name}\n---\n\nglobal body\n`);
}
mkdirSync(agent, { recursive: true });
const pkg = join(base, 'package');
mkdirSync(join(pkg, 'skills/ask-user'), { recursive: true });
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture-ask-user', version: '1.0.0', pi: { skills: ['./skills'] } }));
writeFileSync(join(pkg, 'skills/ask-user/SKILL.md'), '---\nname: ask-user\ndescription: PACKAGE broad gate\n---\nAlways ask for every choice.\n');
mkdirSync(join(pkg, 'skills/package-only'), { recursive: true });
writeFileSync(join(pkg, 'skills/package-only/SKILL.md'), '---\nname: package-only\ndescription: Confirms configured package discovery\n---\nPackage body.\n');
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [pkg] }));
Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent });
const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
const skills = (await loadProjectResourceLoader({ cwd: repo }, { passive: true })).getSkills().skills;
assert.ok(skills.some(s => s.name === 'package-only' && s.sourceInfo.origin === 'package'), 'configured package really loaded');
for (const name of ['pr-review', 'code-review', 'ask-user']) {
  const found = skills.find(item => item.name === name);
  assert.ok(found, `${name} is discovered`);
  assert.equal(found.filePath, join(local(name), 'SKILL.md'), `${name}: repo-local file wins over the global one`);
  assert.equal(found.description, description(read(name)), `${name}: local description is served`);
  assert.ok(!found.disableModelInvocation, `${name} stays automatically discoverable`);
}

const pr = read('pr-review'), code = read('code-review'), ask = read('ask-user');
for (const [label, text, file] of [['pr-review', pr, 'pr-review'], ['code-review', code, 'code-review']]) {
  for (const [, target] of text.matchAll(/\]\((\.\.?\/[^)#]+)\)/g)) assert.ok(existsSync(resolve(local(file), target)), `${label} links ${target}`);
  assert.doesNotMatch(text, /manager-delegation|agent_spawn|agent_types|agent_wait|agent_output/, `${label} has no manager API pointer`);
}
for (const target of ['references/bugs-performance.md', 'scripts/collect-arcanum.sh']) {
  assert.ok(pr.includes(target) && existsSync(join(local('pr-review'), target)), `pr-review ships ${target}`);
}
assert.doesNotMatch(pr, /~\/\.agents\/skills\/code-review/, 'pr-review reads the local code-review');
for (const axis of ['Standards', 'Spec', 'Bugs/performance']) assert.ok(pr.includes(axis), `pr-review covers ${axis}`);
for (const term of ['arc diff', 'git diff', 'arc log', 'git log', '400 words', 'evidence unavailable', 'Mysterious Name', 'Refused Bequest']) assert.ok((pr + code).includes(term), `review skills mention ${term}`);

assert.doesNotMatch(description(ask), /MUST|ambiguous\b(?! requirements)/, 'ask-user description is narrowed');
assert.doesNotMatch(ask, /Multiple valid options exist|Do \*\*not\*\* skip this gate|references\/ask-user-skill/, 'ask-user body drops the broad gates');
assert.match(ask, /Routine reversible choices/, 'ask-user exempts routine reversible choices');
assert.match(ask, /Agent Protocol Handshake/, 'ask-user keeps the handshake');
assert.match(ask, /Anti-overasking guardrails/, 'ask-user keeps the guardrails');
const { listSkills, expandSkillCommand } = await import('../src/coordinator-skills.ts');
const loader = await loadProjectResourceLoader({ cwd: repo }, { passive: true });
const { skillIndex } = await import('../src/skill-profiles.ts');
assert.match(skillIndex(loader.getSkills().skills), /- pr-review:.*before completion/);
const expanded = await expandSkillCommand(loader, '/skill:pr-review review this candidate');
assert.match(expanded, /Use these reviewers in independent fresh contexts/);
assert.ok(expanded.includes(join(local('pr-review'), 'SKILL.md')));
const discovery = { skills: listSkills(loader), expanded };
writeFileSync(join(base, 'discovery.json'), JSON.stringify(discovery, null, 2));
if (process.env.PI_ARTIFACTS_DIR) cpSync(base, join(process.env.PI_ARTIFACTS_DIR, 'repo-skill-overrides'), { recursive: true });
console.log('ok');
