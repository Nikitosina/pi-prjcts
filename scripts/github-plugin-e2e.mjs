// E2E: the Coordinator GitHub tools as the built-in `github` plugin. In-process runtime, fresh home, fake model, fake gh; no network.
// Failure cases written first: github-plugin-failures.md (numbers in check labels).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startFakeModel, FAKE_MODEL } from "./fake-model.mjs";

const repo = process.cwd();
const base = resolve("artifacts", `github-plugin-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(base, { recursive: true });
const fake = await startFakeModel(base);
const fakeGh = join(base, "fake-gh"),
  ghState = join(base, "fake-gh-state.json"),
  ghCalls = join(base, "fake-gh-calls.jsonl");
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "scripts/fake-gh.mjs")}" "$@"\n`);
chmodSync(fakeGh, 0o755);
const ISSUE = {
  number: 95,
  title: "ISSUE-TITLE-95",
  body: "body",
  state: "open",
  labels: ["chat"],
  assignees: [],
  comments: [{ body: "c" }],
};
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: "acme/mari", default_branch: "main" }, pulls: [], issues: [ISSUE] }));
writeFileSync(ghCalls, "");
Object.assign(process.env, {
  PI_PROJECTS_HOME: join(base, "state"),
  PI_PROJECTS_GH_CLI: fakeGh,
  FAKE_GH_STATE: ghState,
  FAKE_GH_CALLS: ghCalls,
  FAKE_GH_BARE: join(base, "no-bare.git"),
});
delete process.env.PI_PROJECTS_PLUGINS;
const ghLog = () =>
  readFileSync(ghCalls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const clearGh = () => writeFileSync(ghCalls, "");

const { plugins } = await import("../src/plugins.ts");
const { openDurableProject } = await import("../src/durable-runtime.ts");
const { projectDir, saveProject, loadProject } = await import("../src/state.ts");
const { authorizationFingerprint, trustedOwner } = await import("../src/workspace-authorization.ts");
const { projectBehavior } = await import("../src/prompt-blocks.ts");

const checks = [];
const pass = (name) => {
  checks.push(name);
  process.stderr.write(`PASS ${name}\n`);
};
const workspace = join(base, "workspace");
mkdirSync(workspace, { recursive: true });
const id = randomUUID();
const project = {
  version: 1,
  id,
  runtime: "durable",
  name: "GitHub plugin E2E",
  cwd: workspace,
  objective: "Check the GitHub plugin",
  createdAt: new Date().toISOString(),
  model: FAKE_MODEL,
  models: { worker: FAKE_MODEL, scout: FAKE_MODEL, reviewer: FAKE_MODEL },
  sessionFile: null,
  phase: "ready",
  problem: null,
  runs: [],
};
const grantFor = (repositoryId, numericId, extra = {}) => ({
  repositoryId,
  numericId,
  branchPrefix: "pi/",
  baseBranch: "main",
  owner: trustedOwner(),
  workspaceRevision: authorizationFingerprint(project),
  at: new Date().toISOString(),
  ...extra,
});
const authorized = { ...project, githubAuthorization: [grantFor("acme/mari", 4242)] };
saveProject(authorized);

const GITHUB_TOOLS = ["projects_github_issue_read", "projects_github_issues", "projects_github_issue_write", "projects_github_pr"];
const githubProvider = () =>
  plugins
    .coordinatorTools()
    .find((provider) =>
      provider
        .create({ projectId: id, root: () => undefined, isCoordinator: () => false })
        .tools.some((tool) => tool.name === "projects_github_issue_read"),
    );
let runtime;
const open = () => openDurableProject({ project: loadProject(id), dir: projectDir(id), onReport: () => {} });
let turn = 0;
const ask = async (text) => {
  const { submissionId } = await runtime.admit(text, { requestId: `turn-${++turn}` });
  const answer = await runtime.wait(submissionId);
  return { answer, request: fake.requests.at(-1) };
};
const readIssue = 'FAKE-CALL projects_github_issue_read {"number":95}';

try {
  // ---- Plugin absent: the registry has never loaded the built-in ----
  const prs = plugins.prProvider("github");
  assert.ok(prs, "the built-in PR provider exists without loading plugins");
  assert.equal(githubProvider(), undefined, "no GitHub coordinator tools before the built-in loads");
  pass("5 without the built-in plugin the GitHub PR provider stays and no GitHub coordinator tools exist");

  runtime = await open();
  {
    const { answer, request } = await ask(readIssue);
    assert.equal(answer.status, "done");
    assert.match(answer.text, /not available/, answer.text);
    assert.ok(!request.tools.some((name) => GITHUB_TOOLS.includes(name)), JSON.stringify(request.tools));
    assert.equal(ghLog().length, 0, "no gh call without the plugin");
  }
  await runtime.close();
  runtime = undefined;
  pass("6 without the plugin the project opens, the tools are not offered and a call is unavailable with no gh call");

  // ---- Built-in loads with no configuration ----
  const statuses = await plugins.load();
  const github = statuses.filter((item) => item.name === "github");
  assert.equal(github.length, 1, JSON.stringify(statuses));
  assert.equal(github[0].state, "loaded", JSON.stringify(github[0]));
  assert.equal(github[0].source, "built-in");
  assert.ok(github[0].provides.includes("coordinatorTools") && github[0].provides.includes("prs"), JSON.stringify(github[0]));
  pass("1/4 the built-in github plugin loads without plugins.json and provides coordinatorTools");
  assert.equal(plugins.prProvider("github"), prs, "the same PR provider");
  assert.equal(plugins.prProviders().filter((item) => item.id === "github").length, 1);
  assert.equal(plugins.coordinatorTools().filter((provider) => provider === githubProvider()).length, 1);
  pass("2 one github identity: one status row, one PR provider, one tools provider");

  // ---- Recorded-call compatibility: the contract captured from the core implementation ----
  const contract = JSON.parse(readFileSync(join(repo, "scripts/fixtures/github-coordinator-tools.json"), "utf8"));
  const created = githubProvider().create({ projectId: id, root: () => undefined, isCoordinator: () => false });
  assert.deepEqual(
    created.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.parameters)),
      replay: tool.replay ?? null,
      executionMode: tool.executionMode ?? null,
    })),
    contract.tools,
  );
  pass("8 names, descriptions, schemas, replay and execution mode match the core implementation");
  assert.equal(created.extension.name, contract.extension);
  pass("9 the Durable extension keeps the name projects.coordinator-github");

  // ---- Existing authorized behavior through the runtime ----
  runtime = await open();
  {
    clearGh();
    const { answer, request } = await ask(readIssue);
    assert.equal(answer.status, "done");
    assert.match(answer.text, /ISSUE-TITLE-95/, answer.text);
    assert.ok(
      GITHUB_TOOLS.every((name) => request.tools.includes(name)),
      JSON.stringify(request.tools),
    );
    assert.deepEqual(
      ghLog().map((call) => `${call.method} ${call.target}`),
      ["GET repos/acme/mari/issues/95", "GET repos/acme/mari/issues/95/comments?per_page=50&page=1"],
    );
  }
  pass("7/17 after the plugin loads, the authorized project gets the tools back and a read sends the same gh calls");
  {
    const groups = (await runtime.profileTools("coordinator")).groups;
    const githubGroup = groups.find((group) => group.id === "github");
    assert.ok(githubGroup && GITHUB_TOOLS.every((name) => githubGroup.tools.some((tool) => tool.name === name)), JSON.stringify(groups));
    assert.equal(githubGroup.label, "GitHub");
    assert.ok(!groups.some((group) => group.id === "plugin" && group.tools.some((tool) => GITHUB_TOOLS.includes(tool.name))));
  }
  pass("19 the tools stay in the GitHub group of Tools/access");
  {
    const blocks = projectBehavior(loadProject(id), "integrations").blocks;
    assert.ok(
      blocks.some((block) => block.id === "github" && block.active),
      JSON.stringify(blocks.map((block) => block.id)),
    );
    assert.ok(!blocks.some((block) => block.id === "plugin:github"));
  }
  pass("20 the GitHub integration block stays the built-in github block");
  await runtime.close();
  runtime = undefined;

  // ---- The plugin goes missing after GitHub calls were recorded, then returns ----
  plugins.reset();
  runtime = await open();
  {
    clearGh();
    const { answer, request } = await ask(readIssue);
    assert.match(answer.text, /not available/, answer.text);
    assert.ok(!request.tools.some((name) => GITHUB_TOOLS.includes(name)));
    assert.equal(ghLog().length, 0);
  }
  await runtime.close();
  runtime = undefined;
  await plugins.load();
  runtime = await open();
  {
    const { answer, request } = await ask(readIssue);
    assert.match(answer.text, /ISSUE-TITLE-95/, answer.text);
    assert.ok(GITHUB_TOOLS.every((name) => request.tools.includes(name)));
  }
  await runtime.close();
  runtime = undefined;
  pass("6/7 a project with recorded GitHub calls reopens without the plugin, offers nothing, and gets the tools back when it loads");

  // ---- Revocation through the runtime: history with GitHub calls reopens; the tools are no longer offered ----
  saveProject({ ...loadProject(id), githubAuthorization: [] });
  runtime = await open();
  {
    clearGh();
    const { answer, request } = await ask(readIssue);
    assert.match(answer.text, /not available/, answer.text);
    assert.ok(!request.tools.some((name) => GITHUB_TOOLS.includes(name)));
    assert.equal(ghLog().length, 0);
  }
  await runtime.close();
  runtime = undefined;
  pass("10 a revoked project with recorded GitHub calls reopens and no longer offers the tools");

  // ---- Authorization rules, checked on every call ----
  saveProject(authorized);
  const COORDINATOR = 7;
  const tools = (isCoordinator = (cid) => Number(cid) === COORDINATOR) =>
    Object.fromEntries(
      githubProvider()
        .create({ projectId: id, root: () => ({ id: COORDINATOR }), isCoordinator })
        .tools.map((tool) => [tool.name, tool]),
    );
  const run = (tool, args, conversationId = COORDINATOR) =>
    tool.execute(args, { conversationId }, { abortSignal: new AbortController().signal });
  const refused = async (label, promise, pattern) => {
    clearGh();
    await assert.rejects(promise, pattern, label);
    assert.equal(ghLog().length, 0, `${label}: no gh call`);
  };
  const t = tools();
  await refused("non-coordinator", run(t.projects_github_issue_read, { number: 95 }, 8), /coordinator-only/);
  pass("11 a caller that is not a Coordinator conversation is refused");
  saveProject({ ...authorized, githubAuthorization: [] });
  await refused("none", run(t.projects_github_issues, {}), /No current GitHub authorization/);
  saveProject({ ...authorized, githubAuthorization: [grantFor("acme/mari", 4242, { owner: "uid:someone-else" })] });
  await refused("other owner", run(t.projects_github_issues, {}), /No current GitHub authorization/);
  saveProject({ ...authorized, githubAuthorization: [grantFor("acme/mari", 4242, { workspaceRevision: "0".repeat(64) })] });
  await refused("stale", run(t.projects_github_issues, {}), /No current GitHub authorization/);
  pass("12 no, foreign-owner or stale authorization is refused");
  saveProject(authorized);
  clearGh();
  await run(t.projects_github_issues, {});
  assert.ok(ghLog().length > 0);
  saveProject({ ...authorized, githubAuthorization: [] });
  await refused("revoked", run(t.projects_github_issue_read, { number: 95 }), /No current GitHub authorization/);
  pass("13 a revocation after the tools were created refuses the next call");
  saveProject(authorized);
  await refused("unauthorized repository", run(t.projects_github_issue_read, { repository: "evil/other", number: 1 }), /not an authorized/);
  saveProject({ ...authorized, githubAuthorization: [grantFor("acme/mari", 4242), grantFor("acme/other", 77)] });
  await refused("ambiguous", run(t.projects_github_issue_read, { number: 95 }), /Pass repository/);
  pass("14 an unauthorized repository, or no repository with several authorized, is refused");
  saveProject({ ...authorized, archived: true });
  await refused("archived", run(t.projects_github_issues, {}), /archived or deleted/);
  pass("15 an archived project is refused");
  saveProject({ ...authorized, githubAuthorization: [grantFor("acme/mari", 9999)] });
  clearGh();
  await assert.rejects(run(t.projects_github_issue_write, { action: "comment", number: 95, body: "hi" }), /no longer has authorized id/);
  assert.deepEqual(
    ghLog().map((call) => call.method),
    ["GET"],
  );
  pass("16 a write with a changed numeric repository id stops before any write call");
  saveProject(authorized);
  clearGh();
  const commented = JSON.parse((await run(t.projects_github_issue_write, { action: "comment", number: 95, body: "hi" })).output[0].text);
  assert.equal(commented.action, "commented");
  assert.deepEqual(
    ghLog().map((call) => `${call.method} ${call.target}`),
    ["GET repos/acme/mari", "POST repos/acme/mari/issues/95/comments"],
  );
  pass("17 an authorized write pins the repository id, then sends the same write call");

  // ---- Offering rule ----
  const provider = githubProvider();
  assert.equal(provider.applies({ ...project }), false);
  assert.equal(provider.applies({ ...project, githubAuthorization: [] }), false);
  assert.equal(provider.applies(authorized), true);
  pass("18 offered exactly while the project has a GitHub authorization");

  // ---- A configured plugin cannot take the identity ----
  plugins.reset();
  process.env.PI_PROJECTS_PLUGINS = join(repo, "plugins", "github");
  const again = await plugins.load();
  const rows = again.filter((item) => item.name === "github");
  assert.equal(rows.filter((item) => item.state === "loaded").length, 1, JSON.stringify(again));
  assert.equal(rows.find((item) => item.state === "loaded").source, "built-in");
  assert.ok(
    rows.some((item) => item.state === "failed" && item.source.endsWith("plugins/github") && /already loaded/.test(item.error)),
    JSON.stringify(again),
  );
  assert.equal(
    plugins
      .coordinatorTools()
      .filter((item) =>
        item
          .create({ projectId: id, root: () => undefined, isCoordinator: () => false })
          .tools.some((tool) => tool.name === "projects_github_pr"),
      ).length,
    1,
  );
  pass("3 configuring plugins/github again is refused and the built-in stays loaded once");
  delete process.env.PI_PROJECTS_PLUGINS;
} finally {
  if (runtime) await runtime.close();
  writeFileSync(join(base, "result.json"), JSON.stringify({ checks, gh: ghLog() }, null, 2) + "\n");
  fake.close();
}
process.stderr.write(`github-plugin-e2e: ${checks.length} checks passed\n`);
