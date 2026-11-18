// Jobs engine on a bare Pi Durable Harness with a scripted faux model: spawn, plan, a checking child and a reviewer, full report,
// restart without duplicates, stop draining the whole tree, and the stall detector's active-child rule.
// The verifier role was retired (2026-11-03): the checking child is a scout running the test tools.
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
import { createJobs, Jobs, liveAgentIds, planEta, readRevision } from "../src/jobs.ts";
import { guardedStream } from "../src/model-guard.ts";
import { DEFAULT_ROLE_PROMPTS, TASK_HELPER_PROMPT } from "../src/role-prompts.ts";

const dir = mkdtempSync(join(tmpdir(), "jobs-e2e-"));
const model = { provider: "faux", modelId: "faux-1" };
const sha = "a".repeat(40);
const [REV_A, REV_B, REV_C, UNAVAILABLE] = ["1", "2", "3", "c"].map((digit) => digit.repeat(40));
const longAnswer = "Full exact retained evidence. ".repeat(300) + "END-OF-EXACT-ANSWER";
const review = (kind) => ["subagent", { role: "reviewer", kind, task: "REVIEW" }];
// A recheck before any full review, three axis reviewers, a fourth, a scout, two rechecks, a third, a full after rechecks, Ready.
const BUDGET_STEPS = [
  review("recheck"),
  review("full"),
  review("full"),
  review("full"),
  review("full"),
  ["subagent", { role: "scout", task: "Look around" }],
  review("recheck"),
  review("recheck"),
  review("recheck"),
  review("full"),
  ["job", { action: "ready", summary: "Within budget", pr: "12", candidate: sha, proof: ["p"], review: "REVIEW-OK", gaps: ["open P1"] }],
];
// A full reviewer whose model fails, then the whole full round, a fourth full reviewer, Ready.
const REFUND_STEPS = [
  ["subagent", { role: "reviewer", kind: "full", task: "REVIEW-FAIL" }],
  review("full"),
  review("full"),
  review("full"),
  review("full"),
  ["job", { action: "ready", summary: "Reviewed", pr: "12", candidate: sha, proof: ["p"], review: "REVIEW-OK" }],
];
// W1-W9 (jobs-failures.md): a worker's re-check continues its reviewer; `worktree` stands in for the worker's checkout.
const worktree = { head: null, dirty: false, unreadable: false };
let continuedReviewer = null;
function setWorktree(head, flags = {}) {
  Object.assign(worktree, { head, dirty: false, unreadable: false, ...flags });
  return head;
}
const recheck = (task, continues) => ["subagent", { role: "reviewer", kind: "recheck", task, continues }];
const CONTINUE_STEPS = [
  () => ["job", { action: "candidate", sha: setWorktree(REV_A) }],
  () => ["subagent", { role: "reviewer", kind: "full", task: "BRIEF-CONT review A" }],
  (r) => ["subagent", { role: "reviewer", kind: "full", task: "again", continues: (continuedReviewer = /reviewer (\d+)/.exec(r[1])?.[1]) }],
  () => recheck("no news", continuedReviewer),
  () => (setWorktree(REV_B, { dirty: true }), ["job", { action: "candidate", sha: REV_B }]),
  () => recheck("dirty", continuedReviewer),
  () => (setWorktree(REV_C), recheck("moved on", continuedReviewer)),
  () => (setWorktree(REV_B, { unreadable: true }), recheck("blind", continuedReviewer)),
  () => (setWorktree(REV_B), recheck("stranger", "999999")),
  () => recheck("REVIEW B", continuedReviewer),
  () => recheck("same again", continuedReviewer),
  () => (setWorktree(REV_C), ["job", { action: "candidate", sha: REV_C }]),
  () => recheck("REVIEW-FAIL", continuedReviewer),
  () => recheck("after the failure", continuedReviewer),
  () => recheck("fresh after the failure"),
  () => ["job", { action: "ready", summary: "Continued", pr: "12", candidate: REV_B, proof: ["p"], review: "REVIEW-OK" }],
];
// Tasks a worker gives its checking scout; other scout tasks answer normally.
const CHECKS = new Set(["CHECK", "SLOW-CHECK", "SILENT", "BUSY"]);
// A glued-words suspect (scripts/agent-signals-failures.md G6).
const GLUED = "Couldmerelykeepownedsessionrunningwhilelocaldebugandrenewlease";
assert.match(DEFAULT_ROLE_PROMPTS.worker, /Mark the PR ready before calling job ready/, "Ready includes the draft PR transition");
for (const prompt of [DEFAULT_ROLE_PROMPTS.worker, TASK_HELPER_PROMPT])
  assert.match(
    prompt,
    /one projects_bg_status call with a large waitSeconds/,
    "workers wait for long commands with one call, not by polling",
  );

// The ETA counts down inside the step in progress and keeps a minute for an overrun one.
{
  const step = (status, estimateMin, startedAt = null) => ({ title: status, status, estimateMin, startedAt, doneAt: null });
  assert.equal(planEta([step("doing", 20, 0), step("todo", 30)], 15 * 60_000).etaMin, 35, "ETA counts down within the doing step");
  assert.equal(planEta([step("doing", 20, 0)], 90 * 60_000).etaMin, 1, "an overrun step still has a minute left");
}

// ── Scripted model: the system prompt names the role, the last message decides the move.
const requests = [];
let quotaFailed = false;
let readerSaw = null;
let holdNextPrepare = false,
  nextHeld = false,
  releaseNext = false;
let holdUnavailable = false,
  unavailableHeld = false,
  unavailableRelease = false;
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
    if (user === "Hold owner response" || user === "Hold failed owner response") return call("gate", {});
    if (user.startsWith("Start ")) return spawn(user.slice(6), user.slice(6).toLowerCase());
    const lastInput = messages.findLast((message) => message.role === "user");
    const command = text(lastInput.content);
    if (command === "Hold failed owner response" && result)
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "scripted terminal failure" });
    if (command.startsWith("Send twice ")) {
      const sent = messages.slice(messages.lastIndexOf(lastInput) + 1).filter((message) => message.role === "toolResult").length;
      return sent < 2
        ? call("agents", { action: "send", id: command.slice("Send twice ".length), message: "Just a question", requestId: "tool-send-1" })
        : say("Sent once.");
    }
    if (user.startsWith("Report ")) {
      const [id, ref] = user.slice(7).split(" ");
      return call("agents", { action: "report", id, ...(ref ? { ref: Number(ref) } : {}) });
    }
    if (user.startsWith("Scout")) return call("agents", { action: "spawn", role: "scout", brief: "Look around", requestId: "scout-1" });
    // V1-V9 (jobs-failures.md): a reviewer reads a new revision in the same conversation.
    if (user.startsWith("Review ")) {
      return call("agents", {
        action: "spawn",
        role: "reviewer",
        brief: "BRIEF-REVREAD",
        readRef: user.slice(7),
        requestId: `rev-${user.slice(7)}`,
      });
    }
    if (user.startsWith("Resend ")) {
      const [id, ref, requestId] = user.slice(7).split(" ");
      return call("agents", {
        action: "send",
        id,
        message: "Read it again",
        ...(ref === "-" ? {} : { readRef: ref }),
        ...(requestId ? { requestId } : {}),
      });
    }
    if (user.startsWith("Stopit ")) return call("agents", { action: "stop", id: user.slice(7), reason: "test stop" });
    if (user.startsWith("WorkerRef ")) {
      return call("agents", {
        action: "spawn",
        role: "worker",
        title: "Job WREF",
        brief: "BRIEF-WREF",
        acceptance: ["x"],
        readRef: user.slice(10),
        requestId: "wref",
      });
    }
    if (user.startsWith("Race ")) {
      const [id, first, second] = user.slice(5).split(" ");
      const send = (ref) =>
        fauxToolCall("agents", { action: "send", id, message: "Read it again", readRef: ref, requestId: `race-${ref[0]}` });
      return fauxAssistantMessage([send(first), send(second)], { stopReason: "toolUse" });
    }
    if (user === "Spawn glued")
      return call("agents", { action: "spawn", role: "scout", brief: `Check ${GLUED} please`, requestId: "glued-scout" });
    if (user.startsWith("Send glued ")) return call("agents", { action: "send", id: user.slice(11), message: `Also ${GLUED}` });
    if (user.startsWith("Wait for ")) return call("agents", { action: "wait", id: user.slice(9), timeoutSec: 900 });
    return result ? say("OK.") : say("Noted.");
  }
  if (role === "worker") {
    if (tag === "BRIEF-BGWAIT") return result ? say("Done.") : call("projects_bg_status", {});
    if (tag === "BRIEF-GLUEDSUB") return result ? say("Done.") : call("subagent", { role: "scout", task: `Look at ${GLUED} closely` });
    if (user === "Replace helper result") return say("New short helper result.");
    if (user === "Replace Ready result")
      return call("job", {
        action: "ready",
        summary: "New Ready summary",
        pr: "12",
        candidate: sha,
        proof: ["new-proof"],
        review: "REVIEW-OK",
        gaps: [],
      });
    if (tag === "BRIEF-LONGHELPER" || tag === "BRIEF-LONGFAIL") return say(longAnswer);
    // Ready first, then a last reply held at the gate (the live A1 sequence).
    if (tag === "BRIEF-READYHOLD") {
      if (result.startsWith("Ready recorded")) return call("gate", {});
      if (result === "gate open") return say("Recorded.");
      return call("job", { action: "ready", summary: "Held", pr: "12", candidate: sha, proof: ["p"], review: "REVIEW-OK" });
    }
    if (tag === "BRIEF-LONGREADY" || tag === "BRIEF-LONGCHECKPOINT") {
      if (result.startsWith("Ready recorded") || result.startsWith("Checkpoint recorded")) return say("Recorded.");
      return call(
        "job",
        tag === "BRIEF-LONGREADY"
          ? {
              action: "ready",
              summary: longAnswer,
              pr: "12",
              candidate: sha,
              proof: ["long-proof"],
              review: "REVIEW-OK",
              gaps: ["Owner must choose the final storage location"],
            }
          : {
              action: "checkpoint",
              summary: "Stage held",
              proof: ["long-proof"],
              gaps: [longAnswer],
            },
      );
    }
    if (/BRIEF-BATCH/.test(user) && !messages.some((message) => message.role === "toolResult")) return call("gate", {});
    if (tag?.startsWith("BRIEF-BATCHREADY") && messages.some((message) => message.role === "toolResult")) {
      if (result.startsWith("Ready recorded")) return say("Shared Ready answer.");
      return call("job", {
        action: "ready",
        summary: "Shared Ready",
        pr: "12",
        candidate: sha,
        proof: ["batch proof"],
        review: "REVIEW-OK",
      });
    }
    if (tag === "BRIEF-BATCHFAIL" && messages.some((message) => message.role === "toolResult"))
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Billing conflict" });
    if (tag === "BRIEF-BATCHQUOTA" && messages.some((message) => message.role === "toolResult")) {
      if (!quotaFailed) {
        quotaFailed = true;
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota" });
      }
      return say("Recovered once.");
    }
    if (tag === "BRIEF-BATCHOK" && messages.some((message) => message.role === "toolResult")) return say("Shared answer.");
    // R1-R7: the review budget, step by step; each step's tool answer is the next request's result.
    if (tag === "BRIEF-BUDGET") {
      if (user === "Recheck once more") return call("subagent", { role: "reviewer", kind: "recheck", task: "REVIEW" });
      const lastUser = text(messages.findLast((message) => message.role === "user").content);
      if (lastUser === "Recheck once more") return say("Reported the open findings.");
      const step = BUDGET_STEPS[messages.filter((message) => message.role === "toolResult").length];
      return step ? call(...step) : say("Budget spent.");
    }
    if (tag === "BRIEF-CONT") {
      const done = messages.filter((message) => message.role === "toolResult").map((message) => text(message.content));
      const step = CONTINUE_STEPS[done.length];
      return step ? call(...step(done)) : say("Continued.");
    }
    if (tag === "BRIEF-CONTOTHER") {
      const results = messages.filter((message) => message.role === "toolResult").length;
      if (results === 0) return call("job", { action: "candidate", sha: setWorktree(REV_B) });
      if (results === 1) return call("subagent", { role: "reviewer", kind: "full", task: "BRIEF-CONTX own review" });
      if (results === 2) return call(...recheck("borrow", continuedReviewer));
      return say("Borrow refused.");
    }
    if (tag === "BRIEF-REFUND") {
      const step = REFUND_STEPS[messages.filter((message) => message.role === "toolResult").length];
      return step ? call(...step) : say("Reviewed.");
    }
    if (tag === "BRIEF-NOREPORT" && user.includes("BRIEF-NOREPORT")) return say("Should I keep the old API or remove it?");
    if (tag?.startsWith("BRIEF-PARKED") && user.includes("BRIEF-PARKED")) return say("Which storage should I use?");
    if (user === "Hold helper response") return call("gate", {});
    if (tag === "BRIEF-HELPER" && user.includes("BRIEF-HELPER"))
      return call("subagent", { role: "reviewer", kind: "full", task: "REVIEW" });
    if (tag === "BRIEF-HELPER" && result.startsWith("Task helpers cannot")) return say("Helper could not get a review.");
    if (tag === "BRIEF-HELPER") return say("Helper changed files, checked them, and returned findings.");
    if (tag === "BRIEF-CHECKPOINT" && (user.includes("BRIEF-CHECKPOINT") || result.startsWith("Checkpoint recorded"))) {
      if (result.startsWith("Checkpoint recorded")) return say("Checkpoint details retained in my transcript.");
      return call("job", {
        action: "checkpoint",
        summary: "Media fix held for the owner's storage decision",
        proof: ["artifact:worker/media-fix/CHECKPOINT.md"],
        gaps: ["Nine videos need approved reachable storage"],
      });
    }
    if (user === "Continue checkpoint")
      return call("job", {
        action: "ready",
        summary: "Storage decision applied",
        pr: "12",
        candidate: sha,
        proof: ["final proof"],
        review: "REVIEW-OK",
      });
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
    if (user === "Race follow-up") {
      gateOpen = false;
      return call("gate", {});
    }
    if (tag === "BRIEF-RACE" && result === "gate open")
      return say(
        messages.some((message) => message.role === "user" && text(message.content) === "Race follow-up")
          ? "Follow-up closing answer."
          : "Initial closing answer.",
      );
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
        role: "scout",
        task: { SLOW: "SLOW-CHECK", SILENT: "SILENT", QUEUEDSILENT: "SILENT", BUSY: "BUSY" }[tag.slice(6)] ?? "CHECK",
      });
    if (result === "PASS") return call("subagent", { role: "reviewer", kind: "full", task: "REVIEW" });
    if (result === "REVIEW-OK")
      return call("job", { action: "ready", summary: "Built it", pr: "12", candidate: sha, proof: ["checks PASS"], review: "REVIEW-OK" });
    if (tag === "BRIEF-RACE" && result.startsWith("Ready recorded")) return call("gate", {});
    return say("Done.");
  }
  if (role === "scout" && CHECKS.has(text(messages.find((message) => message.role === "user").content))) {
    if (user === "SLOW-CHECK" || user === "SILENT") return call("slow", {});
    if (user === "BUSY") return call("step", { n: 1 });
    if (result === "process advanced") return finishSlow ? say("PASS") : call("slow", {});
    if (result.startsWith("step ")) return Number(result.slice(5)) < 12 ? call("step", { n: Number(result.slice(5)) + 1 }) : say("PASS");
    return say("PASS");
  }
  if (role === "reviewer" && user.endsWith("REVIEW-FAIL"))
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "scripted reviewer failure" });
  if (role === "reviewer" && tag === "BRIEF-REVREAD") return say(`SAW ${readerSaw}`);
  if (role === "reviewer" && tag === "BRIEF-CONT")
    return say(`TURNS ${messages.filter((message) => message.role === "user").length}; LAST ${user.slice(0, 400)}`);
  return say(user === "LONG-SCOUT" ? longAnswer : role === "reviewer" ? "REVIEW-OK" : "Scouted.");
}

// ── Host tools standing in for the project's: a gate, a silent blocking "process", and a chatty step.
const processes = new Set();
// Titles whose prepare step is held open, and the ones that have entered it.
const prepareFirstHeld = new Set();
const prepareHeld = new Set(),
  prepareEntered = new Set(),
  prepareRuns = [];
let gateOpen = false,
  gateEntered = false,
  abortDrainHeld = false,
  abortEntered = false,
  bootId = "boot-A",
  backgroundSilenceMs = null,
  slowCycle = 0,
  releasedSlowCycle = 0,
  finishSlow = false,
  bgWaiting = false,
  bgReleased = false;
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
        if (callContext.abortSignal?.aborted) {
          abortEntered = true;
          while (abortDrainHeld) await delay(20);
        }
        return { output: [{ type: "text", text: "gate open" }] };
      },
    }),
    defineTool({
      name: "slow",
      description: "A silent background process",
      parameters: Type.Object({}),
      execute: async (_args, api, callContext) => {
        processes.add(api.conversationId);
        const cycle = ++slowCycle;
        while (!callContext.abortSignal?.aborted && releasedSlowCycle < cycle) await delay(20);
        return { output: [{ type: "text", text: callContext.abortSignal?.aborted ? "aborted" : "process advanced" }] };
      },
    }),
    // Stands in for a long background wait (agent-signals-failures.md W1, W2): blocks until released or aborted.
    defineTool({
      name: "projects_bg_status",
      description: "A long background wait",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, _api, callContext) => {
        bgWaiting = true;
        while (!bgReleased && !callContext.abortSignal?.aborted) await delay(20);
        bgWaiting = false;
        return { output: [{ type: "text", text: '{"state":"running"}' }] };
      },
    }),
    defineTool({
      name: "step",
      description: "A short step",
      parameters: Type.Object({ n: Type.Number() }),
      replay: "safe",
      execute: async (args) => {
        await delay(60);
        return { output: [{ type: "text", text: `step ${args.n}` }] };
      },
    }),
  ],
});

const models = createModels();
const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 600 }, () => route));

const approvedHooks = [];
async function open() {
  const killed = [];
  const jobs = createJobs({
    boot: bootId,
    quotaRetryBaseMs: 60,
    fallbackModel: ({ failure }) =>
      failure === "quota_exceeded" ? { change: { model: { provider: "faux", modelId: "faux-2" } }, label: "faux/faux-2" } : null,
    agentChange: ({ role }) => ({
      model,
      instructions: `ROLE:${role}`,
      extensions: role === "scout" || role === "worker" ? [TestTools] : [],
    }),
    killProcesses: async (ids) => {
      killed.push(...ids);
      for (const id of ids) processes.delete(id);
    },
    prepare: async ({ agent, seq }) => {
      if (agent.title === "BRIEF-REVREAD") {
        const read = readRevision(agent, seq);
        if (holdNextPrepare) {
          holdNextPrepare = false;
          nextHeld = true;
          while (!releaseNext) await delay(20);
        }
        if (read?.sha === UNAVAILABLE) {
          // The first preparation of an unavailable commit stays open until the test restarts the host.
          if (holdUnavailable) {
            holdUnavailable = false;
            unavailableHeld = true;
            while (!unavailableRelease) await delay(20);
          }
          throw new Error(`Commit ${read.sha} is not in the local repository`);
        }
        readerSaw = read?.sha ?? null;
      }
      if (agent.title === "LONGPREPFAIL") throw new Error(longAnswer);
      if (agent.title === "Job STARTFAIL") {
        while (prepareHeld.has(agent.title)) await delay(20);
        throw new Error("Workspace grant is missing");
      }
      prepareEntered.add(agent.title);
      const first = !prepareRuns.includes(agent.id);
      prepareRuns.push(agent.id);
      while (prepareHeld.has(agent.title) || (first && prepareFirstHeld.has(agent.title))) await delay(20);
    },
    approver: { approve: async () => ({ kind: "auto-merge-pending" }) },
    afterApproved: (id) => approvedHooks.push(id),
    backgroundSilence: () => backgroundSilenceMs,
    stallMinutes: () => 20,
    reviewRechecks: () => 2,
    confirmRevision: async () =>
      worktree.unreadable || !worktree.head
        ? { refusal: "The checkout's HEAD cannot be read" }
        : worktree.dirty
          ? { refusal: "The checkout has uncommitted changes" }
          : { sha: worktree.head },
  });
  const registry = createRegistry();
  registry.install(TestTools);
  jobs.install(registry);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "session.sqlite")),
    { models, registry, settings: { followUpMode: "all", steeringMode: "all", retry: { maxRetries: 0 } } },
    context,
  );
  jobs.attach(harness);
  harness.resume();
  const root = await harness.root(context, {
    agent: { model, instructions: "ROLE:coordinator", extensions: [jobs.coordinator, TestTools] },
  });
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

// Old-host bootstrap: a new owner input advances a kept queue without withdrawing or replaying it.
const failedOwner = await root.submit({ type: "input", content: "Hold failed owner response" }, context);
await until(() => gateEntered, "failing owner turn inside gate");
const parkedOwner = await root.submit(
  { type: "input", content: "Parked owner message", whenBusy: "followUp", requestId: "parked-owner" },
  context,
);
gateOpen = true;
assert.equal((await failedOwner.wait(context)).reason, "model_error");
assert.equal((await parkedOwner.status(context)).status, "queued", "the old default keeps failed-run follow-ups queued");
assert.equal(await jobs.busy(harness), true, "parked real owner work protects deployment even with no placed input");
const recoveryOwner = await root.submit({ type: "input", content: "Recover parked owner message", requestId: "recover-owner" }, context);
const recovered = await parkedOwner.wait(context);
assert.equal(recovered.status, "done");
assert.equal((await recoveryOwner.wait(context)).answer, recovered.answer, "one answer settles both actual owner inputs");
assert.equal((await failedOwner.status(context)).reason, "model_error", "recovery does not replay the failed input");
assert.equal((await chatText(root)).filter((line) => line === "Parked owner message").length, 1);
await quiet(harness);
gateOpen = false;
gateEntered = false;

// 1. Spawn, plan, checking scout + reviewer, full Ready report; a retried spawn returns the same agent.
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
assert.equal(
  (await root.entries({}, 200, undefined, context)).items.find(
    (entry) => entry.model?.[0]?.role === "user" && text(entry.model[0].content) === report[0],
  ).kind,
  "projects.internal-input",
  "Ready reports carry machine provenance",
);
for (const part of ["Candidate: " + sha, "PR: 12", "Summary: Built it", "Gaps: none", "agents report"])
  assert.ok(report[0].includes(part), `concise handback carries ${part}`);
for (const part of ["checks PASS", "REVIEW-OK", "Done.", "Worker's closing message:"])
  assert.ok(!report[0].includes(part), `wakeup does not repeat detailed evidence or closing text: ${part}`);
const workerCallsBeforeReport = requests.filter((item) => item.role === "worker").length;
await say_(root, `Report ${job.id}`);
await quiet(harness);
const fullReady = requests.findLast((item) => item.role === "coordinator" && item.result.includes("checks PASS"))?.result;
for (const part of ["checks PASS", "Review: REVIEW-OK", "Done.", "Cumulative time:", "Cumulative cost:", "Answer ref:"])
  assert.ok(
    fullReady?.includes(part),
    `on-demand report retains ${part}: ${requests.filter((item) => item.role === "coordinator").at(-1)?.result}`,
  );
assert.equal(requests.filter((item) => item.role === "worker").length, workerCallsBeforeReport, "reading a report never wakes the worker");
const snapshot = await jobs.snapshot(harness);
assert.equal(snapshot.jobs[0].working, false);
assert.equal(requests.filter((item) => item.role === "scout" && CHECKS.has(item.user)).length, 1);
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

// 4. A worker waiting on its active child is not stalled; a silent one is, once.
const before = (await chatText(root)).length;
await say_(root, "Start BUSY");
await until(() => requests.some((item) => item.role === "scout" && item.user === "BUSY"), "busy checking scout started");
const T = 1_000_000_000;
backgroundSilenceMs = 30 * 60_000;
assert.deepEqual(await jobs.stallTick(harness, T), [], "a quiet service alone does not wake the coordinator");
await delay(300);
assert.deepEqual(await jobs.stallTick(harness, T + 21 * 60_000), [], "child progress wins over an old quiet service");
backgroundSilenceMs = null;
await quiet(harness);
await say_(root, "Start SILENT");
await until(() => processes.size === 1, "silent process started");
assert.deepEqual(await jobs.stallTick(harness, T), []);
const silent = (await jobsOf(harness)).find((item) => item.title === "Job SILENT");
assert.deepEqual(await jobs.stallTick(harness, T + 21 * 60_000), [silent.id]);
assert.deepEqual(await jobs.stallTick(harness, T + 30 * 60_000), [], "one notice per stall");
await until(async () => (await chatText(root)).some((line) => line.startsWith(`[worker ${silent.id} stalled`)), "stall notice in chat");
assert.equal((await chatText(root)).filter((line) => line.includes("stalled")).length, 1);
assert.equal(
  (await root.entries({}, 200, undefined, context)).items.find(
    (entry) => entry.model?.[0]?.role === "user" && text(entry.model[0].content).startsWith(`[worker ${silent.id} stalled`),
  ).kind,
  "projects.internal-input",
  "stall notices carry machine provenance",
);
assert.ok((await chatText(root)).slice(before).every((line) => !line.includes(`[worker ${silent.id} ready`)));
const stalledCalls = requests.filter((item) => item.role === "coordinator" && item.user.includes(`[worker ${silent.id} stalled`)).length;
for (const minute of [77, 83, 90, 94, 99]) {
  await jobs.steer(harness, silent.id, `New diagnostic instruction ${minute}`);
  assert.deepEqual(await jobs.stallTick(harness, T + minute * 60_000), [], "a steer does not rearm the unchanged blocked execution");
}
await delay(100);
assert.equal(
  requests.filter((item) => item.role === "coordinator" && item.user.includes(`[worker ${silent.id} stalled`)).length,
  stalledCalls,
  "unchanged stalls do not invoke the coordinator again",
);
const previousCycle = slowCycle;
releasedSlowCycle = previousCycle;
await until(() => slowCycle > previousCycle, "the child makes real progress and starts another bounded operation");
assert.deepEqual(await jobs.stallTick(harness, T + 100 * 60_000), [], "real progress clears the old episode");
assert.deepEqual(await jobs.stallTick(harness, T + 121 * 60_000), [silent.id], "a genuinely new stall is reported after recovery");

// 4b. A worker inside a long background wait is judged by its background command (agent-signals-failures.md W1, W2); the
// Coordinator's agents wait ends when a message is queued for it (Q8).
{
  await say_(root, "Start BGWAIT");
  await until(() => bgWaiting, "worker inside the background wait");
  const waiter = (await jobsOf(harness)).find((item) => item.title === "Job BGWAIT");
  const T2 = T + 300 * 60_000;
  backgroundSilenceMs = 60_000;
  assert.deepEqual(await jobs.stallTick(harness, T2), []);
  assert.deepEqual(await jobs.stallTick(harness, T2 + 21 * 60_000), [], "W1 a wait on a printing command is not a stall");
  backgroundSilenceMs = 21 * 60_000;
  assert.deepEqual(await jobs.stallTick(harness, T2 + 42 * 60_000), [waiter.id], "W2 a wait on a silent command is a stall");
  backgroundSilenceMs = null;

  const waitTurn = await root.submit({ type: "input", content: `Wait for ${waiter.id}` }, context);
  await until(
    async () =>
      ((await harness.snapshot(LiveDoc, root.id, context))?.tools ?? []).some(
        (slot) => slot.name === "agents" && slot.status === "running",
      ),
    "the coordinator waits on the worker",
  );
  const steerAt = Date.now();
  await root.submit({ type: "input", content: "Owner steer while waiting", whenBusy: "steer" }, context);
  await Promise.race([waitTurn.wait(context), delay(15_000).then(() => assert.fail("Q8 a queued owner message ends agents wait early"))]);
  assert.ok(Date.now() - steerAt < 8000, "Q8 a queued owner message ends agents wait early");
  // The steer is placed right after the result, so the result is read from the transcript.
  const waited = text(
    (await root.entries({}, 20, undefined, context)).items.find((entry) => entry.model?.[0]?.role === "toolResult")?.model[0].content ?? "",
  );
  assert.match(waited, /still working/);
  assert.match(waited, /message/i, waited);
  assert.doesNotMatch(waited, /\[warn\]/, "a call without glued words carries no warning");
  await jobs.stop(harness, waiter.id, "test over");
  await until(() => !bgWaiting, "the stopped worker left its wait");
}

// 5. Stop drains the worker and its child, kills the process, and reports nothing.
await assert.rejects(async () => jobs.stop(harness, silent.id, " "), /reason/);
const sizeBefore = (await chatText(root)).length;
await jobs.stop(harness, silent.id, "owner asked");
const stopped = (await jobsOf(harness)).find((item) => item.id === silent.id);
assert.equal(stopped.status, "stopped");
assert.equal(stopped.reason, "owner asked");
assert.equal(processes.size, 0, "the background process was killed");
assert.ok(killed.length >= 2, "the worker and its child were passed to the process killer");
await quiet(harness);
assert.ok(
  !(await chatText(root)).slice(sizeBefore).some((line) => line.includes(silent.id) && !line.includes("stalled")),
  "a stopped Job reports nothing",
);
assert.match(await jobs.stop(harness, silent.id, "again"), /already stopped/);

// G6: glued words in a brief, a steer or a subagent task are delivered, and the sender's result warns; a clean send does not.
{
  const warned = (result) => result.includes("[warn]") && result.includes(GLUED.slice(0, 40)) && /normal spacing/i.test(result);
  await say_(root, "Spawn glued");
  await quiet(harness);
  const spawnResult =
    requests.findLast((item) => item.role === "coordinator" && item.user === "" && item.result.includes("[warn]"))?.result ?? "";
  assert.ok(warned(spawnResult), `the spawn result warns: ${spawnResult}`);
  assert.ok(
    requests.some((item) => item.role === "scout" && item.user.includes(GLUED)),
    "the scout got the brief unchanged",
  );
  const scout = (await jobs.snapshot(harness)).agents.find((item) => item.role === "scout" && item.title.startsWith("Check "));
  await say_(root, `Send glued ${scout.id}`);
  await quiet(harness);
  const sendResult = requests.findLast((item) => item.role === "coordinator" && item.result.startsWith("Sent to"))?.result ?? "";
  assert.ok(warned(sendResult), `the send result warns: ${sendResult}`);
  assert.ok(
    requests.some((item) => item.role === "scout" && item.user === `Also ${GLUED}`),
    "the steer was delivered unchanged",
  );
  await say_(root, "Start GLUEDSUB");
  await quiet(harness);
  const subResult = requests.findLast((item) => item.role === "worker" && item.tag === "BRIEF-GLUEDSUB" && item.result)?.result ?? "";
  assert.ok(warned(subResult), `the subagent result warns: ${subResult}`);
  assert.ok(
    requests.some((item) => item.role === "scout" && item.user === `Look at ${GLUED} closely`),
    "the subagent got its task",
  );
}

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

// 6b. The initial closing answer cannot settle a worker after a follow-up has been queued.
gateOpen = false;
gateEntered = false;
await say_(root, "Start RACE");
await until(() => gateEntered, "initial Ready answer held open");
const race = (await jobsOf(harness)).find((item) => item.title === "Job RACE");
await jobs.steer(harness, race.id, "Race follow-up", true);
gateOpen = true;
await until(
  () => requests.some((item) => item.role === "worker" && item.tag === "BRIEF-RACE" && item.user === "Race follow-up"),
  "queued follow-up started",
);
assert.equal(
  (await harness.snapshot(Jobs, (await harness.root(context)).id, context)).agents[race.id].endedAt,
  null,
  "the initial reporter leaves the worker live for its follow-up",
);
gateOpen = true;
await quiet(harness);
assert.equal((await jobsOf(harness)).find((item) => item.id === race.id).status, "ready");

// 6c. Steers sharing one turn settle once and recover once, rather than waking the coordinator per input.
for (const name of ["BATCHFAIL", "BATCHOK", "BATCHQUOTA"]) {
  gateOpen = false;
  gateEntered = false;
  await say_(root, `Start ${name}`);
  await until(() => gateEntered, `${name} inside the gate`);
  const batch = (await jobsOf(harness)).find((item) => item.title === `Job ${name}`);
  const conversation = await harness.conversation(batch.workerConversation, context);
  await jobs.steer(harness, batch.id, "Shared steer one");
  await jobs.steer(harness, batch.id, "Shared steer two");
  await until(
    async () => (await harness.inspect(context)).submissions.filter((item) => item.conversationId === conversation.id).length === 3,
    "all three inputs admitted before opening the gate",
  );
  gateOpen = true;
  await quiet(harness);
  const reports = (await chatText(root)).filter((line) => line.startsWith(`[worker ${batch.id} `));
  const record = (await harness.snapshot(Jobs, root.id, context)).agents[batch.id];
  const ended = (await jobsOf(harness)).find((item) => item.id === batch.id);
  assert.equal(reports.length, 1, `${name}: one report for a shared turn`);
  assert.notEqual(record.endedAt, null, `${name}: the shared answer settles the latest send`);
  assert.equal(
    ended.status,
    name === "BATCHFAIL" ? "failed" : "checkpoint",
    `${name}: a model failure fails; an answer without Ready is settled as a checkpoint`,
  );
  if (name === "BATCHQUOTA") {
    assert.equal(record.quota, null, "quota recovery ended");
    assert.equal(record.modelMoves.length, 1, "one fallback move for the shared failure");
    assert.equal(record.modelMoves[0].to, "faux/faux-2");
    const inputs = (await conversation.entries({}, 100, undefined, context)).items.filter((entry) => entry.model?.[0]?.role === "user");
    assert.equal(inputs.length, 4, "one recovery input for a shared quota failure");
  }
}

// Shared Ready answers retain their full report whether the oldest or newest reporter reaches it first.
for (const name of ["BATCHREADYOLD", "BATCHREADYNEW"]) {
  gateOpen = false;
  gateEntered = false;
  if (name.endsWith("NEW")) prepareFirstHeld.add(`Job ${name}`);
  await say_(root, `Start ${name}`);
  const batch = (await jobsOf(harness)).find((item) => item.title === `Job ${name}`);
  if (name.endsWith("OLD")) await until(() => gateEntered, "oldest reporter submitted first");
  await jobs.steer(harness, batch.id, "Shared Ready steer");
  await until(() => gateEntered, "shared Ready worker inside gate");
  prepareFirstHeld.delete(`Job ${name}`);
  await until(
    async () =>
      (await harness.inspect(context)).submissions.filter((item) => item.conversationId === batch.workerConversation).length === 2,
    "both Ready inputs admitted",
  );
  const firstInput = (await (await harness.conversation(batch.workerConversation, context)).entries({}, 20, undefined, context)).items
    .toReversed()
    .find((entry) => entry.model?.[0]?.role === "user");
  assert.equal(
    text(firstInput.model[0].content).includes("Shared Ready steer"),
    name.endsWith("NEW"),
    "reporter registration order is controlled",
  );
  gateOpen = true;
  await quiet(harness);
  const reports = (await chatText(root)).filter((line) => line.startsWith(`[worker ${batch.id} `));
  assert.equal(reports.length, 1, `${name}: one shared Ready report`);
  assert.match(reports[0], new RegExp(`^\\[worker ${batch.id} ready:`), `${name}: the latest full Ready report wins`);
  for (const part of ["Summary: Shared Ready", "PR: 12", `Candidate: ${sha}`, "agents report"])
    assert.ok(reports[0].includes(part), `${name}: concise report carries ${part}`);
  await say_(root, `Report ${batch.id}`);
  await quiet(harness);
  const details = requests.findLast((item) => item.role === "coordinator" && item.result.includes("batch proof"))?.result;
  for (const part of ["batch proof", "Review: REVIEW-OK", "Shared Ready answer."])
    assert.ok(details?.includes(part), `${name}: detailed report retains ${part}`);
  assert.notEqual((await harness.snapshot(Jobs, root.id, context)).agents[batch.id].endedAt, null);
}

// 6d. The coordinator tool uses the same request-id deduplication as host steers.
const toolSendsBefore = (await harness.snapshot(Jobs, root.id, context)).agents[job.id].sends;
await say_(root, `Send twice ${job.id}`);
await quiet(harness);
assert.equal(
  (await harness.snapshot(Jobs, root.id, context)).agents[job.id].sends,
  toolSendsBefore + 1,
  "tool send request id delivers once",
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
assert.equal(await jobs.busy(harness), true, "paused agent preparation still protects deployment until it drains");
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
assert.deepEqual(approvedHooks, [], "R14 no cleanup before the Job is approved");
await jobs.finishApproval(harness, job.id, { kind: "accepted", head: sha }, "Merged aaaaaaaa.");
assert.equal((await jobsOf(harness)).find((item) => item.id === job.id).status, "approved");
assert.deepEqual(approvedHooks, [job.id], "R14 an approved Job starts the cleanup once");
await until(async () => (await chatText(root)).some((line) => line.startsWith(`[worker ${job.id} approve`)), "approve notice in chat");

assert.equal(
  (await root.entries({}, 200, undefined, context)).items.find(
    (entry) => entry.model?.[0]?.role === "user" && text(entry.model[0].content).startsWith(`[worker ${job.id} approve`),
  ).kind,
  "projects.internal-input",
  "approval notices carry machine provenance",
);
// Task helpers return normally, retain their workspace choice on follow-up, and cannot be approved.
const helperSpawn = await jobs.spawn(root, root.id, {
  role: "worker",
  title: "Task helper",
  brief: "BRIEF-HELPER",
  acceptance: ["return findings"],
  workspace: { kind: "shared" },
  requestId: "task-helper",
});
await quiet(harness);
let helper = (await jobsOf(harness)).find((item) => item.id === helperSpawn.id);
assert.equal(helper.status, "completed", "a task helper's ordinary answer completes execution without Ready or PR");
assert.deepEqual(
  helper.children.map((child) => child.role),
  ["reviewer"],
  "a task helper starts its own reviewer with subagent",
);
assert.deepEqual(helper.workspace, { kind: "shared" });
assert.equal(helper.pr, null);
assert.equal(helper.ready, null);
assert.match((await jobs.approve(harness, helper.id)).refused, /task helper/i);
await jobs.steer(harness, helper.id, "Continue the same task");
await quiet(harness);
helper = (await jobsOf(harness)).find((item) => item.id === helper.id);
assert.equal(helper.status, "completed");
assert.deepEqual(helper.workspace, { kind: "shared" }, "follow-ups preserve the selected workspace");
const helperReports = (await chatText(root)).filter((line) => line.startsWith(`[worker ${helper.id} completed`));
assert.equal(helperReports.length, 2, "each settled helper answer reports once");
for (const part of ["shared", "Candidate: none", "Cumulative time:", "Cumulative cost:", "Helper changed files"])
  assert.ok(helperReports[0].includes(part));

// Pausing retains helper identity, but deployment waits for the actual abort drain.
gateOpen = false;
gateEntered = false;
abortEntered = false;
abortDrainHeld = true;
await jobs.steer(harness, helper.id, "Hold helper response");
await until(() => gateEntered, "helper inside abort gate");
assert.equal(await jobs.busy(harness), true, "running helper protects deployment");
const pausing = jobs.pause(harness);
await until(() => abortEntered, "helper abort draining");
assert.equal((await jobs.snapshot(harness)).paused, true);
assert.equal(await jobs.busy(harness), true, "paused is not idle while abort drains");
abortDrainHeld = false;
await pausing;
await root.abort(context, { background: true });
await quiet(harness);
const retained = (await jobs.snapshot(harness)).jobs.find((item) => item.id === helper.id);
assert.equal(retained.status, "running", "pause preserves resumable helper status");
assert.equal((await jobs.snapshot(harness)).agents.find((item) => item.id === helper.id).endedAt, null);
assert.equal(await jobs.busy(harness), false, "fully drained paused helper is deployment idle");
assert.deepEqual(retained.workspace, { kind: "shared" });
await jobs.resume(harness);
await quiet(harness);
assert.equal((await jobsOf(harness)).find((item) => item.id === helper.id).status, "completed", "resume reuses helper identity");

// Long notifications remain bounded previews; the exact full handback is read on demand, never lost.
for (const [name, role, workspace, status] of [
  ["LONGHELPER", "worker", { kind: "shared" }, "completed"],
  ["LONGSCOUT", "scout", undefined, "answered"],
  ["LONGPREPFAIL", "scout", undefined, "failed to start"],
  ["LONGFAIL", "worker", undefined, "checkpoint"],
  ["LONGREADY", "worker", undefined, "ready-with-gaps"],
  ["LONGCHECKPOINT", "worker", undefined, "checkpoint"],
]) {
  const started = await jobs.spawn(root, root.id, {
    role,
    title: name,
    brief: role === "scout" ? "LONG-SCOUT" : `BRIEF-${name}`,
    acceptance: ["return findings"],
    ...(workspace ? { workspace } : {}),
    requestId: name,
  });
  await quiet(harness);
  const notification = (await chatText(root)).find((line) => line.startsWith(`[${role} ${started.id} ${status}:`));
  assert.ok(notification, `${name}: actionable status arrives`);
  assert.ok(notification.length < 2400, `${name}: notification has a fixed size bound`);
  assert.match(notification, /Notification preview.*omitted/s, `${name}: omission is explicit, not authoritative evidence`);
  assert.ok(notification.includes(`agents report id=${started.id}`));
  const ref = /Report ref: (\d+)/.exec(notification)?.[1];
  assert.ok(ref, `${name}: notification carries an immutable report reference`);
  if (name === "LONGHELPER" || name === "LONGREADY") {
    await jobs.steer(harness, started.id, name === "LONGHELPER" ? "Replace helper result" : "Replace Ready result");
    await quiet(harness);
  }
  await say_(root, `Report ${started.id} ${ref}`);
  await quiet(harness);
  const details = requests.findLast((item) => item.role === "coordinator" && item.result.includes("END-OF-EXACT-ANSWER"))?.result;
  assert.ok(details?.includes(longAnswer), `${name}: full exact evidence remains retrievable after later reports`);
  if (name === "LONGREADY") {
    assert.ok(details?.includes("long-proof"), "the old Ready proof survives replacement");
    assert.ok(details?.includes("Owner must choose the final storage location"), "the old Ready gap survives replacement");
    assert.ok(!details?.includes("new-proof"), "historical Ready evidence is not mixed with the latest delivery");
  }
}

// A checkpoint ends a stage without delivery, failure, approval or automatic restart.
await say_(root, "Start CHECKPOINT");
await quiet(harness);
const checkpoint = (await jobsOf(harness)).find((item) => item.title === "Job CHECKPOINT");
assert.equal(checkpoint.status, "checkpoint", "held work is a checkpoint, not Ready or failed");
assert.equal(checkpoint.ready, null);
assert.ok(
  liveAgentIds(await harness.snapshot(Jobs, root.id, context)).includes(checkpoint.id),
  "checkpoint workspace stays owned even when the worker has stopped generating",
);
assert.equal(checkpoint.checkpoint.summary, "Media fix held for the owner's storage decision");
assert.match((await jobs.approve(harness, checkpoint.id)).refused, /checkpoint.*not ready/);
assert.equal((await chatText(root)).filter((line) => line.startsWith(`[worker ${checkpoint.id} checkpoint:`)).length, 1);
const checkpointCalls = requests.filter((item) => item.role === "worker" && item.tag === "BRIEF-CHECKPOINT").length;
await harness.close(context);
({ harness, root, jobs, killed } = await open());
await jobs.recover(harness);
await jobs.pause(harness);
await jobs.resume(harness);
await quiet(harness);
assert.equal(
  requests.filter((item) => item.role === "worker" && item.tag === "BRIEF-CHECKPOINT").length,
  checkpointCalls,
  "restart and project resume do not resume a checkpoint",
);
assert.equal((await jobsOf(harness)).find((item) => item.id === checkpoint.id).status, "checkpoint");
await say_(root, `Report ${checkpoint.id}`);
await quiet(harness);
const checkpointDetails = requests.findLast(
  (item) => item.role === "coordinator" && item.result.includes("artifact:worker/media-fix/CHECKPOINT.md"),
)?.result;
assert.ok(
  checkpointDetails?.includes("Checkpoint details retained in my transcript."),
  "checkpoint evidence and closing answer remain readable",
);
await jobs.steer(harness, checkpoint.id, "Continue checkpoint");
await quiet(harness);
const deliveredCheckpoint = (await jobsOf(harness)).find((item) => item.id === checkpoint.id);
assert.equal(deliveredCheckpoint.status, "ready", "an explicit instruction resumes the same worker to delivery");
assert.equal(deliveredCheckpoint.checkpoint, undefined, "a Ready delivery replaces the prior checkpoint");

// R1-R7 (jobs-failures.md): one full review round (up to three axis reviewers), then at most N re-checks, counted on the Job.
{
  await say_(root, "Start BUDGET");
  await quiet(harness);
  const budget = (await jobsOf(harness)).find((item) => item.title === "Job BUDGET");
  const results = requests.filter((item) => item.role === "worker" && item.tag === "BRIEF-BUDGET").map((item) => item.result);
  const after = (step) => results[step + 1];
  assert.match(after(0), /full review/i, "R3 a re-check needs a full review first");
  for (const step of [1, 2, 3]) assert.equal(after(step), "REVIEW-OK", `R1 axis reviewer ${step} of the full round runs`);
  assert.match(after(4), /full review round already/i, "R2 a fourth full reviewer is refused");
  assert.match(after(4), /job ready/, "R6 a refusal says how to finish");
  assert.equal(after(5), "Scouted.", "R7 a scout does not count");
  for (const step of [6, 7]) assert.equal(after(step), "REVIEW-OK", `R1 re-check ${step - 5} runs`);
  assert.match(after(8), /2 re-checks/, "R1 the third re-check is over the budget of 2");
  assert.match(after(8), /gaps/, "R6 the refusal sends the remaining findings to the Ready gaps");
  assert.match(after(9), /re-checks have started/i, "R2 no full review after the re-checks started");
  assert.equal(budget.status, "ready-with-gaps");
  assert.deepEqual(budget.reviews, { full: 3, rechecks: 2 }, "R1 one full round of three reviewers and two re-checks");
  assert.equal(budget.children.filter((child) => child.role === "reviewer").length, 5, "refused reviewers never start");
  await harness.close(context);
  ({ harness, root, jobs, killed } = await open());
  await jobs.steer(harness, budget.id, "Recheck once more");
  await quiet(harness);
  const refusal = requests.findLast((item) => item.role === "worker" && item.tag === "BRIEF-BUDGET").result;
  assert.match(refusal, /2 re-checks/, "R4 the spent budget survives a restart and a follow-up");
  assert.deepEqual((await jobsOf(harness)).find((item) => item.id === budget.id).reviews, { full: 3, rechecks: 2 });
}

// R9 (jobs-failures.md): a reviewer that never answered gives its place back; the full round still gets three answers.
{
  await say_(root, "Start REFUND");
  await quiet(harness);
  const refund = (await jobsOf(harness)).find((item) => item.title === "Job REFUND");
  const results = requests.filter((item) => item.role === "worker" && item.tag === "BRIEF-REFUND").map((item) => item.result);
  assert.match(results[1], /did not answer/, "R9 the failed reviewer reports that it did not answer");
  for (const step of [2, 3, 4]) assert.equal(results[step], "REVIEW-OK", `R9 full reviewer ${step - 1} runs after the failed one`);
  assert.match(results[5], /full review round already/i, "R9 answered reviewers still close the round");
  assert.equal(refund.status, "ready");
}

// C1-C3: a worker that ends its turn without a report becomes a checkpoint automatically, once, keeping its workspace.
{
  await say_(root, "Start NOREPORT");
  await quiet(harness);
  const held = (await jobsOf(harness)).find((item) => item.title === "Job NOREPORT");
  assert.equal(held.status, "checkpoint", "C1 no report is a checkpoint, not a failure");
  assert.equal(held.reason, null);
  assert.equal(held.checkpoint.auto, true, "C2 the checkpoint is marked automatic");
  assert.equal(held.checkpoint.summary, "Should I keep the old API or remove it?", "C2 the summary is the worker's final answer");
  assert.ok(liveAgentIds(await harness.snapshot(Jobs, root.id, context)).includes(held.id), "C2 the workspace stays owned");
  assert.match((await jobs.approve(harness, held.id)).refused, /checkpoint.*not ready/, "C2 no Approve");
  const notices = (await chatText(root)).filter((line) => line.startsWith(`[worker ${held.id} checkpoint:`));
  assert.equal(notices.length, 1, "C3 the Coordinator is notified once");
  assert.match(
    notices[0],
    /stopped without a Ready report.*waiting for a decision/s,
    "C2 the notice says the worker stopped without a report",
  );
  assert.ok(notices[0].includes("Should I keep the old API"), "C2 the notice carries the question");
  await jobs.steer(harness, held.id, "Continue checkpoint");
  await quiet(harness);
  assert.equal((await jobsOf(harness)).find((item) => item.id === held.id).status, "ready", "an answer resumes the same worker");
}

// I1-I7 (jobs-failures.md "Waiting workers wake the Coordinator"): an idle chat whose workers wait in checkpoint is woken once per waiting set.
{
  for (const job of await jobsOf(harness)) if (job.status === "checkpoint" && !job.dismissedAt) await jobs.dismiss(harness, job.id);
  const W = T + 1000 * 60_000,
    minute = 60_000;
  const wakes = async () => (await chatText(root)).filter((line) => line.startsWith("[waiting"));
  await say_(root, "Start PARKED");
  await quiet(harness);
  const parked = (await jobsOf(harness)).find((item) => item.title === "Job PARKED");
  assert.equal(parked.status, "checkpoint");
  assert.deepEqual(await jobs.waitingTick(harness, W), [], "I4 no wake as the turn ends");
  assert.deepEqual(await jobs.waitingTick(harness, W + 4 * minute), [], "I4 the owner gets a few minutes first");
  assert.deepEqual(await jobs.waitingTick(harness, W + 6 * minute), [root.id], "I1 a parked worker wakes the idle Coordinator");
  await quiet(harness);
  const [wake] = await wakes();
  assert.ok(wake?.includes(parked.id) && wake.includes("Job PARKED"), "I1 the wake names the waiting worker");
  const notWaiting = (await jobsOf(harness)).filter((item) => item.status === "ready" || item.workspace || item.dismissedAt);
  assert.ok(notWaiting.length && notWaiting.every((item) => !wake.includes(item.id)), "I5 Ready, helper and dismissed Jobs do not wait");
  assert.deepEqual(await jobs.waitingTick(harness, W + 20 * minute), [], "I2 an answered wake does not repeat");
  assert.deepEqual(await jobs.waitingTick(harness, W + 40 * minute), [], "I2 nor on a later tick");
  await harness.close(context);
  ({ harness, root, jobs, killed } = await open());
  await jobs.recover(harness);
  assert.deepEqual(await jobs.waitingTick(harness, W + 41 * minute), []);
  assert.deepEqual(await jobs.waitingTick(harness, W + 60 * minute), [], "I2 nor after a restart");
  assert.equal((await wakes()).length, 1);

  // A new answer from the same worker is a new waiting set; a busy Coordinator holds it.
  await jobs.steer(harness, parked.id, "Still unsure");
  await quiet(harness);
  gateOpen = false;
  gateEntered = false;
  const busyOwner = await root.submit({ type: "input", content: "Hold owner response" }, context);
  await until(() => gateEntered, "coordinator busy with the owner");
  assert.deepEqual(await jobs.waitingTick(harness, W + 61 * minute), []);
  assert.deepEqual(await jobs.waitingTick(harness, W + 90 * minute), [], "I3 a busy Coordinator is not woken");
  gateOpen = true;
  await busyOwner.wait(context);
  await quiet(harness);
  assert.deepEqual(await jobs.waitingTick(harness, W + 91 * minute), []);
  assert.deepEqual(await jobs.waitingTick(harness, W + 97 * minute), [root.id], "I7 a new checkpoint answer wakes again");
  await quiet(harness);
  assert.equal((await wakes()).length, 2);

  // A running Job of the same chat will report, so it holds the wake.
  await say_(root, "Start PARKEDB");
  await quiet(harness);
  const other = (await jobsOf(harness)).find((item) => item.title === "Job PARKEDB");
  assert.equal(other.status, "checkpoint");
  gateOpen = false;
  gateEntered = false;
  await jobs.steer(harness, other.id, "Hold helper response");
  await until(() => gateEntered, "PARKEDB holds at the gate");
  assert.deepEqual(await jobs.waitingTick(harness, W + 98 * minute), []);
  assert.deepEqual(await jobs.waitingTick(harness, W + 130 * minute), [], "I3 a running Job of the chat holds the wake");
  gateOpen = true;
  await quiet(harness);
  assert.equal((await jobsOf(harness)).find((item) => item.id === other.id).status, "ready");

  // A paused project wakes nobody; the wake comes after the resume.
  await jobs.steer(harness, parked.id, "Still unsure");
  await quiet(harness);
  await jobs.pause(harness);
  assert.deepEqual(await jobs.waitingTick(harness, W + 131 * minute), []);
  assert.deepEqual(await jobs.waitingTick(harness, W + 160 * minute), [], "I6 a paused project is not woken");
  await jobs.resume(harness);
  await quiet(harness);
  assert.deepEqual(await jobs.waitingTick(harness, W + 161 * minute), []);
  assert.deepEqual(await jobs.waitingTick(harness, W + 167 * minute), [root.id], "I6 the wake follows the resume");
  await quiet(harness);
  await jobs.dismiss(harness, parked.id);
}

// S1: a failure while preparing the worker reads "did not start", apart from a model failure.
{
  await say_(root, "Start STARTFAIL");
  await quiet(harness);
  const notStarted = (await jobsOf(harness)).find((item) => item.title === "Job STARTFAIL");
  assert.equal(notStarted.status, "failed");
  assert.equal(notStarted.failure, "start", "S1 a preparation failure has its own kind");
  assert.equal(notStarted.reason, "Did not start: Workspace grant is missing");
  assert.ok(
    (await chatText(root)).some((line) => line.startsWith(`[worker ${notStarted.id} failed to start:`) && line.includes("Did not start")),
    "S1 the report says it did not start",
  );
  const runFailure = (await jobsOf(harness)).find((item) => item.title === "Job BATCHFAIL");
  assert.equal(runFailure.failure, "run", "S1 a model failure is a run failure");
  prepareHeld.add("Job STARTFAIL");
  await jobs.steer(harness, notStarted.id, "Try again");
  assert.equal((await jobsOf(harness)).find((item) => item.id === notStarted.id).failure, undefined, "S1 a retry clears the failure kind");
  prepareHeld.delete("Job STARTFAIL");
  await quiet(harness);
}

// A queued stall is obsolete once the worker returns a result, even while the coordinator is busy.
await say_(root, "Start QUEUEDSILENT");
const queuedWorker = await until(
  async () => (await jobsOf(harness)).find((item) => item.title === "Job QUEUEDSILENT" && item.children.length),
  "queued-stall child started",
);
await until(() => processes.size === 1, "queued-stall process started");
gateOpen = false;
gateEntered = false;
const heldOwner = await root.submit({ type: "input", content: "Hold owner response" }, context);
await until(() => gateEntered, "coordinator busy awaiting owner response");
assert.deepEqual(await jobs.stallTick(harness, T + 200 * 60_000), []);
assert.deepEqual(await jobs.stallTick(harness, T + 221 * 60_000), [queuedWorker.id]);
finishSlow = true;
releasedSlowCycle = slowCycle;
await until(
  async () => (await jobsOf(harness)).find((item) => item.id === queuedWorker.id)?.status === "ready",
  "worker produces an actionable result while the coordinator is busy",
);
await delay(100);
const obsolete = await harness.commit((tx) => tx.submissionByRequest(root.id, `stall:${queuedWorker.id}:1`), context);
assert.equal(obsolete.status, "unanswered", "completion retracts a still-queued obsolete stall");
gateOpen = true;
await heldOwner.wait(context);
await quiet(harness);
assert.ok(
  !requests.some((item) => item.role === "coordinator" && item.user.includes(`[worker ${queuedWorker.id} stalled`)),
  "obsolete stall never reaches a model request",
);
assert.equal(
  (await chatText(root)).filter((line) => line.startsWith(`[worker ${queuedWorker.id} ready:`)).length,
  1,
  "the actual result still reaches the coordinator exactly once",
);

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

// A1-A5 (jobs-failures.md "Activity reflects what runs"): work is what can still run, not an agent without an end time.
{
  const agentOf = async (id) => (await jobs.snapshot(harness)).agents.find((item) => item.id === id);
  gateOpen = false;
  gateEntered = false;
  await say_(root, "Start READYHOLD");
  await until(() => gateEntered, "READYHOLD worker holds its last reply after Ready");
  const held = (await jobsOf(harness)).find((item) => item.title === "Job READYHOLD");
  assert.equal(held.status, "ready");
  // A project pause: jobs pause, then every chat aborts with its background tasks (the worker's reporter among them).
  await jobs.pause(harness);
  await root.abort(context, { background: true });
  gateOpen = true;
  await quiet(harness);
  assert.notEqual((await agentOf(held.id)).endedAt, null, "A1 a reporter aborted after Ready ends its agent");
  assert.equal(await jobs.busy(harness), false, "A1 a paused project whose Ready worker was cut off is idle");
  await jobs.resume(harness);
  await quiet(harness);

  // A2/A3: a ghost left by an older host (Ready Job, no end time, no reporter) is not work and is ended on open.
  await harness.commit(async (tx) => {
    (await tx.doc(Jobs, root.id)).agents[held.id].endedAt = null;
  }, context);
  assert.equal(await jobs.busy(harness), false, "A3 an agent without an end time but with nothing to run is not work");
  await harness.close(context);
  ({ harness, root, jobs, killed } = await open());
  await jobs.recover(harness);
  assert.notEqual((await agentOf(held.id)).endedAt, null, "A2 opening the project ends an agent whose Job already ended");

  // A4/A5: a queued passive write and a blocked task run nothing; queued input and a runnable task are work.
  const fake = (tasks, submissions) => ({
    snapshot: async () => ({ paused: false, jobs: {}, agents: {}, subagents: {}, requests: {} }),
    inspect: async () => ({ scheduling: "running", tasks, submissions }),
  });
  const write = { id: 1, conversationId: 9, requestId: "compaction:8", type: "write", status: "queued" };
  const blocked = { record: { id: 2, kind: "x" }, state: { kind: "blocked", reason: "restart_limit" } };
  assert.equal(await jobs.busy(fake([], [write])), false, "A4 a queued passive write is not work");
  assert.equal(await jobs.busy(fake([blocked], [])), false, "A5 a blocked task is not work");
  assert.equal(await jobs.busy(fake([], [{ ...write, type: "input" }])), true, "queued input is work");
  assert.equal(
    await jobs.busy(fake([{ record: { id: 3, kind: "x" }, state: { kind: "sleeping", until: 1 } }], [])),
    true,
    "a sleeping task is work",
  );
}

// V1-V9: one reviewer reads A, then B, in the same conversation; the old report still identifies A.
{
  const reviewers = async () => (await jobs.snapshot(harness)).agents.filter((item) => item.role === "reviewer" && item.readRef === REV_A);
  const reportsOf = async (agent) =>
    (await (await harness.conversation(agent.conversationId, context)).entries({}, 200, undefined, context)).items
      .toReversed()
      .filter((entry) => entry.kind === "projects.agent-report")
      .map((entry) => entry.data.text);
  const lastTool = () => requests.findLast((item) => item.role === "coordinator" && item.result)?.result ?? "";
  await say_(root, `Review ${REV_A}`);
  await quiet(harness);
  const [reviewer] = await reviewers();
  let reports = await reportsOf(reviewer);
  assert.equal(reports.length, 1);
  assert.match(
    reports[0],
    new RegExp(`Read revision: ${REV_A}, confirmed in its checkout before the review began; not locked, and not checked again after it\\.`),
    "V3 the first report names A and says when it was confirmed",
  );
  assert.equal(readerSaw, REV_A);

  await say_(root, `Resend ${reviewer.id} ${REV_B} send-b`);
  await quiet(harness);
  assert.equal((await reviewers()).length, 1, "the same reviewer is reused");
  assert.equal(readerSaw, REV_B, "V1 the new turn reads B");
  reports = await reportsOf(reviewer);
  assert.equal(reports.length, 2);
  assert.match(reports[0], new RegExp(`Read revision: ${REV_A}`), "V3 the old report still identifies A");
  assert.doesNotMatch(reports[0], new RegExp(REV_B), "V3 the old report never names B");
  assert.match(reports[1], new RegExp(`Read revision: ${REV_B}`), "V3 the new report names B");
  const told = requests.findLast((item) => item.role === "reviewer").user;
  assert.match(told, new RegExp(`${REV_B}`), "V9 the reviewer is told its checkout is now B");
  assert.match(told, new RegExp(REV_A), "V9 and what it read before");

  await say_(root, `Resend ${reviewer.id} ${REV_B} send-b`);
  await quiet(harness);
  assert.match(lastTool(), /Already sent/, "V6 a retried request returns the same send");
  assert.equal((await reportsOf(reviewer)).length, 2, "V6 a retry starts no turn");

  // V4: an unavailable SHA reads nothing and leaves the reviewer on B.
  await say_(root, `Resend ${reviewer.id} ${UNAVAILABLE} send-c`);
  await quiet(harness);
  reports = await reportsOf(reviewer);
  assert.equal(reports.length, 3);
  assert.match(reports[2], /failed to start/);
  assert.match(reports[2], new RegExp(`${UNAVAILABLE} was not read`), "V4 the failed turn names the SHA it could not read");
  assert.doesNotMatch(reports[2], new RegExp(`Read revision: ${REV_B}`), "V4 a failed turn does not claim B");
  await say_(root, `Resend ${reviewer.id} - plain-1`);
  await quiet(harness);
  reports = await reportsOf(reviewer);
  assert.equal(readerSaw, REV_B, "V4 a plain send after a failed one reads the last good revision");
  assert.match(reports[3], new RegExp(`Read revision: ${REV_B}`));
  assert.doesNotMatch(reports[3], new RegExp(UNAVAILABLE));

  // V7: refused without widening access, and a refusal does not consume its requestId.
  for (const bad of ["main", "--upload-pack=x", "pull/1", "F".repeat(40), REV_B.slice(0, 12)]) {
    await say_(root, `Resend ${reviewer.id} ${bad} bad-${bad.length}`);
    assert.match(lastTool(), /full lowercase commit SHA/, `V4 ${bad} is refused`);
  }
  await say_(root, "Scout again");
  await quiet(harness);
  const scout = (await jobs.snapshot(harness)).agents.find((item) => item.role === "scout");
  await say_(root, `Resend ${scout.id} ${REV_C}`);
  assert.match(lastTool(), /reviewer/i, "V7 a scout cannot change revision");
  await say_(root, `Resend ${reviewer.id} ${REV_C} send-c2`);
  await quiet(harness);
  assert.equal(readerSaw, REV_C, "a refused request id is not consumed");

  // V4: a first SHA that cannot be prepared is reported as not read, not as read.
  await say_(root, `Review ${UNAVAILABLE}`);
  await quiet(harness);
  const lost = (await jobs.snapshot(harness)).agents.find((item) => item.readRef === UNAVAILABLE);
  const [lostReport] = await reportsOf(lost);
  assert.match(lostReport, new RegExp(`Revision ${UNAVAILABLE} was not read\\.`), "V4 an unavailable first SHA is reported as not read");
  assert.doesNotMatch(lostReport, /Read revision:/, "V4 and never as read");

  // V3: only a reader's report names a commit; a worker given a readRef reads none.
  await say_(root, `WorkerRef ${REV_A}`);
  await quiet(harness);
  const worker = (await jobs.snapshot(harness)).agents.find((item) => item.title === "Job WREF");
  const workerReports = await reportsOf(worker);
  assert.ok(workerReports.length && !workerReports.some((text) => /revision/i.test(text)), "V3 a worker's report names no revision");

  // V5: two sends with different SHAs while the reviewer prepares: neither starts a turn.
  const turns = (await reportsOf(reviewer)).length;
  const runs = prepareRuns.length;
  prepareHeld.add("BRIEF-REVREAD");
  await say_(root, `Resend ${reviewer.id} - held-1`);
  await until(() => prepareRuns.length > runs, "held prepare");
  await say_(root, `Race ${reviewer.id} ${REV_A} ${REV_B}`);
  assert.match(lastTool(), /still working/i, "V5 a revision change on a working reviewer is refused");
  prepareHeld.delete("BRIEF-REVREAD");
  await quiet(harness);
  assert.equal((await reportsOf(reviewer)).length, turns + 1, "V5 only the plain send started a turn");
  assert.equal(readerSaw, REV_C, "V5 the refused races changed nothing");

  // V4: recovery while a new commit is still being prepared tolerates it, and the unavailable commit is reported as not read.
  holdUnavailable = true;
  await say_(root, `Resend ${reviewer.id} ${UNAVAILABLE} restart-1`);
  await until(() => unavailableHeld, "unavailable commit preparing");
  await jobs.recover(harness);
  unavailableRelease = true;
  await quiet(harness);
  const afterRestart = await reportsOf(reviewer);
  assert.match(
    afterRestart.at(-1),
    new RegExp(`Revision ${UNAVAILABLE} was not read\\.`),
    "V4 the unavailable commit is reported as not read",
  );
  await say_(root, `Resend ${reviewer.id} - plain-after-restart`);
  await quiet(harness);
  assert.equal(readerSaw, REV_C, "V4 a plain send after the failed turn reads the last commit that was read");

  // V5: stopping a reviewer in the middle of a turn does not let another revision in before that turn has been reported.
  const stoppedRuns = prepareRuns.length;
  prepareHeld.add("BRIEF-REVREAD");
  await say_(root, `Resend ${reviewer.id} - held-2`);
  await until(() => prepareRuns.length > stoppedRuns, "held prepare before stop");
  await say_(root, `Stopit ${reviewer.id}`);
  await say_(root, `Race ${reviewer.id} ${REV_A} ${REV_B}`);
  assert.match(lastTool(), /still working/i, "V5 a stopped reviewer whose turn is not reported keeps its revision");
  prepareHeld.delete("BRIEF-REVREAD");
  await quiet(harness);
  assert.equal(readerSaw, REV_C, "V5 the interrupted turn read the revision it was sent with");
  await say_(root, `Resend ${reviewer.id} ${REV_B} after-stop`);
  await quiet(harness);
  assert.equal(readerSaw, REV_B, "V5 once settled, a stopped reviewer takes a new revision");

  // V5: a turn stopped before its checkout was prepared was never read: the next plain send keeps the last commit that was.
  prepareHeld.add("BRIEF-REVREAD");
  const abandonedRuns = prepareRuns.length;
  await say_(root, `Resend ${reviewer.id} ${REV_A} abandoned`);
  await until(() => prepareRuns.length > abandonedRuns, "held prepare of the abandoned turn");
  await say_(root, `Stopit ${reviewer.id}`);
  await say_(root, `Resend ${reviewer.id} - at-once`);
  prepareHeld.delete("BRIEF-REVREAD");
  await quiet(harness);
  assert.equal(readerSaw, REV_B, "V12 a plain send right after the stop does not inherit the abandoned commit");
  await say_(root, `Resend ${reviewer.id} - after-abandon`);
  await quiet(harness);
  assert.equal(readerSaw, REV_B, "V5 a stopped, never prepared turn does not become the reviewer's commit");
  const abandoned = await reportsOf(reviewer);
  assert.match(abandoned.at(-1), new RegExp(`Read revision: ${REV_B}`));

  // V10: a pause aborts the reporter of a turn in flight; after the resume the reviewer still takes a new commit.
  const pausedRuns = prepareRuns.length;
  prepareHeld.add("BRIEF-REVREAD");
  await say_(root, `Resend ${reviewer.id} - paused-turn`);
  await until(() => prepareRuns.length > pausedRuns, "held prepare before pause");
  await jobs.pause(harness);
  const aborting = root.abort(context, { background: true });
  await delay(100);
  prepareHeld.delete("BRIEF-REVREAD");
  await aborting;
  await quiet(harness);
  await jobs.resume(harness);
  await quiet(harness);
  await say_(root, `Resend ${reviewer.id} - after-pause`);
  await quiet(harness);
  await say_(root, `Resend ${reviewer.id} ${REV_C} paused-new`);
  await quiet(harness);
  assert.equal(readerSaw, REV_C, "V10 a pause that aborted a turn does not shut the reviewer's commit for good");

  // V5: an older message still being prepared keeps the commit shut even when a newer one has been reported.
  holdNextPrepare = true;
  await say_(root, `Resend ${reviewer.id} - overlap-1`);
  await until(() => nextHeld, "first overlapping message preparing");
  const before = (await reportsOf(reviewer)).length;
  await say_(root, `Resend ${reviewer.id} - overlap-2`);
  await until(async () => (await reportsOf(reviewer)).length > before, "newer message reported");
  await say_(root, `Resend ${reviewer.id} ${REV_A} overlap-3`);
  assert.match(lastTool(), /still working/i, "V5 an unreported older message keeps the reviewer's commit");
  releaseNext = true;
  await quiet(harness);
  await say_(root, `Resend ${reviewer.id} ${REV_A} overlap-3`);
  await quiet(harness);
  assert.equal(readerSaw, REV_A, "V5 once every earlier message is reported, the new commit is taken");
}

// W1-W9 (jobs-failures.md): a re-check continues its reviewer's conversation on the repaired, confirmed candidate.
{
  await say_(root, "Start CONT");
  await quiet(harness);
  const cont = (await jobsOf(harness)).find((item) => item.title === "Job CONT");
  const results = requests.filter((item) => item.role === "worker" && item.tag === "BRIEF-CONT").map((item) => item.result);
  assert.ok(continuedReviewer, "W1 the first review names the reviewer to continue");
  assert.match(results[3], /fresh|independent/i, "W2 a full review never continues a conversation");
  assert.match(results[4], /already read/i, "W4 the commit the reviewer read is not read again");
  assert.match(results[6], /uncommitted/i, "W3 a dirty checkout is refused");
  assert.match(results[7], /recorded candidate/i, "W3 a checkout that is not the recorded candidate is refused");
  assert.match(results[8], /cannot be read/i, "W3 an unreadable checkout is refused");
  assert.match(results[9], /not a reviewer of this Job/i, "W2 an unknown reviewer is refused");
  assert.match(
    results[10],
    new RegExp(`^TURNS 2; LAST \\[The commit under review changed.*holds ${REV_B}.*read ${REV_A}`, "s"),
    "W1 W5 the same conversation reads B and is told A came before",
  );
  assert.match(results[11], /already read/i, "W4 a second re-check on B is refused");
  assert.match(results[13], /did not answer/, "W7 a continued turn whose model fails reports it");
  assert.match(results[14], /not answered its last turn/, "W8 a reviewer that did not answer is not continued");
  assert.match(results[15], /^REVIEW-OK/, "W7 the failed continued turn gave its re-check back, so a fresh one still runs");
  assert.deepEqual(cont.reviews, { full: 1, rechecks: 3 }, "W7 W9 refusals spend nothing; each started turn is one re-check");
  const child = cont.children.find((item) => String(item.id) === continuedReviewer);
  assert.deepEqual(
    child.reads.map((item) => item.sha),
    [REV_A, REV_B, REV_C],
    "W6 every commit a turn was sent is recorded, oldest first",
  );
  assert.equal(
    cont.children.filter((item) => item.role === "reviewer").length,
    2,
    "W1 continuing starts no conversation; only the fresh re-check does",
  );
  await say_(root, "Start CONTOTHER");
  await quiet(harness);
  const other = requests.filter((item) => item.role === "worker" && item.tag === "BRIEF-CONTOTHER").map((item) => item.result);
  assert.match(other[3], /not a reviewer of this Job/i, "W2 another Job's reviewer is never continued");
}

await harness.close(context);
rmSync(dir, { recursive: true, force: true });
console.log("jobs e2e passed");
