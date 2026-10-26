import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// verify-pi-prjcts is discovered by the SDK catalog and by worker repository-skill discovery, and the .cursor pointer resolves to the single canonical copy.
const root = process.cwd(), name = 'verify-pi-prjcts';
const temp = [mkdtempSync(join(tmpdir(), 'vsd-home-')), mkdtempSync(join(tmpdir(), 'vsd-agent-'))];
Object.assign(process.env, { HOME: temp[0], PI_CODING_AGENT_DIR: temp[1], PI_OFFLINE: '1' });
const canonical = join(root, '.agents/skills', name), pointer = join(root, '.cursor/skills', name);
assert.ok(lstatSync(canonical).isDirectory() && !lstatSync(canonical).isSymbolicLink(), 'canonical copy is a real directory');
assert.ok(lstatSync(pointer).isSymbolicLink() && realpathSync(pointer) === realpathSync(canonical), '.cursor pointer resolves to the canonical copy');
const { loadProjectResourceLoader } = await import('../src/project-resources.ts');
const skill = (await loadProjectResourceLoader({ cwd: root }, { passive: true })).getSkills().skills.find(item => item.name === name);
assert.ok(skill, 'SDK catalog lists the skill');
assert.equal(realpathSync(skill.filePath), join(realpathSync(canonical), 'SKILL.md'));
assert.match(skill.description, /browser inbox/);
const { discoverRepositorySkills } = await import('../src/worker-skill-discovery.ts');
const found = await discoverRepositorySkills({ repositoryId: 'verify', ownerCheckout: root, protectedFiles: [] });
assert.deepEqual(found.diagnostics.filter(item => String(item.path).includes(name)), [], 'no diagnostics for this skill');
assert.ok(found.candidates.some(item => item.name === name), 'worker repository discovery lists the skill');
for (const dir of temp) rmSync(dir, { recursive: true, force: true });
console.log('ok');
