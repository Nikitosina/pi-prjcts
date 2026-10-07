#!/usr/bin/env node
// One-click "Let workers edit this repo": real host API + real Git worktree allocation, no model.
//
// Failure inventory, written before the implementation:
//  F1  preview offers a grant for a non-Git folder or a subfolder of a repository
//  F2  repository ID is not derived from the GitHub origin (or crashes without origin)
//  F3  grant accepted without matching confirmation or with a stale workspace revision
//  F4  a second click creates a duplicate whole-repository scope
//  F5  worktree root missing, world-readable, or inside the owner checkout
//  F6  uncommitted owner edits still block allocation, or leak into the worker copy
//  F7  worker base is the grant-time HEAD instead of HEAD at first allocation
//  F8  re-dispatching an existing thread after HEAD moved fails or silently rebases it
//  F9  writes escape: .git, "..", absolute paths, symlinks
//  F10 new files (in new directories) cannot be created
//  F11 list tool exposes .git or follows a symlink
//  F12 GitHub publication tools are offered for a whole-repository scope (revised by W2: whole scopes get open_draft_pr, never the file-list publisher)
//  F13 folder-limited (advanced) scopes lose exact-file enforcement or dirty-owner blocking
//  F14 coordinator catalog / browser project view lacks the whole-repository signal
//  F15 the refactored advanced workspace-grant API path regresses
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.PI_PACKAGE_DIR) throw new Error("Run from a parent shell: PI_PACKAGE_DIR is set");
const artifacts = resolve(`artifacts/workspace-quick-grant-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `projects-quick-grant-${randomUUID()}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
process.env.PI_PROJECTS_HOME = join(root, "home");
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true, mode: 0o700 });
const checks = [];
const pass = (name, evidence = null) => { checks.push({ name, evidence }); process.stderr.write(`PASS ${name}\n`); };
const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const rejects = async (promise, pattern) => { try { await promise; } catch (error) { assert.match(String(error?.message ?? error), pattern); return String(error.message); } throw new Error(`expected rejection ${pattern}`); };
const call = (tool, args, conversationId) => tool.execute(args, { conversationId, taskId: 1, callId: randomUUID() }, { abortSignal: undefined });
const payload = out => JSON.parse(out.content[0].text);

let errorText = null, harness;
try {
  const repo = join(root, "Demo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "e2e@example.invalid"); git(repo, "config", "user.name", "E2E");
  git(repo, "remote", "add", "origin", "git@github.com:acme/demo.git");
  writeFileSync(join(repo, "README.md"), "base\n"); writeFileSync(join(repo, "src", "a.txt"), "A\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "c1");
  const c1 = git(repo, "rev-parse", "HEAD");
  const plain = join(root, "plain"); mkdirSync(plain);

  const { request } = await import("../src/client.ts");
  // F1
  const plainProject = await request({ action: "create", name: "Plain", cwd: plain });
  const plainSnap = await request({ action: "owner-setup-snapshot", id: plainProject.id });
  assert.equal(plainSnap.quickGrant.available, false); assert.match(plainSnap.quickGrant.blocker, /not a Git repository/);
  const sub = await request({ action: "create", name: "Sub", cwd: join(repo, "src") });
  const subSnap = await request({ action: "owner-setup-snapshot", id: sub.id });
  assert.equal(subSnap.quickGrant.available, false); assert.match(subSnap.quickGrant.blocker, /not the root/);
  pass("F1 non-Git and subfolder projects get a blocker, not a grant", { plain: plainSnap.quickGrant, sub: subSnap.quickGrant });

  const project = await request({ action: "create", name: "Demo", cwd: repo });
  const id = project.id;
  let snap = await request({ action: "owner-setup-snapshot", id });
  const expectedRoot = join(realpathSync(process.env.PI_PROJECTS_HOME), id, "worktrees");
  assert.deepEqual({ ...snap.quickGrant }, { available: true, repositoryId: "acme/demo", ownerCheckout: realpathSync(repo), approvedRoot: expectedRoot, head: c1, dirty: false });
  pass("F2 preview derives repo ID from origin, root, HEAD", snap.quickGrant);

  // F3
  await rejects(request({ action: "workspace-quick-grant", id, confirm: plainProject.id, expectedRevision: snap.workspaceRevision }), /confirmation/);
  await rejects(request({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: "0".repeat(64) }), /changed/);
  pass("F3 wrong confirmation and stale revision rejected");

  // Owner checkout gets uncommitted edits before the grant (F6 setup).
  writeFileSync(join(repo, "README.md"), "owner uncommitted\n"); writeFileSync(join(repo, "scratch.txt"), "untracked\n");
  snap = await request({ action: "owner-setup-snapshot", id });
  assert.equal(snap.quickGrant.dirty, true);
  const granted = await request({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: snap.workspaceRevision });
  assert.equal(granted.wholeRepository, true); assert.deepEqual(granted.files, []);
  snap = await request({ action: "owner-setup-snapshot", id });
  assert.equal(snap.workspace.scopes.length, 1); assert.equal(snap.workspace.scopes[0].wholeRepository, true);
  assert.equal(snap.workspace.repositories[0].fileOwnershipPrefix, "."); assert.equal(snap.workspace.repositories[0].approvedRoot, expectedRoot);
  assert.ok(statSync(expectedRoot).isDirectory()); assert.equal(statSync(expectedRoot).mode & 0o077, 0); assert.ok(!expectedRoot.startsWith(realpathSync(repo)));
  pass("F5 grant persisted; worktree root exists, 0700, outside checkout", { scope: snap.workspace.scopes[0], root: expectedRoot });
  assert.equal(snap.quickGrant.available, false);
  await rejects(request({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: snap.workspaceRevision }), /already/);
  pass("F4 second click rejected", snap.quickGrant);

  // F14 browser view carries the flag the stepper reads.
  const shown = await request({ action: "show", id });
  assert.equal(shown.project.workspaceAuthorization.scopes[0].wholeRepository, true);
  // F15 advanced grant through the refactored API path; owner HEAD must match.
  const advancedRoot = join(root, "advanced-root"); mkdirSync(advancedRoot);
  const advanced = await request({ action: "workspace-grant", id, confirm: id, expectedRevision: snap.workspaceRevision, provider: "github", repositoryId: "acme/demo-src", ownerCheckout: repo, approvedRoot: advancedRoot, fileOwnershipPrefix: "src", files: ["src/a.txt"], baseRevision: c1 });
  assert.equal(advanced.wholeRepository, undefined);
  pass("F14/F15 project view has wholeRepository; advanced grant API still works", { advancedScope: advanced.id });
  await request({ action: "shutdown" }, false);

  // ---- Worker binding, in process (no host, no model) ----
  const [{ ModelRuntime }, { BACKGROUND_CONTEXT }, { Harness, createRegistry }, { openNodeSqliteStorage }, { durableWorkspaceBinding }, state, auth, coordinator] = await Promise.all([
    import("@earendil-works/pi-coding-agent"), import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("@earendil-works/pi-durable/storage/sqlite/node"),
    import("../src/durable-workspace-binding.ts"), import("../src/state.ts"), import("../src/workspace-authorization.ts"), import("../src/coordinator.ts"),
  ]);
  const catalogEntry = auth.catalog(state.loadProject(id)).find(item => item.wholeRepository);
  assert.ok(catalogEntry?.note?.includes("host opens a draft PR"));
  pass("F14 coordinator catalog marks whole-repository scope", catalogEntry);

  const control = join(root, "control"); mkdirSync(control, { mode: 0o700 });
  harness = await Harness.open(await openNodeSqliteStorage(join(control, "durable.sqlite")), { models: await ModelRuntime.create({ allowModelNetwork: false }), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const conversation = await harness.createConversation({ ownership: { kind: "conversation" } }, BACKGROUND_CONTEXT);
  const loaded = state.loadProject(id);
  const wholeScope = loaded.workspaceAuthorization.scopes.find(scope => scope.wholeRepository), advancedScope = loaded.workspaceAuthorization.scopes.find(scope => !scope.wholeRepository);
  // F12: with a matching GitHub authorization, only the push-verifying draft-PR tool, never the file-list publisher.
  const withGithub = { ...loaded, githubAuthorization: [{ repositoryId: "acme/demo", workspaceRevision: auth.authorizationFingerprint(loaded), numericId: 1, branchPrefix: "pi/", baseBranch: "main", owner: auth.trustedOwner() }] };
  const configuredSkillLoader = await coordinator.loadProjectResourceLoader(loaded);
  const bind = project => durableWorkspaceBinding({ project, configuredSkillLoader, conversation: () => conversation, controlRoot: control });
  const prepare = (project, scope, threadId, conversationId) => bind(project)({ conversationId, workId: randomUUID(), threadId, role: "worker", workspaceScopeId: scope.id });

  const threadA = randomUUID();
  const a = await prepare(withGithub, wholeScope, threadA, 11);
  const names = a.tools.map(tool => tool.name);
  assert.equal(git(a.cwd, "rev-parse", "HEAD"), c1);
  assert.equal(readFileSync(join(a.cwd, "README.md"), "utf8"), "base\n"); assert.ok(!existsSync(join(a.cwd, "scratch.txt")));
  pass("F6/F7 dirty owner allowed; worker copy at owner HEAD without uncommitted edits", { cwd: a.cwd, head: c1 });
  assert.ok(names.some(name => /^projects_github_[a-f0-9]+_open_draft_pr$/.test(name)));
  assert.ok(!names.some(name => /^projects_github_[a-f0-9]+_(?:publish|pr|update_pr|verify_local_publication)$/.test(name)));
  assert.ok(["read", "write", "edit", "bash"].every(name => names.includes(name)));
  assert.ok(!names.some(name => name.startsWith("projects_workspace_") && /_(read|write|read_list|list)$/.test(name)));
  pass("F12 whole-repo binding uses Pi coding tools, offers open_draft_pr instead of the file-list publisher, no duplicate workspace tools", names);

  // F13 advanced scope keeps exact files and still blocks on a dirty owner.
  await rejects(prepare(loaded, advancedScope, randomUUID(), 12), /dirty/);
  git(repo, "add", "-A"); git(repo, "commit", "-m", "c2");
  const c2 = git(repo, "rev-parse", "HEAD");
  // F8 same thread keeps its first base; F7 a new thread starts at the new HEAD.
  const again = await prepare(loaded, wholeScope, threadA, 11);
  assert.equal(again.cwd, a.cwd); assert.equal(git(again.cwd, "rev-parse", "HEAD"), c1);
  const b = await prepare(loaded, wholeScope, randomUUID(), 13);
  assert.notEqual(b.cwd, a.cwd); assert.equal(git(b.cwd, "rev-parse", "HEAD"), c2);
  pass("F7/F8 existing thread keeps base, new thread follows HEAD", { threadA: c1, threadB: c2 });

  const folder = auth.grantWorkspace({ project: loaded, repositoryId: "acme/demo-src2", provider: "github", ownerCheckout: repo, approvedRoot: advancedRoot, fileOwnershipPrefix: "src", files: ["src/a.txt"], baseRevision: c2 });
  const c = await prepare(folder.project, folder.project.workspaceAuthorization.scopes.at(-1), randomUUID(), 14);
  assert.ok(!c.tools.some(tool => ["bash", "edit"].includes(tool.name)));
  const cWrite = c.tools.find(item => item.name.endsWith("_write"));
  assert.ok(!c.tools.some(item => item.name.endsWith("_list")));
  assert.equal((await call(cWrite, { path: "src/b.txt", text: "x", expectedRevision: null }, 14)).isError, true);
  assert.equal((await call(cWrite, { path: "README.md", text: "x", expectedRevision: (payload(await call(c.tools.find(item => item.name.endsWith("_read")), { path: "src/a.txt" }, 14))).revision }, 14)).isError, true);
  pass("F13 advanced scope: dirty owner blocked, exact files enforced, no list tool");
} catch (error) { errorText = error instanceof Error ? error.stack : String(error); }
finally {
  try { await harness?.close?.(); } catch {}
  const log = join(process.env.PI_PROJECTS_HOME, "host.log");
  if (existsSync(log)) writeFileSync(join(artifacts, "host.log"), readFileSync(log));
  writeFileSync(join(artifacts, "result.json"), JSON.stringify({ status: errorText ? "failed" : "passed", checks, error: errorText, root }, null, 2));
}
if (errorText) { process.stderr.write(`${errorText}\nArtifact: ${artifacts}\n`); process.exitCode = 1; }
else process.stdout.write(`PASS ${checks.length} checks\nArtifact: ${artifacts}\n`);
