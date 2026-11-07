// E2E: scoped models and live coordinator model changes.
// Isolated host, local fake provider with three models, no real providers. Failure cases: scripts/scoped-models-failures.md.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kit, delay } from "./notify-kit.mjs";

const brain = { held: null };
const respond = async ({ coordinator, marker, say }) => {
  if (coordinator) {
    if (marker === "MARK-BUSY") {
      await brain.held;
      return say("Busy turn done.");
    }
  }
  return undefined;
};
const k = await kit("scoped-models", {}, respond);
const { rpc, result, eventually, startHost, stopHost } = k;
const check = (name, ok, detail) => {
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`);
  result.checks.push(name);
  process.stderr.write(`PASS ${name}\n`);
};
const fails = async (fn, pattern) => {
  try {
    await fn();
    return false;
  } catch (error) {
    return pattern.test(String(error.message));
  }
};

try {
  const agentModels = join(k.root, "agent", "models.json"),
    models = JSON.parse(readFileSync(agentModels, "utf8"));
  const base = models.providers.fake.models[0];
  models.providers.fake.models = ["fake-model", "fake-two", "fake-three"].map((id) => ({ ...base, id, name: id }));
  writeFileSync(agentModels, JSON.stringify(models));
  await startHost();

  const created = await rpc({
    action: "create",
    requestId: crypto.randomUUID(),
    name: "Scoped",
    cwd: k.workspace,
    objective: "Disposable scoped-model fixture",
    model: "fake/fake-model",
  });
  const id = created.id;
  const settings = () => rpc({ action: "settings-snapshot", id });
  const update = async (changes) =>
    rpc({ action: "settings-update", id, confirm: id, expectedRevision: (await settings()).revision, changes });
  const show = (chatId) => rpc({ action: "show", id, ...(chatId ? { chatId } : {}) });
  const modelsOf = (role) => result.calls.filter((call) => call.coordinator === (role === "coordinator")).map((call) => call.model);

  let values = (await settings()).values;
  check("S1 a new project stores no role models (all inherit the coordinator)", JSON.stringify(values.models) === "{}", values.models);

  values = (await update({ models: { worker: "fake/fake-two" } })).values;
  check("S3 an explicit role model is kept", values.models.worker === "fake/fake-two", values.models);
  values = (await update({ models: { worker: null } })).values;
  check("S3 null returns a role to inherit", values.models.worker === undefined, values.models);

  const scoped = async () => (await rpc({ action: "model-picker-snapshot", id })).scoped;
  check("S6 without an override the scope is Pi's (no enabledModels: empty)", (await scoped()).length === 0, await scoped());
  values = (await update({ scopedModels: ["fake/fake-model", "fake/fake-two"] })).values;
  check(
    "S6 a project scope narrows the picker",
    JSON.stringify(await scoped()) === JSON.stringify(["fake/fake-model", "fake/fake-two"]),
    await scoped(),
  );
  check("S7 an unknown model in the scope is refused when saved", await fails(() => update({ scopedModels: ["zzz/none"] }), /zzz\/none/));
  await update({ scopedModels: null });
  check("S8 null restores Pi's scope", (await scoped()).length === 0 && (await settings()).values.scopedModels === null, await settings());

  // Inherited scope comes from the selected project's Pi settings, not the host's cwd.
  mkdirSync(join(k.workspace, ".pi"), { recursive: true });
  writeFileSync(join(k.workspace, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["fake/fake-two"] }));
  check(
    "S16 the inherited scope reads the project's own Pi settings",
    JSON.stringify(await scoped()) === JSON.stringify(["fake/fake-two"]),
    await scoped(),
  );
  check("S16 the project-less picker keeps the host-wide scope", (await rpc({ action: "model-picker-snapshot" })).scoped.length === 0);
  rmSync(join(k.workspace, ".pi"), { recursive: true });
  check(
    "S17 an empty scope override is refused (null is how to inherit)",
    await fails(() => update({ scopedModels: [] }), /scopedModels|at least|minItems|must/i),
  );
  check("S17 the refused empty override saved nothing", (await settings()).values.scopedModels === null);

  await update({ model: "fake/fake-two" });
  await k.ask(id, "main", "MARK-PLAIN after the change");
  check("S11 the coordinator now requests the new model", modelsOf("coordinator").at(-1) === "fake-two", modelsOf("coordinator"));
  const chat = await rpc({ action: "chat-create", id, title: "Second" });
  await k.ask(id, chat.id, "MARK-PLAIN in the second chat");
  check("S11 a chat created later uses the new model", modelsOf("coordinator").at(-1) === "fake-two");
  await update({ model: "fake/fake-three" });
  await k.ask(id, chat.id, "MARK-PLAIN again");
  await k.ask(id, "main", "MARK-PLAIN main");
  check(
    "S11 both Main and the existing chat follow the change",
    modelsOf("coordinator")
      .slice(-2)
      .every((model) => model === "fake-three"),
    modelsOf("coordinator"),
  );
  // Hold an actual provider request, not just a turn waiting to start.
  let free;
  brain.held = new Promise((ok) => {
    free = ok;
  });
  await rpc({ action: "message", id, chatId: chat.id, text: "MARK-BUSY hold this turn" });
  await eventually(
    async () => result.calls.some((call) => call.coordinator && call.marker === "MARK-BUSY"),
    "held provider request never started",
  );
  values = (await update({ model: "fake/fake-two" })).values;
  check("S10 a busy coordinator accepts and saves the new model", values.model === "fake/fake-two");
  await k.ask(id, "main", "MARK-PLAIN while the other chat is busy");
  check(
    "S10 an idle chat uses the new model while another request runs",
    modelsOf("coordinator").at(-1) === "fake-two" && (await show(chat.id)).busy,
  );
  await rpc({ action: "message", id, chatId: chat.id, text: "MARK-NEXT queued after the model change" });
  free();
  await eventually(
    async () => result.calls.some((call) => call.coordinator && call.marker === "MARK-NEXT") && !(await show(chat.id)).busy,
    "held request and queued follow-up did not finish",
  );
  const heldCalls = result.calls.filter((call) => call.coordinator && call.marker === "MARK-BUSY");
  check(
    "S10 the held request finishes once on its original model",
    heldCalls.length === 1 &&
      heldCalls[0].model === "fake-three" &&
      (await show(chat.id)).messages.some((message) => message.role === "assistant" && /Busy turn done/.test(message.text)),
    heldCalls,
  );
  check(
    "S10 the queued follow-up uses the new model",
    result.calls.find((call) => call.coordinator && call.marker === "MARK-NEXT")?.model === "fake-two",
  );

  // Restart: the saved selection is what runs.
  await stopHost();
  await startHost();
  check("S12 the model survives a host restart", (await settings()).values.model === "fake/fake-two");
  await k.ask(id, "main", "MARK-PLAIN after restart");
  check("S12 the restarted coordinator requests the saved model", modelsOf("coordinator").at(-1) === "fake-two", modelsOf("coordinator"));

  // S15 over RPC: the classic composer model button and Settings dialog were retired on 2026-11-04 (docs/classic-retirement.md);
  // the saves they made keep their meaning.
  await update({ models: { scout: null }, scopedModels: ["fake/fake-model", "fake/fake-two", "fake/fake-three"] });
  values = (await settings()).values;
  check(
    "S15 worker, scout and reviewer default to inherit the coordinator",
    ["worker", "scout", "reviewer"].every((role) => values.models[role] === undefined),
    values.models,
  );
  await update({ models: { worker: "fake/fake-two" }, scopedModels: ["fake/fake-model", "fake/fake-three"] });
  values = (await settings()).values;
  check(
    "S15 an explicit worker model and a narrowed scope are saved",
    values.models.worker === "fake/fake-two" &&
      JSON.stringify(values.scopedModels) === JSON.stringify(["fake/fake-model", "fake/fake-three"]) &&
      values.models.scout === undefined,
    values,
  );
  await update({ models: { worker: null } });
  check("S15 inheriting again removes the explicit model", (await settings()).values.models.worker === undefined);

  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = String(error?.stack ?? error);
} finally {
  await k.finish(result.status ?? "failed");
}
