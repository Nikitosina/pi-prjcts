// Jobs engine on a bare Pi Durable Harness with a scripted faux model: spawn, plan, verifier and reviewer, full report,
// restart without duplicates, stop draining the whole tree, and the stall detector's active-verifier rule.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createJobs, Jobs, planEta } from "../src/jobs.ts";
import { guardedStream } from "../src/model-guard.ts";

const dir = mkdtempSync(join(tmpdir(), "jobs-e2e-"));
const model = { provider: "faux", modelId: "faux-1" };
const sha = "a".repeat(40);

// The ETA counts down inside the step in progress and keeps a minute for an overrun one.
{
  const step = (status, estimateMin, startedAt = null) => ({ title: status, status, estimateMin, startedAt, doneAt: null });
  assert.equal(planEta([step("doing", 20, 0), step("todo", 30)], 15 * 60_000).etaMin, 35, "ETA counts down within the doing step");
  assert.equal(planEta([step("doing", 20, 0)], 90 * 60_000).etaMin, 1, "an overrun step still has a minute left");
}

// ── Scripted model: the system prompt names the role, the last message decides the move.
const requests = [];
const text = (content) =>
  typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const say = (value) => fauxAssistantMessage([fauxText(value)]);
function route(request) {
  const role = request.messages
    .flatMap((message) => (message.role === "system" ? [/ROLE:(\w+)/.exec(JSON.stringify(message.sections ?? {}))?.[1]] : []))
    .findLast(Boolean);
  const messages = request.messages.filter((message) => message.role !== "system");
  const last = messages.at(-1);
  const user = last.role === "user" ? text(last.content) : "";
  const result = last.role === "toolResult" ? text(last.content) : "";
  const tag = /BRIEF-\w+/.exec(text(messages.find((message) => message.role === "user").content))?.[0];
  requests.push({ role, tag, user, result });
  if (role === "coordinator") {
    const spawn = (name, id) =>
      call("agents", {
        action: "spawn",
        role: "worker",
        title: `Job ${name}`,
        brief: `BRIEF-${name}`,
        acceptance: ["it works"],
        requestId: id,
      });
    if (user.startsWith("Start ")) return spawn(user.slice(6), user.slice(6).toLowerCase());
    if (user.startsWith("Scout")) return call("agents", { action: "spawn", role: "scout", brief: "Look around", requestId: "scout-1" });
    return result ? say("OK.") : say("Noted.");
  }
  if (role === "worker") {
    if (user.startsWith("Just a question")) return say("Answer.");
    if (user.startsWith("Add a test"))
      return call("job", {
        action: "ready",
        summary: "Added the test",
        pr: "12",
        candidate: sha,
        proof: ["test run"],
        review: "REVIEW-OK",
      });
    if (/BRIEF-(GATE|INTR)/.test(user) && !messages.some((message) => message.role === "toolResult")) return call("gate", {});
    if (tag === "BRIEF-INTR" && result.startsWith("gate open")) return say("Interrupted before it finished.");
    if (user.includes("BRIEF-") || result.startsWith("gate open") || user.includes("host restarted"))
      return call("job", {
        action: "plan",
        steps: [
          { title: "Build", status: "doing", estimateMin: 5 },
          { title: "Verify", status: "todo", estimateMin: 2 },
        ],
      });
    if (result.startsWith("Plan saved"))
      return call("subagent", {
        role: "verifier",
        task: { SLOW: "SLOW-VERIFY", SILENT: "SILENT", BUSY: "BUSY" }[tag.slice(6)] ?? "VERIFY",
      });
    if (result === "PASS") return call("subagent", { role: "reviewer", task: "REVIEW" });
    if (result === "REVIEW-OK")
      return call("job", { action: "ready", summary: "Built it", pr: "12", candidate: sha, proof: ["verifier PASS"], review: "REVIEW-OK" });
    return say("Done.");
  }
  if (role === "verifier") {
    if (user === "SLOW-VERIFY" || user === "SILENT") return call("slow", {});
    if (user === "BUSY") return call("step", { n: 1 });
    if (result.startsWith("step ")) return Number(result.slice(5)) < 12 ? call("step", { n: Number(result.slice(5)) + 1 }) : say("PASS");
    return say("PASS");
  }
  return say(role === "reviewer" ? "REVIEW-OK" : "Scouted.");
}

// ── Host tools standing in for the project's: a gate, a silent blocking "process", and a chatty step.
const processes = new Set();
// Titles whose prepare step is held open, and the ones that have entered it.
const prepareHeld = new Set(),
  prepareEntered = new Set(),
  prepareRuns = [];
let gateOpen = false,
  gateEntered = false,
  bootId = "boot-A";
const TestTools = defineExtension({
  name: "test-tools",
  tools: [
    defineTool({
      name: "gate",
      description: "Wait for the test to open the gate",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, _api, callContext) => {
        gateEntered = true;
        while (!gateOpen && !callContext.abortSignal?.aborted) await delay(20);
        return { content: [{ type: "text", text: "gate open" }] };
      },
    }),
    defineTool({
      name: "slow",
      description: "A silent background process",
      parameters: Type.Object({}),
      execute: async (_args, api, callContext) => {
        processes.add(api.conversationId);
        while (!callContext.abortSignal?.aborted) await delay(20);
        return { content: [{ type: "text", text: "aborted" }] };
      },
    }),
    defineTool({
      name: "step",
      description: "A short step",
      parameters: Type.Object({ n: Type.Number() }),
      replay: "safe",
      execute: async (args) => {
        await delay(60);
        return { content: [{ type: "text", text: `step ${args.n}` }] };
      },
    }),
  ],
});

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 600 }, () => route));

async function open() {
  const killed = [];
  const jobs = createJobs({
    boot: bootId,
    agentChange: ({ role }) => ({
      model,
      instructions: `ROLE:${role}`,
      extensions: role === "verifier" ? [TestTools] : role === "worker" ? [TestTools] : [],
    }),
    killProcesses: async (ids) => {
      killed.push(...ids);
      for (const id of ids) processes.delete(id);
    },
    prepare: async ({ agent }) => {
      prepareEntered.add(agent.title);
      prepareRuns.push(agent.id);
      while (prepareHeld.has(agent.title)) await delay(20);
    },
    approver: { approve: async () => ({ kind: "auto-merge-pending" }) },
    backgroundSilence: () => null,
    stallMinutes: () => 20,
  });
  const registry = createRegistry();
  registry.install(TestTools);
  jobs.install(registry);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "session.sqlite")),
    { models, registry, settings: { followUpMode: "all" } },
    context,
  );
  jobs.attach(harness);
  harness.resume();
  const root = await harness.root(context, { agent: { model, instructions: "ROLE:coordinator", extensions: [jobs.coordinator] } });
  return { harness, root, jobs, killed };
}
const until = async (check, what, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(20)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`Timed out: ${what}`);
};
const quiet = async (harness) => {
  let calm = 0;
  await until(async () => {
    const live = await harness.inspect(context);
    calm = live.tasks.length === 0 && live.submissions.length === 0 ? calm + 1 : 0;
    return calm >= 5;
  }, "no live work");
};
const chatText = async (conversation) =>
  (await conversation.entries({}, 200, undefined, context)).items
    .toReversed()
    .flatMap((entry) => (entry.model?.[0]?.role === "user" ? [text(entry.model[0].content)] : []));
const jobsOf = async (harness) => Object.values((await harness.snapshot(Jobs, (await harness.root(context)).id, context)).jobs);
const say_ = async (root, content) => (await root.submit({ type: "input", content }, context)).wait(context);

let { harness, root, jobs, killed } = await open();

// 1. Spawn, plan, verifier + reviewer, full Ready report; a retried spawn returns the same agent.
await say_(root, "Start A");
await say_(root, "Start A");
await quiet(harness);
let [job] = await jobsOf(harness);
assert.equal((await jobsOf(harness)).length, 1, "a retried spawn must not start a second worker");
assert.equal(job.status, "ready");
assert.equal(job.candidate, sha);
assert.equal(job.plan.length, 2);
const report = (await chatText(root)).filter((line) => line.startsWith(`[worker ${job.id} ready`));
assert.equal(report.length, 1, "exactly one Ready report");
for (const part of [
  "Candidate: " + sha,
  "PR: 12",
  "Summary: Built it",
  "- verifier PASS",
  "Review: REVIEW-OK",
  "Not fixed: none",
  "Gaps: none",
  "Done.",
  "Cost: ",
])
  assert.ok(report[0].includes(part), `report carries ${part}`);
const snapshot = await jobs.snapshot(harness);
assert.equal(snapshot.jobs[0].working, false);
assert.equal(requests.filter((item) => item.role === "verifier").length, 1);
assert.equal(requests.filter((item) => item.role === "reviewer").length, 1);

// 2. A scout answers its brief; the answer reaches the chat.
await say_(root, "Scout the tree");
await quiet(harness);
assert.ok((await chatText(root)).some((line) => /^\[scout .* answered/.test(line) && line.includes("Scouted.")));

// 3. Restart while the worker is mid-run: no duplicate brief, one report.
await say_(root, "Start GATE");
await until(() => gateEntered, "worker inside the gate");
await harness.close(context);
({ harness, root, jobs, killed } = await open());
gateOpen = true;
await quiet(harness);
const gate = (await jobsOf(harness)).find((item) => item.title === "Job GATE");
assert.equal(gate.status, "ready");
assert.equal(
  requests.filter((item) => item.role === "worker" && item.user.includes("BRIEF-GATE")).length,
  1,
  "the brief reaches the worker once",
);
assert.equal(
  (await chatText(root)).filter((line) => line.startsWith(`[worker ${gate.id} ready`)).length,
  1,
  "one report after the restart",
);
assert.equal((await jobsOf(harness)).length, 2, "no duplicate workers after the restart");

// 3b. A restart that cuts a run short is not a worker failure: no failed state, no report to the coordinator, the worker is told to continue.
gateOpen = false;
gateEntered = false;
await say_(root, "Start INTR");
await until(() => gateEntered, "worker inside the gate");
await harness.close(context);
bootId = "boot-B";
({ harness, root, jobs, killed } = await open());
gateOpen = true;
await quiet(harness);
const intr = (await jobsOf(harness)).find((item) => item.title === "Job INTR");
assert.equal(intr.status, "ready", "the interrupted worker continued to Ready instead of failing");
assert.equal(
  (await chatText(root)).filter((line) => line.includes(`[worker ${intr.id} failed`)).length,
  0,
  "no failure report after a restart",
);
assert.equal(requests.filter((item) => item.role === "worker" && item.user.includes("host restarted")).length, 1, "told once to continue");

// 4. A worker waiting on its active verifier is not stalled; a silent one is, once.
const before = (await chatText(root)).length;
await say_(root, "Start BUSY");
await until(() => requests.some((item) => item.role === "verifier" && item.user === "BUSY"), "busy verifier started");
const T = 1_000_000_000;
assert.deepEqual(await jobs.stallTick(harness, T), []);
await delay(300);
assert.deepEqual(await jobs.stallTick(harness, T + 21 * 60_000), [], "the verifier made progress, so the worker is not stalled");
await quiet(harness);
await say_(root, "Start SILENT");
await until(() => processes.size === 1, "silent process started");
assert.deepEqual(await jobs.stallTick(harness, T), []);
const silent = (await jobsOf(harness)).find((item) => item.title === "Job SILENT");
assert.deepEqual(await jobs.stallTick(harness, T + 21 * 60_000), [silent.id]);
assert.deepEqual(await jobs.stallTick(harness, T + 30 * 60_000), [], "one notice per stall");
await until(async () => (await chatText(root)).some((line) => line.startsWith(`[worker ${silent.id} stalled`)), "stall notice in chat");
assert.equal((await chatText(root)).filter((line) => line.includes("stalled")).length, 1);
assert.ok((await chatText(root)).slice(before).every((line) => !line.includes(`[worker ${silent.id} ready`)));

// 5. Stop drains the worker and its verifier, kills the process, and reports nothing.
await assert.rejects(async () => jobs.stop(harness, silent.id, " "), /reason/);
const sizeBefore = (await chatText(root)).length;
await jobs.stop(harness, silent.id, "owner asked");
const stopped = (await jobsOf(harness)).find((item) => item.id === silent.id);
assert.equal(stopped.status, "stopped");
assert.equal(stopped.reason, "owner asked");
assert.equal(processes.size, 0, "the background process was killed");
assert.ok(killed.length >= 2, "the worker and its verifier were passed to the process killer");
await quiet(harness);
assert.ok(
  !(await chatText(root)).slice(sizeBefore).some((line) => line.includes(silent.id) && !line.includes("stalled")),
  "a stopped Job reports nothing",
);
assert.match(await jobs.stop(harness, silent.id, "again"), /already stopped/);

// 6. A question to a finished Job is answered without failing it; a steer that does work reports again, and a retried steer id sends once.
const preparesBefore = prepareRuns.filter((id) => id === job.id).length;
await jobs.steer(harness, job.id, "Just a question");
await quiet(harness);
assert.equal(
  prepareRuns.filter((id) => id === job.id).length,
  preparesBefore + 1,
  "a follow-up to a finished Job after a restart prepares its workspace and tools again",
);
assert.equal((await jobsOf(harness)).find((item) => item.id === job.id).status, "ready", "an answer-only follow-up keeps the Job Ready");
assert.equal((await chatText(root)).filter((line) => line.startsWith(`[worker ${job.id} answered`)).length, 1);
await jobs.steer(harness, job.id, "Add a test too", false, "steer-1");
assert.match(await jobs.steer(harness, job.id, "Add a test too", false, "steer-1"), /Already sent/);
await quiet(harness);
assert.equal(
  (await chatText(root)).filter((line) => line.startsWith(`[worker ${job.id} ready`)).length,
  2,
  "the follow-up answer reports once more, and the retried steer did not run twice",
);

// 7. Stop or pause while the agent is still preparing never submits its brief; resume sends it once.
const holdPrepare = async (title, name) => {
  prepareHeld.add(title);
  await say_(root, `Start ${name}`);
  await until(() => prepareEntered.has(title), `${title} preparing`);
  return (await jobsOf(harness)).find((item) => item.title === title);
};
const prep = await holdPrepare("Job PREP", "PREP");
await jobs.stop(harness, prep.id, "changed my mind");
prepareHeld.delete("Job PREP");
await quiet(harness);
assert.ok(!requests.some((item) => item.tag === "BRIEF-PREP"), "a Job stopped during prepare never reaches the model");
assert.equal((await jobsOf(harness)).find((item) => item.id === prep.id).status, "stopped");
const paused = await holdPrepare("Job PAUSEPREP", "PAUSEPREP");
await jobs.pause(harness);
prepareHeld.delete("Job PAUSEPREP");
await quiet(harness);
assert.ok(!requests.some((item) => item.tag === "BRIEF-PAUSEPREP"), "a paused project does not start the agent");
await jobs.resume(harness);
await quiet(harness);
assert.equal((await jobsOf(harness)).find((item) => item.id === paused.id).status, "ready");
assert.equal(
  requests.filter((item) => item.role === "worker" && item.user.includes("BRIEF-PAUSEPREP")).length,
  1,
  "resume sends the brief once",
);

// 7b. Dismiss clears an ended Job from the list (not a running one); a send to it retries the task and sends the unsent brief first.
const dismissTool = (id) => jobs.dismiss(harness, id);
assert.match(await dismissTool(gate.id), /already|still running|Dismissed/, "dismiss answers");
assert.match(await dismissTool(prep.id), /^Dismissed/);
assert.match(await dismissTool(prep.id), /already dismissed/);
assert.ok((await jobsOf(harness)).find((item) => item.id === prep.id).dismissedAt, "the mark is kept on the record");
await jobs.steer(harness, prep.id, "Try again");
await quiet(harness);
assert.ok(
  requests.some((item) => item.role === "worker" && item.user.includes("BRIEF-PREP")),
  "a retry sends the brief that never arrived",
);
assert.equal((await jobsOf(harness)).find((item) => item.id === prep.id).dismissedAt, undefined, "a new message clears the mark");

// 8. Approve: an armed auto-merge answers at once; the background finish marks the Job approved and tells the chat.
const outcome = await jobs.approve(harness, job.id);
assert.deepEqual(outcome, { outcome: { kind: "auto-merge-pending" } });
assert.equal((await jobsOf(harness)).find((item) => item.id === job.id).status, "ready");
await jobs.finishApproval(harness, job.id, { kind: "accepted", head: sha }, "Merged aaaaaaaa.");
assert.equal((await jobsOf(harness)).find((item) => item.id === job.id).status, "approved");
await until(async () => (await chatText(root)).some((line) => line.startsWith(`[worker ${job.id} approve`)), "approve notice in chat");

// 9. A running Job whose idle worker never reported is flagged once it has been quiet past the limit.
const rootId = (await harness.root(context)).id;
await harness.commit(async (tx) => {
  const record = (await tx.doc(Jobs, rootId)).jobs[gate.id];
  Object.assign(record, { status: "running", ready: null, endedAt: null });
}, context);
assert.deepEqual(await jobs.stallTick(harness, T), []);
assert.deepEqual(await jobs.stallTick(harness, T + 21 * 60_000), [gate.id], "an idle running Job is stalled");

// 10. A provider that hangs and ignores its abort signal cannot keep a stopped conversation busy; a silent one is cut off.
{
  const hung = createModels();
  const fake = fauxProvider();
  hung.setProvider(fake.provider);
  const dispatch = () => createAssistantMessageEventStream(); // never yields, never ends, ignores the signal
  let idleMs = 400;
  hung.streamSimple = (m, r, o) => guardedStream(dispatch, m, r, o, o?.signal, idleMs);
  const registry = createRegistry();
  const h = await Harness.open(
    await openNodeSqliteStorage(join(dir, "hung.sqlite")),
    { models: hung, registry, settings: { retry: { maxRetries: 0 } } },
    context,
  );
  h.resume();
  const conversation = await h.root(context, { agent: { model, instructions: "x" } });
  const submission = await conversation.submit({ type: "input", content: "hello" }, context);
  const answer = await Promise.race([submission.wait(context), delay(5_000).then(() => "hung")]);
  assert.notEqual(answer, "hung", "a silent request ends after the idle bound");
  assert.equal(answer.status, "unanswered");
  idleMs = 60_000;
  const second = await conversation.submit({ type: "input", content: "again" }, context);
  await delay(100);
  const stopped = await Promise.race([conversation.abort(context).then(() => "idle"), delay(3_000).then(() => "hung")]);
  assert.equal(stopped, "idle", "abort of a request that ignores the signal still ends the run");
  await second.wait(context).catch(() => {});
  assert.equal((await h.snapshot(LiveDoc, conversation.id, context))?.run, undefined, "the stopped conversation is no longer working");
  await h.close(context);
}

await harness.close(context);
rmSync(dir, { recursive: true, force: true });
console.log("jobs e2e passed");
