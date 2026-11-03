// E2E: quota fallback and bounded retries of a Job's worker. Three local fake models, a private host and a disposable worktree.
// The tier chain cases are F1-F4 in scripts/ui2-backend-failures.md.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, say, randomUUID, delay } from "./lib/e2e-kit.mjs";

const RATE = {
  status: 429,
  body: { error: { message: "Rate limit reached: Too many requests", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } },
};
const QUOTA = {
  status: 429,
  body: { error: { message: "Quota exceeded: session limit reached", type: "insufficient_quota", code: "insufficient_quota" } },
};
const requests = [],
  coordinator = [];
const kit = await createKit("worker-quota", {
  env: { PI_PROJECTS_QUOTA_RETRY_BASE_MS: "60" },
  handler: ({ role, model, user, msgs }) => {
    if (role === "coordinator") {
      // Each case runs in its own chat, so the whole conversation names it.
      const marker = ["COEND", "COQUOTA", "COPLAIN"].find((value) => JSON.stringify(msgs ?? user).includes(value));
      if (marker) coordinator.push({ marker, model });
      if (marker === "COEND" || (marker === "COQUOTA" && model === "fake-model")) return QUOTA;
      return say(marker === "COQUOTA" ? "Coordinator recovered." : "Noted.");
    }
    if (role !== "worker") return say("Noted.");
    const marker = ["FALLBACK", "EXHAUST", "UNKNOWN", "CHAINEND", "CHAIN", "RATE"].find((value) => user.includes(value));
    requests.push({ marker, model, at: Date.now() });
    if (marker === "FALLBACK" && model === "fallback-model") return say("Finished on the fallback model.");
    if (marker === "CHAIN" && model === "third-model") return say("Finished on the third model.");
    if (marker === "RATE") return model === "fake-model" ? RATE : say("Finished after the rate limit.");
    return QUOTA;
  },
});
await kit.run(async () => {
  const modelPath = join(kit.agentDir, "models.json");
  const config = JSON.parse(readFileSync(modelPath, "utf8"));
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: "fallback-model", name: "Fallback fake" });
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: "third-model", name: "Third fake" });
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
    kit.eventually(
      async () => {
        const job = (await kit.jobs(id)).find((item) => item.id === jobId);
        return job && job.status !== "running" ? job : false;
      },
      `Job ${jobId} did not settle`,
      1200,
    );
  const callsFor = (marker) => requests.filter((call) => call.marker === marker);

  await kit.updateSettings(id, { fallbackModels: { worker: "fake/fallback-model" } });
  const fallback = await settled(await submit("FALLBACK finish after quota"));
  kit.check(
    "F3 without a tier, quota moves the worker once to the configured fallback and it finishes there",
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

  const exhaustedCalls = callsFor("EXHAUST");
  kit.check(
    "every exhausted-fallback failure waits for a fresh backoff",
    exhaustedCalls.slice(2).every((call, index) => call.at - exhaustedCalls[index + 1].at >= 40),
    exhaustedCalls,
  );

  await kit.updateSettings(id, { fallbackModels: { worker: null } });
  const unknown = await settled(await submit("UNKNOWN reset time"));
  kit.check(
    "without a fallback the worker retries on its own model, then fails",
    unknown.status === "failed" && unknown.modelMoves.length === 0 && callsFor("UNKNOWN").length === 9,
    { unknown, calls: callsFor("UNKNOWN").length },
  );
  const unknownCalls = callsFor("UNKNOWN");
  kit.check(
    "every same-model quota failure waits for a fresh backoff",
    unknownCalls.slice(1).every((call, index) => call.at - unknownCalls[index].at >= 40),
    unknownCalls,
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

  // A tier replaces the single fallback: quota and rate limits walk its models in order.
  const tiers = await kit.rpc({ action: "tiers-get" });
  await kit.rpc({
    action: "tiers-set",
    revision: tiers.revision,
    tiers: [
      ...tiers.tiers,
      { id: "chain", name: "Chain", letter: "C", models: ["fake/fake-model", "fake/fallback-model", "fake/third-model"] },
    ],
  });
  const profiles = await kit.rpc({ action: "profiles-get", projectId: id });
  await kit.rpc({ action: "profiles-set", projectId: id, revision: profiles.revision, profile: "worker", patch: { tier: "chain" } });
  const chain = await settled(await submit("CHAIN quota twice"));
  kit.check(
    "F1 quota walks the tier in order and finishes on the third model",
    JSON.stringify(chain.modelMoves.map((move) => move.to)) === JSON.stringify(["fake/fallback-model", "fake/third-model"]) &&
      JSON.stringify(callsFor("CHAIN").map((call) => call.model)) === JSON.stringify(["fake-model", "fallback-model", "third-model"]),
    { chain, calls: callsFor("CHAIN") },
  );
  const chainEnd = await settled(await submit("CHAINEND every model"));
  kit.check(
    "F2 the exhausted last tier model retries a bounded number of times, never earlier models, then fails",
    chainEnd.status === "failed" &&
      chainEnd.modelMoves.length === 2 &&
      callsFor("CHAINEND")
        .slice(2)
        .every((call) => call.model === "third-model") &&
      callsFor("CHAINEND").length <= 12,
    { chainEnd, calls: callsFor("CHAINEND").map((call) => call.model) },
  );
  const rate = await settled(await submit("RATE limited once"));
  kit.check(
    "F4 a rate limit moves a tiered worker to the next model",
    rate.modelMoves.length === 1 && callsFor("RATE").at(-1).model === "fallback-model",
    { rate, calls: callsFor("RATE").map((call) => call.model) },
  );

  const { check } = kit;
  // G5: the Coordinator's tier advances on quota, once per failed turn, only in the chat that failed.
  const coordinatorProfiles = await kit.rpc({ action: "profiles-get", projectId: id });
  await kit.rpc({
    action: "profiles-set",
    projectId: id,
    revision: coordinatorProfiles.revision,
    profile: "coordinator",
    patch: { tier: "chain" },
  });
  const chat = async (title) => (await kit.rpc({ action: "chat-create", id, title })).id;
  const quotaChat = await chat("Quota"),
    plainChat = await chat("Plain"),
    endChat = await chat("End");
  const coCalls = (marker) => coordinator.filter((call) => call.marker === marker).map((call) => call.model);
  await kit.rpc({ action: "message", id, chatId: quotaChat, text: "COQUOTA answer me" });
  await kit.eventually(async () => coCalls("COQUOTA").includes("fallback-model"), "coordinator moved to the next tier model");
  await kit.settle(id);
  await delay(500);
  check(
    "G5 a quota failure moves the coordinator chat to the next tier model, once",
    JSON.stringify(coCalls("COQUOTA")) === JSON.stringify(["fake-model", "fallback-model"]),
    coCalls("COQUOTA"),
  );
  await kit.rpc({ action: "message", id, chatId: plainChat, text: "COPLAIN hello" });
  await kit.eventually(async () => coCalls("COPLAIN").length > 0, "plain chat answered");
  check("G5 another chat keeps the tier's first model", coCalls("COPLAIN")[0] === "fake-model", coCalls("COPLAIN"));
  await kit.rpc({ action: "message", id, chatId: endChat, text: "COEND every model" });
  await kit.eventually(async () => coCalls("COEND").includes("third-model"), "end chat reached the last model");
  await kit.settle(id);
  await delay(800);
  check(
    "G5 the end of the tier stops there instead of cycling",
    JSON.stringify(coCalls("COEND")) === JSON.stringify(["fake-model", "fallback-model", "third-model"]),
    coCalls("COEND"),
  );
});
