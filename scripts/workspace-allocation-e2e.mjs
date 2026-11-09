#!/usr/bin/env -S node --experimental-strip-types
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceIsolation } from "../src/workspace-isolation.ts";
import { endedWorkerWorkspaceOwner } from "../src/durable-workspace-binding.ts";
import { Jobs } from "../src/jobs.ts";
import { archiveHome, currentWorktreeRoot } from "../src/archive-host.ts";
import { grantWorkspace, trustedOwner } from "../src/workspace-authorization.ts";
import { commandProfilesSnapshot, prepareCommandProfile } from "../src/command-profiles.ts";
import { projectDir } from "../src/state.ts";

const id = randomUUID(),
  stamp = new Date().toISOString().replaceAll(":", "-");
const evidence = join(process.env.PI_ARTIFACTS_DIR ?? join(process.cwd(), "artifacts"), `workspace-allocation-${stamp}-${id}`);
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const report = {
  failuresRecordedBeforeEffects: [
    "effect before receipt",
    "dirty/foreign/active cleanup",
    "provider/scope mismatch",
    "shared object store and lease drift (provider plugins test their own backends)",
  ],
  checks: [],
  receipts: [],
  commands: [],
};
const run = (file, args, cwd) => {
  report.commands.push({ file, args, cwd });
  return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};
const check = (value, message) => {
  report.checks.push({ value, message });
  if (!value) throw Error(message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = () =>
  writeFileSync(join(evidence, "report.json"), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2) + "\n", {
    mode: 0o600,
  });
async function durable() {
  const h = await Harness.open(
    await openNodeSqliteStorage(join(evidence, "durable.sqlite")),
    { models: await ModelRuntime.create({ allowModelNetwork: false }), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  return [h, await h.root(BACKGROUND_CONTEXT)];
}
try {
  const fixtureRaw = join(tmpdir(), `workspace-git-${id}`);
  mkdirSync(fixtureRaw, { recursive: true });
  const fixture = realpathSync(fixtureRaw),
    owner = join(fixture, "owner"),
    gitPath = join(fixture, "writer");
  mkdirSync(owner, { recursive: true });
  run("/usr/bin/git", ["init", "--initial-branch=main"], owner);
  run("/usr/bin/git", ["config", "user.email", "e2e@example.invalid"], owner);
  run("/usr/bin/git", ["config", "user.name", "e2e"], owner);
  writeFileSync(join(owner, "owner.txt"), "owner\n");
  run("/usr/bin/git", ["add", "owner.txt"], owner);
  run("/usr/bin/git", ["commit", "-m", "fixture"], owner);
  const gitHead = run("/usr/bin/git", ["rev-parse", "HEAD"], owner).trim();
  const gitProject = randomUUID(),
    gitOwner = `agent-session-${id}`;
  let [h, root] = await durable();
  let iso = workspaceIsolation({
    conversation: root,
    authority: { projectId: gitProject, owner: gitOwner },
    authorizedRepositories: [
      { repositoryId: "git-e2e", provider: "git", approvedRoot: fixture, ownerCheckout: owner, fileOwnershipPrefix: "owned" },
    ],
  });
  const gitIntent = {
    id: randomUUID(),
    attemptId: randomUUID(),
    action: "allocate",
    scope: {
      projectId: gitProject,
      repositoryId: "git-e2e",
      provider: "git",
      ownerCheckout: owner,
      approvedRoot: fixture,
      workspacePath: gitPath,
      workspaceName: "writer",
      branch: `writer-${id.slice(0, 8)}`,
      baseRevision: gitHead,
      headRevision: gitHead,
      owner: gitOwner,
      leaseReason: "workspace allocation e2e",
      sharedObjectStore: null,
      fileOwnership: ["owned/a.txt"],
      capabilityProfileRevision: "e2e-1",
    },
  };
  let r = await iso.allocate(gitIntent);
  report.receipts.push(r);
  check(r.state === "allocated", "Git allocated from prepared Durable intent");
  check(run("/usr/bin/git", ["status", "--porcelain=v1"], owner) === "", "Git owner unchanged");
  writeFileSync(join(gitPath, "dirty.txt"), "preserve\n");
  r = await iso.release(gitIntent);
  report.receipts.push(r);
  check(r.state === "preserved", "dirty Git workspace preserved");
  const cleanIntent = {
    ...gitIntent,
    id: randomUUID(),
    attemptId: randomUUID(),
    scope: { ...gitIntent.scope, workspacePath: join(fixture, "clean"), workspaceName: "clean", branch: `clean-${id.slice(0, 8)}` },
  };
  r = await iso.allocate(cleanIntent);
  report.receipts.push(r);
  check(r.state === "allocated", "clean Git allocated");
  r = await iso.release(cleanIntent);
  report.receipts.push(r);
  check(r.state === "released", "owned Git lock unlocked and unforced clean removal");
  // A continued branch held by the previous host's worktree: taken over only when clean and pushed, and only under the old home.
  const git = (cwd, ...args) => run("/usr/bin/git", args, cwd).trim();
  const remote = join(fixture, "remote.git");
  git(fixture, "init", "--bare", "--initial-branch=main", remote);
  git(owner, "remote", "add", "origin", remote);
  git(owner, "push", "origin", "main");
  const currentRoot = join(fixture, "current-worktrees");
  mkdirSync(currentRoot);
  const oldHome = join(fixture, "old-home");
  mkdirSync(join(oldHome, "wt"), { recursive: true });
  const held = (name, where) => {
    git(owner, "branch", name, "main");
    git(owner, "push", "origin", name);
    const path = join(where, name);
    git(owner, "worktree", "add", "--lock", "--reason", "old host", path, name);
    return path;
  };
  const continueIntent = (name) => ({
    ...gitIntent,
    id: randomUUID(),
    attemptId: randomUUID(),
    scope: {
      ...gitIntent.scope,
      approvedRoot: currentRoot,
      workspacePath: join(currentRoot, `new-${name}`),
      workspaceName: name,
      branch: name,
      continueBranch: true,
    },
  });
  const takeover = async (name, where, prepare = () => {}) => {
    const path = held(name, where);
    prepare(path);
    iso = workspaceIsolation({ ...isoOptions, oldHome });
    return [path, await iso.allocate(continueIntent(name))];
  };
  const isoOptions = {
    conversation: root,
    authority: { projectId: gitProject, owner: gitOwner },
    authorizedRepositories: [
      { repositoryId: "git-e2e", provider: "git", approvedRoot: currentRoot, ownerCheckout: owner, fileOwnershipPrefix: "owned" },
    ],
  };
  // Current-host recovery must preserve ignored files even with a missing archive home and no remote branch.
  const sameHost = async (name, refusal = null, prepare = () => {}) => {
    const { continueBranch: _continued, ...sourceScope } = continueIntent(name).scope;
    const source = {
      ...continueIntent(name),
      scope: { ...sourceScope, workspacePath: join(currentRoot, name) },
    };
    const allocator = workspaceIsolation(isoOptions);
    check((await allocator.allocate(source)).state === "allocated", `${name}: source allocated`);
    await prepare(source.scope.workspacePath);
    const recovery = workspaceIsolation({ ...isoOptions, oldHome: join(fixture, "missing-home"), endedWorktreeOwner: async () => refusal });
    const target = await recovery.allocate(continueIntent(name));
    report.receipts.push(target);
    return [source, target];
  };
  const [detached, continued] = await sameHost("same-ended", null, (path) => {
    git(path, "config", "core.excludesFile", join(fixture, "ignored-patterns"));
    writeFileSync(join(fixture, "ignored-patterns"), "evidence/\n");
    mkdirSync(join(path, "evidence"));
    writeFileSync(join(path, "evidence", "proof.txt"), "keep proof\n");
  });
  check(continued.state === "allocated", `ended same-host holder continued: ${continued.reason}`);
  check(git(detached.scope.workspacePath, "rev-parse", "--abbrev-ref", "HEAD") === "HEAD", "old holder detached");
  check(readFileSync(join(detached.scope.workspacePath, "evidence", "proof.txt"), "utf8") === "keep proof\n", "ignored evidence preserved");
  check(git(owner, "rev-parse", `refs/heads/${detached.scope.branch}`) === gitHead, "branch and commits preserved without push");
  const threadId = randomUUID(),
    scopeId = randomUUID();
  const hex = createHash("sha256").update(`${gitProject}:${threadId}:${scopeId}`).digest("hex");
  const ownedReceipt = {
    ...continued,
    intentId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    scope: { ...continued.scope, leaseReason: `durable workspace ${threadId}` },
  };
  const ownerState = async (endedAt, status, paused = false, dismissedAt) =>
    root.commit(async (tx) => {
      const state = await tx.doc(Jobs, root.id);
      state.paused = paused;
      state.agents[threadId] = { id: threadId, role: "worker", jobId: threadId, scopeId, endedAt };
      state.jobs[threadId] = { id: threadId, status, ...(dismissedAt === undefined ? {} : { dismissedAt }) };
    }, BACKGROUND_CONTEXT);
  await ownerState(1, "ready-with-gaps");
  check((await endedWorkerWorkspaceOwner(root, ownedReceipt)) === null, "durable ended owner accepted");
  for (const [endedAt, status, paused] of [
    [null, "running", false],
    [null, "running", true],
    [1, "running", true],
    [1, "checkpoint", false],
  ]) {
    await ownerState(endedAt, status, paused);
    check(
      typeof (await endedWorkerWorkspaceOwner(root, ownedReceipt)) === "string",
      `durable live/suspended/checkpoint owner refused: ${status}/${paused}`,
    );
  }
  await ownerState(1, "checkpoint", false, 1);
  check((await endedWorkerWorkspaceOwner(root, ownedReceipt)) === null, "dismissed checkpoint owner ended");
  check(
    typeof (await endedWorkerWorkspaceOwner(root, { ...ownedReceipt, intentId: randomUUID() })) === "string",
    "foreign ownership identity refused",
  );
  await ownerState(1, "ready");
  const [firstClaim, secondClaim] = await Promise.all([
    endedWorkerWorkspaceOwner(root, ownedReceipt, "next-intent"),
    endedWorkerWorkspaceOwner(root, ownedReceipt, "other-intent"),
  ]);
  check([firstClaim, secondClaim].filter((value) => value === null).length === 1, "concurrent claims have only one winner");
  const claimed = await root.commit(async (tx) => (await tx.doc(Jobs, root.id)).agents[threadId].workspaceContinuedBy, BACKGROUND_CONTEXT);
  check(claimed === "next-intent" || claimed === "other-intent", "handoff is durable before Git detach");
  check((await endedWorkerWorkspaceOwner(root, ownedReceipt, claimed)) === null, "same claim is replay safe");
  for (const reason of ["owning thread is live", "owning thread is suspended", "owning thread is unknown"]) {
    const [source, blocked] = await sameHost(`same-${reason.split(" ").at(-1)}`, reason);
    check(
      blocked.state === "blocked" && blocked.reason.includes(source.scope.workspacePath) && blocked.reason.includes(reason),
      `${reason}: precise refusal`,
    );
    check(git(source.scope.workspacePath, "branch", "--show-current") === source.scope.branch, `${reason}: branch unchanged`);
  }
  for (const tracked of [false, true]) {
    const [source, blocked] = await sameHost(`same-dirty-${tracked}`, null, (path) =>
      writeFileSync(join(path, tracked ? "owner.txt" : "untracked.txt"), "keep changes\n"),
    );
    check(
      blocked.state === "blocked" && blocked.reason.includes(source.scope.workspacePath) && /uncommitted/.test(blocked.reason),
      "dirty same-host holder refused",
    );
    check(git(source.scope.workspacePath, "branch", "--show-current") === source.scope.branch, "dirty branch unchanged");
  }
  const [foreign, foreignResult] = await sameHost("same-foreign-lock", null, (path) => {
    git(owner, "worktree", "unlock", path);
    git(owner, "worktree", "lock", "--reason", "foreign", path);
  });
  check(
    foreignResult.state === "blocked" && foreignResult.reason.includes(foreign.scope.workspacePath) && /lock/.test(foreignResult.reason),
    "foreign lock refused",
  );
  let busy;
  try {
    const [source, blocked] = await sameHost("same-busy", null, async (path) => {
      busy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: path, stdio: "ignore" });
      await new Promise((ok, fail) => {
        busy.once("spawn", ok);
        busy.once("error", fail);
      });
    });
    check(
      blocked.state === "blocked" && blocked.reason.includes(source.scope.workspacePath) && /process/.test(blocked.reason),
      "active same-host holder refused",
    );
  } finally {
    if (busy) {
      const ended = new Promise((ok) => busy.once("exit", ok));
      busy.kill();
      await ended;
    }
  }
  let [oldPath, taken] = await takeover("held-clean", join(oldHome, "wt"));
  report.receipts.push(taken);
  check(
    taken.state === "allocated" && !existsSync(oldPath),
    "clean pushed worktree under the old home is removed and the branch continued",
  );
  check(
    taken.providerFacts.reclaimedWorktree === realpathSync(join(oldHome, "wt")) + "/held-clean",
    "the removal is recorded in the receipt facts",
  );
  [oldPath, taken] = await takeover("held-dirty", join(oldHome, "wt"), (path) => writeFileSync(join(path, "scratch.txt"), "keep\n"));
  check(taken.state === "blocked" && existsSync(oldPath), "a dirty old worktree is kept");
  check(
    /held-dirty/.test(taken.reason) && taken.reason.includes(oldPath) && /scratch\.txt/.test(taken.reason),
    "the refusal names the path, branch and file",
  );
  [oldPath, taken] = await takeover("held-ahead", join(oldHome, "wt"), (path) => {
    writeFileSync(join(path, "ahead.txt"), "x\n");
    git(path, "add", "ahead.txt");
    git(path, "-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-m", "unpushed");
  });
  check(
    taken.state === "blocked" && existsSync(oldPath) && /not pushed/.test(taken.reason),
    "an old worktree with an unpushed commit is kept",
  );
  const outside = join(fixture, "herdr");
  mkdirSync(outside, { recursive: true });
  [oldPath, taken] = await takeover("held-outside", outside);
  check(
    taken.state === "blocked" && existsSync(oldPath) && /outside the previous host/.test(taken.reason),
    "a worktree outside the old home is never removed",
  );
  const { continueBranch: _drop, ...plainScope } = continueIntent("plain").scope;
  taken = await iso.allocate({ ...continueIntent("plain"), scope: { ...plainScope, branch: "main" } });
  check(taken.state === "blocked" && /already exists/.test(taken.reason), "a blocked reason carries git's own message");
  // A carried project's approved root inside the old home is replaced by this host's own folder, without touching the stored grant.
  process.env.PI_PROJECTS_HOME = join(fixture, "new-home");
  const carried = join(archiveHome(), gitProject, "worktrees");
  check(
    currentWorktreeRoot(gitProject, carried) === realpathSync(join(projectDir(gitProject), "worktrees")),
    "an approved root in the old home maps to this host's folder",
  );
  check(currentWorktreeRoot(gitProject, fixture) === fixture, "any other approved root is used as granted");
  // H1: the old home is gone; a carried grant still takes a new scope and keeps its stored root.
  writeFileSync(join(process.env.PI_PROJECTS_HOME, "archive.json"), JSON.stringify({ home: join(fixture, "removed-old-home") }));
  const gone = join(archiveHome(), gitProject, "worktrees");
  check(!existsSync(gone), "the old home does not exist");
  const carriedProject = {
    id: gitProject,
    name: "Carried",
    cwd: owner,
    workspaceAuthorization: {
      version: 1,
      provider: "github",
      owner: trustedOwner(),
      repositories: [
        {
          repositoryId: "carried/repo",
          provider: "github",
          ownerCheckout: owner,
          approvedRoot: gone,
          fileOwnershipPrefix: "src",
          sharedObjectStore: null,
        },
      ],
      scopes: [],
    },
  };
  const regranted = grantWorkspace({
    project: carriedProject,
    repositoryId: "carried/repo",
    provider: "github",
    ownerCheckout: owner,
    approvedRoot: gone,
    fileOwnershipPrefix: "src",
    files: ["src/a.ts"],
    baseRevision: run("/usr/bin/git", ["rev-parse", "HEAD"], owner).trim(),
  });
  check(
    regranted.project.workspaceAuthorization.repositories[0].approvedRoot === gone &&
      regranted.project.workspaceAuthorization.scopes.length === 1,
    "H1 a carried grant takes a new scope after the old home is removed and keeps its stored root",
  );
  // H2: a command profile of that project is checked against the folder the host uses, not the removed one.
  const profiled = await prepareCommandProfile(regranted.project, {
    id: gitProject,
    confirm: gitProject,
    expectedRevision: commandProfilesSnapshot(regranted.project).revision,
    profile: {
      id: randomUUID(),
      label: "List",
      repositoryId: "carried/repo",
      scopeIds: [regranted.scope.id],
      executable: "/bin/ls",
      arguments: [],
      effect: "workspace",
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      enabled: true,
    },
  });
  check(profiled.program.path === "/bin/ls", "H2 a command profile is accepted after the old home is removed");
  await h.close(BACKGROUND_CONTEXT);
  save(); // Provider-plugin backends are tested in their own repositories.
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  save();
  process.exitCode = 1;
}
console.log(JSON.stringify({ evidence, exitCode: process.exitCode ?? 0 }));
