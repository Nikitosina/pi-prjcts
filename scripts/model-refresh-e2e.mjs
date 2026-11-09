import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createKit, randomUUID, call } from "./lib/e2e-kit.mjs";

let release;
const held = new Promise((resolve) => {
  release = resolve;
});
let releaseCoordinator;
const heldCoordinator = new Promise((resolve) => {
  releaseCoordinator = resolve;
});
let releaseInstructions;
const heldInstructions = new Promise((resolve) => {
  releaseInstructions = resolve;
});
const k = await createKit("model-refresh", {
  handler: async ({ role, user, results }) => {
    if (user.includes("HELD-REFRESH")) await held;
    if (role === "coordinator" && user === "INSTANCE-COORD-HELD" && !results.length) {
      await heldCoordinator;
      return call("projects_knowledge_list", {});
    }
    if (role === "coordinator" && user === "INSTANCE-PROFILES" && !results.length)
      return call("projects_delegate", { role: "worker", task: "INSTANCE-WORKER" });
    if (role === "worker" && user.includes("INSTANCE-WORKER") && results.length < 2)
      return call("subagent", {
        role: ["reviewer", "scout"][results.length],
        ...(results.length ? {} : { kind: "full" }),
        task: "INSTANCE-CHILD",
      });
    if (role === "worker" && user.includes("INSTANCE-HELD") && !results.length) {
      await heldInstructions;
      return call("projects_knowledge_list", {});
    }
  },
});
k.initRepo();
writeFileSync(join(k.workspace, "AGENTS.md"), "REPOSITORY-INSTRUCTIONS.\n");
k.git(k.workspace, "add", "AGENTS.md");
k.git(k.workspace, "commit", "-qm", "repository instructions");
writeFileSync(join(k.agentDir, "AGENTS.md"), "PERSONAL-INSTRUCTIONS-NOT-LOADED.\n");
const { rpc, check } = k;
const file = join(k.agentDir, "models.json");
const config = JSON.parse(readFileSync(file, "utf8"));
const base = config.providers.fake.models[0];
const save = () => writeFileSync(file, JSON.stringify(config));
const picker = (id) => rpc({ action: "model-picker-snapshot", ...(id ? { id } : {}) });
const find = (snapshot, ref) => snapshot.items.find((item) => item.reference === ref);
const fail = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};
await k.run(async () => {
  const id = await k.createProject("Refresh");
  await k.ask(id, "Before refresh");
  check(
    "missing instance file does not load personal instructions",
    !k.result.calls.at(-1).system.includes("PERSONAL-INSTRUCTIONS-NOT-LOADED"),
  );
  const instanceFile = join(k.home, "AGENTS.md");
  writeFileSync(instanceFile, "INSTANCE-INSTRUCTIONS-A.\n");
  await k.ask(id, "INSTANCE-PROFILES");
  for (const role of ["coordinator", "worker", "scout", "reviewer"]) {
    const request = k.result.calls.find((c) => c.role === role && c.user.includes("INSTANCE-"));
    check(
      `${role} loads instance instructions before repository instructions`,
      request?.system.includes("INSTANCE-INSTRUCTIONS-A.") &&
        request.system.indexOf("INSTANCE-INSTRUCTIONS-A.") < request.system.indexOf("REPOSITORY-INSTRUCTIONS."),
    );
  }
  const scope = (await rpc({ action: "workspace-catalog", id })).find((s) => s.wholeRepository).id;
  const active = await rpc({
    action: "work-submit",
    id,
    threadId: randomUUID(),
    requestId: randomUUID(),
    workspaceScopeId: scope,
    text: "INSTANCE-HELD",
  });
  await k.eventually(() => k.lastCall("worker", "INSTANCE-HELD"), "instance worker not held");
  writeFileSync(instanceFile, "INSTANCE-INSTRUCTIONS-B.\n");
  await rpc({ action: "message", id, text: "INSTANCE-COORD-B" });
  await k.eventually(() => k.lastCall("coordinator", "INSTANCE-COORD-B"), "updated coordinator did not dispatch");
  check(
    "next coordinator admission refreshes shared instructions",
    k.lastCall("coordinator", "INSTANCE-COORD-B").system.includes("INSTANCE-INSTRUCTIONS-B."),
  );
  releaseInstructions();
  await k.settle(id);
  check(
    "an active worker keeps its snapshot across tool rounds",
    k.lastCall("worker", "INSTANCE-HELD").system.includes("INSTANCE-INSTRUCTIONS-A.") &&
      !k.lastCall("worker", "INSTANCE-HELD").system.includes("INSTANCE-INSTRUCTIONS-B."),
  );
  await rpc({ action: "thread-send", id, threadId: active.id, requestId: randomUUID(), text: "INSTANCE-RETRY" });
  await k.settle(id);
  check(
    "an ended worker retry refreshes only shared instructions without reauthorization",
    k.lastCall("worker", "INSTANCE-RETRY")?.system.includes("INSTANCE-INSTRUCTIONS-B.") &&
      k.lastCall("worker", "INSTANCE-RETRY").system.replace("INSTANCE-INSTRUCTIONS-B.", "INSTANCE-INSTRUCTIONS-A.") ===
        k.lastCall("worker", "INSTANCE-HELD").system,
  );
  await rpc({ action: "message", id, text: "INSTANCE-COORD-HELD" });
  await k.eventually(() => k.lastCall("coordinator", "INSTANCE-COORD-HELD"), "coordinator not held");
  writeFileSync(instanceFile, "INSTANCE-INSTRUCTIONS-C.\n");
  await rpc({ action: "message", id, text: "INSTANCE-COORD-QUEUED" });
  releaseCoordinator();
  await k.settle(id);
  check(
    "busy coordinator keeps its snapshot through its current tool round",
    k.lastCall("coordinator", "INSTANCE-COORD-HELD").system.includes("INSTANCE-INSTRUCTIONS-B."),
  );
  check(
    "queued coordinator input picks up edits on its next turn",
    k.lastCall("coordinator", "INSTANCE-COORD-QUEUED").system.includes("INSTANCE-INSTRUCTIONS-C."),
  );
  writeFileSync(instanceFile, "INSTANCE-INSTRUCTIONS-B.\n");
  check("reload clears a deferred snapshot even when the file was reverted", (await rpc({ action: "chat-reload", id })).changed);
  const other = await k.createProject("Other instance project");
  await k.ask(other, "INSTANCE-OTHER-PROJECT");
  check(
    "instance instructions apply across projects",
    k.lastCall("coordinator", "INSTANCE-OTHER-PROJECT").system.includes("INSTANCE-INSTRUCTIONS-B."),
  );
  await k.stopHost();
  k.startHost();
  await k.waitHost();
  await rpc({ action: "thread-send", id, threadId: active.id, requestId: randomUUID(), text: "INSTANCE-AFTER-RESTART" });
  await k.settle(id);
  check(
    "instruction snapshots survive reopen without duplicate sections",
    (k.lastCall("worker", "INSTANCE-AFTER-RESTART")?.system.match(/INSTANCE-INSTRUCTIONS-B\./g) ?? []).length === 1,
  );
  for (const [label, make] of [
    [
      "symlink",
      () => {
        rmSync(instanceFile);
        symlinkSync(join(k.workspace, "AGENTS.md"), instanceFile);
      },
    ],
    ...(process.getuid?.() === 0 ? [] : [["unreadable", () => chmodSync(instanceFile, 0)]]),
    ["invalid UTF-8", () => writeFileSync(instanceFile, Buffer.from([255]))],
    ["oversized", () => writeFileSync(instanceFile, "x".repeat(64001))],
    [
      "directory",
      () => {
        rmSync(instanceFile);
        mkdirSync(instanceFile);
      },
    ],
  ]) {
    make();
    let problem = "";
    try {
      await rpc({ action: "message", id, text: "INVALID-INSTANCE" });
    } catch (error) {
      problem = String(error);
    }
    check(
      `${label} instance instructions fail admission with a bounded source error`,
      problem.includes("AGENTS.md") && problem.length < 2000,
    );
    check(`${label} instance instructions fail reload safely`, await fail(() => rpc({ action: "chat-reload", id })));
    rmSync(instanceFile, { recursive: true, force: true });
    writeFileSync(instanceFile, "INSTANCE-INSTRUCTIONS-B.\n");
  }
  rmSync(instanceFile);
  await k.ask(id, "INSTANCE-REMOVED");
  check(
    "removing instance instructions clears them on next coordinator turn",
    !k.lastCall("coordinator", "INSTANCE-REMOVED").system.includes("INSTANCE-INSTRUCTIONS-"),
  );

  await picker(id);
  await rpc({ action: "message", id, text: "HELD-REFRESH" });
  await k.eventually(() => k.result.calls.some((call) => call.user.includes("HELD-REFRESH")), "held request did not start");
  const marker = join(k.agentDir, "extension-executed");
  mkdirSync(join(k.agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(k.agentDir, "extensions/late.js"),
    `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)}, 'ran');`,
  );
  config.providers.fake.models.push({ ...base, id: "kimi-k3.1", name: "New Kimi" });
  config.providers.nocred = { baseUrl: config.providers.fake.baseUrl, api: "openai-completions", models: [{ ...base, id: "no-key" }] };
  save();
  mkdirSync(join(k.workspace, ".pi"), { recursive: true });
  writeFileSync(join(k.workspace, ".pi/settings.json"), JSON.stringify({ enabledModels: ["fake/kimi-k3.1"] }));
  let snapshot = await picker(id);
  check(
    "new config model appears without restart; effective enabledModels applies",
    find(snapshot, "fake/kimi-k3.1")?.configured && snapshot.scoped.join() === "fake/kimi-k3.1",
  );
  check(
    "absent credentials shown and selection rejected",
    find(snapshot, "nocred/no-key")?.configured === false && (await fail(() => k.updateSettings(id, { model: "nocred/no-key" }))),
  );
  await k.updateSettings(id, { scopedModels: ["fake/fake-model"] });
  check("explicit scope wins", (await picker(id)).scoped.join() === "fake/fake-model");
  await k.updateSettings(id, { scopedModels: null, model: "fake/kimi-k3.1" });
  release();
  await k.settle(id);
  check(
    "in-flight request survives registry and model selection changes",
    k.result.calls.find((call) => call.user.includes("HELD-REFRESH"))?.model === "fake-model" &&
      !(await rpc({ action: "show", id })).project.problem,
  );
  await k.ask(id, "After live selection");
  check("live selection dispatches actual new model", k.result.calls.at(-1)?.model === "kimi-k3.1");
  const scopeId = (await rpc({ action: "workspace-catalog", id })).find((scope) => scope.wholeRepository).id;
  const worker = await rpc({
    action: "work-submit",
    id,
    threadId: randomUUID(),
    requestId: randomUUID(),
    workspaceScopeId: scopeId,
    text: "WORKER-MODEL-RETRY",
  });
  await k.eventually(
    async () => (await k.jobs(id)).find((job) => job.id === worker.id && job.status !== "running"),
    "worker did not finish",
  );
  const prompt = k.result.calls.find((call) => call.role === "worker" && call.user.includes("WORKER-MODEL-RETRY")).system;
  await k.updateSettings(id, { models: { worker: "fake/kimi-k3.1" } });
  await rpc({ action: "thread-send", id, threadId: worker.id, requestId: randomUUID(), text: "RETRY-ON-NEW-MODEL" });
  await k.eventually(
    () => k.result.calls.some((call) => call.role === "worker" && call.user.includes("RETRY-ON-NEW-MODEL")),
    "retry did not dispatch",
  );
  const retried = k.result.calls.findLast((call) => call.role === "worker" && call.user.includes("RETRY-ON-NEW-MODEL"));
  check(
    "ended worker retries use current role model without replacing its frozen prompt",
    retried.model === "kimi-k3.1" && retried.system === prompt,
  );
  await k.updateSettings(id, { models: { worker: "fake/fake-model" } });
  config.providers.fake.models.find((m) => m.id === "kimi-k3.1").contextWindow = 64000;
  save();
  await rpc({ action: "chat-reload", id });
  check("reload adopts edited registry metadata", (await rpc({ action: "show", id })).context.catalogWindow === 64000);
  config.providers.fake.models = config.providers.fake.models.filter((m) => m.id !== "kimi-k3.1");
  save();
  check("removed config model disappears", !find(await picker(id), "fake/kimi-k3.1"));
  check("removed selection rejected", await fail(() => k.updateSettings(id, { model: "fake/kimi-k3.1" })));
  check("reload refuses missing current model", await fail(() => rpc({ action: "chat-reload", id })));
  await k.ask(id, "Previous runtime still works");
  check("failed refresh keeps usable live state", k.result.calls.at(-1)?.model === "kimi-k3.1");
  await k.updateSettings(id, { model: "fake/fake-model" });
  const last = await picker(id);
  writeFileSync(file, '{ "private-sentinel": broken');
  snapshot = await picker(id);
  check(
    "bad config keeps previous picker with safe diagnostic",
    snapshot.items.length === last.items.length &&
      snapshot.extensionErrors.some((e) => e.extension === "local models") &&
      !JSON.stringify(snapshot).includes("private-sentinel"),
  );
  check(
    "bad config rejects settings rather than using stale validation",
    await fail(() => k.updateSettings(id, { model: "fake/fake-model" })),
  );
  save();

  // A remote-provider catalog can change independently of models.json.
  const piStore = join(k.agentDir, "models-store.json");
  const projectStore = join(k.home, "models-store.json");
  const stored = (id) => ({
    ...base,
    id,
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const owned = JSON.stringify({
    openai: { lastModified: Date.now() + 86400000, models: [stored("stale-project")] },
    anthropic: { lastModified: Date.now() + 86400000, models: [{ ...stored("project-only"), provider: "anthropic" }] },
  });
  writeFileSync(projectStore, owned);
  writeFileSync(piStore, JSON.stringify({ openai: { lastModified: Date.now() + 86400000, models: [stored("new-catalog")] } }));
  snapshot = await picker(id);
  check("fresh Pi provider catalog replaces stale seed", find(snapshot, "openai/new-catalog") && !find(snapshot, "openai/stale-project"));
  check("Projects-only provider records remain usable", find(snapshot, "anthropic/project-only"));
  writeFileSync(piStore, JSON.stringify({ openai: { lastModified: Date.now() + 86400000, models: [stored("edited-catalog")] } }));
  snapshot = await picker(id);
  check(
    "catalog edits and removals visible on next open",
    find(snapshot, "openai/edited-catalog") && !find(snapshot, "openai/new-catalog"),
  );
  writeFileSync(piStore, "{}");
  snapshot = await picker(id);
  check(
    "removed Pi provider does not resurrect its stale Projects seed",
    !find(snapshot, "openai/stale-project") && !find(snapshot, "openai/edited-catalog"),
  );
  check("registry refresh does not discover or execute new extensions", !existsSync(marker));
  check("neither catalog is overwritten", readFileSync(projectStore, "utf8") === owned && readFileSync(piStore, "utf8") === "{}");
});
