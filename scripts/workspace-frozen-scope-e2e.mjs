#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceIsolation } from "../src/workspace-isolation.ts";
const id = randomUUID(),
  root = resolve("artifacts", `workspace-frozen-scope-${id}`);
let owner = join(tmpdir(), `scope-owner-${id}`),
  alloc = join(tmpdir(), `scope-alloc-${id}`);
const db = join(root, "durable.sqlite"),
  report = { ok: false, checks: [], receipts: [] };
mkdirSync(root, { recursive: true });
mkdirSync(owner, { recursive: true });
mkdirSync(alloc, { recursive: true });
owner = realpathSync(owner);
alloc = realpathSync(alloc);
const run = (...a) => execFileSync(a[0], a.slice(1), { cwd: owner, encoding: "utf8" }),
  save = () => writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
async function open() {
  const h = await Harness.open(
    await openNodeSqliteStorage(db),
    { models: await ModelRuntime.create({ allowModelNetwork: false }), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  return [h, await h.root(BACKGROUND_CONTEXT)];
}
try {
  run("/usr/bin/git", "init", "-b", "main");
  run("/usr/bin/git", "config", "user.email", "e2e@example.invalid");
  run("/usr/bin/git", "config", "user.name", "E2E");
  writeFileSync(join(owner, "base"), "x");
  run("/usr/bin/git", "add", ".");
  run("/usr/bin/git", "commit", "-m", "base");
  const head = run("/usr/bin/git", "rev-parse", "HEAD").trim(),
    project = randomUUID(),
    lease = `agent-session-${id}`,
    intent = {
      id: randomUUID(),
      attemptId: randomUUID(),
      action: "allocate",
      scope: {
        projectId: project,
        repositoryId: "local",
        provider: "git",
        ownerCheckout: owner,
        approvedRoot: alloc,
        workspacePath: join(alloc, "writer"),
        workspaceName: "writer",
        branch: `writer-${id.slice(0, 8)}`,
        baseRevision: head,
        headRevision: head,
        owner: lease,
        leaseReason: "frozen scope",
        sharedObjectStore: null,
        fileOwnership: ["owned/a.txt"],
        capabilityProfileRevision: "v1",
      },
    };
  let [h, conversation] = await open(),
    iso = workspaceIsolation({
      conversation,
      authority: { projectId: project, owner: lease },
      authorizedRepositories: [
        { repositoryId: "local", provider: "git", ownerCheckout: owner, approvedRoot: alloc, fileOwnershipPrefix: "owned" },
      ],
    });
  const receipt = await iso.allocate(intent);
  report.receipts.push(receipt);
  assert.equal(receipt.state, "allocated");
  // Coordinator reuse permits branch changes; ordinary workers still require the allocated branch.
  const git = (cwd, ...args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
  const path = intent.scope.workspacePath;
  git(path, "switch", "-c", "coordinator/followup");
  await assert.rejects(iso.checkOwned(intent), /Owned Git branch differs/);
  await iso.checkOwned(intent, { branch: "any" });
  git(path, "switch", "--detach", "HEAD");
  await assert.rejects(iso.checkOwned(intent), /Owned Git branch differs/);
  await iso.checkOwned(intent, { branch: "any" });
  await assert.rejects(iso.checkOwned({ ...intent, attemptId: randomUUID() }, { branch: "any" }), /matching owned workspace receipt/);
  await assert.rejects(
    iso.checkOwned({ ...intent, scope: { ...intent.scope, workspacePath: owner } }, { branch: "any" }),
    /matching owned workspace receipt/,
  );
  git(owner, "worktree", "unlock", path);
  await assert.rejects(iso.checkOwned(intent, { branch: "any" }), /Git lock is not owned/);
  git(owner, "worktree", "lock", "--reason", "another intent", path);
  await assert.rejects(iso.checkOwned(intent, { branch: "any" }), /Git lock is not owned/);
  git(owner, "worktree", "unlock", path);
  git(owner, "worktree", "lock", "--reason", `workspace-intent:${intent.id}`, path);
  const saved = `${path}-saved`;
  renameSync(path, saved);
  symlinkSync(saved, path);
  await assert.rejects(iso.checkOwned(intent, { branch: "any" }), /symlink/);
  unlinkSync(path);
  renameSync(saved, path);
  const foreign = join(alloc, "foreign");
  mkdirSync(foreign);
  git(foreign, "init", "-b", "main");
  git(foreign, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-m", "foreign");
  const replacement = join(alloc, "replacement");
  git(foreign, "worktree", "add", "--detach", replacement);
  renameSync(path, saved);
  renameSync(replacement, path);
  await assert.rejects(iso.checkOwned(intent, { branch: "any" }), /repository association differs/);
  renameSync(path, replacement);
  renameSync(saved, path);
  await iso.checkOwned(intent, { branch: "any" });
  git(path, "switch", intent.scope.branch);
  await iso.checkOwned(intent);
  report.checks.push("Coordinator branch freedom retains receipt/path/lock/repository ownership; default worker checks remain strict");
  await h.close(BACKGROUND_CONTEXT);
  [h, conversation] = await open();
  iso = workspaceIsolation({
    conversation,
    authority: { projectId: project, owner: lease },
    authorizedRepositories: [
      { repositoryId: "local", provider: "git", ownerCheckout: owner, approvedRoot: alloc, fileOwnershipPrefix: "owned" },
    ],
  });
  const changed = { ...intent, scope: { ...intent.scope, fileOwnership: ["owned/a.txt", "owned/b.txt"] } };
  await assert.rejects(iso.allocate(changed), /intent\/scope differs/);
  await assert.rejects(iso.reconcile({ ...intent, attemptId: randomUUID() }), /intent\/scope differs/);
  const after = await iso.snapshot();
  assert.deepEqual(after.receipts[0], receipt);
  const found = await iso.reconcile(intent);
  assert.equal(found.state, "allocated");
  assert.equal(found.workspacePath, receipt.workspacePath);
  await h.close(BACKGROUND_CONTEXT);
  const crash = {
    ...intent,
    id: randomUUID(),
    attemptId: randomUUID(),
    scope: { ...intent.scope, workspacePath: join(alloc, "crash"), workspaceName: "crash", branch: `crash-${id.slice(0, 8)}` },
  };
  const witness = join(root, "crash-witness.json"),
    input = JSON.stringify({ db, project, lease, owner, alloc, crash, witness });
  const code = `import {writeFileSync} from 'node:fs';import {BACKGROUD_CONTEXT as X} from '@earendil-works/chord/context';`;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import {writeFileSync} from 'node:fs';import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';import {ModelRuntime} from '@earendil-works/pi-coding-agent';import {Harness,createRegistry} from '@earendil-works/pi-durable';import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';import {workspaceIsolation} from ${JSON.stringify(new URL("../src/workspace-isolation.ts", import.meta.url).href)};const x=JSON.parse(process.argv[1]);const h=await Harness.open(await openNodeSqliteStorage(x.db),{models:await ModelRuntime.create({allowModelNetwork:false}),registry:createRegistry()},BACKGROUND_CONTEXT);const c=await h.root(BACKGROUND_CONTEXT);const i=workspaceIsolation({conversation:c,authority:{projectId:x.project,owner:x.lease},authorizedRepositories:[{repositoryId:'local',provider:'git',ownerCheckout:x.owner,approvedRoot:x.alloc,fileOwnershipPrefix:'owned'}],afterProviderEffect:r=>{writeFileSync(x.witness,JSON.stringify({pid:process.pid,receipt:r}));process.kill(process.pid,'SIGKILL')}});await i.allocate(x.crash);`,
      input,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const signal = await new Promise((resolve) => child.on("exit", (_c, s) => resolve(s)));
  assert.equal(signal, "SIGKILL");
  assert.ok(readFileSync(witness));
  [h, conversation] = await open();
  iso = workspaceIsolation({
    conversation,
    authority: { projectId: project, owner: lease },
    authorizedRepositories: [
      { repositoryId: "local", provider: "git", ownerCheckout: owner, approvedRoot: alloc, fileOwnershipPrefix: "owned" },
    ],
  });
  const crashBefore = await iso.snapshot();
  const crashReceipt = crashBefore.receipts.find((r) => r.intentId === crash.id);
  assert.ok(crashReceipt && crashReceipt.state !== "allocated");
  assert.ok(readFileSync(witness));
  await assert.rejects(
    iso.reconcile({ ...crash, scope: { ...crash.scope, fileOwnership: ["owned/a.txt", "owned/b.txt"] } }),
    /intent\/scope differs/,
  );
  const adopted = await iso.reconcile(crash);
  assert.equal(adopted.state, "allocated");
  report.crash = { signal, witness: JSON.parse(readFileSync(witness)), before: crashReceipt, adopted };
  report.ok = true;
  report.checks.push("frozen changed scope/attempt rejected before adoption", "original intent reconciles exact existing worktree");
  await h.close(BACKGROUND_CONTEXT);
} catch (e) {
  report.error = e?.stack ?? String(e);
  process.exitCode = 1;
} finally {
  save();
}
console.log(join(root, "report.json"));
