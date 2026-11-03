// E2E: UI 2.0 backend settings (docs/ui2-contract.md): model tiers, per-profile tier/thinking/tools, profile-tools, prompt-render,
// the host ui document, host change topics, create grants and the removed verifier. Private host, fake provider, fake gh.
// Failure cases: scripts/ui2-backend-failures.md (T, P, L, R, U, H, C, V).
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createKit, say, randomUUID } from "./lib/e2e-kit.mjs";

const repo = process.cwd();
const holder = {};
const kit = await createKit("ui2-settings", {
  env: { PI_PROJECTS_GH_CLI: "", FAKE_GH_STATE: "", FAKE_GH_BARE: "", FAKE_GH_CALLS: "" },
  handler: ({ role }) => (role === "worker" ? say("Worker done without Ready.") : say(`OK ${role}`)),
});
// The fake gh lives under the kit's root, known only after createKit.
const fakeGh = join(kit.root, "fake-gh"),
  ghState = join(kit.root, "gh-state.json"),
  ghCalls = join(kit.root, "gh-calls.jsonl"),
  bare = join(kit.root, "remote.git");
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "scripts/fake-gh.mjs")}" "$@"\n`);
chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: "acme/demo", default_branch: "main" }, pulls: [] }));
writeFileSync(ghCalls, "");
Object.assign(kit.hostEnv, { PI_PROJECTS_GH_CLI: fakeGh, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, FAKE_GH_CALLS: ghCalls });
// A dead MCP server: listing tools must never connect to it.
writeFileSync(join(kit.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { deadsrv: { url: "http://127.0.0.1:9/mcp" } } }));
const modelPath = join(kit.agentDir, "models.json");
const config = JSON.parse(readFileSync(modelPath, "utf8"));
const base = { ...config.providers.fake.models[0], reasoning: true, compat: { supportsReasoningEffort: true } };
config.providers.fake.models = ["fake-model", "fake-two", "fake-three"].map((id) => ({ ...base, id, name: id }));
// Installed but without credentials (P10).
config.providers.keyless = { ...config.providers.fake, apiKey: undefined, models: [{ ...base, id: "locked", name: "locked" }] };
writeFileSync(modelPath, JSON.stringify(config));

await kit.run(async () => {
  const { rpc, rejects, check, result } = kit;
  const fails = async (input, pattern) => {
    const error = await rejects(input);
    return error !== null && pattern.test(String(error));
  };
  kit.initRepo();
  const id = await kit.createProject("Profiles");
  holder.id = id;
  const calls = (role) => result.calls.filter((call) => call.role === role);

  // Host change stream, read like the browser does.
  const web = new URL((await rpc({ action: "web" })).url);
  const token = new URLSearchParams(web.hash.slice(1)).get("token");
  const frames = [];
  const stream = await fetch(new URL("/changes?project=host", web.origin), { headers: { authorization: `Bearer ${token}` } });
  check("H1 /changes?project=host opens with the token", stream.status === 200, stream.status);
  const noToken = await fetch(new URL("/changes?project=host", web.origin));
  check("H1 /changes?project=host refuses a missing token", noToken.status === 401, noToken.status);
  void (async () => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const part of stream.body) {
      text += decoder.decode(part, { stream: true });
      for (let cut = text.indexOf("\n\n"); cut >= 0; cut = text.indexOf("\n\n")) {
        const line = text.slice(0, cut);
        text = text.slice(cut + 2);
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});
  const projectFrames = [];
  const projectStream = await fetch(new URL(`/changes?project=${id}`, web.origin), { headers: { authorization: `Bearer ${token}` } });
  void (async () => {
    for await (const part of projectStream.body) projectFrames.push(new TextDecoder().decode(part));
  })().catch(() => {});
  const topic = (name) =>
    kit.eventually(async () => frames.some((frame) => frame.t === "topic" && frame.topic === name), `host topic ${name}`);

  // Tiers.
  const first = await rpc({ action: "tiers-get" });
  check(
    "T1 generated tiers only list models projects already use",
    first.tiers.length > 0 && first.tiers.every((tier) => tier.models.every((model) => model === "fake/fake-model")),
    first.tiers,
  );
  check("T2 a second read is stable", (await rpc({ action: "tiers-get" })).revision === first.revision);
  const two = first.catalog.find((item) => item.ref === "fake/fake-two");
  check(
    "T6 the catalog carries context window, prices and availability",
    two && two.contextWindow === 128000 && two.available === true && typeof two.inputCost === "number",
    two,
  );
  check(
    "P1 absent profiles keep the legacy models and medium thinking",
    Object.values((await rpc({ action: "profiles-get", projectId: id })).profiles).every(
      (profile) => profile.effectiveModel === "fake/fake-model" && profile.tier === undefined,
    ),
  );
  const tiers = [
    ...first.tiers,
    { id: "top", name: "Top", letter: "S", models: ["fake/fake-three", "fake/fake-two"] },
    { id: "work", name: "Workhorse", letter: "A", models: ["fake/fake-two", "fake/fake-model"] },
  ];
  check("T3 a stale tiers revision is refused", await fails({ action: "tiers-set", revision: "0".repeat(64), tiers }, /revision/i));
  check(
    "T4 an uninstalled model is refused",
    await fails(
      { action: "tiers-set", revision: first.revision, tiers: [{ id: "x", name: "X", letter: "X", models: ["nope/none"] }] },
      /nope\/none/,
    ),
  );
  check(
    "T4 an empty tier is refused",
    await fails(
      { action: "tiers-set", revision: first.revision, tiers: [{ id: "x", name: "X", letter: "X", models: [] }] },
      /model|fewer|minItems|must/i,
    ),
  );
  check(
    "T4 duplicate tier ids are refused",
    await fails({ action: "tiers-set", revision: first.revision, tiers: [tiers.at(-1), tiers.at(-1)] }, /duplicate|twice|unique/i),
  );
  const saved = await rpc({ action: "tiers-set", revision: first.revision, tiers });
  check(
    "T8 tiers are saved",
    saved.tiers.some((tier) => tier.id === "top"),
  );
  await topic("tiers");
  check("H2 host topics stay off project streams", !projectFrames.join("").includes('"tiers"'));

  // Profiles.
  const profiles = () => rpc({ action: "profiles-get", projectId: id });
  const setProfile = async (profile, patch, revision) =>
    rpc({ action: "profiles-set", projectId: id, revision: revision ?? (await profiles()).revision, profile, patch });
  check(
    "P2 an unknown tier is refused",
    await fails(
      { action: "profiles-set", projectId: id, revision: (await profiles()).revision, profile: "coordinator", patch: { tier: "ghost" } },
      /ghost/,
    ),
  );
  check(
    "P2 a thinking level outside the union is refused",
    await fails(
      {
        action: "profiles-set",
        projectId: id,
        revision: (await profiles()).revision,
        profile: "coordinator",
        patch: { thinking: "extreme" },
      },
      /thinking|must|union|expected/i,
    ),
  );
  check(
    "P2 the verifier is no longer a profile",
    await fails(
      { action: "profiles-set", projectId: id, revision: (await profiles()).revision, profile: "verifier", patch: {} },
      /profile|must|union|expected/i,
    ),
  );
  check(
    "P3 a stale profile revision is refused",
    await fails({ action: "profiles-set", projectId: id, revision: "0".repeat(64), profile: "coordinator", patch: {} }, /revision/i),
  );
  check(
    "P9 the coordinator's agents tool is locked",
    await fails(
      {
        action: "profiles-set",
        projectId: id,
        revision: (await profiles()).revision,
        profile: "coordinator",
        patch: { tools: { disabled: ["agents"] } },
      },
      /agents|locked/i,
    ),
  );
  const coordinator = await setProfile("coordinator", { tier: "top", thinking: "high", tools: { disabled: ["bash"] } });
  check(
    "P4 the coordinator's effective model is the tier's first",
    coordinator.profiles.coordinator.effectiveModel === "fake/fake-three",
    coordinator,
  );
  await kit.ask(id, "PROFILE-ONE hello");
  const lastCoordinator = calls("coordinator").at(-1);
  check("P4 Main requests the tier model without a restart", lastCoordinator.model === "fake-three", lastCoordinator.model);
  check("P6 the coordinator's thinking level reaches the provider", lastCoordinator.reasoning === "high", lastCoordinator.reasoning);
  check(
    "P7 a disabled tool is not offered",
    !lastCoordinator.tools.includes("bash") && lastCoordinator.tools.includes("read"),
    lastCoordinator.tools,
  );
  check(
    "T5 a tier in use cannot be removed",
    await fails({ action: "tiers-set", revision: saved.revision, tiers: first.tiers }, /top|in use|uses/i),
  );

  await setProfile("worker", { tier: "work", thinking: "off", tools: { disabled: ["group:knowledge"] } });
  const scopeId = (await rpc({ action: "workspace-catalog", id })).find((scope) => scope.wholeRepository).id;
  const jobId = (
    await rpc({
      action: "work-submit",
      id,
      threadId: randomUUID(),
      requestId: randomUUID(),
      workspaceScopeId: scopeId,
      text: "PROFILE-WORKER go",
    })
  ).id;
  await kit.eventually(async () => calls("worker").some((call) => call.user.includes("PROFILE-WORKER")), "worker request");
  const worker = calls("worker").find((call) => call.user.includes("PROFILE-WORKER"));
  const raw = (name) => worker.request?.tools?.find((tool) => tool.function?.name === name);
  check("P5 the worker uses its own tier's first model", worker.model === "fake-two", worker.model);
  check("P6 thinking off sends no reasoning effort", worker.reasoning === null, worker.reasoning);
  check("P7 a disabled group removes every tool of it", !worker.tools.some((name) => name.startsWith("projects_knowledge")), worker.tools);
  check(
    "P8 the coordinator keeps knowledge tools",
    lastCoordinator.tools.some((name) => name.startsWith("projects_knowledge")),
  );
  check("V2 workers are offered projects_verify_run", worker.tools.includes("projects_verify_run"), worker.tools);
  check("P9 the worker keeps its job tool", worker.tools.includes("job"));
  void raw;
  await kit.settle(id);
  void jobId;

  // Profile tools (no MCP connection, no workspace allocation).
  const worktrees = () => (existsSync(join(kit.home, id, "worktrees")) ? readdirSync(join(kit.home, id, "worktrees")).length : 0);
  const before = worktrees(),
    started = Date.now();
  const tools = await rpc({ action: "profile-tools", projectId: id, profile: "coordinator" });
  check("L1 profile-tools answers without contacting the dead MCP server", Date.now() - started < 3000, Date.now() - started);
  check("L1 profile-tools allocates no workspace", worktrees() === before);
  const group = (gid) => tools.groups.find((item) => item.id === gid);
  const bash = tools.groups.flatMap((item) => item.tools).find((tool) => tool.name === "bash");
  check("L2 a disabled tool shows enabled: false", bash && bash.enabled === false && typeof bash.description === "string", bash);
  check(
    "L3 one group per MCP server with a writes pseudo-tool",
    group("mcp:deadsrv")?.tools.some((tool) => tool.name === "mcp-writes:deadsrv"),
    tools.groups.map((item) => item.id),
  );
  check(
    "L3 skills are one group",
    tools.groups.some((item) => item.source === "skill"),
  );
  check(
    "L2 the agents tool is locked",
    tools.groups.some((item) => item.locked && item.tools.some((tool) => tool.name === "agents")),
  );
  const workerTools = await rpc({ action: "profile-tools", projectId: id, profile: "worker" });
  check(
    "L2 the worker's knowledge group is disabled as a whole",
    workerTools.groups.find((item) => item.id === "knowledge").tools.every((tool) => !tool.enabled),
  );
  check("V1 the worker's subagent tool no longer offers a verifier", !JSON.stringify(workerTools).includes('"verifier"'));

  // Prompt render.
  const prompt = await rpc({ action: "prompt-render", projectId: id, profile: "coordinator" });
  const ids = prompt.sections.map((section) => section.id);
  const order = ["host", "instance", "repository", "project", "role", "preferences", "memory", "skills"];
  check(
    "R2 sections come in contract order",
    JSON.stringify(ids.filter((s) => order.includes(s))) === JSON.stringify(order.filter((s) => ids.includes(s))),
    ids,
  );
  const projectSection = prompt.sections.find((section) => section.id === "project");
  check(
    "R2 project instructions are the old objective and editable",
    projectSection.editable && projectSection.text.includes("Disposable ui2-settings fixture"),
    projectSection,
  );
  check("R2 the host contract is locked", prompt.sections.find((section) => section.id === "host").editable === false);
  check(
    "R4 tokens are labelled as estimates",
    prompt.sections.every((section) => /estimate/i.test(section.source)) && prompt.totalTokens > 0,
  );
  const system = calls("coordinator").at(-1).system;
  check(
    "R1 every instruction section is the text the coordinator was given",
    prompt.sections
      .filter((section) => ["host", "repository", "project", "role", "skills"].includes(section.id) && section.text)
      .every((section) => system.includes(section.text.trim().slice(0, 200))),
    { ids },
  );

  // UI document.
  const ui = await rpc({ action: "ui-get" });
  check(
    "U1 defaults come from the contract",
    ui.ui.theme === "claude" && ui.ui.animations === "subtle" && ui.ui.statusLine === true && ui.ui.panels.list === true,
    ui,
  );
  check(
    "U2 a stale ui revision is refused",
    await fails({ action: "ui-set", revision: "0".repeat(64), patch: { theme: "light" } }, /revision/i),
  );
  check(
    "U2 an unknown theme is refused",
    await fails({ action: "ui-set", revision: ui.revision, patch: { theme: "neon" } }, /theme|must|expected/i),
  );
  const hot = await rpc({ action: "ui-set", revision: ui.revision, patch: { hotkeys: { "panel.list": "[" } } });
  const themed = await rpc({ action: "ui-set", revision: hot.revision, patch: { theme: "midnight", panels: { context: false } } });
  check(
    "U3 a patch merges",
    themed.ui.theme === "midnight" &&
      themed.ui.hotkeys["panel.list"] === "[" &&
      themed.ui.panels.list === true &&
      themed.ui.panels.context === false,
    themed,
  );
  await topic("ui");
  check("U4 saving the ui document publishes the host ui topic", true);

  // Create grants the workspace and one-click GitHub in one step.
  const gitRepo = join(kit.root, "Demo");
  mkdirSync(gitRepo);
  execFileSync("/usr/bin/git", ["init", "--bare", "-q", "-b", "main", bare]);
  kit.initRepo(gitRepo);
  kit.git(gitRepo, "remote", "add", "origin", "https://github.com/acme/demo.git");
  kit.git(gitRepo, "config", "remote.origin.pushurl", bare);
  kit.git(gitRepo, "push", "-q", "origin", "main");
  const created = await rpc({ action: "create", requestId: randomUUID(), name: "Granted", cwd: gitRepo, model: "fake/fake-model" });
  await topic("projects");
  const project = JSON.parse(readFileSync(join(kit.home, created.id, "project.json"), "utf8"));
  check(
    "C1 create grants the whole-repository workspace",
    project.workspaceAuthorization?.scopes.some((scope) => scope.wholeRepository),
    project.workspaceAuthorization,
  );
  check(
    "C1 create grants one-click GitHub",
    project.githubAuthorization?.some((item) => item.oneClick && item.repositoryId === "acme/demo"),
    project.githubAuthorization,
  );
  writeFileSync(ghState, JSON.stringify({ repo: { id: 1, full_name: "other/repo", default_branch: "main" }, pulls: [] }));
  const plain = join(kit.root, "Plain");
  mkdirSync(plain);
  kit.initRepo(plain);
  kit.git(plain, "remote", "add", "origin", "https://github.com/acme/demo.git");
  const second = await rpc({ action: "create", requestId: randomUUID(), name: "No GitHub", cwd: plain, model: "fake/fake-model" });
  const secondProject = JSON.parse(readFileSync(join(kit.home, second.id, "project.json"), "utf8"));
  check(
    "C2 a failing GitHub grant does not fail create",
    secondProject.workspaceAuthorization?.scopes.length === 1 && !secondProject.githubAuthorization?.length,
    secondProject,
  );

  // Verification no longer needs a verifier model.
  mkdirSync(join(kit.workspace, ".agents", "skills", "verify-demo"), { recursive: true });
  writeFileSync(
    join(kit.workspace, ".agents", "skills", "verify-demo", "SKILL.md"),
    "---\nname: verify-demo\ndescription: Verify the demo.\n---\n\nRun it.\n",
  );
  const verification = await kit.updateSettings(id, { verification: { enabled: true, skill: "verify-demo" } });
  check("V3 verification turns on without a verifier model", verification.values.verification.enabled === true, verification);

  // A project whose runtime was never used answers both reads; missing instruction files are empty sections, not errors.
  const closedTools = await rpc({ action: "profile-tools", projectId: second.id, profile: "worker" });
  const closedPrompt = await rpc({ action: "prompt-render", projectId: second.id, profile: "worker" });
  check("L4 profile-tools works for a project that has not run", closedTools.groups.length > 0);
  check(
    "R3 missing instance and repository instructions render as empty sections",
    ["instance", "repository"].every((name) => (closedPrompt.sections.find((section) => section.id === name)?.text ?? "") === ""),
    closedPrompt.sections.map((section) => [section.id, section.text.slice(0, 60)]),
  );

  // A revoked one-click grant stays revoked when the runtime opens again.
  const owner = await rpc({ action: "owner-setup-snapshot", id: created.id });
  await rpc({
    action: "github-revoke",
    id: created.id,
    repositoryId: "acme/demo",
    confirm: created.id,
    expectedRevision: owner.githubRevision,
  });
  await rpc({ action: "profile-tools", projectId: created.id, profile: "coordinator" });
  await kit.ask(created.id, "after revoke");
  check(
    "C3 nothing re-grants GitHub after a revoke",
    !JSON.parse(readFileSync(join(kit.home, created.id, "project.json"), "utf8")).githubAuthorization?.length,
  );

  // Tiers skip models without credentials; a tier with none is refused when assigned.
  const withKeyless = await rpc({ action: "tiers-get" });
  check(
    "P10 a model without credentials is listed as unavailable",
    withKeyless.catalog.some((item) => item.ref === "keyless/locked" && item.available === false),
    withKeyless.catalog,
  );
  await rpc({
    action: "tiers-set",
    revision: withKeyless.revision,
    tiers: [
      ...withKeyless.tiers,
      { id: "mixed", name: "Mixed", letter: "M", models: ["keyless/locked", "fake/fake-two"] },
      { id: "keyless", name: "Keyless", letter: "K", models: ["keyless/locked"] },
    ],
  });
  const mixed = await setProfile("scout", { tier: "mixed" });
  check("P10 the tier's first usable model is chosen", mixed.profiles.scout.effectiveModel === "fake/fake-two", mixed.profiles.scout);
  check(
    "P10 a tier with no usable model is refused",
    await fails(
      { action: "profiles-set", projectId: id, revision: mixed.revision, profile: "scout", patch: { tier: "keyless" } },
      /credentials/,
    ),
  );

  // A damaged tiers file is an error, never replaced by generated tiers.
  const tiersFile = join(kit.home, "tiers.json"),
    savedTiers = readFileSync(tiersFile, "utf8");
  writeFileSync(tiersFile, "{ not json");
  check("T7 a damaged tiers.json is an error", await fails({ action: "tiers-get" }, /tiers/i));
  check("T7 and it is left as it was", readFileSync(tiersFile, "utf8") === "{ not json");
  writeFileSync(tiersFile, savedTiers);
});
