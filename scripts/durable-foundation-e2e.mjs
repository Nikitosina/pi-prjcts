import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "artifacts", `durable-${new Date().toISOString().replaceAll(":", "-")}`);
const workspace = join(dir, "workspace"); mkdirSync(workspace, { recursive: true });
const marker = `INDEX_${randomUUID()}`, secret = `TOPIC_${randomUUID()}`, steer = `STEER_${randomUUID()}`;
const config = { dir, workspace, marker, secret, provider: "openai-codex", modelId: "gpt-5.6-luna" };
writeFileSync(join(dir, "config.json"), JSON.stringify(config));
const checks = [];
function save(name, value) { writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n"); }
function assistantText(view) {
  return (view?.entries ?? []).flatMap(entry => entry.model ?? []).filter(message => message.role === "assistant").flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text)).join("\n");
}
function check(name, value) { assert.ok(value, name); checks.push(name); save("assertions.json", checks); process.stderr.write(`PASS ${name}\n`); }
async function until(name, read) {
  const end = Date.now() + 180000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(100); }
  throw new Error(`Timed out: ${name}`);
}
function launch() {
  const process = spawn(globalThis.process.execPath, [join(root, "scripts", "durable-fixture.ts"), join(dir, "config.json")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(); let stderr = "";
  process.stderr.on("data", data => { stderr += data; writeFileSync(join(dir, `stderr-${process.pid}.log`), stderr); });
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  createInterface({ input: process.stdout }).on("line", line => {
    let reply; try { reply = JSON.parse(line); } catch { rejectReady(new Error(`Non-JSON fixture output: ${line}`)); return; }
    if ("ready" in reply) { if (reply.ready) resolveReady(reply); else rejectReady(new Error(reply.error)); return; }
    const item = pending.get(reply.id); if (!item) return;
    pending.delete(reply.id); if (reply.ok) item.resolve(reply.value); else item.reject(new Error(reply.error));
  });
  const exited = new Promise(resolve => process.on("exit", (code, signal) => {
    const error = new Error(`Fixture exited ${code}/${signal}: ${stderr}`); rejectReady(error);
    for (const item of pending.values()) item.reject(error); pending.clear(); resolve({ code, signal });
  }));
  process.on("error", rejectReady);
  function call(op, input = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture ${op} timed out`)); }, 180000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      process.stdin.write(JSON.stringify({ id, op, ...input }) + "\n");
    });
  }
  return { process, ready, exited, call };
}
let host;
try {
  host = launch(); const info = await host.ready; save("dependencies.json", info);
  check("Pinned Durable uses the installed Pi 1.0 shared libraries", info.durable === "1.0.0" && info.pi === "1.0.0" && info.sharedLibraries);
  const duplicate = launch(); let denied;
  try { await duplicate.ready; } catch (error) { denied = error.message; }
  duplicate.process.kill("SIGKILL"); await duplicate.exited;
  check("Only one process owns Durable storage", /owned|locked/i.test(denied ?? ""));
  const greeting = { text: "Only answer HELLO_DURABLE.", requestId: "greeting" };
  const first = await host.call("say", greeting), again = await host.call("say", greeting);
  check("Real-model coordinator responds", first.text.includes("HELLO_DURABLE"));
  check("Retried submission reuses its identity and answer", first.id === again.id && first.answer === again.answer);
  await host.call("say", { text: "Use projects_delegate to start worker reader. Task: call fixture_read_wait with tag reading, then projects_knowledge_read for research/proof.md and answer its exact TOPIC_ value. Do not do the task yourself.", requestId: "delegate" });
  const before = await until("background reader starts", async () => {
    const s = await host.call("snapshot"); return s.workers.agents.reader && existsSync(join(dir, "started-reading")) ? s : null;
  });
  check("Coordinator delegates to a background conversation", !!before.workers.agents.reader.conversationId);
  const quick = await host.call("say", { text: "Only answer QUICK_REPLY; do not wait for reader.", requestId: "quick" });
  check("Coordinator remains available while worker is busy", quick.text.includes("QUICK_REPLY") && !existsSync(join(dir, "release-reading")));
  await host.call("send", { name: "reader", text: `After the read completes, include ${steer} with the exact TOPIC_ value.`, requestId: "steer-reader", steer: true });
  const readerId = before.workers.agents.reader.conversationId;
  host.process.kill("SIGKILL"); await host.exited;
  host = launch(); await host.ready;
  check("Restart preserves the worker conversation identity", (await host.call("snapshot")).workers.agents.reader.conversationId === readerId);
  await until("safe read replays", async () => readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(line => line.includes('"tag":"reading"')).length >= 2);
  writeFileSync(join(dir, "release-reading"), "go");
  const answered = await until("worker answer reports once", async () => {
    const s = await host.call("snapshot"); return s.workers.agents.reader.reported.length && assistantText(s.conversations.reader).includes(steer) && assistantText(s.conversations.reader).includes(secret) ? s : null;
  });
  save("answered.json", answered);
  const reads = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(call => call.event === "read" && call.tag === "reading");
  check("Safe interrupted read replays after SIGKILL", reads.length >= 2 && reads[0].taskId === reads[1].taskId);
  check("Steering survives restart and reaches the intended worker", assistantText(answered.conversations.reader).includes(steer));
  await host.call("idle");
  check("Two worker submissions produce one report for a shared answer", (await host.call("snapshot")).workers.agents.reader.reported.length === 1);
  const prompts = readFileSync(join(dir, "prompts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  check("Coordinator and worker initially receive only the memory index", prompts.filter(p => p.initial).length >= 2 && prompts.filter(p => p.initial).every(p => JSON.stringify(p.messages).includes(marker) && !JSON.stringify(p.messages).includes(secret)));
  await host.call("send", { name: "reader", text: "Call fixture_mutate with tag denied, then report the tool result. Do not try other ways to edit files.", requestId: "denied-mutation", steer: false });
  await until("approval recorded", async () => (await host.call("snapshot")).approvals.reader?.questions.length);
  check("Execution gate blocks an unapproved mutation", readFileSync(join(workspace, "canary.txt"), "utf8") === "KEEP");
  await host.call("idle"); host.process.kill("SIGKILL"); await host.exited;
  host = launch(); await host.ready;
  check("Pending approval survives restart", (await host.call("snapshot")).approvals.reader.questions.length >= 1);
  const dispatches = () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(call => call.event === "model_dispatch").length;
  const beforeBad = dispatches();
  const memory = join(dir, "knowledge", "MEMORY.md"); writeFileSync(memory, "界".repeat(3001));
  const bad = await host.call("say", { text: "Only answer INVALID_SHOULD_NOT_RUN.", requestId: "invalid-index" }); save("invalid-index.json", bad);
  check("Oversized manual index fails before model dispatch", bad.status === "unanswered" && !bad.text.includes("INVALID_SHOULD_NOT_RUN") && dispatches() === beforeBad);
  writeFileSync(memory, `# Memory\n${marker}\n`);
  check("Owner can repair memory without losing conversation", (await host.call("say", { text: "Only answer REPAIRED.", requestId: "repair" })).text.includes("REPAIRED"));
  const state = await host.call("snapshot"); save("final.json", state);
  check("Usage is recorded for real-model conversations", Object.keys(state.usage.models).length > 0);
  save("report.json", { ok: true, checks, dependencyEvidence: "dependencies.json", repeat: "npm run e2e:durable-foundation", scope: "Isolated Durable prototype, not production migration" });
  process.stdout.write(`${dir}/report.json\n`);
} catch (error) { save("failure.json", { error: error.stack ?? String(error), checks }); throw error; }
finally { if (host) { host.process.kill("SIGKILL"); await host.exited; } }
