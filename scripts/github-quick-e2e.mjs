#!/usr/bin/env node
// Failure list (checked before implementation): F1 whole-repo scope receives no GitHub inspect tools; F2 base-file reads remain file-list constrained; F3 one-click GitHub authorization is absent; F4 GitHub UI still directs users to advanced JSON; F5 whole-repo publication cannot derive changed paths; F6 no offline fake-provider end-to-end coverage exists.
// F7 owner-setup-snapshot offers one-click GitHub before step 1, or its preview defaults differ from origin (repo, numeric id, default branch, pi/, reviewReplies, localPublication).
// F8 github-quick-authorize accepts a wrong confirmation or a stale expectedRevision.
// F9 a later workspace grant leaves a one-click authorization bound to the old workspace fingerprint (GitHub tools silently vanish).
// F10 open_draft_pr opens a PR before the branch is pushed, or when remote head != worktree HEAD, or for a head the worker never pushed.
// F11 the draft PR is not draft, targets another base, or uses a branch other than the worker's pi/ branch.
// F12 the receipt changed-set omits deletions or added files (base..HEAD).
// F13 a second push creates a second PR instead of updating the first.
// F14 the host performs any GitHub write other than pulls create/update (merge, refs, contents), or touches real GitHub.
// F15 folder-limited scopes lose the file-list publisher or gain open_draft_pr.
// Model-free and offline by contract: this suite must use a fake GitHub API and local bare remote; it must never contact GitHub or write to it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

if (process.env.PI_PACKAGE_DIR || process.env.NODE_OPTIONS) throw new Error("Run from a parent shell: PI_PACKAGE_DIR/NODE_OPTIONS is set");
const artifacts = resolve(`artifacts/github-quick-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const requestedRoot = join(tmpdir(), `github-quick-${randomUUID()}`);
mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
const root = realpathSync(requestedRoot);
const checks = [];
const pass = (name, evidence) => { checks.push({ name, evidence }); process.stderr.write(`PASS ${name}\n`); };
const git = (cwd, ...args) => execFileSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const rejects = async (promise, pattern, label) => { let failure = null; try { await promise; } catch (error) { failure = error; } assert.ok(failure, `${label} should fail`); if (pattern) assert.match(String(failure.message), pattern, label); return failure.message; };

// Fake GitHub CLI (scripts/fake-gh.mjs) behind a shell shim; the host and this process reach it via PI_PROJECTS_GH_CLI.
const fakeGh = join(root, "fake-gh"), ghState = join(root, "fake-gh-state.json"), ghCalls = join(root, "fake-gh-calls.jsonl"), bare = join(root, "remote.git");
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${resolve("scripts/fake-gh.mjs")}" "$@"\n`);
chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: "acme/quick", default_branch: "main" }, pulls: [] }));
writeFileSync(ghCalls, "");
const calls = () => readFileSync(ghCalls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const pulls = () => JSON.parse(readFileSync(ghState, "utf8")).pulls;
Object.assign(process.env, { PI_PROJECTS_HOME: join(root, "home"), PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: ghCalls });
mkdirSync(process.env.PI_PROJECTS_HOME, { recursive: true, mode: 0o700 });

function fixture(name) {
  const repo = join(root, name);
  mkdirSync(repo); git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "e2e@example.invalid"); git(repo, "config", "user.name", "E2E");
  // Credential-free GitHub origin for identity checks; pushes go to the local bare remote.
  git(repo, "remote", "add", "origin", "https://github.com/acme/quick.git"); git(repo, "config", "remote.origin.pushurl", bare);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "base\n"); writeFileSync(join(repo, "old.txt"), "remove me\n"); writeFileSync(join(repo, "src", "a.txt"), "a\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "base");
  return repo;
}

let error = null, harness = null, BACKGROUND_CONTEXT = null;
const summary = { root, artifacts, project: null, branch: null, pr: null, receipts: null };
try {
  execFileSync("/usr/bin/git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  const repo = fixture("repo");
  git(repo, "push", "origin", "main");
  const { request } = await import("../src/client.ts");
  const [{ ModelRuntime }, chord, durable, binding, state, workspaceAuth, planning, githubWorker, coordinator] = await Promise.all([
    import("@earendil-works/pi-coding-agent"), import("@earendil-works/chord/context"), import("@earendil-works/pi-durable"), import("../src/durable-workspace-binding.ts"), import("../src/state.ts"), import("../src/workspace-authorization.ts"), import("../src/durable-planning.ts"), import("../src/github-worker.ts"), import("../src/coordinator.ts"),
  ]);
  BACKGROUND_CONTEXT = chord.BACKGROUND_CONTEXT;
  const project = await request({ action: "create", name: "GitHub quick", cwd: repo });
  summary.project = project.id;

  let snap = await request({ action: "owner-setup-snapshot", id: project.id });
  assert.equal(snap.githubQuick.available, false); assert.match(snap.githubQuick.blocker, /step 1/);
  pass("F7 one-click GitHub is blocked before workspace access", snap.githubQuick);

  await request({ action: "workspace-quick-grant", id: project.id, confirm: project.id, expectedRevision: snap.workspaceRevision });
  snap = await request({ action: "owner-setup-snapshot", id: project.id });
  assert.deepEqual(snap.githubQuick, { available: true, repositoryId: "acme/quick", branchPrefix: "pi/", reviewReplies: true, localPublication: true });
  assert.equal(calls().length, 0, "snapshot preview must stay offline");
  pass("F7 preview derives repo, pi/, reviewReplies and localPublication from origin without a GitHub call", snap.githubQuick);

  await rejects(request({ action: "github-quick-authorize", id: project.id, confirm: randomUUID(), expectedRevision: snap.githubRevision }), /confirmation/, "wrong confirm");
  await rejects(request({ action: "github-quick-authorize", id: project.id, confirm: project.id, expectedRevision: "0".repeat(64) }), /changed/, "stale revision");
  assert.equal(state.loadProject(project.id).githubAuthorization, undefined);
  pass("F8 wrong confirmation and stale revision are rejected without storing authority", true);

  const authorized = await request({ action: "github-quick-authorize", id: project.id, confirm: project.id, expectedRevision: snap.githubRevision });
  assert.equal(authorized.numericId, 4242); assert.equal(authorized.baseBranch, "main"); assert.equal(authorized.branchPrefix, "pi/");
  assert.equal(authorized.reviewReplies, true); assert.equal(authorized.localPublication, true); assert.equal(authorized.oneClick, true); assert.equal(authorized.readInspection, true);
  snap = await request({ action: "owner-setup-snapshot", id: project.id });
  assert.equal(snap.githubQuick.available, false); assert.match(snap.githubQuick.blocker, /connected/);
  assert.ok(calls().every(call => call.method === "GET"), "authorization performs only reads");
  pass("F3 one-click authorize stores numeric id + default branch from the API with one-click defaults", authorized);

  const docsRoot = join(root, "docs-root"); mkdirSync(docsRoot);
  const head = git(repo, "rev-parse", "HEAD");
  const beforeRevision = state.loadProject(project.id).githubAuthorization[0].workspaceRevision;
  await request({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: snap.workspaceRevision, repositoryId: "acme/quick-docs", provider: "github", ownerCheckout: repo, approvedRoot: docsRoot, fileOwnershipPrefix: "src", files: ["src/a.txt"], baseRevision: head });
  const rebound = state.loadProject(project.id);
  assert.notEqual(rebound.githubAuthorization[0].workspaceRevision, beforeRevision);
  assert.equal(rebound.githubAuthorization[0].workspaceRevision, workspaceAuth.authorizationFingerprint(rebound));
  pass("F9 a later workspace grant rebinds the one-click authorization to the new fingerprint", { before: beforeRevision, after: rebound.githubAuthorization[0].workspaceRevision });

  harness = await durable.Harness.open(await (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(join(root, "harness.sqlite")), { models: await ModelRuntime.create({ allowModelNetwork: false }), registry: durable.createRegistry() }, BACKGROUND_CONTEXT);
  const conversation = await harness.createConversation({ ownership: { kind: "conversation" } }, BACKGROUND_CONTEXT);
  async function prepare(saved, scope, conversationId) {
    const workId = randomUUID(), threadId = randomUUID();
    await conversation.commit(async tx => {
      const plan = await tx.doc(planning.DurablePlanning, conversation.id);
      plan.work[workId] = { id: workId, threadId, role: "worker", text: "e2e", dependsOn: [], requestId: null, requiredTools: [], workspaceScopeId: scope.id, workspaceBindingRevision: null, workspaceConfigured: true, status: "running", blocker: null, conversationId, taskId: 1, attempt: null };
      plan.threads[threadId] = { conversationId, activeWorkId: workId, workspaceScopeId: scope.id, workspaceBindingRevision: null, workspaceConfigured: true };
    }, BACKGROUND_CONTEXT);
    return binding.durableWorkspaceBinding({ project: saved, configuredSkillLoader: await coordinator.loadProjectResourceLoader(saved), conversation: () => conversation, controlRoot: root })({ conversationId, workId, threadId, role: "worker", workspaceScopeId: scope.id });
  }
  const api = conversationId => ({ callId: randomUUID(), output() {}, diagnostic() {}, details: async () => {}, commit: fn => conversation.commit(fn, BACKGROUND_CONTEXT), memo: async () => undefined, createTask: async () => 1, getTask: async () => undefined, waitForTask: async () => undefined, conversation: async () => undefined, registry: {}, taskId: 1, conversationId, env: undefined });
  const call = async (tool, args, conversationId = 1) => tool.execute(args, api(conversationId), { abortSignal: undefined });
  const wholeScope = rebound.workspaceAuthorization.scopes.find(scope => scope.wholeRepository);
  const prepared = await prepare(rebound, wholeScope, 1);
  const names = prepared.tools.map(tool => tool.name);
  const tool = suffix => prepared.tools.find(item => item.name.startsWith("projects_github_") && item.name.endsWith(`_${suffix}`));
  for (const suffix of ["open_draft_pr", "inspect_pr", "inspect_ci", "inspect_ci_detail", "inspect_ci_job", "inspect_reviews", "inspect_conflicts", "read_base_file", "reply_review", "comment", "inspect_effect"]) assert.ok(tool(suffix), `missing ${suffix}`);
  for (const suffix of ["publish", "update_pr", "verify_local_publication"]) assert.equal(tool(suffix), undefined, `unexpected ${suffix}`);
  assert.ok(!names.some(name => /^projects_github_[a-f0-9]+_pr$/.test(name)));
  assert.ok(names.includes("bash"));
  const branch = git(prepared.cwd, "branch", "--show-current");
  assert.match(branch, /^pi\/durable-/); assert.match(prepared.workerInstructions, /open_draft_pr/); assert.ok(prepared.workerInstructions.includes(branch));
  summary.branch = branch;
  pass("F1/F15 whole scope gets inspect tools + open_draft_pr, no file-list publisher; branch uses pi/ prefix", { branch, github: names.filter(name => name.startsWith("projects_github_")) });

  const open = tool("open_draft_pr"), bash = prepared.tools.find(item => item.name === "bash");
  const sh = async command => { const output = await call(bash, { command }); assert.notEqual(output.isError, true, JSON.stringify(output)); return output; };
  await rejects(call(open, { expectedHead: git(prepared.cwd, "rev-parse", "HEAD"), title: "t", body: "b" }), /push this branch first/, "unpushed branch");
  await sh("printf 'changed\\n' > README.md && printf 'new\\n' > src/new.txt && git rm -q old.txt && git add -A && git commit -qm 'worker change'");
  const head1 = git(prepared.cwd, "rev-parse", "HEAD");
  await rejects(call(open, { expectedHead: head1, title: "t", body: "b" }), /push this branch first/, "committed but not pushed");
  await sh("git push -q -u origin HEAD");
  await rejects(call(open, { expectedHead: head, title: "t", body: "b" }), /expectedHead/, "wrong expectedHead");
  assert.equal(pulls().length, 0); assert.ok(!calls().some(entry => entry.method !== "GET"));
  pass("F10 open_draft_pr refuses before push and for a head that differs from the pushed branch", { head1 });

  const first = JSON.parse((await call(open, { expectedHead: head1, title: "Worker change", body: "Summary" })).content[0].text);
  assert.equal(first.pr.number, 1); assert.equal(first.branch, branch); assert.equal(first.head, head1); assert.equal(first.base, head);
  const [created] = pulls();
  assert.equal(created.draft, true); assert.equal(created.head, branch); assert.equal(created.base, "main"); assert.match(created.body, /pi-projects-effect:/);
  assert.equal(git(bare, "rev-parse", `refs/heads/${branch}`), head1);
  pass("F11 draft PR is draft, head = worker pi/ branch, base = default branch", created);
  assert.deepEqual(first.changed.toSorted((a, b) => a.path < b.path ? -1 : 1), [{ status: "M", path: "README.md" }, { status: "D", path: "old.txt" }, { status: "A", path: "src/new.txt" }]);
  pass("F12 changed-set lists base..HEAD including the deletion", first.changed);

  const baseFile = JSON.parse((await call(tool("read_base_file"), { pullRequest: 1, expectedHead: head1, expectedBase: head, path: "old.txt" })).content[0].text);
  assert.equal(baseFile.state, "present"); assert.equal(baseFile.content, "remove me\n");
  pass("F2 read_base_file reads any repository path for whole scopes", { path: baseFile.path, state: baseFile.state });

  await sh("printf 'more\\n' >> src/new.txt && git commit -qam 'follow-up' && git push -q origin HEAD");
  const head2 = git(prepared.cwd, "rev-parse", "HEAD");
  const second = JSON.parse((await call(open, { expectedHead: head2, title: "Worker change v2", body: "Summary v2" })).content[0].text);
  assert.equal(second.pr.number, 1); assert.equal(pulls().length, 1); assert.equal(pulls()[0].title, "Worker change v2");
  const receipts = await githubWorker.githubWriteSnapshot(conversation);
  assert.deepEqual(receipts.items.map(item => `${item.operation}:${item.state}`), ["verify-local-publication:done", "create-pr:done", "verify-local-publication:done", "update-pr:done"]);
  assert.ok(receipts.items.filter(item => item.operation === "verify-local-publication").every(item => item.source === "local-git-verification"));
  summary.pr = pulls()[0]; summary.receipts = receipts.items;
  pass("F13 a second push updates the same draft PR; receipts record both verified heads", receipts.items.map(item => item.operation));

  await sh("printf 'local only\\n' >> README.md && git commit -qam 'not pushed'");
  await rejects(call(open, { expectedHead: git(prepared.cwd, "rev-parse", "HEAD"), title: "t", body: "b" }), /push this branch first/, "unpushed follow-up");
  assert.equal((await call(bash, { command: "git push origin HEAD:main" })).isError, true);
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), head);
  pass("F10 local-only commit is refused; push to main stays blocked", true);

  const writes = calls().filter(entry => entry.method !== "GET");
  assert.deepEqual(writes.map(entry => `${entry.method} ${entry.target}`), ["POST repos/acme/quick/pulls", "PATCH repos/acme/quick/pulls/1"]);
  assert.ok(calls().every(entry => entry.status === 200 || entry.status === 404), "no unsupported fake GitHub calls");
  assert.ok(!calls().some(entry => /merge/.test(entry.target)));
  pass("F14 host GitHub writes are exactly one PR create and one PR update; no merge, ref or content writes", writes);

  // Folder-limited scope with an advanced (non-one-click) authorization keeps the file-list publisher.
  const repoB = fixture("repo-b"), approvedB = join(root, "approved-b"); mkdirSync(approvedB);
  const projectB = await request({ action: "create", name: "GitHub advanced", cwd: repoB });
  let snapB = await request({ action: "owner-setup-snapshot", id: projectB.id });
  await request({ action: "workspace-grant", id: projectB.id, confirm: projectB.id, expectedRevision: snapB.workspaceRevision, repositoryId: "acme/quick", provider: "github", ownerCheckout: repoB, approvedRoot: approvedB, fileOwnershipPrefix: "src", files: ["src/a.txt"], baseRevision: git(repoB, "rev-parse", "HEAD") });
  snapB = await request({ action: "owner-setup-snapshot", id: projectB.id });
  assert.equal(snapB.githubQuick.available, false);
  await request({ action: "github-authorize", id: projectB.id, confirm: projectB.id, expectedRevision: snapB.githubRevision, repositoryId: "acme/quick", expectedRepositoryId: 4242, branchPrefix: "pi/", localPublication: true });
  const savedB = state.loadProject(projectB.id);
  const preparedB = await prepare(savedB, savedB.workspaceAuthorization.scopes[0], 2);
  const namesB = preparedB.tools.map(item => item.name);
  for (const suffix of ["publish", "pr", "update_pr", "verify_local_publication"]) assert.ok(namesB.some(name => name.startsWith("projects_github_") && name.endsWith(`_${suffix}`)), `folder scope lost ${suffix}`);
  assert.ok(!namesB.some(name => name.endsWith("_open_draft_pr"))); assert.ok(!namesB.includes("bash"));
  assert.equal(savedB.githubAuthorization[0].oneClick, undefined);
  pass("F15 folder-limited scope keeps the file-list publisher and gets neither open_draft_pr nor bash", namesB.filter(name => name.startsWith("projects_github_")));

  await harness.close(BACKGROUND_CONTEXT); harness = null;
  await request({ action: "shutdown" }, false);

  const uiArtifacts = join(artifacts, "ui"); mkdirSync(uiArtifacts, { mode: 0o700 });
  const env = { ...process.env, ARTIFACT_DIR: uiArtifacts };
  for (const key of ["PI_PROJECTS_HOME", "PI_PROJECTS_GH_CLI", "FAKE_GH_STATE", "FAKE_GH_BARE", "FAKE_GH_CALLS"]) delete env[key];
  execFileSync(process.execPath, [resolve("scripts/github-quick-ui-e2e.mjs")], { env, stdio: ["ignore", "ignore", "inherit"], timeout: 180000 });
  const ui = JSON.parse(readFileSync(join(uiArtifacts, "result.json"), "utf8"));
  assert.equal(ui.status, "passed"); assert.ok(ui.checks.length >= 7);
  pass("F4 browser: step 2 Connect GitHub button, confirm dialog, connected state (github-quick-ui-e2e)", { artifacts: uiArtifacts, checks: ui.checks });
} catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); }
finally {
  if (harness) await harness.close(BACKGROUND_CONTEXT).catch(() => {});
  if (error) { try { const { request } = await import("../src/client.ts"); await request({ action: "shutdown" }, false); } catch {} }
  const ghLog = existsSync(ghCalls) ? calls() : [];
  writeFileSync(join(artifacts, "fake-github-calls.json"), JSON.stringify(ghLog, null, 2));
  writeFileSync(join(artifacts, "result.json"), JSON.stringify({ status: error ? "failed" : "passed", checks: checks.length, passed: checks, error, summary, githubCalls: ghLog.length, realGithubContacted: false }, null, 2));
  if (!error) rmSync(join(root, "home", "host.log"), { force: true });
}
if (error) { process.stderr.write(`${error}\nArtifact: ${artifacts}\n`); process.exitCode = 1; }
else process.stdout.write(`PASS ${checks.length} checks\nArtifact: ${artifacts}\n`);
