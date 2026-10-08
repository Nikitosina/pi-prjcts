// Browser E2E: Arc project detection and grant (S1). Fake arc / arc-wt on a fake Arcadia mount, fake model, private HOME. Failure cases: arc-detect-grant-failures.md.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKit } from './lib/e2e-kit.mjs';
import { fakeArcadia, assertFakeOnly, SUBPATH } from './lib/fake-arc-kit.mjs';

const kit = await createKit('arc-detect-grant');
const { check, rpc, result, root } = kit;
const fake = fakeArcadia(kit.root);
Object.assign(kit.hostEnv, fake.env);
kit.initRepo();
// Owner skills (arc, arc-wt, arcanum-go, arcadia-ci): ~/.agents/skills is a pi source; ~/.claude/skills is only reported.
const skill = (base, name, extra = '') => { const dir = join(kit.userHome, base, 'skills', name); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Owner skill ${name} for Arcadia work.\n${extra}---\n\n# ${name}\n`); };
for (const name of ['arc', 'arcanum-go', 'arcadia-ci']) skill('.agents', name);
skill('.agents', 'arc-wt', 'disable-model-invocation: true\n');
skill('.claude', 'claude-only-skill');
const real = path => realpathSync(path);
const snapshotOf = id => rpc({ action: 'owner-setup-snapshot', id });
const configure = changes => { const path = join(fake.dir, 'wt.json'), data = JSON.parse(readFileSync(path, 'utf8')); Object.assign(data.config, changes); writeFileSync(path, JSON.stringify(data)); };
const knob = changes => { const path = join(fake.dir, 'state.json'), data = JSON.parse(readFileSync(path, 'utf8')); writeFileSync(path, JSON.stringify({ ...data, ...changes })); };

await kit.run(async () => {
  const id = await kit.createProject('YKKeyboard', { grant: false, cwd: fake.subdir });
  const gitId = await kit.createProject('Plain git', { grant: false });
  let spawnedByGit = fake.calls().length;
  const gitSnap = await snapshotOf(gitId);
  check('F2/F10 a git project previews a github grant and spawns no arc process', gitSnap.quickGrant.available === true && (gitSnap.quickGrant.provider ?? 'github') === 'github' && fake.calls().length === spawnedByGit, gitSnap.quickGrant);

  let snap = await snapshotOf(id);
  const quick = snap.quickGrant;
  check('F3/F6 the subdirectory project previews an Arc grant at the Arc root with the trunk head', quick.available && quick.provider === 'arc' && quick.repositoryId === 'arcadia' && quick.ownerCheckout === real(fake.arcadia) && quick.subpath === SUBPATH && quick.approvedRoot === real(fake.wtBase) && quick.head === fake.trunkHead && quick.head !== fake.featureHead, quick);
  check('F9 Connect Arcadia is blocked until the workspace grant exists', snap.arcQuick?.available === false && /edit this repository/i.test(snap.arcQuick.blocker), snap.arcQuick);

  // Breakages block the preview with a message and write nothing.
  const blocked = async (label, change, restore, pattern) => { change(); const value = (await snapshotOf(id)).quickGrant; check(label, value.available === false && pattern.test(value.blocker), value); restore(); };
  await blocked('F4 `arc root` disagreeing with the mount is a blocker', () => knob({ rootOverride: '/somewhere/else' }), () => knob({ rootOverride: undefined }), /root|arc/i);
  await blocked('F4 an unreadable `arc info` is a blocker', () => knob({ infoBroken: true }), () => knob({ infoBroken: undefined }), /info|arc/i);
  await blocked('F6 an unreachable trunk is a blocker', () => knob({ trunkBroken: true }), () => knob({ trunkBroken: undefined }), /trunk/i);
  const objectStore = fake.objects;
  await blocked('F4 arc-wt config without an object store is a blocker', () => configure({ object_store_path: null }), () => configure({ object_store_path: objectStore }), /object store|arc-wt/i);
  await blocked('F5 a worktree root inside the Arc root is refused', () => configure({ worktrees_base_path: join(fake.arcadia, 'wt') }), () => configure({ worktrees_base_path: fake.wtBase }), /outside|inside/i);
  check('F4 the breakages wrote no grant', (await snapshotOf(id)).workspace === null);
  check('F8 a stale revision is refused', (await kit.rejects({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: '0'.repeat(64) })) !== null);

  // UI.
  const page = await kit.openPage(await kit.webUrl(id, 'settings'));
  await page.waitFor(`document.querySelectorAll('#owner-steps li').length >= 3`, 'owner steps');
  const stepsText = () => page.evaluate(`document.querySelector('#owner-steps').innerText`);
  const before = await stepsText();
  check('F11 step 1 offers the one-click grant for an Arc project', /Let workers edit this repo/.test(before), before);
  await page.evaluate(`document.querySelector('[data-action="workspace-quick"]').click()`);
  await page.waitFor(`document.querySelector('dialog')?.open && /arc-wt/.test(document.querySelector('dialog').innerText)`, 'arc workspace dialog');
  const dialogText = await page.evaluate(`document.querySelector('dialog').innerText`);
  check('F11 the dialog speaks Arc: arc-wt worktrees, subpath, trunk', /arc-wt/.test(dialogText) && dialogText.includes(SUBPATH) && /trunk/i.test(dialogText) && !/git worktree/i.test(dialogText), dialogText);
  await page.shot('01-arc-workspace-dialog');
  await page.evaluate(`document.querySelector('[data-action="workspace-quick-confirm"]').click()`);
  await page.waitFor(`/Arcadia/.test(document.querySelector('dialog')?.innerText ?? '') && !!document.querySelector('[data-action="arc-quick"]')`, 'owner dialog with Connect Arcadia');
  await page.evaluate(`document.querySelector('[data-action="close-dialog"]')?.click(); document.querySelector('dialog')?.close?.()`);
  await page.waitFor(`/Connect Arcadia/.test(document.querySelector('#owner-steps').innerText)`, 'step 2 Connect Arcadia');
  const after = await stepsText();
  check('F11 step 2 is Arcadia, not GitHub', /Connect Arcadia/.test(after) && !/Connect GitHub/.test(after), after);
  await page.shot('02-arc-owner-steps');
  snap = await snapshotOf(id);
  const repo = snap.workspace?.repositories?.[0], scope = snap.workspace?.scopes?.[0];
  check('F3/F6 the grant persisted: provider arc, Arc root, arc-wt root, subpath, shared store, trunk base', snap.workspace.provider === 'arc' && repo.provider === 'arc' && repo.ownerCheckout === real(fake.arcadia) && repo.approvedRoot === real(fake.wtBase) && repo.subpath === SUBPATH && repo.fileOwnershipPrefix === '.' && repo.sharedObjectStore === real(fake.objects) && scope.wholeRepository && scope.baseRevision === fake.trunkHead, { repo, scope });
  check('F8 a second quick grant is refused', (await kit.rejects({ action: 'workspace-quick-grant', id, confirm: id, expectedRevision: snap.workspaceRevision })) !== null);

  await page.evaluate(`document.querySelector('[data-action="arc-quick"]').click()`);
  await page.waitFor(`document.querySelector('dialog')?.open && /trunk/.test(document.querySelector('dialog').innerText) && !!document.querySelector('[data-action="arc-quick-confirm"]')`, 'connect dialog');
  await page.shot('03-connect-arcadia-dialog');
  await page.evaluate(`document.querySelector('[data-action="arc-quick-confirm"]').click()`);
  await page.waitFor(`/Arcadia connected|✓ Arcadia/.test(document.querySelector('dialog')?.innerText ?? '')`, 'connected dialog');
  await page.evaluate(`document.querySelector('[data-action="close-dialog"]')?.click(); document.querySelector('dialog')?.close?.()`);
  snap = await snapshotOf(id);
  check('F9 Connect Arcadia recorded repository, login, trunk base and the workspace revision', snap.arc?.repositoryId === 'arcadia' && snap.arc.login === fake.login && snap.arc.baseBranch === 'trunk' && /^[a-f0-9]{64}$/.test(snap.arc.workspaceRevision), snap.arc);
  check('F9 a second Connect Arcadia is refused', (await kit.rejects({ action: 'arc-quick-authorize', id, confirm: id, expectedRevision: snap.arcRevision })) !== null);
  check('F9 and the preview says connected', snap.arcQuick?.available === false && /connected/i.test(snap.arcQuick.blocker), snap.arcQuick);
  await page.viewport(390, 844, true); await page.evaluate(`document.querySelector('#owner-steps').scrollIntoView()`);
  const narrow = await page.evaluate(`document.documentElement.scrollWidth > innerWidth + 1`);
  await page.shot('04-arc-owner-steps-390');
  check('F11 the Arc steps fit 390 px', !narrow);

  // Skills.
  const names = (await rpc({ action: 'coordinator-skills', id })).skills;
  const byName = Object.fromEntries(names.map(item => [item.name, item]));
  check('F12 arc, arc-wt, arcanum-go and arcadia-ci are skill candidates (from ~/.agents/skills)', ['arc', 'arc-wt', 'arcanum-go', 'arcadia-ci'].every(name => byName[name]), names.map(item => item.name));
  check('F12 arc-wt is manual-only', byName['arc-wt'].manual === true);
  result.skillSources = { claudeOnlyListed: Boolean(byName['claude-only-skill']), sources: Object.fromEntries(names.map(item => [item.name, item.source])) };

  // Persistence across a restart; the git project is unaffected.
  await kit.restartHost();
  const again = await snapshotOf(id);
  check('the grant and authorization survive a host restart', JSON.stringify(again.workspace) === JSON.stringify(snap.workspace) && JSON.stringify(again.arc) === JSON.stringify(snap.arc));
  assertFakeOnly(fake, root, check);
});
