// Private host, real Git worktrees and fake-model tool calls. See codemode-native-tools-failures.md.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKit, call, say, randomUUID } from "./lib/e2e-kit.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const where = `await tools.bash({ command: 'pwd; echo "ART=$PI_ARTIFACTS_DIR"; echo "CACHE=$PI_WORKSPACE_CACHE"' })`;
let owner = "",
  root = "",
  approvalTarget = "",
  coordinatorResults = [];
const scripts = {
  coordinator: () => `const ok = ${where};
const failed = await tools.bash({ command: "echo before-exit; exit 3" });
console.log(JSON.stringify({ ok, failed, models: typeof models }));`,
  worker: () => `const at = ${where};
const push = await tools.bash({ command: "git push origin HEAD:main" });
let write = "wrote";
try { await tools.write({ path: ${JSON.stringify(join(owner, "owned.txt"))}, content: "x" }); } catch (error) { write = String(error.message ?? error); }
console.log(JSON.stringify({ at, push, write }));`,
  scout:
    () => `const reach = async (name, args) => { try { await tools[name](args); return "reached"; } catch (error) { return /does not exist/.test(String(error.message)) ? "missing" : String(error.message ?? error).slice(0, 120); } };
console.log(JSON.stringify({ bash: await reach("bash", { command: "touch reached" }), write: await reach("write", { path: "reached", content: "x" }), edit: await reach("edit", { path: "README.md", edits: [] }), code_read: typeof tools.code_read }));`,
  sleeper: () => `await tools.bash({ command: ${JSON.stringify(`touch ${root}/started; sleep 8; touch ${root}/finished`)} });`,
};
const spawn = (marker, role = "worker") =>
  call("agents", {
    action: "spawn",
    role,
    title: marker,
    brief: marker,
    ...(role === "worker" ? { acceptance: ["Run the script"] } : {}),
    requestId: randomUUID(),
  });
const coordinatorSteps = [
  ["codemode", { code: scripts.coordinator() }],
  ["codemode", { code: 'console.log("y".repeat(400000))' }],
  ["read", { path: "pic.png" }],
  [
    "codemode",
    {
      code: `const art = await tools.projects_artifacts_list({});
const written = await tools.projects_knowledge_write({ path: "runbooks/typed.md", text: "typed", expectedRevision: null });
const noted = await tools.projects_note({ text: "typed note" });
console.log(JSON.stringify({ art: Array.isArray(art?.threads), written: typeof written?.revision, noted: typeof noted?.id }));`,
    },
  ],
];
const k = await createKit("codemode-native-tools", {
  handler: ({ role, user, results }) => {
    const once = (code) => (results.length ? say(`finished ${role}`) : call("codemode", { code }));
    if (role === "coordinator") {
      if (user === "MARK-COORD") coordinatorResults = results;
      if (user === "MARK-COORD")
        return results.length < coordinatorSteps.length ? call(...coordinatorSteps[results.length]) : say("Coordinator finished");
      if (user === "MARK-NESTED")
        return results.length
          ? say("nested done")
          : call("codemode", {
              code: `await tools.bash({ command: "true" });
try { await tools.read({ path: "missing-file.txt" }); } catch {}
await tools.bash({ command: ${JSON.stringify(`touch ${root}/nested-started; sleep 4`)} });`,
            });
      if (user === "MARK-DISABLED")
        return results.length
          ? say("disabled done")
          : call("codemode", {
              code: `let outcome;
try { await tools["projects_knowledge_write"]({ path: "preferences/forbidden.md", text: "must not run", expectedRevision: null }); outcome = "ran"; }
catch (error) { outcome = String(error.message ?? error); }
console.log(JSON.stringify({ outcome, exposed: ALL_TOOLS.includes("projects_knowledge_write") }));`,
            });
      if (user === "MARK-APPROVAL")
        return results.length
          ? say("approval done")
          : call("codemode", {
              code: `let direct = "not exposed";
try { await tools.archive({ id: ${JSON.stringify(approvalTarget)} }); direct = "ran"; } catch {}
const gate = await tools.owner_approval_request({ action: "archive", input: { id: ${JSON.stringify(approvalTarget)} }, summary: "Archive the nested-code-mode target" });
console.log(JSON.stringify({ direct, state: gate.state, action: gate.action }));`,
            });
      for (const [marker, kind] of [
        ["MARK-WORKER", "WORKER-CODE"],
        ["MARK-SCOUT", "SCOUT-CODE"],
        ["MARK-SLEEP", "WORKER-SLEEP"],
      ])
        if (user === marker) return results.length ? say("queued") : spawn(kind, kind === "SCOUT-CODE" ? "scout" : "worker");
      return;
    }
    if (user.includes("WORKER-CODE")) return once(scripts.worker());
    if (user.includes("SCOUT-CODE")) return once(scripts.scout());
    if (user.includes("WORKER-SLEEP")) return once(scripts.sleeper());
  },
});
owner = k.workspace;
root = k.root;
await k.run(async () => {
  k.initRepo();
  writeFileSync(join(k.workspace, "pic.png"), Buffer.from(PNG, "base64"));
  k.git(k.workspace, "add", "pic.png");
  k.git(k.workspace, "commit", "-qm", "pic");
  const id = await k.createProject("Native tools and code mode");
  const offered = (role, marker) => k.result.calls.find((c) => c.role === role && c.user.includes(marker))?.tools ?? [];
  const parse = (text) => {
    const line = text.split("\n").find((value) => value.startsWith("{"));
    try {
      return line ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  };

  await k.ask(id, "MARK-COORD");
  k.check(
    "N1 coordinator is offered codemode with read and bash",
    ["codemode", "read", "bash"].every((n) => offered("coordinator", "MARK-COORD").includes(n)),
    offered("coordinator", "MARK-COORD"),
  );
  const results = coordinatorResults; // untruncated, unlike result.calls
  const coordinator = parse(results[0] ?? "");
  k.check(
    "N2 tools.bash resolves with output and exitCode, also for a nonzero exit",
    coordinator?.ok?.exitCode === 0 && coordinator?.failed?.exitCode === 3 && coordinator.failed.output.includes("before-exit"),
    results[0],
  );
  const worktree = coordinator?.ok?.output?.split("\n")[0] ?? "";
  k.check(
    "N3 a coordinator script runs bash in the chat worktree with $PI_ARTIFACTS_DIR",
    worktree.startsWith(k.root) && worktree !== k.workspace && /ART=\S*\/artifacts\//.test(coordinator?.ok?.output ?? ""),
    coordinator?.ok,
  );
  const cacheOf = (output) => /CACHE=(\S*)/.exec(output ?? "")?.[1] ?? "";
  const coordinatorCache = cacheOf(coordinator?.ok?.output);
  k.check(
    "C3 a coordinator's bash names its chat workspace's cache folder, outside the worktree",
    /\/workspace-cache\/[0-9a-f-]{36}$/.test(coordinatorCache) &&
      coordinatorCache.startsWith(k.home) &&
      !coordinatorCache.startsWith(worktree),
    coordinator?.ok,
  );
  k.check("N7 scripts get no models global", coordinator?.models === "undefined", coordinator);
  k.check(
    "N9 output past the budget keeps its full text in a file",
    /\[Full output: \S+ \(read with offset\/limit\)\]/.test(results[1] ?? "") && !/Could not save/.test(results[1] ?? ""),
    (results[1] ?? "").slice(-600),
  );
  k.check(
    "N10 a direct image read returns a stored artifact reference",
    /artifact:[^)\s]+\/binary\/[0-9a-f]+\.png/.test(results[2] ?? ""),
    results[2],
  );

  k.check(
    "N11 scripts get artifact listings and knowledge receipts as objects",
    JSON.stringify(parse(results[3] ?? "")) === JSON.stringify({ art: true, written: "string", noted: "string" }),
    results[3],
  );

  const page = await k.openPage(await k.webUrl(id));
  await page.waitFor(`document.body.dataset.ready === "1" && !!document.querySelector("#composer")`, "chat page");
  await k.rpc({ action: "message", id, text: "MARK-NESTED" });
  await k.eventually(() => existsSync(join(k.root, "nested-started")), "nested bash started");
  const nested = `document.querySelector('#feed .tool-row.live[data-tool="codemode"] [data-nested]')?.textContent ?? ""`;
  await page.waitFor(`/now .*bash/.test(${nested}) && /2 calls done, 1 failed/.test(${nested})`, "nested live status", 60000);
  const live = await page.evaluate(nested);
  await page.shot("nested-live-status");
  k.check("N13 the live codemode row names the running nested tool and counts finished and failed calls in text", true, live);
  await k.settle(id);

  // Cache root setting: absolute only, revision-checked; a set root holds each project's caches in its own folder.
  const storage = await k.rpc({ action: "storage-get" });
  const refused = async (input, pattern) => {
    try {
      await k.rpc({ action: "storage-set", ...input });
      return false;
    } catch (error) {
      return pattern.test(String(error.message ?? error));
    }
  };
  k.check(
    "C12 a relative cache root and a stale revision are refused",
    storage.storage.cacheRoot === null &&
      (await refused({ revision: storage.revision, patch: { cacheRoot: "caches" } }, /absolute/i)) &&
      (await refused({ revision: "0".repeat(64), patch: { cacheRoot: "/tmp/x" } }, /revision/i)),
    storage,
  );
  const cacheRoot = join(k.root, "custom-cache");
  await k.rpc({ action: "storage-set", revision: storage.revision, patch: { cacheRoot } });
  await k.ask(id, "MARK-WORKER");
  k.check(
    "N1 a scoped worker is offered codemode",
    offered("worker", "WORKER-CODE").includes("codemode"),
    offered("worker", "WORKER-CODE"),
  );
  const worker = await k.eventually(() => parse(k.toolResult("worker", "WORKER-CODE")), "worker script result");
  k.check(
    "N3 a worker script runs bash in its own worktree with $PI_ARTIFACTS_DIR",
    worker?.at?.exitCode === 0 &&
      !worker.at.output.startsWith(k.workspace) &&
      worker.at.output.split("\n")[0] !== worktree &&
      /ART=\S*\/artifacts\//.test(worker.at.output),
    worker?.at,
  );
  k.check(
    "C3/C13 a worker's cache folder is its own, under the set cache root in the project's folder",
    new RegExp(`^${cacheRoot}/${id}/[0-9a-f-]{36}$`).test(cacheOf(worker?.at?.output)),
    worker?.at,
  );
  k.check(
    "N4 a nested worker push to main is blocked by the Git policy",
    worker?.push?.exitCode === 126 && /Blocked by worker Git policy/.test(worker.push.output),
    worker?.push,
  );
  k.check(
    "N5 a nested worker write to the owner's checkout is refused",
    /inside the owner's checkout/.test(worker?.write ?? "") && !existsSync(join(k.workspace, "owned.txt")),
    worker?.write,
  );

  await k.ask(id, "MARK-SCOUT");
  k.check("N1 a scout is offered codemode", offered("scout", "SCOUT-CODE").includes("codemode"), offered("scout", "SCOUT-CODE"));
  const scout = await k.eventually(() => parse(k.toolResult("scout", "SCOUT-CODE")), "scout script result");
  k.check(
    "N6 a scout script reaches no bash, write or edit",
    scout?.code_read === "function" && ["bash", "write", "edit"].every((name) => scout[name] === "missing"),
    scout,
  );

  await k.rpc({ action: "message", id, text: "MARK-SLEEP" });
  await k.waitFor(() => existsSync(join(k.root, "started")), "nested sleeper start", { timeout: 60000 });
  const snapshot = await k.rpc({ action: "jobs-snapshot", id });
  const job = snapshot.jobs.find((item) => item.title === "WORKER-SLEEP");
  const agent = snapshot.agents.find((item) => item.jobId === job?.id || item.id === job?.agentId || item.title === "WORKER-SLEEP");
  await k.rpc({ action: "thread-stop", id, threadId: agent?.id ?? job?.threadId });
  await k.settle(id);
  await k.delay(9000);
  k.check("N8 stopping a worker stops its script's nested bash", !existsSync(join(k.root, "finished")), { job, agent });

  const profiles = await k.rpc({ action: "profiles-get", projectId: id });
  await k.rpc({
    action: "profiles-set",
    projectId: id,
    revision: profiles.revision,
    profile: "coordinator",
    patch: { tools: { disabled: ["projects_knowledge_write"] } },
  });
  await k.ask(id, "MARK-DISABLED");
  const disabled = parse(k.toolResult("coordinator", "MARK-DISABLED"));
  k.check(
    "N14 codemode cannot invoke a tool disabled for the conversation profile",
    disabled?.exposed === false && /does not exist|not available|unknown/i.test(disabled?.outcome ?? "") && disabled?.outcome !== "ran",
    disabled ?? k.toolResult("coordinator", "MARK-DISABLED"),
  );

  approvalTarget = await k.createProject("Nested approval target", { grant: false });
  await k.ask(id, "MARK-APPROVAL");
  const gate = parse(k.toolResult("coordinator", "MARK-APPROVAL"));
  const pending = (await k.rpc({ action: "approvals-list" })).approvals.find(
    (item) => item.action === "archive" && item.input.id === approvalTarget,
  );
  k.check(
    "N15 a nested dangerous action only files an owner approval and does not run directly",
    gate?.direct === "not exposed" && pending?.state === "pending" && pending?.requestedBy.kind === "coordinator",
    { gate, pending },
  );
  k.check(
    "N16 the dangerous nested request has not changed its target before approval",
    (await k.rpc({ action: "list" })).find((item) => item.id === approvalTarget)?.archived !== true,
  );
});
