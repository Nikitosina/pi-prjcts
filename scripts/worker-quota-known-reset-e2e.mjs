// Local fake provider supplies an exhausted-window reset. No real provider or credentials.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, randomUUID, say, call, delay } from "./lib/e2e-kit.mjs";
let resetAt,
  requests = 0;
const kit = await createKit("worker-quota-known-reset", {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: "100", PI_PROJECTS_QUOTA_SWEEP_MS: "30" },
  handler: ({ role }) => {
    if (role !== "worker") return say("Noted.");
    requests++;
    if (requests > 2) return say("Recovered after reset.");
    if (requests === 2) return { status: 429, body: { error: { message: "Quota exceeded", code: "insufficient_quota" } } };
    resetAt = Date.now() + 5000;
    return {
      status: 200,
      stream: call("bash", { command: ":" }),
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(resetAt / 1000),
      },
    };
  },
});
await kit.run(async () => {
  const path = join(kit.agentDir, "models.json"),
    config = JSON.parse(readFileSync(path, "utf8"));
  config.providers.anthropic = { ...config.providers.fake, models: [{ ...config.providers.fake.models[0], id: "local-reset-model" }] };
  writeFileSync(path, JSON.stringify(config));
  kit.initRepo();
  const id = await kit.createProject("Known quota reset");
  await kit.updateSettings(id, { models: { worker: "anthropic/local-reset-model" } });
  const scope = (await kit.rpc({ action: "workspace-catalog", id })).find((scope) => scope.wholeRepository);
  const submitted = await kit.rpc({
    action: "work-submit",
    id,
    threadId: randomUUID(),
    requestId: randomUUID(),
    workspaceScopeId: scope.id,
    text: "Recover only after provider reset",
  });
  const row = () => kit.jobs(id).then((jobs) => jobs.find((job) => job.id === submitted.id));
  const waiting = await kit.eventually(async () => {
    const job = await row();
    return job?.status === "running" && job.quota ? job : false;
  }, "quota wait missing");
  kit.check("deadline uses provider reset instead of short test backoff", Math.abs(waiting.quota.retryAt - resetAt) < 1500, waiting.quota);
  await delay(300);
  kit.check("no request before reset despite repeated sweeps", requests === 2 && (await row()).status === "running");
  await kit.restartHost();
  const done = await kit.eventually(async () => {
    const job = await row();
    return job && job.status !== "running" ? job : false;
  }, "work did not recover");
  const calls = kit.result.calls.filter((call) => call.role === "worker");
  kit.check(
    "persisted reset recovers exactly once on the same model",
    requests === 3 && calls[2].at >= resetAt - 1000 && done.modelMoves.length === 0 && done.quota === null,
    { done, calls },
  );
});
