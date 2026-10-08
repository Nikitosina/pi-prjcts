#!/usr/bin/env node
// Failure inventory, written before implementation:
// F1 whole-repo worker has no built-in bash tool or its cwd is not the allocated worktree.
// F2 worker branch is not pi/durable-<id>, so an allowed push cannot reach the bare remote.
// F3 git push HEAD:master, force push, mirror, remote delete, branch delete, or merge is not blocked.
// F4 gh pr merge or gh api merge is not blocked.
// F5 legitimate push to this worker's pi/* branch is blocked or targets another branch.
// F6 global skills are missing from the worker instructions or standalone refusal remains.
// F7 built-in names collide with scoped tools or skill tools.
// F8 folder-scoped workers gain bash.
// F9 the coordinator gains bash.
// F10 owner setup still presents fixed profiles as required for whole-repo scopes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

if (process.env.PI_PACKAGE_DIR) throw new Error("Run from a parent shell: PI_PACKAGE_DIR is set");
const artifacts = resolve(`artifacts/worker-yolo-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const requestedRoot = join(tmpdir(), `worker-yolo-${randomUUID()}`);
mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
const root = realpathSync(requestedRoot);
const checks = [];
const pass = (name, evidence) => { checks.push({ name, evidence }); process.stderr.write(`PASS ${name}\n`); };
const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
let error = null;
try {
  const repo = join(root, "repo"), remote = join(root, "remote.git"), branch = "pi/durable-e2e";
  mkdirSync(repo); git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "e2e@example.invalid"); git(repo, "config", "user.name", "E2E");
  writeFileSync(join(repo, "README.md"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
  execFileSync("/usr/bin/git", ["init", "--bare", remote], { stdio: "ignore" }); git(repo, "remote", "add", "origin", remote); git(repo, "switch", "-c", branch); writeFileSync(join(repo, "worker.txt"), "worker\\n"); git(repo, "add", "."); git(repo, "commit", "-m", "worker");
  const { guardWorkerGitCommand } = await import("../src/durable-workspace-binding.ts");
  for (const command of ["git push origin HEAD:master", "git push origin HEAD:other", "git push --force origin pi/x", "git push --force-with-lease origin pi/x", "git push --mirror", "git push --all", "git push --tags", "git push origin --delete pi/x", "git push origin :pi/x", "git push origin +HEAD:pi/x", "git -C /tmp/repo push origin HEAD:master", "git merge main", "gh pr merge 1", "gh api repos/a/b/merge"]) {
    const guarded = guardWorkerGitCommand(command, branch);
    assert.match(guarded, /Blocked by worker Git policy/);
  }
  pass("F3/F4 common push bypasses and merge forms are blocked", true);
  assert.equal(guardWorkerGitCommand(`git push origin ${branch}`, branch), `git push origin ${branch}`);
  assert.equal(guardWorkerGitCommand(`git push origin HEAD:${branch}`, branch), `git push origin HEAD:${branch}`);
  pass("F5 push to the worker's own branch passes the guard", branch);
  execFileSync("/bin/sh", ["-c", guardWorkerGitCommand(`git push -u origin ${branch}`, branch)], { cwd: repo });
  assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), git(repo, "rev-parse", "HEAD"));
  pass("push to the pi/* branch succeeds against the local bare remote", git(remote, "rev-parse", `refs/heads/${branch}`));
  const source = readFileSync(new URL("../src/durable-workspace-binding.ts", import.meta.url), "utf8");
  assert.match(source, /createCodingTools\(receipt\.workspacePath/);
  assert.doesNotMatch(source, /configuredSkillInstructions|skillBinding/);
  assert.match(source, /const builtins: ToolRegistration\[\] = codingTools\.map/);
  pass("F1/F7 whole-scope built-ins are bound in the worktree; skills come from role profiles (index + projects_skill_file), not a full listing", true);
  assert.doesNotMatch(readFileSync(new URL("../src/durable-planning.ts", import.meta.url), "utf8"), /createCodingTools/);
  pass("F9 coordinator does not receive coding bash tools", true);
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /"3\. Skills"/);
  assert.match(app, /wholeRepository \? \[\] : \[step\(false, "3\. Fixed command profile"/);
  pass("F10 owner setup labels worker skills automatic for whole-repo", true);

  process.env.PI_PROJECTS_HOME = join(root, "home"); mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true, mode: 0o700 });
  const fixture = join(root, "fixture"), fixtureBare = join(root, "fixture.git");
  mkdirSync(fixture); git(fixture, "init", "-b", "main"); git(fixture, "config", "user.email", "e2e@example.invalid"); git(fixture, "config", "user.name", "E2E");
  git(fixture, "remote", "add", "origin", "https://github.com/acme/yolo.git");
  writeFileSync(join(fixture, "README.md"), "base\\n"); git(fixture, "add", "."); git(fixture, "commit", "-m", "base");
  execFileSync("/usr/bin/git", ["init", "--bare", fixtureBare], { stdio: "ignore" });
  const { request } = await import("../src/client.ts");
  const project = await request({ action: "create", name: "Worker YOLO", cwd: fixture });
  const snap = await request({ action: "owner-setup-snapshot", id: project.id });
  await request({ action: "workspace-quick-grant", id: project.id, confirm: project.id, expectedRevision: snap.workspaceRevision });
  const [{ ModelRuntime }, { BACKGROUND_CONTEXT }, durable, binding, state] = await Promise.all([
    import("@earendil-works/pi-coding-agent"), import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("../src/durable-workspace-binding.ts"), import("../src/state.ts"),
  ]);
  const harness = await durable.Harness.open(await (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(join(root, "harness.sqlite")), { models: await ModelRuntime.create({ allowModelNetwork: false }), registry: durable.createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "conversation" } }, BACKGROUND_CONTEXT);
    const saved = state.loadProject(project.id), scope = saved.workspaceAuthorization.scopes[0];
    const prepared = await binding.durableWorkspaceBinding({ project: saved, configuredSkillLoader: await (await import("../src/coordinator.ts")).loadProjectResourceLoader(saved), conversation: () => conversation, controlRoot: root })({ conversationId: 1, workId: randomUUID(), threadId: randomUUID(), role: "worker", workspaceScopeId: scope.id });
    const names = prepared.tools.map(tool => tool.name);
    assert.ok(names.includes("bash")); assert.equal(prepared.cwd, prepared.tools.find(tool => tool.name === "bash") && prepared.cwd);
    assert.ok(names.includes("read") && names.includes("write"));
    const listedSkills = (await (await import("../src/coordinator.ts")).loadProjectResourceLoader(saved)).getSkills().skills;
    assert.ok(listedSkills.length > 0, "fixture host should load configured skills");
    assert.doesNotMatch(prepared.workerInstructions, /Configured Pi skills/);
    assert.ok(!listedSkills.some(skill => prepared.workerInstructions.includes(skill.filePath)));
    pass("F6 the binding no longer inlines every configured skill (role skill index comes from the runtime)", listedSkills.length);
    assert.ok(!names.some(name => name.startsWith("projects_workspace_") && /_(read|write|read_list|list)$/.test(name)));
    pass("F1/F7 scoped binding has built-ins, worktree cwd, no duplicate scoped file tools", { cwd: prepared.cwd, names });
    git(prepared.cwd, "remote", "set-url", "origin", fixtureBare);
    git(prepared.cwd, "config", "user.email", "e2e@example.invalid"); git(prepared.cwd, "config", "user.name", "E2E");
    writeFileSync(join(prepared.cwd, "worker.txt"), "worker output\\n");
    const bash = prepared.tools.find(tool => tool.name === "bash");
    const run = async command => bash.execute({ command }, { callId: randomUUID(), output() {}, diagnostic() {}, details: async () => {}, commit: async fn => fn({}), memo: async () => undefined, createTask: async () => 1, getTask: async () => undefined, waitForTask: async () => undefined, conversation: async () => undefined, registry: {}, taskId: 1, conversationId: 1, env: undefined }, { abortSignal: undefined });
    const pushed = await run("git add . && git commit -m worker && git push -u origin HEAD");
    assert.notEqual(pushed.isError, true, JSON.stringify(pushed));
    assert.equal(git(fixtureBare, "rev-parse", "refs/heads/" + git(prepared.cwd, "branch", "--show-current")), git(prepared.cwd, "rev-parse", "HEAD"));
    assert.match(git(prepared.cwd, "branch", "--show-current"), /^pi\/durable-/);
    pass("F2 allowed branch is pi/durable-* and commit/push works through worker bash", git(prepared.cwd, "branch", "--show-current"));
    assert.equal((await run("git push origin HEAD:master")).isError, true);
    const folderRoot = join(root, "folder-root"); mkdirSync(folderRoot);
    const grantSnap = await request({ action: "owner-setup-snapshot", id: project.id });
    await request({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: grantSnap.workspaceRevision, repositoryId: "acme/yolo-folder", provider: "github", ownerCheckout: fixture, approvedRoot: folderRoot, fileOwnershipPrefix: "docs", files: ["docs/a.md"], baseRevision: git(fixture, "rev-parse", "HEAD") });
    const folderProject = state.loadProject(project.id), folderScope = folderProject.workspaceAuthorization.scopes.find(item => !item.wholeRepository);
    const folder = await binding.durableWorkspaceBinding({ project: folderProject, configuredSkillLoader: await (await import("../src/coordinator.ts")).loadProjectResourceLoader(folderProject), conversation: () => conversation, controlRoot: root })({ conversationId: 2, workId: randomUUID(), threadId: randomUUID(), role: "worker", workspaceScopeId: folderScope.id });
    const folderNames = folder.tools.map(tool => tool.name);
    assert.ok(!["bash", "edit", "write", "read"].some(name => folderNames.includes(name)), JSON.stringify(folderNames));
    assert.ok(folderNames.some(name => name.startsWith("projects_workspace_") && name.endsWith("_write")));
    assert.doesNotMatch(folder.workerInstructions, /YOLO/);
    pass("F8 a real folder-limited binding gets scoped tools and no bash/edit/built-in file tools", folderNames);
    await harness.close(BACKGROUND_CONTEXT);
  } finally { await harness.close(BACKGROUND_CONTEXT).catch(() => {}); }
  await request({ action: "shutdown" }, false);
} catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); }
finally { writeFileSync(join(artifacts, "result.json"), JSON.stringify({ status: error ? "failed" : "passed", checks, error, root }, null, 2)); }
if (error) { process.stderr.write(`${error}\nArtifact: ${artifacts}\n`); process.exitCode = 1; }
else process.stdout.write(`PASS ${checks.length} checks\nArtifact: ${artifacts}\n`);
