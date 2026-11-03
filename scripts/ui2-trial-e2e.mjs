// E2E: the live trial launcher `npm run ui2` (scripts/ui2-trial.mjs), cases X1-X4 in scripts/ui2-backend-failures.md.
// HOME is a temp directory, so `~/.pi/agent/projects-ui2` resolves inside it; no real home or provider is touched.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "ui2-trial-"));
const decoy = join(root, "decoy-home");
const env = { ...process.env, HOME: root, ZDOTDIR: root, PI_OFFLINE: "1", PI_PROJECTS_HOME: decoy };
for (const key of Object.keys(env))
  if (key === "PI_CODING_AGENT_DIR" || key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const launcher = new URL("./ui2-trial.mjs", import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 120000 });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail ?? null).slice(0, 600)}`}`);
  if (!ok) failures.push(name);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const home = join(root, ".pi", "agent", "projects-ui2");
let pid = 0;
try {
  const started = run();
  check("X2 the launcher starts", started.status === 0, { status: started.status, out: started.stdout, err: started.stderr.slice(-2000) });
  const url = /(http:\/\/127\.0\.0\.1:\d+\/ui2\/#token=[a-f0-9]{64})/.exec(started.stdout)?.[1];
  check("X2 it prints the /ui2/ URL with the token", !!url, started.stdout);
  check("X2 it prints a stop command", /npm run ui2 -- stop/.test(started.stdout), started.stdout);
  check("X1 the dedicated home exists with mode 0700", existsSync(home) && (statSync(home).mode & 0o777) === 0o700);
  check("X1 the caller's PI_PROJECTS_HOME is ignored", !existsSync(decoy));
  check(
    "X1 no other home is created",
    readdirSync(join(root, ".pi", "agent"))
      .filter((name) => name.startsWith("projects"))
      .join() === "projects-ui2",
    readdirSync(join(root, ".pi", "agent")),
  );
  pid = Number(readFileSync(join(home, "host.lock"), "utf8"));
  if (url) {
    const page = await fetch(url.replace(/#.*/, ""));
    check("X2 the URL serves the UI 2.0 page", page.status === 200 && (await page.text()).includes("ui2"), page.status);
  }
  const second = run();
  check("X3 a second start refuses", second.status !== 0 && /already/i.test(second.stderr + second.stdout), second.stderr);
  check("X3 the running host is left alone", alive(pid));
  const stopped = run("stop");
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    gone = !alive(pid);
    if (!gone) await delay(100);
  }
  check("X4 the stop command stops that host", stopped.status === 0 && gone, { out: stopped.stdout, err: stopped.stderr });
} finally {
  if (pid && alive(pid)) process.kill(pid, "SIGTERM");
  rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("ui2-trial-e2e passed");
