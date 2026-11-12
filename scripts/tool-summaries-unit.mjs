// Contracts of the tool summary store, queue and model call (scripts/tool-summaries-failures.md), with a fake model runtime and
// hand-built Pi Durable commits. No host, no provider, no network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { openToolSummaries } from "../src/tool-summaries.ts";

const root = mkdtempSync(join(tmpdir(), "tool-summaries-unit-"));
const path = join(root, "tool-summaries.sqlite");
const MODEL = "fake/light",
  OTHER = "fake/other";
const usage = (input, output, cost) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

/** A runtime whose replies come from `plan` in order: a string answers, "hang" never answers, "error" fails. */
function fakeRuntime() {
  const requests = [],
    plan = [];
  let live = 0,
    peak = 0;
  const model = (provider, id) => ({
    provider,
    id,
    api: "openai-completions",
    name: id,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
  });
  const runtime = {
    requests,
    plan,
    peak: () => peak,
    getModel: (provider, id) =>
      ["light", "other"].includes(id) && ["fake", "nocreds"].includes(provider) ? model(provider, id) : undefined,
    getProviderAuthStatus: (provider) => ({ configured: provider === "fake" }),
    streamSimple(target, context, options) {
      const step = plan.length ? plan.shift() : "One thing was done. It worked.";
      requests.push({ model: `${target.provider}/${target.id}`, context, options });
      const stream = createAssistantMessageEventStream();
      const message = (text, stopReason = "stop", errorMessage) => ({
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        api: target.api,
        provider: target.provider,
        model: target.id,
        usage: usage(100, 20, 0.001),
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
        timestamp: Date.now(),
      });
      live++;
      peak = Math.max(peak, live);
      const end = () => live--;
      options?.signal?.addEventListener("abort", () => {
        end();
        const failed = message("", "aborted", "aborted");
        stream.push({ type: "error", reason: "aborted", error: failed });
        stream.end(failed);
      });
      if (step === "hang") return stream;
      queueMicrotask(() => {
        end();
        if (step === "error") {
          const failed = message("", "error", "provider exploded");
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end(failed);
          return;
        }
        const done = message(step);
        stream.push({ type: "start", partial: done });
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      });
      return stream;
    },
  };
  return runtime;
}

let seq = 1,
  entryId = 100,
  callN = 0,
  taskN = 5_000;
const commit = (...changes) => ({ seq: seq++, changes: changes.flat() });
const nextCall = (name, args = {}) => ({ id: `call-${++callN}`, name, args });
/** An assistant message with these blocks in order: `"think:…"` and `"text:…"` strings, and calls. */
const message = (conversationId, blocks, at = 1_000) => ({
  type: "entry",
  value: {
    id: ++entryId,
    conversationId,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: blocks.map((block) =>
          typeof block !== "string"
            ? { type: "toolCall", id: block.id, name: block.name, arguments: block.args }
            : block.startsWith("think:")
              ? { type: "thinking", thinking: block.slice(6) }
              : { type: "text", text: block.slice(5) },
        ),
        timestamp: at,
      },
    ],
  },
});
/** A message that says something first, so its calls start a group of their own. */
const assistant = (conversationId, calls, at = 1_000) => message(conversationId, ["text:Let me look.", ...calls], at);
const result = (conversationId, call, text, { isError = false, images = 0, nestedCalls, at = 2_000 } = {}) => ({
  type: "entry",
  value: {
    id: ++entryId,
    conversationId,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          { type: "text", text },
          ...Array.from({ length: images }, () => ({ type: "image", data: "QUJD".repeat(50_000), mimeType: "image/png" })),
        ],
        isError,
        ...(nestedCalls ? { nestedCalls } : {}),
        timestamp: at,
      },
    ],
  },
});
/** An input entry: a steer or follow-up (`pi.user`), an owner or internal input, or a model-less entry with `model: false`. */
const input = (conversationId, text, { kind = "pi.user", model = true } = {}) => ({
  type: "entry",
  value: {
    id: ++entryId,
    conversationId,
    kind,
    ...(model ? { model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1_500 }] } : { data: { text } }),
  },
});
const waitFor = async (fn, label, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
};
const fresh = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
};
const LIMITS = { retryMs: 5, timeoutMs: 2000 };
const open = (runtime, settings = { enabled: true, model: MODEL }, limits = {}) =>
  openToolSummaries({ path, settings, runtime: async () => runtime, limits: { ...LIMITS, ...limits } });
const userText = (request) =>
  request.context.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join(""))).join("\n");
/** What a host does once a conversation store opened: drop its ended groups and queue its recovered summaries. */
const admit = (service, scope, { running = [], nested = [] } = {}) =>
  service.reconcile({ scope, running: new Set(running), before: Date.now(), nested: new Set(nested) });
/** The calls of assistant entries as a transcript page lists them. */
const callsOf = (...entries) =>
  entries.flatMap((entry) =>
    entry.value.model[0].content
      .filter((part) => part.type === "toolCall")
      .map((part) => ({ entry: entry.value.id, call: part.id, name: part.name })),
  );
const pageOf = (service, scope, conversationId, ...entries) => service.read({ scope, conversationId, calls: callsOf(...entries) });
/** The group id and view of one call of `entry` (its first by default), as an owner page reads it. */
const groupOf = (service, scope, conversationId, entry, index = 0) => {
  const page = pageOf(service, scope, conversationId, entry);
  const call = callsOf(entry)[index];
  const id = page?.calls[`${call.entry}:${call.call}`];
  return id ? { id, ...page.groups[id] } : undefined;
};
const statusOf = (service, scope, conversationId, entry, index) => groupOf(service, scope, conversationId, entry, index)?.status;
/** The stored group that starts at `entry`, read straight from the database. */
const stored = (entry) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT status, calls, waiting, size, updated FROM tool_groups WHERE first_entry = ?").get(entry);
  db.close();
  return row && { ...row };
};
/** A Pi Durable task change of `conversationId`: by default one of its generations (`pi.generation`) ending. */
const task = (conversationId, { kind = "pi.generation", owner, status = "terminal" } = {}) => ({
  type: "task",
  value: {
    id: ++taskN,
    conversationId,
    kind,
    version: 1,
    input: {},
    background: false,
    abortRequested: status === "terminal",
    ...(owner ? { owner } : {}),
    state: status === "terminal" ? { status, outcome: { status: "aborted" } } : { status, checkpoint: {} },
  },
});
/** The run of `conversationId` ends: its generation ends and no next one starts. */
const end = (conversationId) => task(conversationId);
/** A generation hands the run to the next one in the same commit; the run goes on. */
const handover = (conversationId) => [task(conversationId), task(conversationId, { status: "pending" })];

// G1 G2 G7 G9 Q6 Q7: thinking, three calls from three messages, thinking, two calls, the final text: exactly two summaries, of
// three calls and of two, each asked once after its group closed with every result; no tools, untrusted data, two sentences.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  const changed = [];
  service.watch("p1", (conversationId) => changed.push(conversationId));
  const a = nextCall("read", { path: "artifacts/report.json" }),
    b = nextCall("bash", { command: "git log -4" }),
    c = nextCall("read", { path: "scripts/jobs-e2e.mjs" }),
    d = nextCall("edit", { path: "scripts/jobs-e2e.mjs" }),
    e = nextCall("bash", { command: "npm run check" });
  const m1 = message(7, ["think:TS-THOUGHT-ONE collect the facts", a]);
  service.observe("p1", commit(m1));
  const collecting = groupOf(service, "p1", 7, m1);
  assert.deepEqual([collecting?.status, collecting?.calls], ["collecting", 1], "D3: a group collecting calls reads as collecting");
  service.observe("p1", commit(result(7, a, "TS-RESULT-A step approve failed", { isError: true }), handover(7)));
  // G7: an empty thinking block and whitespace text are not a boundary.
  const m2 = message(7, ["think:", "text:  \n", b]);
  service.observe("p1", commit(m2));
  service.observe("p1", commit(result(7, b, "TS-RESULT-B 4844943"), handover(7)));
  const m3 = message(7, [c]);
  service.observe("p1", commit(m3, result(7, c, "TS-RESULT-C waitFor 5000"), handover(7)));
  await delay(30);
  assert.equal(runtime.requests.length, 0, "G2 G9: nothing is asked while the group may still grow");
  const first = groupOf(service, "p1", 7, m1);
  assert.deepEqual([first.status, first.calls], ["collecting", 3], "G1: three calls from three messages are one group");
  assert.equal(groupOf(service, "p1", 7, m2).id, first.id, "G1: the second message's call joins the group");
  assert.equal(groupOf(service, "p1", 7, m3).id, first.id, "G1: the third message's call joins the group");

  runtime.plan.push("Read the report, the log and the script. Approve waits too long. Then it did more. And more again.");
  const m4 = message(7, ["think:TS-THOUGHT-TWO raise the timeout", d]);
  service.observe("p1", commit(m4));
  const second = groupOf(service, "p1", 7, m4);
  assert.notEqual(second.id, first.id, "G1: thinking starts a new group");
  await waitFor(() => statusOf(service, "p1", 7, m1) === "ready", "first group summarized");
  assert.equal(runtime.requests.length, 1, "G2: thinking closes the first group and asks once");
  const request = runtime.requests[0];
  assert.equal(request.model, MODEL);
  assert.ok(!request.context.tools?.length && !request.options?.tools, "Q6: the summary model gets no tools");
  assert.match(request.context.systemPrompt, /untrusted/i, "Q6: tool text is framed as untrusted data");
  assert.match(request.context.systemPrompt, /two sentences/i, "S5: the prompt fixes the length");
  const text = userText(request);
  for (const marker of ["artifacts/report.json", "git log -4", "scripts/jobs-e2e.mjs", "TS-RESULT-A", "TS-RESULT-B", "TS-RESULT-C"])
    assert.ok(text.includes(marker), `G1: the first summary covers ${marker}`);
  assert.ok(!text.includes("npm run check"), "G1: the next group's call is not in it");
  assert.ok(!text.includes("TS-THOUGHT"), "the agent's own thinking is not sent, only calls and results");
  assert.equal(
    groupOf(service, "p1", 7, m1).text,
    "Read the report, the log and the script. Approve waits too long.",
    "Q6: cut to two sentences",
  );
  assert.equal(groupOf(service, "p1", 7, m1).model, MODEL);
  assert.ok(changed.includes(7), "a state change notifies the conversation");

  service.observe("p1", commit(result(7, d, "edited"), handover(7)));
  const m5 = message(7, [e]);
  service.observe("p1", commit(m5, result(7, e, "TS-RESULT-E ok"), handover(7)));
  await delay(30);
  assert.equal(runtime.requests.length, 1, "G9: a call joining the second group asks nothing");
  const m6 = message(7, ["text:Done: raised the timeout."]);
  service.observe("p1", commit(m6, end(7)));
  await waitFor(() => statusOf(service, "p1", 7, m5) === "ready", "second group summarized");
  assert.equal(runtime.requests.length, 2, "exactly two summaries");
  const secondText = userText(runtime.requests[1]);
  assert.ok(secondText.includes("TS-RESULT-E") && secondText.includes("edited"), "the second summary covers its two calls");
  assert.ok(!secondText.includes("TS-RESULT-A"), "G1: the second summary covers only its own group");
  const page = pageOf(service, "p1", 7, m1, m2, m3, m4, m5, m6);
  assert.deepEqual(
    Object.values(page.groups).map((group) => [group.status, group.calls, group.failed]),
    [
      ["ready", 3, 1],
      ["ready", 2, 0],
    ],
    "two groups on the page, of three calls and of two, with the whole group's failed calls",
  );
  assert.equal(new Set(Object.values(page.calls)).size, 2, "G10: every call belongs to one of the two groups");
  assert.equal(Object.keys(page.calls).length, 5, "G10: each original call keeps its own entry and call id");

  // G3: the same commits again change nothing.
  service.observe("p1", commit(m1, result(7, a, "again"), m2, m3, m4, m5, m6, end(7)));
  await delay(30);
  assert.equal(runtime.requests.length, 2, "G3: commits seen twice do not summarize twice");
  assert.deepEqual(pageOf(service, "p1", 7, m1, m2, m3, m4, m5, m6), page, "G3 G10: the same groups with the same ids");

  // G6: reads have no side effects; a page holding only some calls of a group reads that group with its whole count (D10).
  const db = new DatabaseSync(path, { readOnly: true });
  const before = db.prepare("SELECT COUNT(*) AS n, MAX(updated) AS u FROM tool_groups").get();
  const partial = pageOf(service, "p1", 7, m3);
  assert.deepEqual(
    Object.values(partial.groups).map((group) => [group.calls, group.failed]),
    [[3, 1]],
    "D10: a partial page reads the group's whole count and its failure on an earlier page",
  );
  service.read({ scope: "p1", conversationId: 7, calls: [{ entry: 9999, call: "nope", name: "bash" }] });
  service.usage("p1");
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n, MAX(updated) AS u FROM tool_groups").get(), before, "G6: reads write nothing");
  // Q8: a finished group keeps no copy of the calls.
  assert.deepEqual(
    db
      .prepare("SELECT calls, waiting FROM tool_groups WHERE status = 'ready'")
      .all()
      .map((row) => [row.calls, row.waiting]),
    [
      [null, null],
      [null, null],
    ],
    "Q8: the bounded input copy is dropped once the summary is done",
  );
  db.close();

  // U1: usage is kept per conversation, separately.
  const spent = service.usage("p1").get(7);
  assert.equal(spent.requests, 2);
  assert.equal(spent.summaries, 2);
  assert.equal(spent.interrupted, 0);
  assert.ok(Math.abs(spent.usage.cost.total - 0.002) < 1e-9 && spent.usage.input === 200);
  assert.equal(service.usage("other-scope").size, 0, "another scope has no usage");
  await service.close();
}

// G1: the order of blocks inside a message decides; inputs, an agent report, a compaction, a reset and the end of a run close a
// group, a generation handing the run on and model-less entries do not.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  const [a, b, c, d, e, f, g, h, i, j] = Array.from({ length: 10 }, (_, n) => nextCall("bash", { command: `step ${n}` }));
  const mixed = message(50, [a, "text:TS-BETWEEN now the check", b]);
  service.observe("p1", commit(mixed, result(50, a, "a"), result(50, b, "b"), handover(50)));
  assert.notEqual(groupOf(service, "p1", 50, mixed, 0).id, groupOf(service, "p1", 50, mixed, 1).id, "G1: text inside a message splits");
  await waitFor(() => statusOf(service, "p1", 50, mixed, 0) === "ready", "the call before the text is summarized");
  const thoughtAfter = message(50, [c, "think:TS-AFTER weigh it"]);
  service.observe("p1", commit(thoughtAfter, result(50, c, "c"), handover(50)));
  assert.equal(groupOf(service, "p1", 50, thoughtAfter).id, groupOf(service, "p1", 50, mixed, 1).id, "a call joins before the thinking");
  await waitFor(() => statusOf(service, "p1", 50, thoughtAfter) === "ready", "thinking after a call closes its group");
  // A model-less entry (a chat write) and a system entry are not boundaries.
  const quiet = message(50, [d]);
  service.observe(
    "p1",
    commit(
      quiet,
      result(50, d, "d"),
      input(50, "note", { kind: "projects.note", model: false }),
      { ...input(50, "x"), value: { ...input(50, "x").value, kind: "pi.system", model: [{ role: "system", content: "prompt" }] } },
      handover(50),
    ),
  );
  const joined = message(50, [e]);
  service.observe("p1", commit(joined, result(50, e, "e"), handover(50)));
  assert.equal(groupOf(service, "p1", 50, joined).id, groupOf(service, "p1", 50, quiet).id, "model-less and system entries do not split");
  // Each input kind closes the open group; the next call starts another.
  const kinds = [
    ["pi.user", true],
    ["projects.owner-input", true],
    ["projects.internal-input", true],
    ["projects.agent-report", false],
    ["pi.compaction", true],
    ["pi.reset", true],
  ];
  let previous = joined;
  for (const [kind, model] of kinds) {
    const call = [f, g, h, i, j, nextCall("bash", { command: kind })][kinds.findIndex(([k]) => k === kind)];
    service.observe("p1", commit(input(50, `TS-${kind}`, { kind, model })));
    const next = message(50, [call]);
    service.observe("p1", commit(next, result(50, call, kind), handover(50)));
    assert.notEqual(groupOf(service, "p1", 50, next).id, groupOf(service, "p1", 50, previous).id, `G1: ${kind} closes the group`);
    await waitFor(() => statusOf(service, "p1", 50, previous) === "ready", `${kind}: the closed group is summarized`);
    previous = next;
  }
  // The end of a run closes the group; a new run's calls never join it.
  service.observe("p1", commit(end(50)));
  await waitFor(() => statusOf(service, "p1", 50, previous) === "ready", "the run's end closes the group");
  const nextRun = message(50, [nextCall("bash", { command: "next run" })]);
  service.observe("p1", commit(nextRun));
  assert.notEqual(groupOf(service, "p1", 50, nextRun).id, groupOf(service, "p1", 50, previous).id, "G1: a new run starts a new group");
  // Another conversation's boundaries do not touch this group.
  service.observe("p1", commit(message(51, ["text:other"]), input(51, "other"), end(51)));
  assert.equal(statusOf(service, "p1", 50, nextRun), "collecting", "another conversation's text, input or run end keeps the group");
  await service.close();
}

// G4: memory calls keep their own rows: they are left out of the group, do not split it, and a memory-only group gets nothing.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  const memory = nextCall("projects_knowledge_read", { path: "preferences.md" });
  const only = assistant(8, [memory]);
  service.observe("p1", commit(only, result(8, memory, "prefs"), end(8)));
  const bash = nextCall("bash", { command: "ls" }),
    mem2 = nextCall("projects_knowledge_write", { path: "decisions/x.md" }),
    bash2 = nextCall("bash", { command: "pwd" });
  const mixed = assistant(8, [bash, mem2]),
    after = message(8, [bash2]);
  service.observe("p1", commit(mixed, result(8, bash, "a b c"), result(8, mem2, "written"), handover(8)));
  service.observe("p1", commit(after, result(8, bash2, "/x"), end(8)));
  await waitFor(() => statusOf(service, "p1", 8, mixed) === "ready", "mixed summary");
  assert.equal(pageOf(service, "p1", 8, only), undefined, "G4: no group for memory calls only");
  assert.equal(groupOf(service, "p1", 8, mixed, 1), undefined, "G4: the memory call belongs to no group");
  assert.equal(groupOf(service, "p1", 8, after).id, groupOf(service, "p1", 8, mixed).id, "G4: a memory call does not split the group");
  assert.equal(groupOf(service, "p1", 8, mixed).calls, 2);
  assert.equal(runtime.requests.length, 1);
  assert.ok(!userText(runtime.requests[0]).includes("decisions/x.md"), "G4: the memory call is not part of the summary");
  await service.close();
}

// G5 S3 S4: disabled calls are never summarized, enabling does not backfill or join earlier calls, disabling cancels queued work and
// open groups, re-enabling starts a separate group, and a model change applies at once.
{
  fresh();
  const runtime = fakeRuntime();
  let service = open(runtime, { enabled: false, model: MODEL });
  const off = nextCall("bash", { command: "echo off" });
  const offMessage = assistant(9, [off]);
  service.observe("p1", commit(offMessage, result(9, off, "off"), handover(9)));
  const straddle = nextCall("bash", { command: "echo straddle" });
  const straddleMessage = message(9, [straddle]);
  service.observe("p1", commit(straddleMessage));
  service.configure({ enabled: true, model: MODEL });
  service.observe("p1", commit(result(9, straddle, "done"), handover(9)));
  const joinedLate = nextCall("bash", { command: "echo TS-AFTER-ENABLE" });
  const lateJoin = message(9, [joinedLate]);
  service.observe("p1", commit(lateJoin, result(9, joinedLate, "after"), end(9)));
  await waitFor(() => statusOf(service, "p1", 9, lateJoin) === "ready", "the call after enabling is summarized alone");
  assert.equal(runtime.requests.length, 1);
  assert.ok(!/echo off|echo straddle/.test(userText(runtime.requests[0])), "G5: calls from before enabling stay out of the group");
  assert.equal(pageOf(service, "p1", 9, offMessage, straddleMessage), undefined, "G5: no backfill");
  assert.equal(groupOf(service, "p1", 9, lateJoin).calls, 1);

  // Enabled at the call, disabled before the group closed: cancelled; re-enabling starts a separate group.
  const late = nextCall("bash", { command: "echo TS-BEFORE-DISABLE" });
  const lateMessage = assistant(9, [late]);
  service.observe("p1", commit(lateMessage, result(9, late, "late"), handover(9)));
  service.configure({ enabled: false, model: MODEL });
  service.configure({ enabled: true, model: MODEL });
  const resumed = nextCall("bash", { command: "echo TS-AFTER-REENABLE" });
  const resumedMessage = message(9, [resumed]);
  service.observe("p1", commit(resumedMessage, result(9, resumed, "resumed"), end(9)));
  await waitFor(() => statusOf(service, "p1", 9, resumedMessage) === "ready", "the group after re-enabling");
  assert.equal(pageOf(service, "p1", 9, lateMessage), undefined, "S3: the cancelled group reads as none");
  assert.ok(!userText(runtime.requests.at(-1)).includes("TS-BEFORE-DISABLE"), "S3: re-enabling never joins the old open group");
  assert.equal(runtime.requests.length, 2);

  // Queued work stops when summaries are turned off.
  await service.close();
  service = open(runtime, { enabled: true, model: MODEL }, { concurrency: 1 });
  runtime.plan.push("hang");
  const busy = nextCall("bash", { command: "echo busy" }),
    queued = nextCall("bash", { command: "echo queued" });
  const busyMessage = assistant(9, [busy]),
    queuedMessage = assistant(9, [queued]);
  service.observe("p1", commit(busyMessage, result(9, busy, "x"), handover(9)));
  service.observe("p1", commit(queuedMessage));
  await waitFor(() => runtime.requests.length === 3, "busy request started");
  service.observe("p1", commit(result(9, queued, "y"), end(9)));
  assert.equal(statusOf(service, "p1", 9, queuedMessage), "pending", "queued behind the concurrency limit");
  service.configure({ enabled: false, model: MODEL });
  await delay(30);
  assert.equal(runtime.requests.length, 3, "S3: queued work does not run after disabling");
  service.configure({ enabled: true, model: MODEL });
  assert.equal(pageOf(service, "p1", 9, busyMessage, queuedMessage), undefined, "cancelled summaries read as none");

  // S4: the next summary uses the new model without reopening.
  service.configure({ enabled: true, model: OTHER });
  const next = nextCall("bash", { command: "echo next" });
  const nextMessage = assistant(9, [next]);
  service.observe("p1", commit(nextMessage, result(9, next, "z"), end(9)));
  await waitFor(() => statusOf(service, "p1", 9, nextMessage) === "ready", "summary with the new model");
  assert.equal(runtime.requests.at(-1).model, OTHER);
  assert.equal(groupOf(service, "p1", 9, nextMessage).model, OTHER);

  // D5: while off, reads attach nothing even for cached summaries; turning on shows them again.
  service.configure({ enabled: false, model: OTHER });
  assert.equal(pageOf(service, "p1", 9, nextMessage), undefined, "D5: summaries off reads as none");
  service.configure({ enabled: true, model: OTHER });
  assert.equal(statusOf(service, "p1", 9, nextMessage), "ready", "cached summaries come back");
  await service.close();
}

// Q1 Q2 U2: a group open over a restart keeps collecting while its run goes on; a request cut off by a restart is resumed after it
// and counted as unknown cost.
{
  fresh();
  const runtime = fakeRuntime();
  let service = open(runtime);
  const x = nextCall("bash", { command: "TS-BEFORE-RESTART" }),
    y = nextCall("bash", { command: "TS-AFTER-RESTART" });
  const first = assistant(10, [x]);
  service.observe("p1", commit(first, result(10, x, "x done"), handover(10)));
  await service.close();
  service = open(runtime);
  admit(service, "p1", { running: [10] });
  const second = message(10, [y]);
  service.observe("p1", commit(second));
  assert.equal(groupOf(service, "p1", 10, second).id, groupOf(service, "p1", 10, first).id, "Q1: the open group continues");
  service.observe("p1", commit(result(10, y, "y done"), end(10)));
  await waitFor(() => statusOf(service, "p1", 10, first) === "ready", "the group closes after the restart");
  const both = userText(runtime.requests.at(-1));
  assert.ok(both.includes("TS-BEFORE-RESTART") && both.includes("y done"), "Q1: one summary of the calls from both sides");
  assert.equal(runtime.requests.length, 1);

  // A closed group whose request was running when the host stopped.
  const hanging = fakeRuntime();
  hanging.plan.push("hang");
  await service.close();
  service = open(hanging);
  admit(service, "p1", { running: [10] });
  const call = nextCall("bash", { command: "sleep" });
  const cut = assistant(10, [call]);
  service.observe("p1", commit(cut, result(10, call, "slept"), end(10)));
  await waitFor(() => hanging.requests.length === 1, "request started");
  await service.close();
  service = open(runtime);
  admit(service, "p1", { running: [10] });
  await waitFor(() => statusOf(service, "p1", 10, cut) === "ready", "Q1: the summary finishes after the restart");
  const spent = service.usage("p1").get(10);
  assert.equal(spent.interrupted, 1, "U2: the cut-off request is counted as unknown cost");
  assert.equal(spent.requests, 3);
  assert.equal(runtime.requests.length, 2, "the restarted host asks once");
  await service.close();
}

// Q3: failures are retried a bounded number of times, then the summary fails quietly; a hang counts as a timed-out attempt.
{
  const runtime = fakeRuntime();
  runtime.plan.push("error", "hang", "error");
  const service = open(runtime, undefined, { timeoutMs: 50, attempts: 3 });
  const call = nextCall("bash", { command: "boom" });
  const failing = assistant(11, [call]);
  service.observe("p1", commit(failing, result(11, call, "boom"), end(11)));
  await waitFor(() => statusOf(service, "p1", 11, failing) === "failed", "Q3: failed after the attempt limit");
  await delay(30);
  assert.equal(runtime.requests.length, 3, "Q3: exactly the attempt limit");
  assert.match(groupOf(service, "p1", 11, failing).error, /provider exploded|timed out/);
  assert.equal(groupOf(service, "p1", 11, failing).calls, 1, "a failed group still reads its calls");
  assert.equal(service.usage("p1").get(11).interrupted, 1, "the timed-out attempt has an unknown cost");
  await service.close();
}

// Q4: at most `concurrency` requests at once, and a bounded queue.
{
  fresh();
  const runtime = fakeRuntime();
  for (let i = 0; i < 6; i++) runtime.plan.push("hang");
  const service = open(runtime, undefined, { concurrency: 2, queue: 4 });
  const messages = [];
  for (let i = 0; i < 6; i++) {
    const call = nextCall("bash", { command: `job ${i}` });
    const next = assistant(12, [call]);
    messages.push(next);
    service.observe("p1", commit(next, result(12, call, `ok ${i}`), i === 5 ? end(12) : handover(12)));
  }
  await waitFor(() => runtime.requests.length === 2, "two requests");
  await delay(30);
  assert.equal(runtime.peak(), 2, "Q4: concurrency limit");
  const states = messages.map((next) => groupOf(service, "p1", 12, next));
  assert.equal(states.filter((item) => item?.status === "pending").length, 4);
  assert.equal(states.filter((item) => item?.status === "failed").length, 2, "Q4: groups past the queue limit fail instead of queueing");
  assert.match(states.at(-1).error, /queue/i);
  await service.close();
}

// Q5: bounded input, no binary data, nested codemode calls only as recorded; a long group keeps its first and latest calls.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  const calls = Array.from({ length: 30 }, (_, i) =>
    nextCall(i === 0 ? "codemode" : "read", { path: `file-${i}.md`, blob: "x".repeat(1_000_000) }),
  );
  const big = assistant(13, calls.slice(0, 20)),
    rest = message(13, calls.slice(20));
  const results = calls.map((call, i) =>
    result(13, call, i === 0 ? "script printed 3 lines" : "y".repeat(1_000_000), {
      images: i === 1 ? 1 : 0,
      ...(i === 0
        ? {
            nestedCalls: {
              complete: false,
              calls: [
                { id: "n1", name: "web_search", arguments: { query: "pi durable" }, status: "ok" },
                { id: "n2", name: "bash", status: "unfinished", argumentsBytes: 90_000 },
              ],
            },
          }
        : {}),
    }),
  );
  service.observe("p1", commit(big, ...results.slice(0, 20), handover(13)));
  service.observe("p1", commit(rest, ...results.slice(20), end(13)));
  await waitFor(() => runtime.requests.length === 1, "bounded request");
  const text = userText(runtime.requests[0]);
  assert.ok(text.length <= 24_000, `Q5: prompt is bounded (${text.length})`);
  assert.ok(!text.includes("QUJD"), "Q5: image data is never sent");
  assert.match(text, /1 image omitted/);
  assert.match(text, /14 more calls/, "Q5: calls past the limit are counted, not sent");
  assert.ok(text.includes("file-1.md") && text.includes("file-29.md"), "Q5: the first and the latest calls are kept");
  assert.ok(!text.includes("file-15.md"), "Q5: a call from the middle is left out");
  assert.ok(
    text.includes("web_search") && /unfinished/.test(text) && /incomplete/i.test(text),
    "nested calls as recorded, marked incomplete",
  );
  assert.ok(runtime.requests[0].options.maxTokens <= 300, "Q5: output is bounded");
  assert.equal(groupOf(service, "p1", 13, rest).calls, 30, "the group counts every call");
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT max(length(calls)) AS n FROM tool_groups").get();
  db.close();
  assert.ok(row.n === null || row.n < 40_000, "the stored input copy is bounded");
  await service.close();
}

// S2: a model that lost credentials or left the catalog fails the summary with the reason; nothing else is asked.
{
  const runtime = fakeRuntime(),
    service = open(runtime, { enabled: true, model: "nocreds/light" });
  const call = nextCall("bash", { command: "a" });
  const first = assistant(14, [call]);
  service.observe("p1", commit(first, result(14, call, "a"), end(14)));
  await waitFor(() => statusOf(service, "p1", 14, first) === "failed", "no credentials");
  assert.match(groupOf(service, "p1", 14, first).error, /credentials/);
  service.configure({ enabled: true, model: "fake/missing" });
  const other = nextCall("bash", { command: "b" });
  const otherMessage = assistant(14, [other]);
  service.observe("p1", commit(otherMessage, result(14, other, "b"), end(14)));
  await waitFor(() => statusOf(service, "p1", 14, otherMessage) === "failed", "missing model");
  assert.match(groupOf(service, "p1", 14, otherMessage).error, /not installed/);
  assert.equal(runtime.requests.length, 0, "S2: no request goes to a substitute model");
  await service.close();
}

// Q9: turning summaries off while a summary waits for the model catalog sends nothing.
{
  fresh();
  const runtime = fakeRuntime();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const service = openToolSummaries({
    path,
    settings: { enabled: true, model: MODEL },
    runtime: async () => (await gate, runtime),
    limits: LIMITS,
  });
  const call = nextCall("bash", { command: "gated" });
  const gated = assistant(15, [call]);
  service.observe("p1", commit(gated, result(15, call, "gated"), end(15)));
  service.configure({ enabled: false, model: MODEL });
  release();
  await delay(30);
  assert.equal(runtime.requests.length, 0, "Q9: no request after summaries were turned off");
  service.configure({ enabled: true, model: MODEL });
  assert.equal(pageOf(service, "p1", 15, gated), undefined, "Q9: the cancelled summary stays cancelled");
  await service.close();
}

// U3: a request stopped by turning summaries off is counted as an unknown cost.
{
  fresh();
  const runtime = fakeRuntime();
  runtime.plan.push("hang");
  const service = open(runtime);
  const call = nextCall("bash", { command: "stopped" });
  service.observe("p1", commit(assistant(16, [call]), result(16, call, "stopped"), end(16)));
  await waitFor(() => runtime.requests.length === 1, "request started");
  service.configure({ enabled: false, model: MODEL });
  await waitFor(() => service.usage("p1").get(16)?.interrupted === 1, "U3: the stopped request counts as interrupted");
  assert.equal(service.usage("p1").get(16).requests, 1);
  await service.close();
}

// Q10: a restart during the last attempt fails the summary instead of asking again.
{
  fresh();
  const hanging = fakeRuntime();
  hanging.plan.push("hang");
  let service = open(hanging, undefined, { attempts: 1 });
  const call = nextCall("bash", { command: "last" });
  const last = assistant(17, [call]);
  service.observe("p1", commit(last, result(17, call, "last"), end(17)));
  await waitFor(() => hanging.requests.length === 1, "last attempt started");
  await service.close();
  const runtime = fakeRuntime();
  service = open(runtime, undefined, { attempts: 1 });
  admit(service, "p1");
  await delay(30);
  assert.equal(runtime.requests.length, 0, "Q10: no request past the attempt limit");
  assert.equal(statusOf(service, "p1", 17, last), "failed");
  assert.equal(service.usage("p1").get(17).interrupted, 1, "the cut-off attempt still has an unknown cost");
  await service.close();
}

// Q11: a group whose results never arrive is dropped when the next assistant message shows they will not come, also a group that
// text closed while its result was still missing; it never waits or reads as a success.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  const lost = nextCall("bash", { command: "cut off" });
  const lostMessage = assistant(18, [lost]);
  service.observe("p1", commit(lostMessage));
  const next = nextCall("bash", { command: "next" });
  const nextMessage = message(18, [next]);
  service.observe("p1", commit(nextMessage));
  assert.deepEqual(
    [stored(lostMessage.value.id).status, stored(lostMessage.value.id).calls],
    ["cancelled", null],
    "Q11: the abandoned group keeps nothing",
  );
  assert.notEqual(groupOf(service, "p1", 18, nextMessage)?.id, undefined, "the next call starts its own group");
  // Text right after a call closes the group before its result; the next message shows the result will not come.
  const early = nextCall("bash", { command: "closed early" });
  const closedEarly = message(18, ["text:I will", early, "text:wait for it"]);
  service.observe("p1", commit(closedEarly));
  assert.equal(statusOf(service, "p1", 18, closedEarly), "collecting", "a closed group waits for its result");
  service.observe("p1", commit(message(18, ["text:moving on"])));
  assert.equal(stored(closedEarly.value.id).status, "cancelled", "Q11: the closed group whose result never came is dropped");
  await delay(30);
  assert.equal(runtime.requests.length, 0, "Q11: nothing incomplete is summarized");
  await service.close();
}

// Q11: the generation that made the calls ending drops a group still waiting for a result; another task, another conversation's
// turn or a turn still running keep it. A stopped turn whose calls got their aborted results in the same commit is complete.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  const running = nextCall("bash", { command: "TS-SECRET-ARG long build" });
  const longRun = assistant(19, [running]);
  service.observe("p1", commit(longRun));
  service.observe("p1", commit(task(19, { kind: "pi.tool", owner: 5 }), task(19, { kind: "pi.compaction" }), task(20)));
  service.observe("p1", commit(task(19, { status: "running" })));
  assert.equal(stored(longRun.value.id).status, "open", "Q11: other tasks and other conversations keep a running group");
  service.observe("p1", commit(handover(19)));
  const dropped = stored(longRun.value.id);
  assert.deepEqual([dropped.status, dropped.calls, dropped.waiting], ["cancelled", null, null], "Q11: the ended generation drops it");
  const stopped = nextCall("bash", { command: "sleep 100" });
  const stoppedMessage = assistant(21, [stopped]);
  service.observe("p1", commit(stoppedMessage));
  service.observe("p1", commit(end(21), result(21, stopped, "Tool bash was aborted", { isError: true })));
  await waitFor(() => statusOf(service, "p1", 21, stoppedMessage) === "ready", "stopped group summarized");
  assert.equal(runtime.requests.length, 1, "only the complete group asks the model");
  assert.ok(!userText(runtime.requests[0]).includes("TS-SECRET-ARG"), "the dropped group never reaches the model");
  await service.close();
}

// Q11: after a restart, a store reopening drops the open groups of its conversations with no running turn; however old, a group
// whose turn still runs is kept, as are other stores' groups and groups written after the store read its running turns.
{
  fresh();
  const runtime = fakeRuntime();
  let service = open(runtime);
  const ended = assistant(22, [nextCall("bash", { command: "never returns" })]);
  const running = assistant(23, [nextCall("bash", { command: "runs for days" })]);
  const other = assistant(22, [nextCall("bash", { command: "other store" })]);
  service.observe("p1", commit(ended, running));
  service.observe("p2", commit(other));
  await service.close();
  service = open(runtime);
  const before = Date.now();
  await delay(5);
  const late = assistant(24, [nextCall("bash", { command: "started during the scan" })]);
  service.observe("p1", commit(late));
  service.reconcile({ scope: "p1", running: new Set([23]), before, nested: new Set() });
  assert.deepEqual([stored(ended.value.id).status, stored(ended.value.id).calls], ["cancelled", null], "Q11: dropped at reopen");
  assert.equal(stored(running.value.id).status, "open", "Q11: a running turn's group is kept");
  assert.equal(stored(other.value.id).status, "open", "another store's group is kept");
  assert.equal(stored(late.value.id).status, "open", "a group written after the scan is kept");
  assert.equal(runtime.requests.length, 0, "Q11: nothing incomplete is summarized");
  await service.close();
}

// N1 N2: a worker's own subagents (`nested`) never queue or send a summary, live or recovered after a restart; the Coordinator's
// direct agents still do. Saved summaries of nested conversations are kept, and a store opening twice asks once.
{
  fresh();
  const runtime = fakeRuntime();
  let service = open(runtime);
  const nestedCall = nextCall("code_ls", { path: "TS-NESTED-LIVE" }),
    directCall = nextCall("code_ls", { path: "TS-DIRECT-LIVE" });
  const nestedMessage = assistant(40, [nestedCall]),
    directMessage = assistant(41, [directCall]);
  service.observe("p1", commit(nestedMessage, result(40, nestedCall, "listed"), end(40)), new Set([40]));
  service.observe("p1", commit(directMessage, result(41, directCall, "listed"), end(41)), new Set([40]));
  await waitFor(() => statusOf(service, "p1", 41, directMessage) === "ready", "N1: a direct agent's summary");
  await delay(20);
  assert.equal(stored(nestedMessage.value.id), undefined, "N1: a nested message opens no group");
  await service.close();
  // Groups written before nested conversations were left out: queued, cut off while running, still collecting and still open.
  const db = new DatabaseSync(path);
  const insert = db.prepare(
    "INSERT INTO tool_groups (scope, conversation, first_entry, first_call, last_entry, status, size, waiting, calls, text, attempts, requests, created, updated) VALUES ('p1', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, 0)",
  );
  const copy = (marker, result) => JSON.stringify({ calls: [{ id: `c-${marker}`, name: "bash", args: marker, result }], more: 0 });
  const done = { text: "ok", isError: false, images: 0, nested: null };
  insert.run(42, 9101, "c-1", 9101, "pending", null, copy("TS-NESTED-PENDING", done), null, 0, 0);
  insert.run(42, 9102, "c-2", 9102, "running", null, copy("TS-NESTED-RUNNING", done), null, 1, 1);
  insert.run(
    42,
    9103,
    "c-TS-NESTED-COLLECTING",
    9103,
    "collecting",
    '["c-TS-NESTED-COLLECTING"]',
    copy("TS-NESTED-COLLECTING", null),
    null,
    0,
    0,
  );
  insert.run(42, 9104, "c-4", 9104, "ready", null, null, "Saved nested summary.", 1, 1);
  insert.run(43, 9105, "c-5", 9105, "pending", null, copy("TS-DIRECT-PENDING", done), null, 0, 0);
  for (const [conversation, entry, call] of [
    [42, 9103, "c-TS-NESTED-COLLECTING"],
    [42, 9104, "c-4"],
    [43, 9105, "c-5"],
  ])
    db.prepare(
      "INSERT INTO tool_group_calls (scope, conversation, entry, call, grp) SELECT 'p1', ?, ?, ?, id FROM tool_groups WHERE first_entry = ?",
    ).run(conversation, entry, call, entry);
  db.close();
  const before = runtime.requests.length;
  service = open(runtime);
  await delay(30);
  assert.equal(runtime.requests.length, before, "N2: nothing recovered is sent before its store opens");
  admit(service, "p1", { running: [42, 43], nested: [42] });
  admit(service, "p1", { running: [42, 43], nested: [42] });
  const read = (conversationId, entry, call) => service.read({ scope: "p1", conversationId, calls: [{ entry, call, name: "bash" }] });
  await waitFor(() => Object.values(read(43, 9105, "c-5")?.groups ?? {})[0]?.status === "ready", "N2: a direct agent's recovered summary");
  service.observe("p1", commit(result(42, { id: "c-TS-NESTED-COLLECTING", name: "bash" }, "late")), new Set([42]));
  await delay(30);
  for (const entry of [9101, 9102, 9103])
    assert.deepEqual([stored(entry).status, stored(entry).calls], ["cancelled", null], `N2: recovered nested group ${entry} is dropped`);
  assert.equal(Object.values(read(42, 9104, "c-4").groups)[0]?.text, "Saved nested summary.", "N2: a saved nested summary is kept");
  assert.equal(runtime.requests.length, before + 1, "N2: one request, for the direct agent only, though its store opened twice");
  assert.ok(!runtime.requests.some((request) => userText(request).includes("TS-NESTED")), "N1 N2: no nested call reaches the model");
  await service.close();
}

// C1: summaries written per assistant message before groups stay readable as groups of that message's calls; a per-message row
// in flight at the upgrade is cancelled once (a running request counts as interrupted) and sends nothing.
{
  fresh();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE summaries (
      scope TEXT NOT NULL, conversation INTEGER NOT NULL, entry INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('collecting','pending','running','ready','failed','cancelled')),
      waiting TEXT, calls TEXT, text TEXT, error TEXT, model TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, interrupted INTEGER NOT NULL DEFAULT 0, usage TEXT,
      created INTEGER NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (scope, entry));`);
  const legacy = db.prepare(
    "INSERT INTO summaries (scope, conversation, entry, status, waiting, calls, text, error, model, attempts, requests, usage, created, updated) VALUES ('p1', 60, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
  );
  const copy = (marker, result) => JSON.stringify({ calls: [{ id: `c-${marker}`, name: "bash", args: marker, result }], more: 0 });
  const done = { text: "ok", isError: false, images: 0, nested: null };
  const spent = JSON.stringify(usage(100, 20, 0.001));
  legacy.run(9201, "ready", null, null, "Old per-message summary.", null, MODEL, 1, 1, spent);
  legacy.run(9202, "failed", null, null, null, "Old failure", MODEL, 3, 3, null);
  legacy.run(9203, "pending", null, copy("TS-LEGACY-PENDING", done), null, null, null, 0, 0, null);
  legacy.run(9204, "running", null, copy("TS-LEGACY-RUNNING", done), null, null, MODEL, 1, 1, null);
  legacy.run(9205, "collecting", '["c-TS-LEGACY-COLLECTING"]', copy("TS-LEGACY-COLLECTING", null), null, null, null, 0, 0, null);
  db.close();
  const runtime = fakeRuntime();
  let service = open(runtime);
  admit(service, "p1", { running: [60] });
  service.observe("p1", commit(result(60, { id: "c-TS-LEGACY-COLLECTING", name: "bash" }, "late"), end(60)));
  await delay(50);
  assert.equal(runtime.requests.length, 0, "C1: no request under the old rule");
  const page = service.read({
    scope: "p1",
    conversationId: 60,
    calls: [
      { entry: 9201, call: "old-a", name: "read" },
      { entry: 9201, call: "old-b", name: "bash" },
      { entry: 9201, call: "old-m", name: "projects_knowledge_read" },
      { entry: 9202, call: "old-c", name: "bash" },
      { entry: 9203, call: "c-TS-LEGACY-PENDING", name: "bash" },
      { entry: 9204, call: "c-TS-LEGACY-RUNNING", name: "bash" },
      { entry: 9205, call: "c-TS-LEGACY-COLLECTING", name: "bash" },
    ],
  });
  const old = page.groups[page.calls["9201:old-a"]];
  assert.deepEqual(
    [old.status, old.text, old.calls],
    ["ready", "Old per-message summary.", 2],
    "C1: a saved summary reads as its message's group",
  );
  assert.equal(page.calls["9201:old-b"], page.calls["9201:old-a"], "C1: both calls of the old message share it");
  assert.equal(page.calls["9201:old-m"], undefined, "C1: the memory call stays out of it");
  assert.equal(page.groups[page.calls["9202:old-c"]].status, "failed", "C1: a saved failure still reads");
  for (const entry of [9203, 9204, 9205])
    assert.equal(
      Object.keys(page.calls).some((key) => key.startsWith(`${entry}:`)),
      false,
      `C1: in-flight ${entry} reads as none`,
    );
  const legacyRows = () => {
    const read = new DatabaseSync(path, { readOnly: true });
    const rows = read
      .prepare("SELECT entry, status, calls, interrupted FROM summaries ORDER BY entry")
      .all()
      .map((row) => ({ ...row }));
    read.close();
    return rows;
  };
  assert.deepEqual(
    legacyRows()
      .slice(2)
      .map((row) => [row.status, row.calls, row.interrupted]),
    [
      ["cancelled", null, 0],
      ["cancelled", null, 1],
      ["cancelled", null, 0],
    ],
    "C1: in-flight rows are cancelled once and drop their copy; the cut-off request counts as interrupted",
  );
  const counted = service.usage("p1").get(60);
  assert.deepEqual([counted.summaries, counted.requests, counted.interrupted], [1, 5, 1], "C1: old usage still counts");
  await service.close();
  service = open(runtime);
  admit(service, "p1", { running: [60] });
  assert.deepEqual(legacyRows()[3].interrupted, 1, "C1: reopening counts nothing twice");
  await service.close();
}

// Q12: arguments, nested arguments and results are cut by a bounded walk; nothing is serialized or read whole.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  let reads = 0;
  const counted = (length, item) =>
    new Proxy([], {
      get(target, key) {
        if (key === "length") return length;
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads++;
          return item(Number(key));
        }
        return Reflect.get(target, key);
      },
    });
  let deep = { leaf: "TS-DEEP-LEAF" };
  for (let i = 0; i < 100_000; i++) deep = { next: deep };
  const wide = counted(1_000_000, (i) => i);
  const call = nextCall("codemode", { deep, wide, long: "z".repeat(2_000_000) + "TS-LONG-TAIL" });
  const walked = assistant(70, [call]);
  const done = result(70, call, "", {
    nestedCalls: { complete: true, calls: [{ id: "n1", name: "bash", arguments: { deep, wide }, status: "ok" }] },
  });
  done.value.model[0].content = counted(1_000_000, () => ({ type: "text", text: "r" }));
  service.observe("p1", commit(walked));
  service.observe("p1", commit(done, end(70)));
  await waitFor(() => runtime.requests.length === 1, "bounded request");
  const text = userText(runtime.requests[0]);
  assert.ok(reads < 500, `Q12: only the head of large arrays is read (${reads} reads)`);
  assert.ok(!text.includes("TS-DEEP-LEAF") && !text.includes("TS-LONG-TAIL"), "cut values do not reach the model");
  assert.match(text, /more\]/, "Q12: a cut array says so");
  assert.match(text, /\{…\}/, "Q12: levels past the depth limit are marked");
  assert.match(text, /more parts/, "Q12: unread result parts are counted");
  await service.close();
}

// Q13: damaged groups fail quietly, drop their copy and block nothing; usage skips a damaged record; reads write nothing.
{
  fresh();
  const runtime = fakeRuntime();
  await open(runtime).close();
  const db = new DatabaseSync(path);
  const insert = db.prepare(
    "INSERT INTO tool_groups (scope, conversation, first_entry, first_call, last_entry, status, size, waiting, calls, text, usage, requests, created, updated) VALUES ('p1', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?)",
  );
  const member = db.prepare(
    "INSERT INTO tool_group_calls (scope, conversation, entry, call, grp) SELECT 'p1', ?, ?, ?, id FROM tool_groups WHERE first_entry = ?",
  );
  const damaged = [
    [25, 9001, "call-x", "collecting", '["call-x"]', "TS-DAMAGED not json", null, null, 0, Date.now()],
    [26, 9002, "call-2", "pending", null, '{"calls":5,"more":0}', null, null, 0, Date.now()],
    [27, 9003, "call-3", "ready", null, null, "Fine summary.", '{"input":"lots"}', 1, Date.now()],
    [28, 9004, "call-y", "open", '{"not":"a list"}', '{"calls":[],"more":0}', null, null, 0, Date.now()],
    [29, 9005, "call-5", "ready", null, null, null, null, 0, 1],
    [
      31,
      9006,
      "call-6",
      "pending",
      null,
      '{"calls":[{"id":"c","name":"bash","args":"TS-DAMAGED-OPEN","result":null}],"more":0}',
      null,
      null,
      0,
      Date.now(),
    ],
  ];
  for (const [conversation, entry, call, status, waiting, calls, text, spent, requests, updated] of damaged) {
    insert.run(conversation, entry, call, entry, status, waiting, calls, text, spent, requests, updated);
    member.run(conversation, entry, call, entry);
  }
  db.close();
  const service = open(runtime);
  admit(service, "p1", { running: [25, 28] });
  service.observe("p1", commit(result(25, { id: "call-x", name: "bash" }, "x")));
  service.observe("p1", commit(result(28, { id: "call-y", name: "bash" }, "y")));
  const view = (conversationId, entry, call) =>
    Object.values(service.read({ scope: "p1", conversationId, calls: [{ entry, call, name: "bash" }] })?.groups ?? {})[0];
  await waitFor(() => view(26, 9002, "call-2")?.status === "failed", "Q13: a damaged queued group fails");
  for (const [conversation, entry, call] of [
    [25, 9001, "call-x"],
    [26, 9002, "call-2"],
    [28, 9004, "call-y"],
    [31, 9006, "call-6"],
  ]) {
    assert.match(view(conversation, entry, call)?.error ?? "", /damaged/, `Q13: group ${entry} fails as damaged`);
    assert.equal(stored(entry).calls, null, `Q13: group ${entry} drops its copy`);
  }
  assert.equal(view(27, 9003, "call-3")?.text, "Fine summary.", "a sound group next to damaged ones still reads");
  assert.equal(service.usage("p1").get(27)?.usage.cost.total, 0, "Q13: a damaged usage record counts as nothing");
  assert.equal(view(29, 9005, "call-5")?.status, "failed", "Q13: a ready group without text reads as failed");
  assert.equal(stored(9005).updated, 1, "reading a damaged group writes nothing");
  const fine = nextCall("bash", { command: "fine" });
  const fineMessage = assistant(30, [fine]);
  service.observe("p1", commit(fineMessage, result(30, fine, "ok"), end(30)));
  await waitFor(() => statusOf(service, "p1", 30, fineMessage) === "ready", "Q13: damaged groups block nothing");
  assert.ok(!runtime.requests.some((request) => userText(request).includes("TS-DAMAGED")), "Q13: damaged data never reaches the model");
  await service.close();
}

rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ status: "passed" }));
