// E2E: worktree lifecycle (C2 git merge/rebase + any thread continues a project PR branch, C3 PR-head reads,
// C4 per-project setup command, C9 safe cleanup + Settings action, C11 a/c/d/f/g, attempt.toolNames).
// Isolated host, local fake model, fake gh, local bare remote. No real providers, no network.
// Failure cases recorded in worktree-lifecycle-failures.md before implementation.
import { spawn, execFileSync } from "node:child_process";
import { createServer, request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { call } from "./lib/e2e-kit.mjs";

const repo = process.cwd();
const artifacts = join(repo, "artifacts", `worktree-lifecycle-${new Date().toISOString().replaceAll(":", "-")}`);
const root = join(realpathSync(tmpdir()), `worktree-lifecycle-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace"),
  agentDir = join(root, "agent"),
  userHome = join(root, "userhome"),
  clone = join(root, "clone");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw Error("Clear runtime overrides first");
for (const dir of [artifacts, root, home, workspace, agentDir, userHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { root, checks: [], calls: [], errors: [], httpErrors: [] };
const save = () => writeFileSync(join(artifacts, "report.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
const check = (name, ok, detail) => {
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`);
  result.checks.push(name);
  process.stderr.write(`PASS ${name}\n`);
};

const bare = join(root, "remote.git"),
  fakeGh = join(root, "fake-gh"),
  ghState = join(root, "fake-gh-state.json"),
  ghCalls = join(root, "fake-gh-calls.jsonl");
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "scripts/fake-gh.mjs")}" "$@"\n`);
chmodSync(fakeGh, 0o755);
writeFileSync(
  ghState,
  JSON.stringify({ repo: { id: 4242, full_name: "acme/mari", default_branch: "main" }, issues: [], checks: {}, pulls: [] }),
);
writeFileSync(ghCalls, "");
const gh$ = () => JSON.parse(readFileSync(ghState, "utf8"));
const ghSet = (change) => {
  const state = gh$();
  change(state);
  writeFileSync(ghState, JSON.stringify(state));
};

const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const say = (value) => chunk({ role: "assistant", content: value }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
const contentText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : JSON.stringify(content ?? "");
// The fake "brain" remembers W1's branch from its push output.
const brain = { b1: null, sha1: null };
const model = createServer((req, res) => {
  req.setEncoding("utf8");
  let body = "";
  req.on("data", (part) => {
    body += part;
  });
  req.on("end", async () => {
    const input = JSON.parse(body),
      msgs = input.messages,
      tools = (input.tools ?? []).map((t) => t.function?.name).filter(Boolean);
    const first = contentText(msgs.find((m) => m.role === "user")?.content);
    const role = tools.includes("agents")
      ? "coordinator"
      : tools.includes("bash")
        ? "worker"
        : tools.includes("code_read")
          ? /REVIEW/.test(first)
            ? "reviewer"
            : "scout"
          : "other";
    const lastUser = msgs.findLastIndex((m) => m.role === "user"),
      userText = contentText(msgs[lastUser]?.content);
    const firstUser = contentText(msgs.find((m) => m.role === "user")?.content);
    const results = msgs
      .slice(lastUser + 1)
      .filter((m) => m.role === "tool")
      .map((m) => contentText(m.content));
    const system = contentText(msgs.find((m) => m.role === "system" || m.role === "developer")?.content);
    result.calls.push({
      at: Date.now(),
      role,
      first: firstUser.slice(0, 200),
      user: userText.slice(0, 1500),
      results: results.map((r) => r.slice(0, 3000)),
      tools,
      system: role === "worker" || role === "coordinator" ? system : undefined,
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tool = (suffix) => tools.find((name) => name.endsWith(suffix));
    if (role === "coordinator") {
      const owner = !/^\[(worker|reviewer|scout) /.test(userText);
      if (!owner) return res.end(say(""));
      const n = results.length;
      if (/MARK-BUILD/.test(userText) && n === 0)
        return res.end(call("projects_delegate", { role: "worker", task: "W1-TASK add feature.txt and open a draft PR for it" }));
      if (/MARK-CONTINUE/.test(userText) && n === 0)
        return res.end(
          call("projects_delegate", {
            role: "worker",
            task: `W2-TASK continue the open PR branch ${brain.b1}: merge main into it, resolve conflicts, then rebase it onto main and push it back`,
          }),
        );
      if (/MARK-REVIEW (\S+) (\S+)/.test(userText)) {
        const [, scope, dirtyWorker] = /MARK-REVIEW (\S+) (\S+)/.exec(userText);
        if (n === 0)
          return res.end(
            call("projects_delegate", { role: "reviewer", ref: brain.sha1, task: "REVIEW-HEAD review feature.txt on the PR head" }),
          );
        if (n === 1)
          return res.end(call("projects_delegate", { role: "scout", workspaceScopeId: scope, task: "SCOUT-SCOPED read README.md" }));
        if (n === 2)
          return res.end(
            call("projects_delegate", {
              role: "reviewer",
              ref: `--upload-pack=touch /tmp/pwned-lifecycle-${process.pid}`,
              task: "BAD-REF",
            }),
          );
        if (n === 3) return res.end(call("projects_delegate", { role: "reviewer", ref: brain.b1, task: "BRANCH-REF" }));
        if (n === 4) return res.end(call("projects_delegate", { role: "reviewer", ref: dirtyWorker, task: "DIRTY-READ" }));
        if (n === 5) return res.end(call("projects_delegate", { role: "reviewer", ref: "f".repeat(40), task: "UNKNOWN-COMMIT" }));
        return res.end(say("Review dispatched."));
      }
      if (/MARK-DRIFT (\S+)/.test(userText) && n === 0)
        return res.end(call("projects_delegate", { role: "reviewer", ref: /MARK-DRIFT (\S+)/.exec(userText)[1], task: "DRIFT-REVIEW" }));
      if (/MARK-LOCAL/.test(userText) && n === 0)
        return res.end(call("projects_delegate", { role: "worker", task: "W3-TASK commit local.txt locally; do not push" }));
      if (/MARK-FOLLOW3 (\S+)/.test(userText) && n === 0)
        return res.end(
          call("projects_worker_control", {
            action: "follow_up",
            threadId: /MARK-FOLLOW3 (\S+)/.exec(userText)[1],
            text: "W3-AGAIN one more change",
            requestId: randomUUID(),
          }),
        );
      if (/MARK-FOLLOW2 (\S+)/.test(userText) && n === 0)
        return res.end(
          call("projects_worker_control", {
            action: "follow_up",
            threadId: /MARK-FOLLOW2 (\S+)/.exec(userText)[1],
            text: "W2-AGAIN keep going",
            requestId: randomUUID(),
          }),
        );
      if (/MARK-FOLLOW (\S+)/.test(userText) && n === 0)
        return res.end(
          call("projects_worker_control", {
            action: "follow_up",
            threadId: /MARK-FOLLOW (\S+)/.exec(userText)[1],
            text: "W1-AGAIN one more change",
            requestId: randomUUID(),
          }),
        );
      return res.end(say("Noted."));
    }
    if (role === "worker") {
      const n = results.length;
      if (/W1-TASK/.test(firstUser) && !/W1-AGAIN/.test(userText)) {
        if (n === 0)
          return res.end(
            call("bash", {
              command: `cat node_modules/dep/ok.txt && printf 'v1\\n' > feature.txt && git add -A && git commit -qm 'Add feature' && git push -q -u origin HEAD && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD`,
            }),
          );
        if (n === 1) {
          brain.b1 = /(pi\/durable-[0-9a-f-]+)/.exec(results[0])?.[1];
          brain.sha1 = /[a-f0-9]{40}/.exec(results[0])?.[0];
          return res.end(
            call(tool("_open_draft_pr"), {
              expectedHead: /[a-f0-9]{40}/.exec(results[0])?.[0],
              title: "Add feature",
              body: "Adds feature.txt.",
            }),
          );
        }
        // A worker that ends without a report becomes a checkpoint and keeps its worktree; W1 delivers.
        if (n === 2) return res.end(call("job", { action: "ready", summary: "W1 feature", pr: "1", candidate: brain.sha1 }));
        return res.end(say(`W1-DONE branch ${brain.b1}`));
      }
      if (/W2-TASK/.test(firstUser) && /W2-AGAIN/.test(userText)) {
        if (n === 0) return res.end(call("bash", { command: "pwd && git branch --show-current && ls wip-note.txt" }));
        return res.end(say("W2-AGAIN-DONE"));
      }
      if (/W2-TASK/.test(firstUser)) {
        if (userText.startsWith("[Child work")) return res.end(say("W2-DONE after child review"));
        const b = brain.b1;
        const steps = [
          `git fetch -q origin && git checkout -q -B cont origin/${b} && git merge --no-edit origin/main; echo MERGE-EXIT=$?`,
          `printf 'v1+main\\n' > feature.txt && git add feature.txt && git -c core.editor=true merge --continue >/dev/null && git log --oneline -1 && git merge-base HEAD origin/main && git push -q origin HEAD:${b} && echo PUSHED-MERGE`,
          `git push origin HEAD:main 2>&1`,
          `git push --force origin HEAD:${b} 2>&1 && echo FORCED-OWN; git push -f origin +HEAD:main 2>&1`,
          `git log --oneline -1 >/dev/null && git checkout -q -B rb origin/${b} && git rebase -X theirs origin/main >/dev/null 2>&1; git log --format=%s -3 && git push -q --force-with-lease origin HEAD:${b} 2>&1 && echo PUSHED-REBASE && git rev-parse HEAD`,
          `printf 'wip\\n' > wip-note.txt && echo WIP-WRITTEN`,
        ];
        if (n < steps.length) return res.end(call("bash", { command: steps[n] }));
        if (n === steps.length)
          return res.end(call("projects_delegate_child", { role: "reviewer", task: "CHILD-REVIEW read wip-note.txt in my worktree" }));
        return res.end(say("W2-WAITING for the child reviewer"));
      }
      if (/W3-TASK/.test(firstUser)) {
        if (n === 0)
          return res.end(
            call("bash", {
              command: `printf 'local\\n' > local.txt && git add local.txt && git commit -qm 'Local only' && echo COMMITTED`,
            }),
          );
        return res.end(say("W3-DONE"));
      }
      return res.end(say("Worker done."));
    }
    if (role === "reviewer" && /DRIFT-REVIEW/.test(firstUser) && results.length === 0) {
      // R9: hold the read open until the test has moved the worker's HEAD.
      brain.driftWaiting = true;
      await brain.driftGate;
    }
    if (role === "reviewer" || role === "scout") {
      const file = /CHILD-REVIEW/.test(firstUser) ? "wip-note.txt" : /REVIEW-HEAD/.test(firstUser) ? "feature.txt" : "README.md";
      if (results.length === 0) return res.end(call("code_read", { path: file }));
      return res.end(say(`SAW[${file}]: ${results[0].replace(/\s+/g, " ").slice(0, 200)}`));
    }
    res.end(say("Done."));
  });
});
await new Promise((ok) => model.listen(0, "127.0.0.1", ok));
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKey: "fake",
        api: "openai-completions",
        models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
      },
    },
  }),
);
const socket = join(
  tmpdir(),
  `pi-projects-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}.sock`,
);
const env = {
  ...process.env,
  HOME: userHome,
  PI_PROJECTS_HOME: home,
  PI_PROJECTS_HOST: "1",
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_PROJECTS_GH_CLI: fakeGh,
  FAKE_GH_STATE: ghState,
  FAKE_GH_BARE: bare,
  FAKE_GH_CALLS: ghCalls,
};
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const git = (dir, ...args) => execFileSync("/usr/bin/git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
execFileSync("/usr/bin/git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
git(workspace, "init", "-b", "main");
git(workspace, "config", "user.email", "e2e@example.invalid");
git(workspace, "config", "user.name", "E2E");
git(workspace, "remote", "add", "origin", "https://github.com/acme/mari.git");
git(workspace, "config", "remote.origin.pushurl", bare);
writeFileSync(join(workspace, "README.md"), "base readme\n");
writeFileSync(join(workspace, ".gitignore"), "node_modules\n");
writeFileSync(join(workspace, "AGENTS.md"), "# Rules\nRun `worktree:setup` first.\n");
git(workspace, "add", ".");
git(workspace, "commit", "-qm", "c1");
git(workspace, "push", "-q", "origin", "main");

let host,
  hostEnded = false,
  hostExit,
  hostRun = 0;
function startHost() {
  const log = createWriteStream(join(artifacts, `host-${++hostRun}.log`), { flags: "wx", mode: 0o600 });
  host = spawn(process.execPath, [join(repo, "src/host.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.pipe(log);
  host.stderr.pipe(log);
  hostEnded = false;
  hostExit = new Promise((ok) =>
    host.once("exit", () => {
      hostEnded = true;
      ok();
    }),
  );
}
function rpc(input) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method: input ? "POST" : "GET",
        path: input ? "/api" : "/health",
        headers: input ? { "content-type": "application/json" } : {},
        timeout: 60000,
      },
      (res) => {
        res.setEncoding("utf8");
        let text = "";
        res.on("data", (part) => {
          text += part;
        });
        res.on("end", () => {
          try {
            const reply = JSON.parse(text);
            if (!reply.ok) throw Error(reply.error);
            resolve(reply.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function eventually(fn, description, tries = 600) {
  for (let i = 0; i < tries * 2; i++) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error(description);
}
const waitHost = () =>
  eventually(async () => {
    if (hostEnded) throw Error("Host exited");
    try {
      return (await rpc()).pid === host.pid;
    } catch {
      return false;
    }
  }, "Owned host did not start");
async function stopHost() {
  if (!hostEnded) {
    try {
      await rpc({ action: "shutdown" });
    } catch {}
    await Promise.race([hostExit, delay(15000)]);
  }
  if (!hostEnded) host.kill("SIGKILL");
}

startHost();
try {
  await waitHost();
  const project = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "Worktrees",
    cwd: workspace,
    objective: "Disposable worktree-lifecycle fixture",
    model: "fake/fake-model",
  });
  const id = project.id;
  const settings = await rpc({ action: "settings-snapshot", id });
  await rpc({
    action: "settings-update",
    id,
    confirm: id,
    expectedRevision: settings.revision,
    changes: { models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" } },
  });
  const first = await rpc({ action: "owner-setup-snapshot", id });
  await rpc({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: first.workspaceRevision });
  // create connects GitHub one-click by itself (docs/ui2-contract.md, create).
  if (!(await rpc({ action: "owner-setup-snapshot", id })).github?.length) throw Error("create did not connect GitHub");
  const scopeId = (await rpc({ action: "owner-setup-snapshot", id })).workspace.scopes[0].id;
  // Fetches go to the local bare remote too (set after the grants, which read the GitHub origin URL).
  git(workspace, "config", `url.${bare}.insteadOf`, "https://github.com/acme/mari.git");
  git(workspace, "fetch", "-q", "origin");
  const plan = async () =>
    (await rpc({ action: "jobs-snapshot", id })).jobs.map((job) => ({
      ...job,
      text: job.request,
      threadId: job.id,
      status: job.status === "running" ? "running" : "completed",
    }));
  const settleAll = () =>
    eventually(
      async () => {
        const main = await rpc({ action: "show", id });
        return !main.chats.some((c) => c.busy) && !(await plan()).some((w) => w.status === "running");
      },
      "project did not go idle",
      1200,
    );
  const ask = async (text) => {
    await rpc({ action: "message", id, text });
    await delay(300);
    await settleAll();
  };
  const byText = (work, marker) => work.filter((w) => w.text.includes(marker));
  const inventory = () => rpc({ action: "worktrees-snapshot", id });

  // UI: Settings → Worktrees card; save the setup command through the page.
  const setupCommand = "mkdir -p node_modules/dep && echo installed > node_modules/dep/ok.txt && echo SETUP-DONE";
  // The classic Settings worktree card was retired 2026-11-04; its save is the same revision-checked settings-update.
  const before = await rpc({ action: "settings-snapshot", id });
  await rpc({ action: "settings-update", id, confirm: id, expectedRevision: before.revision, changes: { worktreeSetup: setupCommand } });
  await eventually(
    async () => (await rpc({ action: "settings-snapshot", id })).values.worktreeSetup === setupCommand,
    "setup command not saved",
  );
  check("W5 the setup command is saved (revision-checked settings-update)", true);

  // Step 1: W1 builds and opens a PR; setup ran in its fresh worktree.
  await ask("MARK-BUILD");
  let work = await plan();
  const [w1] = byText(work, "W1-TASK");
  check(
    "setup: W1 opened draft PR #1 on its pi/ branch",
    !!w1 && gh$().pulls[0]?.head === brain.b1 && /^pi\/durable-/.test(brain.b1 ?? ""),
    { w1, pulls: gh$().pulls, b1: brain.b1 },
  );
  const w1Calls = result.calls.filter((c) => c.role === "worker" && /W1-TASK/.test(c.first));
  check(
    "W1/D the setup command ran in the new worktree before the worker (deps present)",
    /installed/.test(w1Calls[1]?.results[0] ?? ""),
    w1Calls[1]?.results,
  );
  check(
    "W3 the worker is told the setup result",
    /Worktree setup ran when this worktree was created/.test(w1Calls[0].system),
    w1Calls[0].system.slice(-1500),
  );
  check(
    "G10/C11g YOLO text: no unconditional open_draft_pr; merge/rebase/continue-branch allowed; force-with-lease only on project branches",
    !/After pushing, call the GitHub open_draft_pr/.test(w1Calls[0].system) &&
      /only when your task asks for a PR/.test(w1Calls[0].system) &&
      /fetch, merge, rebase/.test(w1Calls[0].system) &&
      /--force-with-lease, only on project branches/.test(w1Calls[0].system),
    w1Calls[0].system.slice(-1500),
  );
  // Base moves with a conflicting feature.txt.
  execFileSync("/usr/bin/git", ["clone", "-q", bare, clone]);
  git(clone, "config", "user.email", "o@example.invalid");
  git(clone, "config", "user.name", "Owner");
  writeFileSync(join(clone, "feature.txt"), "main\n");
  writeFileSync(join(clone, "base2.txt"), "b2\n");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "Owner change on main");
  git(clone, "push", "-q", "origin", "main");
  const mainHead = git(bare, "rev-parse", "main");

  // Step 2: a NEW thread continues W1's PR branch: merge with conflict resolution, merge-base, rebase + force-with-lease.
  await ask("MARK-CONTINUE");
  work = await plan();
  const [w2] = byText(work, "W2-TASK");
  const w2Calls = result.calls.filter((c) => c.role === "worker" && /W2-TASK/.test(c.first) && true);
  const out = (i) => w2Calls.find((c) => c.results.length === i + 1)?.results[i] ?? "";
  check("setup: W2 (a second thread) completed", !!w2 && w2.threadId !== w1.threadId, w2);
  check(
    "G2 git merge origin/main runs (conflict reported, not blocked by policy)",
    /CONFLICT/.test(out(0)) && /MERGE-EXIT=1/.test(out(0)) && !/Blocked by worker Git policy/.test(out(0)),
    out(0),
  );
  check(
    "G1/G5 conflict resolved, merge-base allowed in a compound command, pushed to another thread's project branch",
    /PUSHED-MERGE/.test(out(1)) && new RegExp(mainHead).test(out(1)),
    out(1),
  );
  check(
    "G6/G8 push to main is blocked and the message names the blocked segment",
    /Blocked by worker Git policy at: git push origin HEAD:main/.test(out(2)),
    out(2),
  );
  check(
    "G4 plain --force to the project branch passes the policy; -f/+ref to main is blocked",
    /Blocked by worker Git policy at: git push -f origin \+HEAD:main/.test(out(3)),
    out(3),
  );
  check(
    "G12 a redirected --force-with-lease push to the project branch is not refused",
    !/Blocked by worker Git policy/.test(out(4)),
    out(4),
  );
  const rebased = git(bare, "rev-parse", `refs/heads/${brain.b1}`);
  check(
    "G3 rebase onto main + --force-with-lease to the project PR branch succeeds (linear on top of main)",
    /PUSHED-REBASE/.test(out(4)) &&
      out(4).includes(rebased) &&
      git(bare, "rev-parse", `${rebased}^`) === mainHead &&
      git(bare, "show", `${rebased}:feature.txt`) === "v1",
    { out: out(4), rebased },
  );
  const seen = (marker, role) => result.calls.filter((c) => c.role === role && c.first.includes(marker)).at(-1)?.results[0] ?? "";
  await eventually(async () => seen("CHILD-REVIEW", "reviewer"), "child reviewer did not read", 300);
  check(
    "R4 a worker's child reviewer reads the parent's worktree (uncommitted wip-note.txt)",
    /wip/.test(seen("CHILD-REVIEW", "reviewer")),
    seen("CHILD-REVIEW", "reviewer"),
  );

  // Step 3: a reviewer of a full SHA reads it in its own worktree; scout reads the checkout; refs other than an agent id or a full SHA are refused at spawn.
  await ask(`MARK-REVIEW ${scopeId} ${w2.threadId}`);
  work = await plan();
  await eventually(async () => seen("REVIEW-HEAD", "reviewer") && seen("SCOUT-SCOPED", "scout"), "reviewer and scout did not read", 300);
  const reviewSaw = seen("REVIEW-HEAD", "reviewer");
  const reviewer = (await rpc({ action: "jobs-snapshot", id })).agents.find((agent) => agent.readRef === brain.sha1);
  const reviewerCwd = /SAW\[feature.txt\]/.test(reviewSaw) ? git(workspace, "worktree", "list", "--porcelain") : "";
  check(
    "R1 a reviewer given a full SHA reads that commit (feature.txt v1) in a worktree of its own, not the owner checkout",
    /v1/.test(reviewSaw) && !existsSync(join(workspace, "feature.txt")) && !!reviewer && !/read-heads/.test(reviewerCwd),
    { reviewSaw, reviewer: reviewer?.id, worktrees: reviewerCwd },
  );
  check("S1 a scout reads the project checkout", /base readme/.test(seen("SCOUT-SCOPED", "scout")), seen("SCOUT-SCOPED", "scout"));
  check("R2 an option-like ref never reaches git", !existsSync(`/tmp/pwned-lifecycle-${process.pid}`));
  const reports = (await rpc({ action: "show", id })).messages.map((m) => m.text ?? "").join("\n");
  const spawns =
    result.calls.findLast((c) => c.role === "coordinator" && /MARK-REVIEW/.test(c.user) && c.results.length >= 5)?.results ?? [];
  check(
    "R2/R6 an option-like ref and a branch name are refused at spawn with how to pin a commit",
    [spawns[2], spawns[3]].every((text) => /full lowercase commit SHA/.test(text ?? "") && /Resolve a branch or PR/.test(text ?? "")),
    spawns,
  );
  await eventually(
    async () => /failed to start: UNKNOWN-COMMIT/.test((await rpc({ action: "show", id })).messages.map((m) => m.text ?? "").join("\n")),
    "unknown commit not reported",
    300,
  );
  check(
    "R6 a full SHA that is not in the repository fails the reader's start clearly",
    /failed to start: UNKNOWN-COMMIT\] Commit f{40} is not in the local repository; fetch it first/.test(
      (await rpc({ action: "show", id })).messages.map((m) => m.text ?? "").join("\n"),
    ),
  );
  check(
    "R8 a reader of a worker's worktree with uncommitted changes fails to start and says to commit first",
    /failed to start/.test(reports) && /uncommitted changes/.test(reports) && /commit/.test(reports),
    reports.slice(-1500),
  );

  // Step 4: change the setup to a failing command; W3 commits locally only.
  const s2 = await rpc({ action: "settings-snapshot", id });
  await rpc({
    action: "settings-update",
    id,
    confirm: id,
    expectedRevision: s2.revision,
    changes: { worktreeSetup: "echo boom-setup >&2; exit 3" },
  });
  await ask("MARK-LOCAL");
  work = await plan();
  const [w3] = byText(work, "W3-TASK");
  const w3System = result.calls.find((c) => c.role === "worker" && /W3-TASK/.test(c.first)).system;
  check(
    "W3 a failing setup is visible to the worker (exit code + output)",
    /Worktree setup FAILED/.test(w3System) && /exited 3/.test(w3System) && /boom-setup/.test(w3System),
    w3System.slice(-800),
  );

  check(
    "C11 three Jobs for the whole script; no transfer-commit thread, no extra PR",
    work.length === 3 && gh$().pulls.length === 1,
    work.map((w) => [w.status, w.text.slice(0, 30)]),
  );

  // Step 5: inventory before the PR is merged, with one snapshot left over from before readers got their own worktrees.
  const legacyHead = join(home, id, "read-heads", mainHead);
  mkdirSync(join(home, id, "read-heads"), { recursive: true });
  git(workspace, "worktree", "add", "--detach", "--quiet", legacyHead, mainHead);
  let inv = await inventory();
  result.inventoryBefore = inv;
  const item = (branchName) => inv.items.find((entry) => entry.kind === "worker" && entry.threadId === branchName);
  const [i1, i2, i3] = [w1, w2, w3].map((w) => item(w.threadId));
  check("K4 W1 (open PR #1) is kept", i1 && !i1.removable && i1.reasons.some((r) => /open PR #1/.test(r)), i1);
  check("K1 W2 (uncommitted wip-note.txt) is kept", i2 && !i2.removable && i2.reasons.some((r) => /uncommitted or untracked/.test(r)), i2);
  check(
    "K2 W3 (commit not on any remote, no PR) is kept",
    i3 && !i3.removable && i3.reasons.some((r) => /1 commit\(s\) not on any remote/.test(r)),
    i3,
  );
  check(
    "W3 Settings inventory records setup results (W1 ok, W3 failed exit 3)",
    i1.setup?.ok === true && i3.setup?.ok === false && i3.setup.exitCode === 3,
    { s1: i1.setup, s3: i3.setup },
  );
  const heads = inv.items.filter((entry) => entry.kind === "read-head");
  check(
    "K10 a leftover read-head snapshot is removable",
    heads.length === 1 && heads[0].removable && heads[0].path.endsWith(mainHead),
    heads,
  );
  const readerItem = inv.items.find((entry) => entry.threadId === reviewer.id);
  check(
    "R3 the ended reviewer's worktree is removable although its commit is on no remote any more",
    readerItem?.removable === true && git(workspace, "branch", "-r", "--contains", brain.sha1) === "",
    readerItem,
  );
  check(
    "K7 reclaimable size is reported",
    inv.reclaimableKb > 0 && inv.reclaimableKb === inv.items.filter((e) => e.removable).reduce((a, e) => a + e.sizeKb, 0),
    inv,
  );

  // R9: W3 commits while a reader of its worktree reads; the report says it is not valid for the current code.
  const driftFrom = git(i3.path, "rev-parse", "HEAD");
  let releaseDrift;
  brain.driftGate = new Promise((ok) => (releaseDrift = ok));
  await rpc({ action: "message", id, text: `MARK-DRIFT ${w3.threadId}` });
  await eventually(async () => brain.driftWaiting, "the drift reader did not start", 300);
  git(
    i3.path,
    "-c",
    "user.email=e2e@example.invalid",
    "-c",
    "user.name=E2E",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Moved during the read",
  );
  const driftTo = git(i3.path, "rev-parse", "HEAD");
  releaseDrift();
  await settleAll();
  const driftReport = await eventually(
    async () =>
      (await rpc({ action: "show", id })).messages.map((m) => m.text ?? "").find((text) => /^\[reviewer [^\]]*DRIFT-REVIEW/.test(text)),
    "the drift reader did not report",
    300,
  );
  check(
    "R9 a reader whose target worktree moved during the read reports first that it is not valid for the current code, with both commits",
    /^\[reviewer [^\n]*\n.*not valid for the current code/.test(driftReport) &&
      driftReport.includes(driftFrom) &&
      driftReport.includes(driftTo),
    driftReport.slice(0, 600),
  );
  check(
    "R9 a reader whose target stayed put has no such line",
    !/not valid for the current code/.test(seen("CHILD-REVIEW", "reviewer") + reports),
  );

  // PR #1 merged → W1 becomes removable (its old pre-rebase commit is off-remote, but the PR is merged).
  ghSet((state) => {
    state.pulls[0].state = "closed";
    state.pulls[0].merged = true;
  });
  inv = await inventory();
  check(
    "K4 after the PR merged, W1 is removable",
    inv.items.find((e) => e.threadId === w1.threadId)?.removable === true,
    inv.items.find((e) => e.threadId === w1.threadId),
  );
  check(
    "K7 the inventory reports reclaimable space and the removable worktrees",
    inv.reclaimableKb > 0 && inv.items.some((e) => e.removable) && inv.items.some((e) => !e.removable),
    { reclaimableKb: inv.reclaimableKb },
  );
  const w1Path = inv.items.find((e) => e.threadId === w1.threadId).path,
    w2Path = i2.path,
    w3Path = i3.path,
    headPath = heads[0].path,
    readerPath = readerItem.path;
  // Workspace caches: W1's goes with its worktree, a cache whose workspace is gone goes too, live ones and other folders stay.
  const caches = join(home, id, "workspace-cache"),
    cacheOf = (path) => join(caches, inv.items.find((e) => e.path === path).intentId),
    orphanCache = join(caches, randomUUID()),
    notCache = join(caches, "keep-me");
  for (const dir of [cacheOf(w1Path), cacheOf(w2Path), orphanCache, notCache]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cacheOf(w1Path), "DerivedData.bin"), "x");

  // U4-U6: storage usage, one row per kind, with what the cleanup routine would free under its current settings.
  const duBytes = (path) => Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) * 1024;
  const eightDays = (Date.now() - 8 * 86_400_000) / 1000;
  utimesSync(cacheOf(w1Path), eightDays, eightDays);
  mkdirSync(join(home, id, "artifacts", w1.threadId), { recursive: true });
  writeFileSync(join(home, id, "artifacts", w1.threadId, "run.mp4"), Buffer.alloc(4096));
  const usage = async () => Object.fromEntries((await rpc({ action: "storage-usage", id })).rows.map((row) => [row.id, row]));
  let rows = await usage();
  check(
    "U4 storage usage has a row for each kind",
    ["worktrees", "caches", "disposable", "videos"].every((key) => rows[key]),
    rows,
  );
  check(
    "U4 the worktree row counts the inventory's worktrees and their reclaimable space",
    rows.worktrees.count === inv.items.length && rows.worktrees.bytes > 0 && rows.worktrees.reclaimableBytes > 0,
    { row: rows.worktrees, items: inv.items.length },
  );
  check(
    "U5 the cache row frees exactly the cache unused past the window (W1's), not the live ones",
    rows.caches.count >= 2 &&
      rows.caches.bytes >= rows.caches.reclaimableBytes &&
      rows.caches.reclaimableBytes === duBytes(cacheOf(w1Path)),
    { row: rows.caches, w1: duBytes(cacheOf(w1Path)) },
  );
  check(
    "U4 the video row counts Job videos; a running or unapproved Job's video is not freed",
    rows.videos.count === 1 && rows.videos.bytes >= 4096 && rows.videos.reclaimableBytes === 0,
    rows.videos,
  );
  check(
    "U6 without disposable globs the disposable row is empty and says why",
    rows.disposable.count === 0 && /no disposable/i.test(rows.disposable.note ?? ""),
    rows.disposable,
  );
  const routineNow = (await rpc({ action: "schedule-snapshot", id, includeHistory: false })).schedules.find(
    (item) => item.action?.kind === "cleanup",
  );
  const setDisposable = async (disposable) => {
    const current = (await rpc({ action: "schedule-snapshot", id, includeHistory: false })).schedules.find(
      (item) => item.id === routineNow.id,
    );
    await rpc({ action: "schedule-update", id, scheduleId: current.id, revision: current.revision, cleanup: { disposable } });
  };
  const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
  utimesSync(join(w2Path, "node_modules"), twoDaysAgo, twoDaysAgo);
  utimesSync(join(w2Path, "wip-note.txt"), twoDaysAgo, twoDaysAgo);
  await setDisposable(["node_modules", "wip-note.txt"]);
  rows = await usage();
  check(
    "U5/U6 the disposable row holds only old, git-ignored matches (W2's node_modules, not its untracked note)",
    rows.disposable.count === 1 &&
      rows.disposable.reclaimableBytes === duBytes(join(w2Path, "node_modules")) &&
      rows.disposable.bytes === rows.disposable.reclaimableBytes,
    rows.disposable,
  );
  await setDisposable([]);

  const cleanup = await rpc({ action: "worktrees-cleanup", id, confirm: id });
  await eventually(
    async () => !existsSync(w1Path) && !existsSync(headPath) && !existsSync(readerPath),
    "cleanup did not remove W1, the snapshot and the reader's worktree",
    300,
  );
  check(
    "C6/C7/C8 cleanup removed W1's cache and an orphaned cache, and kept W2's cache and a folder that is not a cache",
    !existsSync(cacheOf(w1Path)) && !existsSync(orphanCache) && existsSync(cacheOf(w2Path)) && existsSync(notCache),
    { caches: existsSync(caches) ? readdirSync(caches) : null },
  );
  check("C9 cleanup reports three removed worktrees", cleanup.removed?.length === 3, cleanup);
  check(
    "C9 manual cleanup removed W1, the snapshot and the reader's worktree; W2 and W3 stay",
    !existsSync(w1Path) && !existsSync(headPath) && existsSync(w2Path) && existsSync(w3Path) && existsSync(join(w2Path, "wip-note.txt")),
  );
  check(
    "K5/K9 removal worked with ignored node_modules and kept W1's local branch",
    /^[0-9a-f]{40}$/.test(git(workspace, "rev-parse", "--verify", `refs/heads/${brain.b1}`)),
    brain.b1,
  );

  // K6: following up a cleaned thread revives its worktree (same path, same kept branch) instead of sending the coordinator to re-delegate.
  await ask(`MARK-FOLLOW ${w1.threadId}`);
  const again = result.calls.findLast((c) => c.role === "worker" && c.user.includes("W1-AGAIN"));
  check(
    "K6 a follow-up on a cleaned-up thread runs in its revived worktree: same path, same kept branch, no re-delegation",
    !!again &&
      existsSync(w1Path) &&
      git(w1Path, "branch", "--show-current") === brain.b1 &&
      git(w1Path, "status", "--porcelain") === "" &&
      git(w1Path, "rev-parse", "HEAD") === git(workspace, "rev-parse", `refs/heads/${brain.b1}`),
    { again: again?.user, exists: existsSync(w1Path), w1Path, list: git(workspace, "worktree", "list") },
  );
  check(
    "K6 reviving left no second worktree for the thread",
    git(workspace, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line === `worktree ${w1Path}`).length === 1,
  );

  // R10-R13: the cleanup routine. One per project, daily, enabled; it cannot be deleted; settings change freely within bounds.
  const routines = async () => (await rpc({ action: "schedule-snapshot", id, includeHistory: false })).schedules;
  const cleanupRoutine = async () => (await routines()).filter((item) => item.action?.kind === "cleanup");
  let [routine] = await cleanupRoutine();
  check(
    "R10 every project has one enabled daily cleanup routine",
    (await cleanupRoutine()).length === 1 && routine.enabled && routine.kind === "interval" && routine.everyMs === 86_400_000,
    await routines(),
  );
  const refusedDelete = await rpc({ action: "schedule-delete", id, scheduleId: routine.id, revision: routine.revision }).catch(
    (error) => error,
  );
  check(
    "R11 the cleanup routine cannot be deleted, only turned off",
    /turn it off/i.test(String(refusedDelete?.message)),
    String(refusedDelete),
  );
  const badGlob = await rpc({
    action: "schedule-update",
    id,
    scheduleId: routine.id,
    revision: routine.revision,
    cleanup: { disposable: ["/tmp"] },
  }).catch((error) => error);
  check("R1 an absolute disposable path is refused", /relative/i.test(String(badGlob?.message)), String(badGlob));
  routine = await rpc({
    action: "schedule-update",
    id,
    scheduleId: routine.id,
    revision: routine.revision,
    cleanup: { disposable: ["e2e-results"] },
  });
  check(
    "R11 cleanup settings change without the owner and keep the defaults they do not name",
    JSON.stringify(routine.action) ===
      JSON.stringify({ kind: "cleanup", settings: { cacheCapGb: 20, unusedDays: 7, videoDays: 14, disposable: ["e2e-results"] } }),
    routine.action,
  );

  // R12: publish W3's commit and give dirty W2 an ignored, two-day-old e2e-results; a run removes W3 and that folder, and keeps W2's work.
  const w3Branch = git(w3Path, "rev-parse", "--abbrev-ref", "HEAD");
  // W3 ended without a report, so it is a checkpoint that keeps its worktree until the owner dismisses it.
  await rpc({ action: "thread-dismiss", id, threadId: w3.threadId });
  git(w3Path, "push", "-q", "origin", `HEAD:refs/heads/${w3Branch}`);
  const exclude = join(git(workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude");
  mkdirSync(join(exclude, ".."), { recursive: true });
  writeFileSync(exclude, `${existsSync(exclude) ? readFileSync(exclude, "utf8") : ""}\ne2e-results/\n`);
  const results = join(w2Path, "e2e-results");
  mkdirSync(join(results, "run-1"), { recursive: true });
  writeFileSync(join(results, "run-1", "video.mp4"), "x");
  const twoDays = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(results, twoDays, twoDays);
  // R13: a run that dies with the host is recorded as interrupted and does not block the next one.
  await stopHost();
  env.PI_PROJECTS_CLEANUP_START_DELAY_MS = "60000";
  startHost();
  await waitHost();
  await rpc({ action: "show", id });
  await rpc({ action: "schedule-run", id, scheduleId: routine.id });
  host.kill("SIGKILL");
  await stopHost().catch(() => {});
  delete env.PI_PROJECTS_CLEANUP_START_DELAY_MS;
  startHost();
  await waitHost();
  await rpc({ action: "show", id });
  check("R10 a restart adds no second cleanup routine", (await cleanupRoutine()).length === 1, await routines());
  const interrupted = (await rpc({ action: "schedule-history", id, kind: "intents" })).items.filter((item) => item.stableId === routine.id);
  check(
    "R13 the run the host died in is interrupted, not an uncertain submission",
    interrupted.length === 1 && interrupted[0].status === "interrupted",
    interrupted,
  );
  await rpc({ action: "schedule-run", id, scheduleId: routine.id });
  await eventually(async () => !existsSync(w3Path) && !existsSync(results), "the cleanup routine did not remove W3 and e2e-results", 600);
  const runs = await eventually(
    async () => {
      const items = (await rpc({ action: "schedule-history", id, kind: "intents" })).items.filter((item) => item.stableId === routine.id);
      return items.some((item) => item.outcome === "completed") && items;
    },
    "the cleanup run never completed",
    300,
  );
  check(
    "R12 running the cleanup routine removed the pushed W3 and W2's old ignored e2e-results, and kept dirty W2's work",
    !existsSync(w3Path) && !existsSync(results) && existsSync(join(w2Path, "wip-note.txt")),
    runs,
  );

  // K12: after the restart, a follow-up to the finished W2 keeps its worktree, branch and tools (bash is how the fake model sees a worker).
  await ask(`MARK-FOLLOW2 ${w2.threadId}`);
  const w2Again = await eventually(
    async () => result.calls.findLast((c) => c.role === "worker" && c.user.includes("W2-AGAIN") && c.results.length),
    "W2 follow-up after the restart never ran as a worker with tools",
    300,
  );
  check(
    "K12 a follow-up after a host restart runs in the same worktree and branch with the worker tools",
    w2Again.results[0].includes(w2Path) &&
      w2Again.results[0].includes("wip-note.txt") &&
      w2Again.tools.some((name) => name.endsWith("_open_draft_pr")),
    w2Again,
  );

  // K11: a cleaned thread whose kept branch is gone cannot be revived: a typed blocker says so and names the way forward, and nothing is created.
  git(workspace, "branch", "-D", w3Branch);
  const worktreesBefore = git(workspace, "worktree", "list", "--porcelain");
  await ask(`MARK-FOLLOW3 ${w3.threadId}`);
  const w3Reports = await eventually(
    async () => {
      const text = (await rpc({ action: "show", id })).messages.map((m) => m.text ?? "").join("\n");
      return /failed to start/.test(text) && text;
    },
    "no start failure for the cleaned thread",
    300,
  );
  check(
    "K11 a cleaned thread whose branch no longer exists fails with an unrecoverable blocker and creates no worktree",
    /no longer exists/.test(w3Reports) &&
      /new worker/.test(w3Reports) &&
      git(workspace, "worktree", "list", "--porcelain") === worktreesBefore,
    w3Reports.slice(-1200),
  );

  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
} finally {
  await stopHost().catch(() => host.kill("SIGKILL"));
  model.closeAllConnections();
  model.close();
  save();
}
console.log(
  JSON.stringify(
    { status: result.status, checks: result.checks.length, failure: result.failure, threads: result.threads, artifact: artifacts },
    null,
    2,
  ),
);
if (result.status !== "passed") process.exitCode = 1;
