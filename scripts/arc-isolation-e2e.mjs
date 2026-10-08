// E2E: Arc worktree allocation, reconcile and release through workspaceIsolation, against the FAKE arc / arc-wt only (no real Arcadia).
// Replaces durable-workspace-arc-e2e, durable-workspace-arc-existing-thread-e2e, durable-workspace-original-intent-reconcile and the Arc half of workspace-allocation-e2e.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { workspaceIsolation } from '../src/workspace-isolation.ts';
import { fakeArcadia, assertFakeOnly } from './lib/fake-arc-kit.mjs';

const stamp = new Date().toISOString().replaceAll(':', '-'), artifacts = join(process.cwd(), 'artifacts', `arc-isolation-${stamp}`);
const root = join(realpathSync(tmpdir()), `arc-isolation-${randomUUID()}`);
mkdirSync(artifacts, { recursive: true }); mkdirSync(root, { recursive: true });
const report = { checks: [], receipts: {} };
const check = (label, ok, detail) => { if (!ok) throw Error(`${label}: ${JSON.stringify(detail ?? null).slice(0, 2000)}`); report.checks.push(label); };
const fake = fakeArcadia(root);
Object.assign(process.env, fake.env);
let harness, child;
try {
  harness = await Harness.open(await openNodeSqliteStorage(join(artifacts, 'durable.sqlite')), { models: await ModelRuntime.create({ allowModelNetwork: false }), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const projectId = randomUUID(), owner = `pi-projects:${projectId}`, store = realpathSync(fake.objects), wtBase = realpathSync(fake.wtBase), arcadia = realpathSync(fake.arcadia);
  const scopeFor = (name, extra = {}) => ({ projectId, repositoryId: 'arcadia', provider: 'arc', ownerCheckout: arcadia, approvedRoot: wtBase, workspacePath: join(wtBase, name), workspaceName: name, branch: name, baseRevision: fake.trunkHead, headRevision: fake.trunkHead, owner, leaseReason: `isolation e2e ${name}`, sharedObjectStore: store, fileOwnership: [], capabilityProfileRevision: 'e2e', allowDirtyOwner: true, ...extra });
  const make = (name, scope = {}, options = {}) => {
    const intent = { id: randomUUID(), attemptId: randomUUID(), action: 'allocate', scope: scopeFor(name, scope) };
    return { intent, iso: workspaceIsolation({ conversation, authority: { projectId, owner }, authorizedRepositories: [{ repositoryId: intent.scope.repositoryId, provider: 'arc', approvedRoot: wtBase, ownerCheckout: arcadia, fileOwnershipPrefix: '.' }], ...options }) };
  };
  const wtCalls = name => fake.calls().filter(call => call.tool === 'arc-wt' && call.argv.includes(name));

  // 1. Allocation: exact lease and shared-store facts.
  const a = make('alloc-one');
  let r = await a.iso.allocate(a.intent); report.receipts.allocate = r;
  check('allocation is allocated from a prepared intent', r.state === 'allocated', r);
  check('the lease owner is the project, the store is the shared object store, the base is trunk', r.lease?.owner === owner && r.providerFacts.objectStore === store && r.providerFacts.base === fake.trunkHead && r.providerFacts.head === fake.trunkHead, r);
  check('the worktree is a real checkout of trunk, outside the Arc mount', existsSync(join(r.workspacePath, 'a.yaml')) && !r.workspacePath.startsWith(arcadia + '/'), r.workspacePath);
  check('the owner mount is untouched (still on its feature branch)', fake.git(arcadia, 'branch', '--show-current') === 'owner-feature');
  const again = await a.iso.allocate(a.intent);
  check('allocating the same intent again adopts the receipt and does not add again', again.state === 'allocated' && wtCalls('alloc-one').filter(call => call.argv[0] === 'add').length === 1);

  // 2. Crash after the provider effect: reconcile keeps the same receipt, no second add.
  const crash = make('alloc-crash', {}, { afterProviderEffect: () => { throw new Error('simulated crash after arc-wt add'); } });
  await crash.iso.allocate(crash.intent).then(() => check('the crash seam fires', false), error => check('the crash seam fires', /simulated crash/.test(error.message)));
  const recovered = make('alloc-crash'); recovered.intent.id = crash.intent.id; recovered.intent.attemptId = crash.intent.attemptId;
  r = await recovered.iso.reconcile(recovered.intent); report.receipts.reconcile = r;
  check('reconcile after a crash yields the allocated receipt, intent and attempt preserved', r.state === 'allocated' && r.intentId === crash.intent.id && r.attemptId === crash.intent.attemptId, r);
  check('reconcile did not add a second worktree', wtCalls('alloc-crash').filter(call => call.argv[0] === 'add').length === 1);

  // 3. Foreign lease: someone else took the lease; reconcile refuses to adopt.
  const foreign = make('alloc-foreign');
  await foreign.iso.allocate(foreign.intent);
  const wt = (...args) => new Promise(done => { const proc = spawn(fake.env.PI_PROJECTS_ARC_WT_CLI, args, { stdio: 'ignore' }); proc.on('close', done); });
  await wt('lease', 'release', 'alloc-foreign', '--owner', owner); await wt('lease', 'acquire', 'alloc-foreign', '--owner', 'someone-else', '--reason', 'theirs');
  r = await foreign.iso.reconcile(foreign.intent);
  check('a foreign lease owner is not adopted', r.state === 'uncertain', r);
  const stolenRelease = await foreign.iso.release(foreign.intent);
  check('and release does not remove it', stolenRelease.state !== 'released' && existsSync(foreign.intent.scope.workspacePath), stolenRelease);

  // 4. Blockers: store mismatch, repository mismatch, existing target, path escape.
  const otherStore = join(root, 'other-store'); mkdirSync(otherStore);
  const badStore = make('alloc-badstore', { sharedObjectStore: realpathSync(otherStore) });
  check('a different shared object store is blocked before any add', (await badStore.iso.allocate(badStore.intent)).state === 'blocked' && wtCalls('alloc-badstore').every(call => call.argv[0] !== 'add'));
  const wrongRepo = make('alloc-wrongrepo', { repositoryId: 'notarcadia' }, {});
  wrongRepo.iso = workspaceIsolation({ conversation, authority: { projectId, owner }, authorizedRepositories: [{ repositoryId: 'notarcadia', provider: 'arc', approvedRoot: wtBase, ownerCheckout: arcadia, fileOwnershipPrefix: '.' }] });
  check('a different repository identity is blocked', (await wrongRepo.iso.allocate(wrongRepo.intent)).state === 'blocked');
  const existing = make('alloc-one', { }); existing.intent.scope.workspacePath = a.intent.scope.workspacePath;
  check('an existing target path is blocked', (await existing.iso.allocate(existing.intent)).state === 'blocked');
  const escape = make('alloc-escape', { workspacePath: join(root, 'escaped') });
  check('a workspace path outside the approved root is blocked', (await escape.iso.allocate(escape.intent)).state === 'blocked' && !existsSync(join(root, 'escaped')));

  // 5. Release: active consumer, dirty, clean.
  child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], { cwd: a.intent.scope.workspacePath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise((ok, no) => { child.once('message', ok); setTimeout(() => no(Error('child timeout')), 5000); });
  r = await a.iso.release(a.intent);
  check('an active consumer in the worktree blocks release', r.state === 'preserved' && /active process/.test(r.reason), r);
  child.kill('SIGTERM'); await new Promise(ok => child.once('close', ok)); child = undefined;
  writeFileSync(join(a.intent.scope.workspacePath, 'dirty.txt'), 'dirty\n');
  r = await a.iso.release(a.intent);
  check('a dirty worktree is preserved', r.state === 'preserved' && /dirty/i.test(r.reason) && existsSync(a.intent.scope.workspacePath), r);
  fake.git(a.intent.scope.workspacePath, 'clean', '-fdq');
  const before = fake.calls().length;
  r = await a.iso.release(a.intent); report.receipts.release = r;
  check('a clean worktree is released with a fenced removal', r.state === 'released' && !existsSync(a.intent.scope.workspacePath), r);
  const after = fake.calls().slice(before).filter(call => call.tool === 'arc-wt').map(call => call.argv);
  const renewAt = after.findIndex(argv => argv[0] === 'lease' && argv[1] === 'renew'), removeAt = after.findIndex(argv => argv[0] === 'remove');
  check('release renewed the lease, then removed with --lease-owner and --lease-renewed', renewAt >= 0 && removeAt > renewAt && after[removeAt].includes('--lease-owner') && after[removeAt].includes('--lease-renewed'), after);
  check('the branch is kept after removal', fake.git(arcadia, 'branch', '--list', 'alloc-one') !== '');
  assertFakeOnly(fake, root, check);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally { child?.kill('SIGTERM'); await harness?.close(BACKGROUND_CONTEXT); writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failure: report.failure, artifact: artifacts }, null, 2));
