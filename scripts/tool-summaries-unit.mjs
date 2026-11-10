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
  callN = 0;
const commit = (...changes) => ({ seq: seq++, changes });
const nextCall = (name, args = {}) => ({ id: `call-${++callN}`, name, args });
const assistant = (conversationId, calls, at = 1_000) => ({
  type: "entry",
  value: {
    id: ++entryId,
    conversationId,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
        ],
        timestamp: at,
      },
    ],
  },
});
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
const statusOf = (service, scope, conversationId, entry) => service.read(scope, conversationId, [entry]).get(entry);

// G1 G2 Q6 Q7: one summary per assistant message, only after every result; no tools; untrusted data framing; one or two sentences.
{
  const runtime = fakeRuntime(),
    service = open(runtime);
  const changed = [];
  service.watch("p1", (conversationId) => changed.push(conversationId));
  const a = nextCall("read", { path: "src/web.ts" }),
    b = nextCall("bash", { command: "npm run check" });
  const first = assistant(7, [a, b]);
  service.observe("p1", commit(first));
  service.observe("p1", commit(result(7, a, "file text")));
  await delay(20);
  assert.equal(runtime.requests.length, 0, "G2: no summary before every call of the message has a result");
  assert.equal(statusOf(service, "p1", 7, first.value.id), undefined, "a message still collecting results reads as no summary");
  runtime.plan.push("Read src/web.ts and ran the type check. It found two errors in web.ts. Then it did more. And more again.");
  service.observe("p1", commit(result(7, b, "2 errors", { isError: true })));
  await waitFor(() => statusOf(service, "p1", 7, first.value.id)?.status === "ready", "first summary ready");
  assert.equal(runtime.requests.length, 1);
  const request = runtime.requests[0];
  assert.equal(request.model, MODEL);
  assert.ok(!request.context.tools?.length && !request.options?.tools, "Q6: the summary model gets no tools");
  assert.match(request.context.systemPrompt, /untrusted/i, "Q6: tool text is framed as untrusted data");
  assert.match(request.context.systemPrompt, /two sentences/i, "S5: the prompt fixes the length");
  const text = userText(request);
  assert.ok(text.includes("src/web.ts") && text.includes("npm run check") && text.includes("2 errors"), "both calls and results are sent");
  assert.ok(!text.includes("Let me look."), "the assistant's own text is not sent, only calls and results");
  const view = statusOf(service, "p1", 7, first.value.id);
  assert.equal(view.text, "Read src/web.ts and ran the type check. It found two errors in web.ts.", "Q6: cut to two sentences");
  assert.equal(view.model, MODEL);
  assert.ok(changed.includes(7), "a state change notifies the conversation");

  // A second message of the same turn is its own summary (G1).
  const c = nextCall("edit", { path: "src/web.ts" });
  const second = assistant(7, [c]);
  service.observe("p1", commit(second, result(7, c, "edited")));
  await waitFor(() => statusOf(service, "p1", 7, second.value.id)?.status === "ready", "second summary ready");
  assert.equal(runtime.requests.length, 2);
  assert.ok(!userText(runtime.requests[1]).includes("npm run check"), "G1: the second summary covers only its own message");

  // G3: the same commits again change nothing.
  service.observe("p1", commit(first, result(7, a, "file text"), result(7, b, "2 errors", { isError: true })));
  await delay(30);
  assert.equal(runtime.requests.length, 2, "G3: a commit seen twice does not summarize twice");

  // G6: reads have no side effects.
  const db = new DatabaseSync(path, { readOnly: true });
  const before = db.prepare("SELECT COUNT(*) AS n, MAX(updated) AS u FROM summaries").get();
  service.read("p1", 7, [first.value.id, second.value.id, 9999]);
  service.usage("p1");
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n, MAX(updated) AS u FROM summaries").get(), before, "G6: reads write nothing");
  // Q8: a finished row keeps no copy of the calls.
  const stored = db.prepare("SELECT calls FROM summaries WHERE entry = ?").get(first.value.id);
  assert.equal(stored.calls, null, "Q8: the bounded input copy is dropped once the summary is done");
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

// G4: memory calls keep their own rows: they are left out of the summary, and a memory-only message gets none.
{
  const runtime = fakeRuntime(),
    service = open(runtime);
  const memory = nextCall("projects_knowledge_read", { path: "preferences.md" });
  const only = assistant(8, [memory]);
  service.observe("p1", commit(only, result(8, memory, "prefs")));
  const mem2 = nextCall("projects_knowledge_write", { path: "decisions/x.md" }),
    bash = nextCall("bash", { command: "ls" });
  const mixed = assistant(8, [mem2, bash]);
  service.observe("p1", commit(mixed, result(8, mem2, "written"), result(8, bash, "a b c")));
  await waitFor(() => statusOf(service, "p1", 8, mixed.value.id)?.status === "ready", "mixed summary");
  assert.equal(statusOf(service, "p1", 8, only.value.id), undefined, "G4: no summary for a memory-only message");
  assert.equal(runtime.requests.length, 1);
  assert.ok(!userText(runtime.requests[0]).includes("decisions/x.md"), "G4: the memory call is not part of the summary");
  await service.close();
}

// G5 S3 S4: disabled calls are never summarized, enabling does not backfill, disabling cancels queued work, a model change applies at once.
{
  const runtime = fakeRuntime();
  let service = open(runtime, { enabled: false, model: MODEL });
  const off = nextCall("bash", { command: "echo off" });
  const offMessage = assistant(9, [off]);
  service.observe("p1", commit(offMessage, result(9, off, "off")));
  const straddle = nextCall("bash", { command: "echo straddle" });
  const straddleMessage = assistant(9, [straddle]);
  service.observe("p1", commit(straddleMessage));
  service.configure({ enabled: true, model: MODEL });
  service.observe("p1", commit(result(9, straddle, "done")));
  await delay(30);
  assert.equal(runtime.requests.length, 0, "G5: enabling summarizes nothing that started while summaries were off");
  assert.equal(service.read("p1", 9, [offMessage.value.id]).size, 0);

  // Enabled at the call, disabled before its results: cancelled, and re-enabling does not bring it back.
  const late = nextCall("bash", { command: "echo late" });
  const lateMessage = assistant(9, [late]);
  service.observe("p1", commit(lateMessage));
  service.configure({ enabled: false, model: MODEL });
  service.observe("p1", commit(result(9, late, "late")));
  service.configure({ enabled: true, model: MODEL });
  await delay(30);
  assert.equal(runtime.requests.length, 0, "S3: results that arrive while off are not summarized");

  // Queued work stops when summaries are turned off.
  await service.close();
  service = open(runtime, { enabled: true, model: MODEL }, { concurrency: 1 });
  runtime.plan.push("hang");
  const busy = nextCall("bash", { command: "echo busy" }),
    queued = nextCall("bash", { command: "echo queued" });
  const busyMessage = assistant(9, [busy]),
    queuedMessage = assistant(9, [queued]);
  service.observe("p1", commit(busyMessage, result(9, busy, "x")));
  await waitFor(() => runtime.requests.length === 1, "busy request started");
  service.observe("p1", commit(queuedMessage, result(9, queued, "y")));
  assert.equal(statusOf(service, "p1", 9, queuedMessage.value.id)?.status, "pending", "queued behind the concurrency limit");
  service.configure({ enabled: false, model: MODEL });
  await delay(30);
  assert.equal(runtime.requests.length, 1, "S3: queued work does not run after disabling");
  service.configure({ enabled: true, model: MODEL });
  assert.equal(service.read("p1", 9, [busyMessage.value.id, queuedMessage.value.id]).size, 0, "cancelled summaries read as none");

  // S4: the next summary uses the new model without reopening.
  service.configure({ enabled: true, model: OTHER });
  const next = nextCall("bash", { command: "echo next" });
  const nextMessage = assistant(9, [next]);
  service.observe("p1", commit(nextMessage, result(9, next, "z")));
  await waitFor(() => statusOf(service, "p1", 9, nextMessage.value.id)?.status === "ready", "summary with the new model");
  assert.equal(runtime.requests.at(-1).model, OTHER);
  assert.equal(statusOf(service, "p1", 9, nextMessage.value.id).model, OTHER);

  // D5: while off, reads attach nothing even for cached summaries; turning on shows them again.
  service.configure({ enabled: false, model: OTHER });
  assert.equal(service.read("p1", 9, [nextMessage.value.id]).size, 0, "D5: summaries off reads as none");
  service.configure({ enabled: true, model: OTHER });
  assert.equal(statusOf(service, "p1", 9, nextMessage.value.id)?.status, "ready", "cached summaries come back");
  await service.close();
}

// Q1 Q2 U2: a request cut off by a restart is resumed after it and counted as unknown cost.
{
  fresh();
  const hanging = fakeRuntime();
  hanging.plan.push("hang");
  let service = open(hanging);
  const call = nextCall("bash", { command: "sleep" });
  const message = assistant(10, [call]);
  service.observe("p1", commit(message, result(10, call, "slept")));
  await waitFor(() => hanging.requests.length === 1, "request started");
  await service.close();
  // A crash leaves the row running; the next open finds it, too.
  const runtime = fakeRuntime();
  service = open(runtime);
  await waitFor(() => statusOf(service, "p1", 10, message.value.id)?.status === "ready", "Q1: the summary finishes after the restart");
  const spent = service.usage("p1").get(10);
  assert.equal(spent.interrupted, 1, "U2: the cut-off request is counted as unknown cost");
  assert.equal(spent.requests, 2);
  assert.equal(runtime.requests.length, 1, "the restarted host asks once");

  // A message collecting results over a restart still completes once its last result arrives.
  const x = nextCall("bash", { command: "x" }),
    y = nextCall("bash", { command: "y" });
  const split = assistant(10, [x, y]);
  service.observe("p1", commit(split, result(10, x, "x done")));
  await service.close();
  service = open(runtime);
  service.observe("p1", commit(result(10, y, "y done")));
  await waitFor(() => statusOf(service, "p1", 10, split.value.id)?.status === "ready", "collecting survives restart");
  assert.ok(userText(runtime.requests.at(-1)).includes("x done"), "the result committed before the restart is part of the input");
  await service.close();
}

// Q3: failures are retried a bounded number of times, then the summary fails quietly; a hang counts as a timed-out attempt.
{
  const runtime = fakeRuntime();
  runtime.plan.push("error", "hang", "error");
  const service = open(runtime, undefined, { timeoutMs: 50, attempts: 3 });
  const call = nextCall("bash", { command: "boom" });
  const message = assistant(11, [call]);
  service.observe("p1", commit(message, result(11, call, "boom")));
  await waitFor(() => statusOf(service, "p1", 11, message.value.id)?.status === "failed", "Q3: failed after the attempt limit");
  await delay(30);
  assert.equal(runtime.requests.length, 3, "Q3: exactly the attempt limit");
  assert.match(statusOf(service, "p1", 11, message.value.id).error, /provider exploded|timed out/);
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
    const message = assistant(12, [call]);
    messages.push(message);
    service.observe("p1", commit(message, result(12, call, `ok ${i}`)));
  }
  await waitFor(() => runtime.requests.length === 2, "two requests");
  await delay(30);
  assert.equal(runtime.peak(), 2, "Q4: concurrency limit");
  const states = messages.map((message) => statusOf(service, "p1", 12, message.value.id));
  assert.equal(states.filter((item) => item?.status === "pending").length, 4);
  assert.equal(states.filter((item) => item?.status === "failed").length, 2, "Q4: messages past the queue limit fail instead of queueing");
  assert.match(states.at(-1).error, /queue/i);
  await service.close();
}

// Q5: bounded input, no binary data, nested codemode calls only as recorded.
{
  fresh();
  const runtime = fakeRuntime(),
    service = open(runtime);
  const calls = Array.from({ length: 30 }, (_, i) =>
    nextCall(i === 0 ? "codemode" : "read", { path: `file-${i}`, blob: "x".repeat(1_000_000) }),
  );
  const message = assistant(13, calls);
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
  service.observe("p1", commit(message, ...results));
  await waitFor(() => runtime.requests.length === 1, "bounded request");
  const text = userText(runtime.requests[0]);
  assert.ok(text.length <= 24_000, `Q5: prompt is bounded (${text.length})`);
  assert.ok(!text.includes("QUJD"), "Q5: image data is never sent");
  assert.match(text, /1 image omitted/);
  assert.match(text, /14 more calls/, "Q5: calls past the limit are counted, not sent");
  assert.ok(
    text.includes("web_search") && /unfinished/.test(text) && /incomplete/i.test(text),
    "nested calls as recorded, marked incomplete",
  );
  assert.ok(runtime.requests[0].options.maxTokens <= 300, "Q5: output is bounded");
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT length(calls) AS n FROM summaries WHERE entry = ?").get(message.value.id);
  db.close();
  assert.ok(row.n === null || row.n < 40_000, "the stored input copy is bounded");
  await service.close();
}

// S2: a model that lost credentials or left the catalog fails the summary with the reason; nothing else is asked.
{
  const runtime = fakeRuntime(),
    service = open(runtime, { enabled: true, model: "nocreds/light" });
  const call = nextCall("bash", { command: "a" });
  const message = assistant(14, [call]);
  service.observe("p1", commit(message, result(14, call, "a")));
  await waitFor(() => statusOf(service, "p1", 14, message.value.id)?.status === "failed", "no credentials");
  assert.match(statusOf(service, "p1", 14, message.value.id).error, /credentials/);
  service.configure({ enabled: true, model: "fake/missing" });
  const other = nextCall("bash", { command: "b" });
  const otherMessage = assistant(14, [other]);
  service.observe("p1", commit(otherMessage, result(14, other, "b")));
  await waitFor(() => statusOf(service, "p1", 14, otherMessage.value.id)?.status === "failed", "missing model");
  assert.match(statusOf(service, "p1", 14, otherMessage.value.id).error, /not installed/);
  assert.equal(runtime.requests.length, 0, "S2: no request goes to a substitute model");
  await service.close();
}

rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ status: "passed" }));
