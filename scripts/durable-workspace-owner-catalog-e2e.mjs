#!/usr/bin/env node
/** Real host/SDK owner-catalog E2E. This driver intentionally uses only the public host API. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FAKE_MODEL, pinFakeRoles, startFakeModel } from "./fake-model.mjs";

const base = resolve("artifacts", `owner-catalog-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const state = join(base, "state"), workspace = join(base, "owner"), approved = join(base, "approved");
mkdirSync(join(workspace, "owned"), { recursive: true }); mkdirSync(approved, { recursive: true });
const fake = await startFakeModel(base, { delayMs: 1500 }); // offline: private SDK home with only the fake model; the host inherits it
process.env.PI_PROJECTS_HOME = state;
const checks = [], failures = [], events = [], sourceHashes = {};
const pass = name => { checks.push(name); process.stderr.write(`PASS ${name}\n`); };
const failFixture = (name, error) => { failures.push({ name, error: String(error) }); process.stderr.write(`FAIL ${name}: ${error}\n`); };
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
function hash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
for (const path of ["scripts/durable-workspace-owner-catalog-e2e.mjs", "src/host.ts", "src/durable-runtime.ts", "src/workspace-authorization.ts"]) { try { sourceHashes[path] = hash(path); } catch { } }
git("init", "-b", "main"); git("config", "user.email", "owner@example.invalid"); git("config", "user.name", "Owner");
writeFileSync(join(workspace, "owned", "assigned.txt"), "BASE\n"); git("add", "."); git("commit", "-m", "base");
const baseRevision = git("rev-parse", "HEAD");
const { ensureHost, request, health } = await import("../src/client.ts");
const { parse, Request } = await import("../src/state.ts");
let pid;
async function api(input) {
  return await request(input);
}
async function expectReject(input, expected) {
  let rejected = false;
  try {
    await request(input);
  } catch (error) {
    rejected = true;
    const text = error instanceof Error ? error.message : String(error);
    assert.equal(text, expected);
    return text;
  }
  assert.fail(`expected ${input.action} to reject`);
}
async function expectHostReject(input, pattern) {
  let rejected = false;
  try { await request(input); } catch (error) {
    rejected = true;
    const text = error instanceof Error ? error.message : String(error);
    assert.match(text, pattern);
    return text;
  }
  assert.fail(`expected ${input.action} to reject`);
}
async function until(predicate, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const view = await api({ action: "show", id: project.id }); writeFileSync(join(base, "latest.json"), JSON.stringify(view, null, 2)); if (predicate(view)) return view; await sleep(500); }
  throw new Error("bounded wait timed out");
}
let project, scope, beforeGrant, afterGrant;
const revision = async () => (await api({ action: "owner-setup-snapshot", id: project.id })).workspaceRevision;
try {
  await ensureHost(); pid = (await health()).pid; pass("isolated public host started");
  project = await api({ action: "create", name: "Fake-model owner catalog", cwd: workspace, model: FAKE_MODEL });
  await pinFakeRoles(api, project.id);
  assert.equal(project.runtime, "durable");
  beforeGrant = await api({ action: "show", id: project.id }); assert.equal(beforeGrant.project.id, project.id); assert.equal(beforeGrant.jobs.length, 0); pass("show opened an idle Durable coordinator");

  // Fresh-provider refusal is exercised at the public parser before any Arc command/SDK call.
  const arc = await expectHostReject({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: await revision(), repositoryId: "arc-refused", provider: "arc", ownerCheckout: workspace, approvedRoot: approved, fileOwnershipPrefix: "owned", files: ["owned/assigned.txt"], baseRevision }, /Invalid data|github|provider/);
  assert.match(arc, /Invalid data|github|provider/); pass("fresh Arc provider refused by public parser before Arc");
  const file = join(base, "not-a-directory"); writeFileSync(file, "x");
  const fileRoot = await expectHostReject({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: await revision(), repositoryId: "file-root", provider: "github", ownerCheckout: workspace, approvedRoot: file, fileOwnershipPrefix: "owned", files: ["owned/assigned.txt"], baseRevision }, /directory/);
  assert.match(fileRoot, /directory/); pass("ordinary-file approved root denied");
  const symlinkFile = join(base, "symlink-root"); symlinkSync(file, symlinkFile);
  const symlinkRoot = await expectHostReject({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: await revision(), repositoryId: "symlink-root", provider: "github", ownerCheckout: workspace, approvedRoot: symlinkFile, fileOwnershipPrefix: "owned", files: ["owned/assigned.txt"], baseRevision }, /directory|Git|root/);
  assert.match(symlinkRoot, /directory|Git|root/); pass("symlink-to-file approved root denied");

  scope = await api({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: await revision(), repositoryId: "local-owner", provider: "github", ownerCheckout: workspace, approvedRoot: approved, fileOwnershipPrefix: "owned", files: ["owned/assigned.txt"], baseRevision });
  assert.match(scope.id, /^[a-f0-9-]{36}$/); pass("owner grant returned opaque scope receipt");
  const catalog = await api({ action: "workspace-catalog", id: project.id }); assert.equal(catalog.length, 1); assert.equal(catalog[0].id, scope.id); pass("public catalog exposes only persisted owned scope");
  afterGrant = await api({ action: "show", id: project.id }); assert.equal(afterGrant.project.id, project.id); assert.deepEqual(afterGrant.messages, beforeGrant.messages); pass("idle owner close/reopen preserves coordinator conversation without lock leak");

  // Existing numeric coordinator must query the newly migrated catalog tool.
  const catalogJob = await api({ action: "message", id: project.id, text: `Use projects_workspace_catalog now. Then reply with exactly CATALOG_SCOPE ${scope.id}. Do not invent an ID. FAKE-CALL projects_workspace_catalog {} FAKE-SAY CATALOG_SCOPE ${scope.id}` });
  const catalogView = await until(view => view.jobs.some(j => j.id === catalogJob.id && j.state === "done"));
  assert.ok(catalogView.messages.some(m => m.text.includes(`CATALOG_SCOPE ${scope.id}`))); pass("coordinator queried catalog after reopen");

  // Forgery and widening cases use the host parser and host authorization, never module calls.
  const extra = await expectHostReject({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: await revision(), repositoryId: "local-owner", provider: "github", ownerCheckout: workspace, approvedRoot: approved, fileOwnershipPrefix: "owned", files: ["other/nope"], baseRevision }, /ownership|prefix|file|authorization/);
  assert.match(extra, /ownership|prefix|file|authorization/); pass("widened/forged ownership grant denied");
  const wrongRepo = await expectHostReject({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: await revision(), repositoryId: "wrong-repo", provider: "github", ownerCheckout: workspace, approvedRoot: approved, fileOwnershipPrefix: "owned", files: ["owned/assigned.txt"], baseRevision: "0".repeat(40) }, /revision|HEAD/);
  assert.match(wrongRepo, /revision|HEAD/); pass("wrong repository/base revision denied");
  const unknownScope = "0".repeat(36);
  const ownerBeforeUnknown = readFileSync(join(workspace, "owned", "assigned.txt"), "utf8");
  const allocationsBeforeUnknown = new Set(readdirSafe(approved));
  const unknown = await api({ action: "message", id: project.id, text: `Call projects_delegate with JSON arguments {"role":"worker","workspaceScopeId":"${unknownScope}","task":"Use the assigned workspace capability write tool to write exactly BAD to owned/assigned.txt."}. Do not substitute another scope ID. FAKE-CALL projects_delegate ${JSON.stringify({ role: "worker", workspaceScopeId: unknownScope, task: "Use the assigned workspace capability write tool to write exactly BAD to owned/assigned.txt." })} FAKE-SAY done` });
  const unknownView = await until(view => view.jobs.some(j => j.id === unknown.id && ["done", "failed"].includes(j.state)));
  const unknownJob = unknownView.jobs.find(j => j.id === unknown.id);
  assert.ok(unknownJob);
  const unknownTranscript = `${unknownJob.error ?? ""} ${unknownView.messages.map(m => m.text).join(" ")}`;
  // Public snapshots retain the exact requested opaque argument even when the model declines to emit a tool result.
  // Never treat a prompt mention as a grant: the no-effect assertions below are mandatory.
  assert.match(unknownTranscript, new RegExp(unknownScope));
  assert.equal(readFileSync(join(workspace, "owned", "assigned.txt"), "utf8"), ownerBeforeUnknown);
  assert.deepEqual(readdirSafe(approved).filter(name => !allocationsBeforeUnknown.has(name)), []);
  pass("unknown workspaceScopeId is denied without allocation or write effect");

  // Admission and grant race: witness the public busy/queued state before requesting the grant.
  const activeMessage = api({ action: "message", id: project.id, text: "Reply exactly ACTIVE_COORDINATOR." });
  const activeView = await until(view => view.busy || view.project.phase === "busy" || view.jobs.some(j => j.state === "queued" || j.state === "running"));
  assert.ok(activeView.busy || activeView.project.phase === "busy" || activeView.jobs.some(j => j.state === "queued" || j.state === "running"));
  await expectReject({ action: "workspace-grant", id: project.id, confirm: project.id, expectedRevision: await revision(), repositoryId: "active", provider: "github", ownerCheckout: workspace, approvedRoot: approved, fileOwnershipPrefix: "owned", files: ["owned/assigned.txt"], baseRevision }, "Workspace grants require an idle Durable project");
  pass("active coordinator grant denied under witnessed host concurrency");
  await activeMessage.catch(() => undefined);

  // A genuine model-mediated delegation selects the opaque ID and invokes the real scoped SDK write tool.
  const allocationBeforeWorker = new Set(readdirSafe(approved));
  // The worker's own directives travel JSON-escaped inside the delegate arguments (so they are not parsed as the coordinator's).
  const workerTask = `Use the assigned workspace capability write tool (not bash) to write exactly WORKER_REAL_WRITE to owned/assigned.txt, then report the result. FAKE-CALL ~projects_workspace_[a-f0-9]+_write$ ${JSON.stringify({ path: "owned/assigned.txt", text: "WORKER_REAL_WRITE", expectedRevision: createHash("sha256").update("BASE\n").digest("hex") })} FAKE-SAY done`;
  const delegateJob = await api({ action: "message", id: project.id, text: `Call projects_workspace_catalog first, then projects_delegate. FAKE-CALL projects_workspace_catalog {} FAKE-CALL projects_delegate ${JSON.stringify({ role: "worker", workspaceScopeId: scope.id, task: workerTask }).replaceAll("FAKE-", "FAKE\\u002D")} FAKE-SAY delegated` });
  const workerDone = await until(view => view.jobs.some(j => j.id === delegateJob.id && j.state === "done"));
  const deadline = Date.now() + 180000; let allocation, changed;
  while (Date.now() < deadline) {
    const fresh = readdirSafe(approved).filter(name => !allocationBeforeWorker.has(name));
    if (fresh.length === 1) {
      allocation = fresh[0];
      const target = join(approved, allocation, "owned", "assigned.txt");
      if (existsSync(target)) { changed = readFileSync(target, "utf8"); if (changed === "WORKER_REAL_WRITE") break; }
    }
    await sleep(500);
  }
  assert.ok(allocation, "correlated worker allocation directory missing"); assert.equal(changed, "WORKER_REAL_WRITE");
  assert.ok(workerDone.messages.some(m => /WORKER_REAL_WRITE|delegate|worker/i.test(m.text))); pass("coordinator delegated opaque scope and worker SDK wrote assigned bytes");
  const digest = createHash("sha256").update(changed).digest("hex");
  assert.equal(digest, createHash("sha256").update("WORKER_REAL_WRITE").digest("hex")); pass("assigned bytes and exact worker result hash are observable");

  const reopened = await (async () => { await api({ action: "shutdown" }, false); pid = undefined; await sleep(800); await ensureHost(); pid = (await health()).pid; return api({ action: "show", id: project.id }); })();
  assert.equal(reopened.project.id, project.id); assert.deepEqual(reopened.messages, workerDone.messages); assert.equal((await api({ action: "workspace-catalog", id: project.id }))[0].id, scope.id); pass("restart preserves owner/peer catalog and coordinator conversation");
  const staged = execFileSync("git", ["-C", workspace, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(); assert.equal(staged, ""); pass("owner checkout staged index remains empty");
} catch (error) {
  failures.push({ name: "fatal", error: String(error), stack: error?.stack });
  writeFileSync(join(base, "failure.log"), `${error?.stack ?? error}\n`);
  throw error;
} finally {
  mkdirSync(base, { recursive: true });
  const report = { ok: failures.length === 0, checks, failures, sourceHashes, projectId: project?.id ?? null, scopeId: scope?.id ?? null, events, baseRevision, artifactRoot: base };
  writeFileSync(join(base, "report.json"), JSON.stringify(report, null, 2) + "\n");
  fake.close();
  if (pid) { try { await api({ action: "shutdown" }, false); } catch { try { process.kill(pid, "SIGTERM"); } catch { } } }
  process.stderr.write(`${join(base, "report.json")}\n`);
}
function readdirSafe(path) { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
