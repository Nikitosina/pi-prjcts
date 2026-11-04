// E2E for one-click "Connect GitHub". Fresh isolated home, Git fixture, local bare remote and fake GitHub CLI. No model; never contacts GitHub.
// Failure list: U0 create does not connect GitHub one-click; U4 one-click authorize does not store the authorization, or accepts a stale
// revision; U7 the flow performs a GitHub write. U1-U3, U5, U6 (the classic Owner setup stepper and dialog) were retired with the
// classic inbox on 2026-11-04 (docs/classic-retirement.md).
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const stamp = new Date().toISOString().replaceAll(":", "-");
const artifacts = process.env.ARTIFACT_DIR || join(join(process.cwd(), "artifacts"), `github-quick-ui-${stamp}`),
  root = process.env.REVIEW_ROOT ? realpathSync(process.env.REVIEW_ROOT) : join(realpathSync(tmpdir()), `github-quick-ui-${randomUUID()}`);
const home = join(root, "home"),
  workspace = join(root, "workspace");
const result = {
  scope: "one-click GitHub UI",
  root,
  home,
  checks: [],
  errors: [],
  httpErrors: [],
  modelSubmissions: 0,
  grantsIssued: 0,
  providerOperations: 0,
};
const save = () => writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
const redact = (text) => String(text).replace(/token=[^&#\s"]+/gi, "token=[redacted]");
if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Unsafe runtime override; refused without clearing");
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(home, { mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
const socket = join(
  tmpdir(),
  `pi-projects-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}.sock`,
);
result.socket = socket;
const bare = join(root, "remote.git"),
  fakeGh = join(root, "fake-gh"),
  ghState = join(root, "fake-gh-state.json"),
  ghCalls = join(root, "fake-gh-calls.jsonl");
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "scripts/fake-gh.mjs")}" "$@"\n`);
chmodSync(fakeGh, 0o755);
writeFileSync(ghState, JSON.stringify({ repo: { id: 4242, full_name: "acme/quick", default_branch: "main" }, pulls: [] }));
writeFileSync(ghCalls, "");
const env = {
  ...process.env,
  PI_PROJECTS_HOME: home,
  PI_PROJECTS_HOST: "1",
  PI_PROJECTS_GH_CLI: fakeGh,
  FAKE_GH_STATE: ghState,
  FAKE_GH_BARE: bare,
  FAKE_GH_CALLS: ghCalls,
};
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const log = createWriteStream(join(artifacts, "host.log"), { flags: "wx", mode: 0o600 });
const host = spawn(process.execPath, [join(repo, "src/host.ts")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
host.stdout.pipe(log, { end: false });
host.stderr.pipe(log, { end: false });
let hostEnded = false;
const hostExit = new Promise((resolve) =>
  host.once("exit", (code, signal) => {
    hostEnded = true;
    result.hostExit = { code, signal };
    save();
    resolve();
  }),
);
function rpc(input) {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath: socket,
        method: input ? "POST" : "GET",
        path: input ? "/api" : "/health",
        headers: input ? { "content-type": "application/json" } : {},
        timeout: 90000,
      },
      (response) => {
        let text = "";
        response.on("data", (part) => {
          text += part;
        });
        response.on("end", () => {
          try {
            const reply = JSON.parse(text);
            if (!reply.ok) throw new Error(reply.error);
            resolve(reply.data);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    call.on("error", reject);
    call.end(input ? JSON.stringify(input) : undefined);
  });
}

const git = (...args) => execFileSync("/usr/bin/git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
try {
  execFileSync("/usr/bin/git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "e2e@example.invalid");
  git("config", "user.name", "E2E");
  git("remote", "add", "origin", "https://github.com/acme/quick.git");
  git("config", "remote.origin.pushurl", bare);
  writeFileSync(join(workspace, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-m", "c1");
  git("push", "-q", "origin", "main");
  let health;
  for (let i = 0; i < 150; i++) {
    if (hostEnded) throw new Error("Host exited before health readiness");
    try {
      health = await rpc();
      break;
    } catch {
      await delay(200);
    }
  }
  if (!health || health.pid !== host.pid || health.home !== home) throw new Error("Owned host health readiness failed");
  const project = await rpc({
    action: "create",
    requestId: randomUUID(),
    name: "GitHub Quick UI",
    cwd: workspace,
    objective: "Disposable.",
  });
  result.projectId = project.id;
  const first = await rpc({ action: "owner-setup-snapshot", id: project.id });
  if (first.github?.length !== 1 || first.github[0].oneClick !== true || first.github[0].repositoryId !== "acme/quick")
    throw new Error("create did not connect GitHub one-click: " + JSON.stringify(first.github));
  result.checks.push("U0 create connects GitHub one-click by itself");
  // Revoke the automatic grant so the stepper's manual Connect path below still runs.
  await rpc({
    action: "github-revoke",
    id: project.id,
    repositoryId: "acme/quick",
    confirm: project.id,
    expectedRevision: first.githubRevision,
  });
  // The classic Owner setup stepper and its Connect GitHub dialog were retired on 2026-11-04; the call they made stays.
  const revoked = await rpc({ action: "owner-setup-snapshot", id: project.id });
  if (revoked.github?.length) throw new Error("Revoke left an authorization: " + JSON.stringify(revoked.github));
  await rpc({
    action: "github-quick-authorize",
    id: project.id,
    confirm: project.id,
    expectedRevision: revoked.githubRevision,
  });
  const snap = await rpc({ action: "owner-setup-snapshot", id: project.id });
  const auth = snap.github?.[0];
  if (
    snap.github?.length !== 1 ||
    auth.oneClick !== true ||
    auth.numericId !== 4242 ||
    auth.baseBranch !== "main" ||
    auth.branchPrefix !== "pi/" ||
    !auth.reviewReplies ||
    !auth.localPublication
  )
    throw new Error("API lacks the one-click authorization: " + JSON.stringify(snap.github));
  result.checks.push("U4 one-click authorize stores 4242, main, pi/, reviewReplies, localPublication");
  try {
    await rpc({ action: "github-quick-authorize", id: project.id, confirm: project.id, expectedRevision: revoked.githubRevision });
    throw new Error("A stale revision was accepted");
  } catch (error) {
    if (!/changed; refresh/.test(String(error.message))) throw error;
  }
  result.checks.push("U4 a stale authorization revision is refused");
  const ghLog = readFileSync(ghCalls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  result.githubCalls = ghLog;
  if (!ghLog.length || ghLog.some((call) => call.method !== "GET")) throw new Error("The flow made a GitHub write or no fake GitHub read");
  result.checks.push("U7 only fake GitHub GETs were made");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = redact(error?.stack ?? error);
} finally {
  save();
}
if (!hostEnded) {
  try {
    await rpc({ action: "shutdown" });
  } catch (e) {
    result.shutdownError = String(e);
  }
  await Promise.race([hostExit, delay(10000)]);
}
if (!hostEnded) host.kill("SIGTERM");
save();
log.end();
console.log(
  JSON.stringify(
    {
      status: result.status,
      checks: result.checks,
      failure: result.failure,
      errors: result.errors,
      httpErrors: result.httpErrors,
      artifact: artifacts,
    },
    null,
    2,
  ),
);
if (result.status !== "passed") process.exitCode = 1;
