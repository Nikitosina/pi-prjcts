// Live trial of UI 2.0 (`npm run ui2`): a host from this checkout on its own home `~/.pi/agent/projects-ui2`, with the owner's real
// providers and Pi agent dir, so live models work. It never reads, imports or copies another home. `npm run ui2 -- stop` stops it.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const home = resolve(homedir(), ".pi", "agent", "projects-ui2");
const checkout = new URL("..", import.meta.url).pathname;
// The host derives its socket from its home the same way (state.ts socketPath).
const socket = join(
  tmpdir(),
  `pi-projects-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}.sock`,
);

const runningPid = () => {
  try {
    const pid = Number(readFileSync(join(home, "host.lock"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
};
const rpc = (input) =>
  new Promise((ok, fail) => {
    const req = request(
      { socketPath: socket, method: "POST", path: "/api", headers: { "content-type": "application/json" }, timeout: 15000 },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part) => (text += part));
        res.on("end", () => {
          try {
            const reply = JSON.parse(text);
            reply.ok ? ok(reply.data) : fail(new Error(reply.error));
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    req.on("error", fail);
    req.end(JSON.stringify(input));
  });

if (process.argv[2] === "stop") {
  const pid = runningPid();
  if (!pid) {
    console.log(`No UI 2.0 trial host is running on ${home}.`);
    process.exit(0);
  }
  await rpc({ action: "shutdown" }).catch(() => process.kill(pid, "SIGTERM"));
  console.log(`Stopping the UI 2.0 trial host (pid ${pid}).`);
  process.exit(0);
}

const owner = runningPid();
if (owner) {
  console.error(`The UI 2.0 trial home ${home} is already owned by a running host (pid ${owner}). Stop it first: npm run ui2 -- stop`);
  process.exit(1);
}
mkdirSync(home, { recursive: true, mode: 0o700 });
const env = { ...process.env, PI_PROJECTS_HOME: home, PI_PROJECTS_HOST: "1" };
// A launcher started from inside an agent session must not hand the host that session's identity.
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const log = openSync(join(home, "host.log"), "a", 0o600);
const host = spawn(process.execPath, [join(checkout, "src/host.ts")], { cwd: checkout, env, detached: true, stdio: ["ignore", log, log] });
host.unref();
closeSync(log);

let url;
for (let attempt = 0; attempt < 600 && !url; attempt++) {
  if (host.exitCode !== null) break;
  url = existsSync(socket)
    ? await rpc({ action: "web" }).then(
        (data) => data.url,
        () => undefined,
      )
    : undefined;
  if (!url) await delay(100);
}
if (!url) {
  console.error(`The UI 2.0 trial host did not come up; see ${join(home, "host.log")}.`);
  process.exit(1);
}
const page = new URL(url);
page.pathname = "/ui2/";
console.log(`UI 2.0 trial host (pid ${host.pid}) on ${home}
Open:  ${page.href}
Stop:  npm run ui2 -- stop
Log:   ${join(home, "host.log")}`);
