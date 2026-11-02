import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "local-models-"));
Object.assign(process.env, {
  HOME: join(root, "user"),
  PI_CODING_AGENT_DIR: join(root, "agent"),
  PI_PROJECTS_HOME: join(root, "projects"),
});
delete process.env.PI_OFFLINE;
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw Error("Unexpected network");
};
try {
  for (const path of ["user", "agent", "projects"]) await mkdir(join(root, path));
  const file = join(root, "agent/models.json");
  const model = { id: "one", name: "One", input: ["text"], reasoning: false, contextWindow: 10000, maxTokens: 1000 };
  const config = {
    providers: { local: { api: "openai-completions", apiKey: "fake-unit-key", baseUrl: "http://127.0.0.1:1/v1", models: [model] } },
  };
  const save = () => writeFile(file, JSON.stringify(config));
  await save();
  const { liveModelRuntime } = await import("../src/live-models.ts");
  const live = await liveModelRuntime();
  const old = live.models.getModel("local", "one");
  assert.equal(old.contextWindow, 10000);
  config.providers.local.models = [{ ...model, id: "two", contextWindow: 20000 }];
  await save();
  const update = await live.prepare();
  assert.equal(live.models.getModel("local", "two"), undefined);
  assert.equal(update.candidate.getModel("local", "two").contextWindow, 20000);
  update.commit();
  assert.equal(live.models.getModel("local", "two").contextWindow, 20000);
  assert.equal(live.models.getModel("local", "one"), old, "already-resolved frozen references survive removal");
  await writeFile(file, "{ private-sentinel: invalid");
  await assert.rejects(live.refresh(), (error) => !error.message.includes("private-sentinel"));
  assert.equal(live.models.getModel("local", "two").contextWindow, 20000);
  assert.equal(requests, 0, "offline registry creation and refresh never fetch, even without PI_OFFLINE");
  // Both adapters must see object arguments; Anthropic drops a root anyOf, so root properties matter too.
  const { createJobs } = await import("../src/jobs.ts");
  const { coordinatorGithubTools } = await import("../src/coordinator-github-tools.ts");
  const { Check } = await import("typebox/value");
  const { normalizeContext } = await import("@earendil-works/pi-ai");
  const tools = [
    ...createJobs({ agentChange: () => ({}) }).tools.worker,
    ...coordinatorGithubTools({ projectId: "unused", root: () => undefined, isCoordinator: () => false }).tools,
  ];
  for (const api of ["anthropic-messages", "openai-completions"]) {
    const { streamSimple } = await import(`@earendil-works/pi-ai/api/${api}`);
    let payload;
    await streamSimple(
      { ...old, api },
      normalizeContext({ messages: [{ role: "user", content: "probe", timestamp: Date.now() }], tools }),
      {
        apiKey: "fake",
        onPayload: (value) => {
          payload = value;
          throw Error("captured before network");
        },
      },
    ).result();
    const parameters = (name) => {
      const tool = payload.tools.find((tool) => (tool.function?.name ?? tool.name) === name);
      return tool.function?.parameters ?? tool.input_schema;
    };
    for (const name of ["job", "projects_github_issue_write"]) {
      const schema = parameters(name);
      assert.equal(schema.type, "object", `${api} ${name} has an object root`);
      assert.ok(schema.properties.action && schema.required.includes("action"), `${api} ${name} exposes action`);
    }
    assert.ok(parameters("job").properties.steps, `${api} exposes plan steps`);
  }
  await writeFile(join(root, "agent/auth.json"), JSON.stringify({ "kimi-coding": { type: "api_key", key: "fake" } }));
  await writeFile(
    join(root, "agent/models-store.json"),
    JSON.stringify({ "kimi-coding": { models: [{ ...old, provider: "kimi-coding", id: "k3.1-pro" }], lastModified: Date.now() } }),
  );
  await save();
  await live.refresh();
  let kimiPayload;
  await live.models
    .streamSimple(
      live.models.getModel("kimi-coding", "k3.1-pro"),
      { messages: [{ role: "user", content: "probe", timestamp: Date.now() }], tools },
      {
        onPayload: (payload) => {
          kimiPayload = payload;
          throw Error("captured before network");
        },
      },
    )
    .result();
  assert.ok(kimiPayload.tools[0].function, "cached Kimi OpenAI models use OpenAI dispatch, not the old native Anthropic adapter");
  const jobSchema = tools.find((tool) => tool.name === "job").parameters;
  assert.ok(Check(jobSchema, { action: "plan", steps: [] }));
  assert.ok(!Check(jobSchema, { action: "plan" }) && !Check(jobSchema, { action: "unknown" }), "local union validation stays strict");
  const issueSchema = tools.find((tool) => tool.name === "projects_github_issue_write").parameters;
  assert.ok(Check(issueSchema, { action: "create", title: "x" }) && !Check(issueSchema, { action: "create" }));
  assert.ok(!Check(issueSchema, { action: "reopen", number: 1, unexpected: true }), "closed union branches stay closed");
  assert.equal(requests, 0, "payload probes never fetch");
  console.log("PASS local SDK integration: staged swaps, frozen references, atomic failure, zero fetches");
} finally {
  await rm(root, { recursive: true, force: true });
}
