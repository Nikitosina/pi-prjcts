#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDurableProject } from "../src/durable-runtime.ts";
import { projectDir, saveProject } from "../src/state.ts";

const root = resolve("artifacts", `workspace-admission-negative-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const state = join(root, "state");
const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...args) => execFileSync("/usr/bin/git", args, { encoding: "utf8" }).trim();
mkdirSync(root, { recursive: true });
process.env.PI_PROJECTS_HOME = state;
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(chunk({ role: "assistant", content: "Observed workspace failure" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const agent = join(root, "agent");
mkdirSync(agent);
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fake", api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }] } } }));
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_OFFLINE = "1";
const report = { sourceBefore: { runtime: sha("src/durable-runtime.ts"), planning: sha("src/durable-planning.ts"), binding: sha("src/durable-workspace-binding.ts") }, cases: [] };
const save = () => writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
try {
  const owner = join(root, "owner"), alloc = join(root, "alloc");
  mkdirSync(owner); mkdirSync(alloc);
  git("init", "-b", "main", owner);
  git("-C", owner, "config", "user.email", "e2e@example.invalid");
  git("-C", owner, "config", "user.name", "e2e");
  mkdirSync(join(owner, "owned")); writeFileSync(join(owner, "owned", "sentinel.txt"), "OWNER\n");
  git("-C", owner, "add", "."); git("-C", owner, "commit", "-m", "fixture");
  const head = git("-C", owner, "rev-parse", "HEAD");
  const snapshot = () => ({ owner: sha(join(owner, "owned", "sentinel.txt")), head: git("-C", owner, "rev-parse", "HEAD"), branch: git("-C", owner, "branch", "--show-current"), inventory: git("-C", owner, "worktree", "list", "--porcelain") });
  const base = authorization => ({ version: 1, runtime: "durable", id: randomUUID(), name: "negative", cwd: owner, objective: "negative", createdAt: new Date().toISOString(), model: "fake/fake-model", models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" }, sessionFile: null, phase: "ready", problem: null, runs: [], workspaceAuthorization: authorization });
  const run = async (name, project, scope, role = "worker") => {
    saveProject(project); const before = snapshot();
    let runtime = await openDurableProject({ project, dir: projectDir(project.id), workerCap: 1 });
    let error = null, plan = null;
    try { plan = await runtime.plan({ work: [{ id: randomUUID(), threadId: randomUUID(), role, workspaceScopeId: scope, text: "scoped negative" }] }); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    let terminal = null;
    if (!error) {
      const until = Date.now() + 60000;
      while (Date.now() < until) {
        const state = await runtime.planSnapshot(), item = state.work.at(-1);
        if (item && item.status !== "queued" && item.status !== "running") { terminal = item; break; }
        await sleep(100);
      }
      if (!terminal) throw Error(`${name} remained queued/running without terminal binder outcome`);
      if (role === "worker") assert.equal(terminal.status, "failed", `${name} must fail, not complete`);
    }
    const after = snapshot(); assert.deepEqual(after, before);
    const sameRuntimeSnapshot = await runtime.planSnapshot(); await runtime.close();
    runtime = await openDurableProject({ project, dir: projectDir(project.id), workerCap: 1 });
    const reopened = await runtime.planSnapshot(); await runtime.close();
    if (name === "scout-unknown-scope") {
      assert.equal(error, null);
      // C11f: scouts are read-only and ignore workspaceScopeId, so an unknown scope no longer fails them.
      assert.equal(terminal.status, "completed");
      assert.equal(reopened.work[0].status, "completed");
    }
    report.cases.push({ name, role, error, plan, terminal, sameRuntimeSnapshot, reopened, before, after });
  };
  await run("no-grant", base(undefined), randomUUID());
  assert.equal(report.cases.at(-1).error, "Workspace scope binding requires a host prepareWorkerEnvironment callback");
  const scope = randomUUID();
  const auth = { version: 1, provider: "github", owner: `agent-${randomUUID()}`, repositories: [{ repositoryId: "local", provider: "github", ownerCheckout: owner, approvedRoot: alloc, fileOwnershipPrefix: "owned" }], scopes: [{ id: scope, repositoryId: "local", files: ["owned/write.txt"], baseRevision: head }] };
  await run("unknown-scope", base(auth), randomUUID());
  assert.equal(report.cases.at(-1).terminal?.status, "failed");
  assert.equal(report.cases.at(-1).terminal?.blocker, "Unknown host workspace scope");
  await run("scout-unknown-scope", base(auth), randomUUID(), "scout");
  const mismatch = { ...auth, repositories: [{ ...auth.repositories[0], provider: "other" }] };
  await run("provider-mismatch", base(mismatch), scope);
  assert.equal(report.cases.at(-1).terminal?.status, "failed");
  assert.equal(report.cases.at(-1).terminal?.blocker, "Workspace scope repository/provider is not host-authorized");
  report.sourceAfter = { runtime: sha("src/durable-runtime.ts"), planning: sha("src/durable-planning.ts"), binding: sha("src/durable-workspace-binding.ts") };
  assert.deepEqual(report.sourceAfter, report.sourceBefore); save(); console.log(join(root, "report.json"));
} catch (e) { report.error = e instanceof Error ? e.stack : String(e); save(); throw e; }
finally { server.closeAllConnections(); server.close(); }
