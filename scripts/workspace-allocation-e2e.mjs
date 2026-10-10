#!/usr/bin/env -S node --experimental-strip-types
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceIsolation } from "../src/workspace-isolation.ts";

const id = randomUUID(), stamp = new Date().toISOString().replaceAll(":", "-");
const evidence = join("/Users/nikitarat/.pi/agent/projects-mvp/artifacts", `workspace-allocation-${stamp}-${id}`); mkdirSync(evidence, { recursive: true, mode: 0o700 });
const report = { failuresRecordedBeforeEffects: ["effect before receipt", "dirty/foreign/active cleanup", "provider/scope mismatch", "shared object store and lease drift (provider plugins test their own backends)"], checks: [], receipts: [], commands: [] };
const run = (file, args, cwd) => { report.commands.push({ file, args, cwd }); return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); };
const check = (value, message) => { report.checks.push({ value, message }); if (!value) throw Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => writeFileSync(join(evidence, "report.json"), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
async function durable() { const h = await Harness.open(await openNodeSqliteStorage(join(evidence, "durable.sqlite")), { models: await ModelRuntime.create({ allowModelNetwork: false }), registry: createRegistry() }, BACKGROUND_CONTEXT); return [h, await h.root(BACKGROUND_CONTEXT)]; }
try {
  const fixtureRaw = join(tmpdir(), `workspace-git-${id}`); mkdirSync(fixtureRaw, { recursive: true }); const fixture = realpathSync(fixtureRaw), owner = join(fixture, "owner"), gitPath = join(fixture, "writer"); mkdirSync(owner, { recursive: true });
  run("/usr/bin/git", ["init", "--initial-branch=main"], owner); run("/usr/bin/git", ["config", "user.email", "e2e@example.invalid"], owner); run("/usr/bin/git", ["config", "user.name", "e2e"], owner); writeFileSync(join(owner, "owner.txt"), "owner\n"); run("/usr/bin/git", ["add", "owner.txt"], owner); run("/usr/bin/git", ["commit", "-m", "fixture"], owner); const gitHead = run("/usr/bin/git", ["rev-parse", "HEAD"], owner).trim();
  const gitProject = randomUUID(), gitOwner = `agent-session-${id}`; let [h, root] = await durable(); let iso = workspaceIsolation({ conversation: root, authority: { projectId: gitProject, owner: gitOwner }, authorizedRepositories: [{ repositoryId: "git-e2e", provider: "git", approvedRoot: fixture, ownerCheckout: owner, fileOwnershipPrefix: "owned" }] });
  const gitIntent = { id: randomUUID(), attemptId: randomUUID(), action: "allocate", scope: { projectId: gitProject, repositoryId: "git-e2e", provider: "git", ownerCheckout: owner, approvedRoot: fixture, workspacePath: gitPath, workspaceName: "writer", branch: `writer-${id.slice(0,8)}`, baseRevision: gitHead, headRevision: gitHead, owner: gitOwner, leaseReason: "workspace allocation e2e", sharedObjectStore: null, fileOwnership: ["owned/a.txt"], capabilityProfileRevision: "e2e-1" } };
  let r = await iso.allocate(gitIntent); report.receipts.push(r); check(r.state === "allocated", "Git allocated from prepared Durable intent"); check(run("/usr/bin/git", ["status", "--porcelain=v1"], owner) === "", "Git owner unchanged"); writeFileSync(join(gitPath, "dirty.txt"), "preserve\n"); r = await iso.release(gitIntent); report.receipts.push(r); check(r.state === "preserved", "dirty Git workspace preserved"); const cleanIntent = { ...gitIntent, id: randomUUID(), attemptId: randomUUID(), scope: { ...gitIntent.scope, workspacePath: join(fixture, "clean"), workspaceName: "clean", branch: `clean-${id.slice(0,8)}` } }; r = await iso.allocate(cleanIntent); report.receipts.push(r); check(r.state === "allocated", "clean Git allocated"); r = await iso.release(cleanIntent); report.receipts.push(r); check(r.state === "released", "owned Git lock unlocked and unforced clean removal"); await h.close(BACKGROUND_CONTEXT);
  save(); // Provider-plugin backends are tested in their own repositories.
} catch (error) { report.error = error instanceof Error ? error.message : String(error); save(); process.exitCode = 1; }
console.log(JSON.stringify({ evidence, exitCode: process.exitCode ?? 0 }));
