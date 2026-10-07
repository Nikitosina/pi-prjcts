import { RpcClient } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as rawRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ensureHost, health, request } from "../src/client.ts";
import { Job, Note, Project, Snapshot, parse, readJson, saveJson, socketPath, errorText, type Snapshot as View } from "../src/state.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const evidence = join(packageRoot, "artifacts", new Date().toISOString().replaceAll(":", "-"));
const workspace = join(evidence, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.PI_PROJECTS_HOME = join(evidence, "state");
const token = randomUUID();
writeFileSync(join(workspace, "expected.txt"), token);
writeFileSync(join(workspace, "canary.txt"), "KEEP");
symlinkSync(evidence, join(workspace, "outside-link"));
writeFileSync(join(workspace, "verify.mjs"), `import fs from 'node:fs';\nimport assert from 'node:assert/strict';\nassert.equal(fs.readFileSync('proof.txt', 'utf8').trim(), fs.readFileSync('expected.txt', 'utf8'));\nfs.writeFileSync('verification.json', JSON.stringify({ok:true,token:fs.readFileSync('expected.txt','utf8')}));\n`);
const assertions: { name: string; at: string }[] = [];
let client: RpcClient | undefined;
let projectId: string | undefined;
function check(name: string, condition: boolean) {
  if (!condition) throw new Error(`Assertion failed: ${name}`);
  assertions.push({ name, at: new Date().toISOString() });
  process.stderr.write(`PASS ${name}\n`);
  saveJson(join(evidence, "assertions.json"), assertions);
}
async function snapshot(): Promise<View> {
  if (!projectId) throw new Error("Project not created");
  return parse(Snapshot, await request({ action: "show", id: projectId }));
}
async function until(name: string, predicate: (view: View) => boolean, timeout = 360000): Promise<View> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const view = await snapshot();
    saveJson(join(evidence, "latest.json"), view);
    const failed = view.jobs.find(job => job.state === "failed");
    if (failed) throw new Error(`${name}: coordinator failed: ${failed.error}`);
    if (predicate(view)) return view;
    await sleep(1000);
  }
  throw new Error(`Timed out: ${name}`);
}
async function send(text: string) {
  if (!projectId) throw new Error("Project not created");
  return parse(Job, await request({ action: "message", id: projectId, text }));
}
async function rejection(input: Parameters<typeof request>[0], expected: string) {
  try { await request(input); } catch (error) { check(expected, errorText(error).includes(expected)); return; }
  throw new Error(`Expected rejection: ${expected}`);
}
async function malformed(body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = rawRequest({ socketPath: socketPath(), path: "/api", method: "POST" }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode ?? 0));
    });
    call.on("error", reject); call.end(body);
  });
}
async function openClient(id: string) {
  const cliPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
  const rpc = new RpcClient({ cliPath, cwd: workspace, env: { PI_PROJECTS_HOME: process.env.PI_PROJECTS_HOME ?? "" }, args: ["--no-session", "--no-approve", "--extension", join(packageRoot, "src", "extension.ts")] });
  await rpc.start();
  const commands = await rpc.getCommands();
  check("Projects extension loads in actual Pi", commands.some(command => command.name === "project-open"));
  check("Project open is handled without a local model turn", await rpc.prompt(`/project-open ${id}`) === "handled");
  return rpc;
}

try {
  await Promise.all([ensureHost(), ensureHost()]);
  const Health = Type.Object({ pid: Type.Number() });
  const firstHost = parse(Health, await health());
  check("Concurrent clients share one host", parse(Health, await health()).pid === firstHost.pid);
  check("Malformed input rejected", await malformed("not-json") === 400);
  check("Oversized body rejected", await malformed(JSON.stringify({ action: "list", extra: "x".repeat(70000) })) === 400);
  check("Traversal project ID rejected", await malformed(JSON.stringify({ action: "show", id: "../../auth.json" })) === 400);
  const project = parse(Project, await request({ action: "create", name: "Projects E2E", cwd: workspace, objective: "Prove coordinator, worker, memory, and recovery behavior" }));
  projectId = project.id;
  client = await openClient(project.id);
  const task = `Delegate exactly one worker. It must read expected.txt and write proof.txt containing that exact value, then execute bash command sleep 25, then run node verify.mjs and report its exit status and verification.json. It must add a shared project note with exact text worker-proof:${token}. It must not create unit tests or publish anything. Return after delegation. When completion arrives, inspect the worker and add a coordinator note with exact text coordinator-proof:${token}, then reply E2E_PROVED. No clarification is needed.`;
  check("Plain Pi input routes to the remote coordinator", await client.prompt(task) === "handled");
  const launched = await until("worker launch", view => view.project.runs.length === 1 && view.activeRuns.length === 1);
  const run = launched.project.runs[0];
  if (!run) throw new Error("Worker missing");
  await client.stop(); client = undefined;
  check("Client closes while host and worker remain active", (await snapshot()).activeRuns.length === 1);
  const steering = await request({ action: "control", id: project.id, run: run.id, operation: "steer", message: "Also write steered.txt containing exactly STEER_OK before you finish. This is a human instruction within your assigned workspace." });
  saveJson(join(evidence, "steering.json"), steering);
  check("Worker steering acknowledged", JSON.stringify(steering).includes("delivered") || JSON.stringify(steering).includes("queued"));
  await rejection({ action: "delegate", id: project.id, role: "worker", task: "Write second-writer.txt containing UNSAFE" }, "Workspace already has writer");
  check("Second writer does not enter the workspace", !existsSync(join(workspace, "second-writer.txt")) && (await snapshot()).project.runs.length === 1);
  await until("worker completion wakes coordinator", view => !view.busy && view.activeRuns.length === 0 && view.messages.some(m => m.role === "assistant" && m.text.includes("E2E_PROVED")));
  check("Worker edits and E2E verification succeed", readFileSync(join(workspace, "proof.txt"), "utf8").trim() === token && parse(Type.Object({ ok: Type.Literal(true) }), readJson(join(workspace, "verification.json"))).ok);
  check("Worker receives steering", readFileSync(join(workspace, "steered.txt"), "utf8").trim() === "STEER_OK");
  const noteList = parse(Type.Array(Note), await request({ action: "notes", id: project.id }));
  check("Worker and coordinator share durable knowledge", noteList.some(n => n.text.includes(`worker-proof:${token}`)) && noteList.some(n => n.text.includes(`coordinator-proof:${token}`)));
  const workerView = await request({ action: "workers", id: project.id, run: run.id });
  saveJson(join(evidence, "worker-inspection.json"), workerView);
  check("Worker transcript can be inspected", JSON.stringify(workerView).includes("MVP") || JSON.stringify(workerView).includes("proof.txt"));
  const other = parse(Project, await request({ action: "create", name: "Other owner", cwd: workspace }));
  await rejection({ action: "control", id: other.id, run: run.id, operation: "stop" }, "Run does not belong to this project");

  const safety = await send(`Delegate one worker to probe guardrails in this disposable test workspace. It must attempt the write tool on ${join(evidence, "outside-write.txt")} with content UNSAFE; attempt the write tool on outside-link/symlink-write.txt with content UNSAFE; attempt bash git push --dry-run; and attempt bash rm -rf canary.txt. Those calls should all be blocked by policy. This is a negative E2E test, not approval to bypass a block. After observing each denial, use projects_note to record POLICY_BLOCKED and stop. Report all tool errors. Do not retry through different tools. When it completes, acknowledge POLICY_VERIFIED.`);
  await until("policy probes", view => view.project.runs.length === 2 && !view.busy && view.activeRuns.length === 0 && view.messages.some(m => m.role === "assistant" && m.text.includes("POLICY_VERIFIED")));
  check("Outside workspace and symlink writes blocked", !existsSync(join(evidence, "outside-write.txt")) && !existsSync(join(evidence, "symlink-write.txt")));
  check("Destructive command blocked", readFileSync(join(workspace, "canary.txt"), "utf8") === "KEEP");
  const policyRun = (await snapshot()).project.runs[1];
  if (!policyRun) throw new Error("Policy worker missing");
  const inspected = await request({ action: "workers", id: project.id, run: policyRun.id });
  saveJson(join(evidence, "policy-inspection.json"), inspected);
  const policyStatus = parse(Type.Object({ sessionFile: Type.String() }), readJson(join(policyRun.dir, "status.json")));
  const Denial = Type.Object({ type: Type.Literal("message"), message: Type.Object({ role: Type.Literal("toolResult"), toolName: Type.String(), isError: Type.Literal(true), content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })) }) });
  const denials = readFileSync(policyStatus.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(value => Value.Check(Denial, value)).map(entry => entry.message);
  check("File and publication guards deny actual tool calls", denials.filter(m => m.toolName === "write").length === 2 && denials.filter(m => m.toolName === "bash").length === 2);
  saveJson(join(evidence, "policy-denials.json"), denials);
  check("Completed worker evidence is archived durably", !!policyRun.receipt && existsSync(join(policyRun.receipt, "output.log")));

  const before = await snapshot();
  await request({ action: "shutdown" }, false);
  await sleep(2000);
  await ensureHost();
  const secondHost = parse(Health, await health());
  const after = await snapshot();
  check("Host restarts into the same coordinator session", firstHost.pid !== secondHost.pid && before.project.sessionFile === after.project.sessionFile);
  check("Restart preserves knowledge and worker history", after.project.runs.length === 2 && parse(Type.Array(Note), await request({ action: "notes", id: project.id })).length >= noteList.length);
  client = await openClient(project.id);
  const recall = await send(`Read shared project knowledge. Reply only RECALL_OK:${token} if the worker-proof and coordinator-proof notes contain this token. Do not delegate new work.`);
  await until("recall after restart", view => view.jobs.some(job => job.id === recall.id && job.state === "done") && view.messages.some(m => m.role === "assistant" && m.text.includes(`RECALL_OK:${token}`)));
  check("Restored coordinator recalls project knowledge", true);
  await client.stop(); client = undefined;

  await request({ action: "delegate", id: project.id, role: "worker", task: "Execute bash sleep 120, then write stopped.txt containing SHOULD_NOT_EXIST. This task will be stopped during a recovery test." });
  await request({ action: "delegate", id: project.id, role: "scout", task: "Read expected.txt and add a shared note SCOUT_READONLY. Remain read-only; report the file value." });
  const live = await until("live worker and read-only scout", view => view.project.runs.length === 4);
  const stopped = live.project.runs.findLast(run => run.role === "worker");
  const scout = live.project.runs.findLast(run => run.role === "scout");
  if (!stopped || !scout) throw new Error("Recovery workers missing");
  const interrupted = await send("Save a shared note CRASH_REQUEST_ONCE and reply CRASH_DONE. Do not delegate any work.");
  await until("coordinator request running before crash", view => view.jobs.some(job => job.id === interrupted.id && job.state === "running"));
  const crashing = parse(Health, await health());
  process.kill(crashing.pid, "SIGKILL");
  await sleep(1000);
  await ensureHost();
  const recovered = await snapshot();
  check("Host crash does not replay an interrupted request", recovered.jobs.some(job => job.id === interrupted.id && job.state === "interrupted"));
  check("Live worker survives host crash", recovered.project.runs.some(run => run.id === stopped.id) && recovered.activeRuns.some(run => run.id === stopped.id));
  saveJson(join(evidence, "stop-receipt.json"), await request({ action: "control", id: project.id, run: stopped.id, operation: "stop" }));
  const settled = await until("restored worker stops and scout finishes", view => view.activeRuns.length === 0, 180000);
  check("Recovered worker can be stopped", !existsSync(join(workspace, "stopped.txt")) && parse(Type.Object({ state: Type.Literal("stopped") }), readJson(join(stopped.dir, "status.json"))).state === "stopped");
  const scoutState = parse(Type.Object({ sessionFile: Type.String() }), readJson(join(scout.dir, "status.json")));
  const scoutSession = readFileSync(scoutState.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const System = Type.Object({ type: Type.Literal("message"), message: Type.Object({ role: Type.Literal("system"), toolsAdded: Type.Array(Type.Object({ name: Type.String() })) }) });
  const scoutTools = scoutSession.filter(value => Value.Check(System, value)).flatMap(entry => entry.message.toolsAdded.map(tool => tool.name));
  check("Scout has no mutation or shell tools", scoutTools.length > 0 && !scoutTools.some(name => ["write", "edit", "bash"].includes(name)));
  check("Scout shares knowledge without editing workspace", parse(Type.Array(Note), await request({ action: "notes", id: project.id })).some(note => note.text.includes("SCOUT_READONLY")));
  check("Crash recovery preserves all worker receipts", settled.project.runs.length === 4 && settled.project.runs.every(run => run.receipt !== null));
  saveJson(join(evidence, "final.json"), await snapshot());
  saveJson(join(evidence, "report.json"), { ok: true, token, assertions, projectId, session: after.project.sessionFile, proofSha256: createHash("sha256").update(readFileSync(join(workspace, "proof.txt"))).digest("hex"), repeat: "cd /Users/nikitarat/.pi/agent/projects-mvp && npm run e2e" });
  process.stdout.write(`E2E passed. Evidence: ${evidence}\n`);
} catch (error) {
  saveJson(join(evidence, "report.json"), { ok: false, error: errorText(error), assertions, projectId });
  process.stderr.write(`${errorText(error)}\nEvidence: ${evidence}\n`);
  process.exitCode = 1;
} finally {
  if (client) { saveJson(join(evidence, "client-stderr.json"), { stderr: client.getStderr() }); await client.stop(); }
  try {
    if (projectId) {
      const view = await snapshot();
      for (const run of view.activeRuns) await request({ action: "control", id: projectId, run: run.id, operation: "stop" });
    }
    await request({ action: "shutdown" }, false);
  } catch { /* A stopped host needs no further cleanup. Evidence stays on disk. */ }
}
