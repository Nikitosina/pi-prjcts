// E2E: quota fallback and bounded retries of a Job's worker. Two local fake models, a private host and a disposable worktree.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, say, randomUUID, delay } from "./lib/e2e-kit.mjs";

const QUOTA = {
  status: 429,
  body: { error: { message: "Quota exceeded: session limit reached", type: "insufficient_quota", code: "insufficient_quota" } },
};
const requests = [];
const kit = await createKit("worker-quota", {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: "60" },
  handler: ({ role, model, user }) => {
    if (role !== "worker") return say("Noted.");
    const marker = ["FALLBACK", "EXHAUST", "UNKNOWN"].find((value) => user.includes(value));
    requests.push({ marker, model });
    if (marker === "FALLBACK" && model === "fallback-model") return say("Finished on the fallback model.");
    return QUOTA;
  },
});
await kit.run(async () => {
  const modelPath = join(kit.agentDir, "models.json");
  const config = JSON.parse(readFileSync(modelPath, "utf8"));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: "fallback-model", name: "Fallback fake" });
  writeFileSync(modelPath, JSON.stringify(config));
  kit.initRepo();
  const id = await kit.createProject("Worker quota");
  const invalid = await kit.rejects({
    action: "settings-update",
    id,
    confirm: id,
    expectedRevision: (await kit.rpc({ action: "settings-snapshot", id })).revision,
    changes: { fallbackModels: { worker: "missing/model" } },
  });
  kit.check("an unavailable fallback model is rejected", invalid !== null, invalid);
  const scopeId = (await kit.rpc({ action: "workspace-catalog", id })).find((scope) => scope.wholeRepository).id;
  const submit = async (text) =>
    (await kit.rpc({ action: "work-submit", id, threadId: randomUUID(), requestId: randomUUID(), workspaceScopeId: scopeId, text })).id;
  const settled = (jobId) =>
    kit.eventually(async () => {
      const job = (await kit.jobs(id)).find((item) => item.id === jobId);
      return job && job.status !== "running" ? job : false;
    }, `Job ${jobId} did not settle`);
  const callsFor = (marker) => requests.filter((call) => call.marker === marker);

  await kit.updateSettings(id, { fallbackModels: { worker: "fake/fallback-model" } });
  const fallback = await settled(await submit("FALLBACK finish after quota"));
  kit.check(
    "quota moves the worker once to the configured fallback and it finishes there",
    fallback.modelMoves.length === 1 &&
      fallback.modelMoves[0].to === "fake/fallback-model" &&
      callsFor("FALLBACK").at(-1).model === "fallback-model",
    fallback,
  );

  const exhausted = await settled(await submit("EXHAUST both models"));
  kit.check(
    "an exhausted fallback never cycles back: the Job fails after a finite number of retries on the fallback",
    exhausted.status === "failed" &&
      exhausted.modelMoves.length === 1 &&
      callsFor("EXHAUST")
        .slice(1)
        .every((call) => call.model === "fallback-model") &&
      callsFor("EXHAUST").length > 2 &&
      callsFor("EXHAUST").length <= 10,
    { exhausted, calls: callsFor("EXHAUST").length },
  );

  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  const unknown = await settled(await submit("UNKNOWN reset time"));
  kit.check(
    "without a fallback the worker retries on its own model, then fails",
    unknown.status === "failed" && unknown.modelMoves.length === 0 && callsFor("UNKNOWN").length === 9,
    { unknown, calls: callsFor("UNKNOWN").length },
  );
  const total = requests.length;
  await delay(400);
  kit.check("a failed Job sends nothing more", requests.length === total);

  const { providerFailure } = await import("../src/provider-failure.ts");
  kit.check(
    "only quota exhaustion triggers recovery",
    providerFailure("model_error: insufficient_quota") === "quota_exceeded" &&
      providerFailure("model_error: 429 Too many requests") === "rate_limited" &&
      providerFailure("model_error: authentication failed") === undefined &&
      providerFailure("model_error: 503 quota service unavailable") === undefined,
  );
});
