import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FAKE_MODEL, startFakeModel } from "./fake-model.mjs";

// Failure inventory before execution: fabricated ToolApi/call IDs are not Durable proof;
// registry-name collisions can cross scopes; independent writers can race; unsafe calls can
// stop after rename; and master, foreign, traversal, VCS, symlink, and stale-CAS calls deny.
// This is a standalone Git-fixture authorization, not allocator/provider parity.
const root = join("/Users/nikitarat/.pi/agent/projects-mvp/artifacts", `workspace-write-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const owner = join(root, "owner"), oneRoot = join(root, "worker-one"), twoRoot = join(root, "worker-two"), crashRoot = join(root, "worker-crash"), control = join(root, "control");
mkdirSync(root, { recursive: true, mode: 0o700 });
const fake = await startFakeModel(root); // offline: private SDK home with only the fake model; the crash child inherits it mkdirSync(control, { mode: 0o700 });
const checks = [], requests = [];
const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const pass = (name, condition = true) => { assert.ok(condition, name); checks.push(name); save("assertions.json", checks); };
const git = (...args) => execFileSync("/usr/bin/git", args, { encoding: "utf8" }).trim();
const source = pathToFileURL(join(process.cwd(), "src", "workspace-capabilities.ts")).href;
const { workspaceCapabilities, workspaceToolNames } = await import(source);
const modelName = FAKE_MODEL;
const [provider, ...modelParts] = modelName.split("/"), modelId = modelParts.join("/");
let harness;
try {
  git("init", "-b", "main", owner); git("-C", owner, "config", "user.email", "workspace-e2e@example.invalid"); git("-C", owner, "config", "user.name", "Workspace E2E");
  mkdirSync(join(owner, "src")); writeFileSync(join(owner, "src", ".gitkeep"), "\n"); git("-C", owner, "add", "."); git("-C", owner, "commit", "-m", "fixture");
  const ownerHead = git("-C", owner, "rev-parse", "HEAD"), ownerStatus = git("-C", owner, "status", "--porcelain=v1");
  git("-C", owner, "worktree", "add", "-b", "worker-one", oneRoot, "HEAD"); git("-C", owner, "worktree", "add", "-b", "worker-two", twoRoot, "HEAD"); git("-C", owner, "worktree", "add", "-b", "worker-crash", crashRoot, "HEAD");
  writeFileSync(join(oneRoot, "neighbour.txt"), "neighbour\n"); symlinkSync(owner, join(oneRoot, "escape"));

  const models = await ModelRuntime.create({ allowModelNetwork: false });
  if (!models.getModel(provider, modelId) || !models.getProviderAuthStatus(provider).configured) throw new Error(`Actual worker model or credentials unavailable: ${modelName}`);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "workspace-e2e-observer", hooks: [hook(GenerationTask, { beforeRequest: (request, api) => { requests.push({ conversationId: Number(api.conversationId), messages: request.messages }); save("model-requests.json", requests); } })] }));
  harness = await Harness.open(await openNodeSqliteStorage(join(control, "durable.sqlite")), { models, registry, settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 0 } } }, BACKGROUND_CONTEXT);
  const master = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider, modelId }, instructions: "You are the coordinator. You have no workspace tools.", tools: [] } });
  const one = await harness.createConversation({ ownership: { kind: "conversation" } }, BACKGROUND_CONTEXT);
  const two = await harness.createConversation({ ownership: { kind: "conversation" } }, BACKGROUND_CONTEXT);
  const makeAuthority = (workspaceId, workspaceRoot, files, attempt) => ({ projectId: "workspace-e2e", repositoryId: ownerHead, provider: "git", workspaceId, receiptId: `receipt-${workspaceId}`, attemptId: attempt, leaseRevision: "lease-1", workspaceRoot, files, expiresAt: new Date(Date.now() + 120000).toISOString() });
  const firstAuthority = makeAuthority("worker-one", oneRoot, ["src/one.txt", "src/lock.txt"], `attempt-${Number(one.id)}`), secondAuthority = makeAuthority("worker-two", twoRoot, ["src/two.txt"], `attempt-${Number(two.id)}`);
  const validator = expected => async candidate => {
    try {
      const top = git("-C", candidate.workspaceRoot, "rev-parse", "--show-toplevel");
      if (resolve(top) !== resolve(expected.workspaceRoot) || candidate.provider !== "git" || candidate.repositoryId !== ownerHead || candidate.workspaceId !== expected.workspaceId) return { approved: false, blocker: "host inventory did not match this allocation" };
      return { approved: true, authority: { ...expected, files: [...expected.files] } };
    } catch { return { approved: false, blocker: "host Git inventory failed" }; }
  };
  const common = { caller: "durable-worker", writeLock: { controlRoot: control, databasePath: join(control, "workspace-lock.sqlite"), waitMs: 500 } };
  const firstTools = await workspaceCapabilities({ ...common, authority: firstAuthority, binding: { role: "durable-worker", conversationId: Number(one.id) }, validateAuthority: validator(firstAuthority) });
  const secondTools = await workspaceCapabilities({ ...common, authority: secondAuthority, binding: { role: "durable-worker", conversationId: Number(two.id) }, validateAuthority: validator(secondAuthority) });
  registry.install(defineExtension({ name: "workspace-e2e-tools", tools: [...firstTools, ...secondTools] }));
  const firstNames = workspaceToolNames(firstAuthority.workspaceId), secondNames = workspaceToolNames(secondAuthority.workspaceId);
  pass("workspace names are deterministic and distinct", firstNames.write !== secondNames.write && firstNames.read !== secondNames.read);
  await one.configure({ model: { provider, modelId }, cwd: oneRoot, tools: firstTools, instructions: `You are durable worker one. Use only ${firstNames.write} exactly once with {"path":"src/one.txt","text":"ONE\n","expectedRevision":null}. Then reply DONE.` }, BACKGROUND_CONTEXT);
  await two.configure({ model: { provider, modelId }, cwd: twoRoot, tools: secondTools, instructions: `You are durable worker two. Use only ${secondNames.write} exactly once with {"path":"src/two.txt","text":"TWO\n","expectedRevision":null}. Then reply DONE.` }, BACKGROUND_CONTEXT);
  const firstRun = await one.submit({ type: "input", content: `Perform your assigned write now. FAKE-CALL ${firstNames.write} {"path":"src/one.txt","text":"ONE\\n","expectedRevision":null} FAKE-SAY DONE`, requestId: "write-one" }, BACKGROUND_CONTEXT); const secondRun = await two.submit({ type: "input", content: `Perform your assigned write now. FAKE-CALL ${secondNames.write} {"path":"src/two.txt","text":"TWO\\n","expectedRevision":null} FAKE-SAY DONE`, requestId: "write-two" }, BACKGROUND_CONTEXT);
  const [firstOutcome, secondOutcome] = await Promise.all([firstRun.wait(BACKGROUND_CONTEXT), secondRun.wait(BACKGROUND_CONTEXT)]);
  pass("two authenticated worker conversations completed", firstOutcome.status === "done" && secondOutcome.status === "done");
  pass("workers wrote only assigned Git worktree files", readFileSync(join(oneRoot, "src", "one.txt"), "utf8") === "ONE\n" && readFileSync(join(twoRoot, "src", "two.txt"), "utf8") === "TWO\n" && !existsSync(join(oneRoot, "src", "two.txt")) && !existsSync(join(twoRoot, "src", "one.txt")));
  const masterAgent = await master.agent(BACKGROUND_CONTEXT); pass("master excludes all workspace tools", !masterAgent.tools.some(tool => tool.name.startsWith("projects_workspace_")));
  const denied = ["../owner/src/.gitkeep", ".git/config", "escape/src/.gitkeep", "neighbour.txt", "/etc/passwd"];
  for (const path of denied) {
    await one.configure({ instructions: `Call ${firstNames.read} exactly once with JSON {"path":${JSON.stringify(path)}}. Then reply BLOCKED.` }, BACKGROUND_CONTEXT);
    const run = await one.submit({ type: "input", content: `Call ${firstNames.read} exactly once with JSON {"path":${JSON.stringify(path)}}. Do not use another tool. Reply BLOCKED. FAKE-CALL ${firstNames.read} {"path":${JSON.stringify(path)}} FAKE-SAY BLOCKED`, requestId: `deny-${Buffer.from(path).toString("hex")}` }, BACKGROUND_CONTEXT);
    const outcome = await run.wait(BACKGROUND_CONTEXT); pass(`actual registered worker denied ${path}`, outcome.status === "done");
  }
  const holder = lockHolder(join(control, "workspace-lock.sqlite")); await holder.ready;
  await one.configure({ instructions: `Call ${firstNames.write} exactly once with {"path":"src/lock.txt","text":"LOCKED\\n","expectedRevision":null}. Then reply BLOCKED.` }, BACKGROUND_CONTEXT);
  const locked = await one.submit({ type: "input", content: `Call ${firstNames.write} exactly once with JSON {"path":"src/lock.txt","text":"LOCKED\\n","expectedRevision":null}. Do not use another tool. FAKE-CALL ${firstNames.write} {"path":"src/lock.txt","text":"LOCKED\\n","expectedRevision":null} FAKE-SAY BLOCKED`, requestId: "cross-process-lock" }, BACKGROUND_CONTEXT);
  await locked.wait(BACKGROUND_CONTEXT); pass("actual registered write is blocked by another process SQLite lock", !existsSync(join(oneRoot, "src", "lock.txt")));
  holder.child.kill("SIGKILL"); await holder.done;
  const recoveredLock = new (await import("node:sqlite")).DatabaseSync(join(control, "workspace-lock.sqlite"));
  try { recoveredLock.exec("BEGIN IMMEDIATE; COMMIT"); }
  finally { recoveredLock.close(); }
  pass("SIGKILL releases the same process-safe SQLite lock", !existsSync(join(oneRoot, "src", "lock.txt")));
  const stale = "0".repeat(64);
  await one.configure({ instructions: `Call ${firstNames.write} exactly once with {"path":"src/one.txt","text":"STALE\\n","expectedRevision":"${stale}"}. Then reply BLOCKED.` }, BACKGROUND_CONTEXT);
  const conflict = await one.submit({ type: "input", content: `Call ${firstNames.write} exactly once with JSON {"path":"src/one.txt","text":"STALE\\n","expectedRevision":"${stale}"}. Do not use another tool. FAKE-CALL ${firstNames.write} {"path":"src/one.txt","text":"STALE\\n","expectedRevision":"${stale}"} FAKE-SAY BLOCKED`, requestId: "stale-cas" }, BACKGROUND_CONTEXT);
  await conflict.wait(BACKGROUND_CONTEXT); pass("actual registered stale CAS leaves bytes unchanged", readFileSync(join(oneRoot, "src", "one.txt"), "utf8") === "ONE\n");
  const mutable = { ...firstAuthority, files: [...firstAuthority.files] };
  const frozen = await workspaceCapabilities({ ...common, authority: mutable, binding: { role: "durable-worker", conversationId: Number(one.id) }, validateAuthority: validator(firstAuthority) }); mutable.files.push("neighbour.txt");
  pass("source options clone before active scope", frozen.every(tool => tool.name !== "projects_workspace_unbound_read") && mutable.files.length === 3);
  const firstView = await one.context(BACKGROUND_CONTEXT), secondView = await two.context(BACKGROUND_CONTEXT);
  const crash = await proveUnsafeRecovery({ ownerHead, modelName, source, workspace: crashRoot, control: join(root, "crash-control") });
  pass("unsafe after-rename crash recovery preserves hash without replay", crash.interrupted && crash.beforeHash === crash.afterHash && crash.readHash === crash.beforeHash);
  await harness.close(BACKGROUND_CONTEXT); harness = undefined;
  const restoredRegistry = createRegistry();
  const restoredFirst = await workspaceCapabilities({ ...common, authority: firstAuthority, binding: { role: "durable-worker", conversationId: Number(one.id) }, validateAuthority: validator(firstAuthority) });
  const restoredSecond = await workspaceCapabilities({ ...common, authority: secondAuthority, binding: { role: "durable-worker", conversationId: Number(two.id) }, validateAuthority: validator(secondAuthority) });
  restoredRegistry.install(defineExtension({ name: "workspace-e2e-tools", tools: [...restoredFirst, ...restoredSecond] }));
  const restored = await Harness.open(await openNodeSqliteStorage(join(control, "durable.sqlite")), { models, registry: restoredRegistry, settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 0 } } }, BACKGROUND_CONTEXT);
  try {
    const restoredOne = await restored.conversation(one.id, BACKGROUND_CONTEXT), restoredTwo = await restored.conversation(two.id, BACKGROUND_CONTEXT);
    if (!restoredOne || !restoredTwo) throw new Error("Persisted worker conversations are missing after reopen");
    const oneNames = (await restoredOne.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name), twoNames = (await restoredTwo.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name);
    pass("registry reconstruction preserves exact worker bindings", oneNames.includes(firstNames.read) && oneNames.includes(firstNames.write) && !oneNames.includes(secondNames.write) && twoNames.includes(secondNames.read) && twoNames.includes(secondNames.write) && !twoNames.includes(firstNames.write));
  } finally { await restored.close(BACKGROUND_CONTEXT); }
  save("tool-outcomes.json", { first: firstView.messages, second: secondView.messages, crash, bytes: { one: readFileSync(join(oneRoot, "src", "one.txt")).byteLength, two: readFileSync(join(twoRoot, "src", "two.txt")).byteLength } });
  save("report.json", { ok: true, kind: "actual-durable-harness-fake-model-standalone-git-scope", root, model: modelName, workers: [Number(one.id), Number(two.id)], names: { firstNames, secondNames }, checks, owner: { head: ownerHead, statusBefore: ownerStatus, statusAfter: git("-C", owner, "status", "--porcelain=v1") }, crash, limitations: ["Standalone host Git inventory authorization only; not integrated allocator parity.", "No OS sandbox: malicious local-process TOCTOU remains."] });
  process.stdout.write(`${join(root, "report.json")}\n`);
} catch (error) {
  save("report.json", { ok: false, root, checks, error: error instanceof Error ? error.stack : String(error) }); throw error;
} finally { await harness?.close(BACKGROUND_CONTEXT); fake.close(); }

async function proveUnsafeRecovery(input) {
  mkdirSync(input.control, { recursive: true, mode: 0o700 });
  const marker = join(input.control, "after-rename.json"), database = join(input.control, "durable.sqlite"), lock = join(input.control, "lock.sqlite");
  const child = spawn(process.execPath, ["--input-type=module", "-e", crashChildCode(), JSON.stringify({ ...input, marker, database, lock })], { env: process.env });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise(resolveDone => child.once("exit", (code, signal) => resolveDone({ code, signal })));
  try {
    await waitForFile(marker, 180000);
    const effect = JSON.parse(readFileSync(marker, "utf8"));
    const target = join(input.workspace, "src", "crash.txt"), before = digest(readFileSync(target));
    child.kill("SIGKILL"); const exit = await done;
    if (exit.signal !== "SIGKILL") throw new Error(`Crash child did not receive SIGKILL: ${JSON.stringify(exit)} ${stderr}`);
    const [provider, ...parts] = input.modelName.split("/"), modelId = parts.join("/");
    const models = await ModelRuntime.create({ allowModelNetwork: false });
    if (!models.getModel(provider, modelId) || !models.getProviderAuthStatus(provider).configured) throw new Error("Actual model unavailable during crash recovery");
    const registry = createRegistry();
    const reopened = await Harness.open(await openNodeSqliteStorage(database), { models, registry, settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 0 } } }, BACKGROUND_CONTEXT);
    try {
      const worker = await reopened.root(BACKGROUND_CONTEXT);
      const authority = { projectId: "workspace-crash", repositoryId: input.ownerHead, provider: "git", workspaceId: "worker-crash", receiptId: "receipt-worker-crash", attemptId: `attempt-${Number(worker.id)}`, leaseRevision: "lease-1", workspaceRoot: input.workspace, files: ["src/crash.txt"], expiresAt: new Date(Date.now() + 120000).toISOString() };
      const tools = await workspaceCapabilities({ caller: "durable-worker", authority, binding: { role: "durable-worker", conversationId: Number(worker.id) }, writeLock: { controlRoot: input.control, databasePath: lock, waitMs: 500 }, validateAuthority: hostValidator(authority, input.ownerHead) });
      const names = workspaceToolNames(authority.workspaceId);
      registry.install(defineExtension({ name: "workspace-crash-tools", tools }));
      reopened.resume(); await worker.waitForIdle(BACKGROUND_CONTEXT);
      const recovered = await worker.context(BACKGROUND_CONTEXT);
      const interrupted = JSON.stringify(recovered.messages).includes("was interrupted and may have partially run");
      const after = digest(readFileSync(target));
      await worker.configure({ model: { provider, modelId }, cwd: input.workspace, tools, instructions: `Call ${names.read} exactly once with {"path":"src/crash.txt"}. Reply with its revision.` }, BACKGROUND_CONTEXT);
      const read = await worker.submit({ type: "input", content: `Call ${names.read} now. FAKE-CALL ${names.read} {"path":"src/crash.txt"}`, requestId: "recover-read" }, BACKGROUND_CONTEXT); await read.wait(BACKGROUND_CONTEXT);
      const view = await worker.context(BACKGROUND_CONTEXT), readHash = JSON.stringify(view.messages).includes(effect.revision) ? effect.revision : null;
      return { effect, beforeHash: before, afterHash: after, readHash, interrupted, recovered: recovered.messages, read: view.messages };
    } finally { await reopened.close(BACKGROUND_CONTEXT); }
  } catch (error) {
    save("crash-failure.json", { error: error instanceof Error ? error.stack : String(error), stderr, marker: existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null });
    throw error;
  } finally { if (!child.killed) child.kill("SIGKILL"); }
}

function hostValidator(expected, head) {
  return async candidate => {
    try { return resolve(git("-C", candidate.workspaceRoot, "rev-parse", "--show-toplevel")) === resolve(expected.workspaceRoot) && candidate.repositoryId === head && candidate.provider === "git" && candidate.workspaceId === expected.workspaceId ? { approved: true, authority: { ...expected, files: [...expected.files] } } : { approved: false, blocker: "host inventory mismatch" }; }
    catch { return { approved: false, blocker: "host inventory failed" }; }
  };
}

async function waitForFile(path, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (existsSync(path)) return; await sleep(10); }
  throw new Error(`Timed out waiting for ${path}`);
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function crashChildCode() { return `
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
const input = JSON.parse(process.argv[1]);
const { workspaceCapabilities, workspaceToolNames } = await import(input.source);
const [provider, ...parts] = input.modelName.split("/"), modelId = parts.join("/");
const models = await ModelRuntime.create({ allowModelNetwork: false });
if (!models.getModel(provider, modelId) || !models.getProviderAuthStatus(provider).configured) throw new Error("Actual crash worker model unavailable");
const registry = createRegistry();
const harness = await Harness.open(await openNodeSqliteStorage(input.database), { models, registry, settings: { stream: { timeoutMs: 120000 }, retry: { maxRetries: 0 } } }, BACKGROUND_CONTEXT);
try {
  const worker = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider, modelId }, tools: [], cwd: input.workspace, instructions: "You are a worker; follow the scoped tool instruction." } });
  const authority = { projectId: "workspace-crash", repositoryId: input.ownerHead, provider: "git", workspaceId: "worker-crash", receiptId: "receipt-worker-crash", attemptId: "attempt-" + Number(worker.id), leaseRevision: "lease-1", workspaceRoot: input.workspace, files: ["src/crash.txt"], expiresAt: new Date(Date.now() + 120000).toISOString() };
  const validator = async candidate => { try { return execFileSync("/usr/bin/git", ["-C", candidate.workspaceRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() === candidate.workspaceRoot && candidate.repositoryId === input.ownerHead ? { approved: true, authority: { ...authority, files: [...authority.files] } } : { approved: false, blocker: "host inventory mismatch" }; } catch { return { approved: false, blocker: "host inventory failed" }; } };
  const tools = await workspaceCapabilities({ caller: "durable-worker", authority, binding: { role: "durable-worker", conversationId: Number(worker.id) }, writeLock: { controlRoot: input.control, databasePath: input.lock, waitMs: 500 }, validateAuthority: validator, testAfterWrite: async effect => { writeFileSync(input.marker, JSON.stringify(effect)); await new Promise(() => { setInterval(() => {}, 1000); }); } });
  registry.install(defineExtension({ name: "workspace-crash-tools", tools }));
  const names = workspaceToolNames(authority.workspaceId);
  await worker.configure({ model: { provider, modelId }, cwd: input.workspace, tools, instructions: "Call " + names.write + " exactly once with {\\"path\\":\\"src/crash.txt\\",\\"text\\":\\"CRASH\\\\n\\",\\"expectedRevision\\":null}." }, BACKGROUND_CONTEXT);
  const run = await worker.submit({ type: "input", content: "Perform the assigned write now. FAKE-CALL " + names.write + " {\\"path\\":\\"src/crash.txt\\",\\"text\\":\\"CRASH\\\\n\\",\\"expectedRevision\\":null}", requestId: "crash-write" }, BACKGROUND_CONTEXT); await run.wait(BACKGROUND_CONTEXT);
} finally { await harness.close(BACKGROUND_CONTEXT); }
`; }

function lockHolder(databasePath) {
  const code = `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(JSON.parse(process.argv[1]).databasePath); db.exec("BEGIN IMMEDIATE"); console.log("READY"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ databasePath })]);
  let output = ""; let readyResolve;
  const ready = new Promise(resolveReady => { readyResolve = resolveReady; });
  child.stdout.on("data", chunk => { output += chunk; if (output.includes("READY")) readyResolve(); });
  const done = new Promise(resolveDone => child.once("exit", resolveDone));
  return { child, ready: Promise.race([ready, sleep(5000).then(() => { throw new Error("SQLite holder did not become ready"); })]), done };
}
