import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { home, socketPath, parse, Reply, WebInfo, Id, type Request } from "./state.ts";
import { once } from "node:events";
import { remoteConfig, kickstartRemoteHost } from "./remote.ts";

// Allow the bounded shell import as well as normal host initialization.
const hostStartAttempts = 250;

export async function request(input: Request, start = true): Promise<unknown> {
  if (start) await ensureHost();
  return exchange("POST", "/api", JSON.stringify(input));
}

export async function inboxUrl(id?: string): Promise<string> {
  const info = parse(WebInfo, await request({ action: "web" }));
  const url = new URL(info.url);
  if (id) url.searchParams.set("project", parse(Id, id));
  return url.toString();
}

export async function openInbox(id?: string): Promise<string> {
  const url = await inboxUrl(id);
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error("Could not open the browser. Use the CLI ui-url command.");
  return url;
}

/** `repo` starts the host from another checkout (deploy); `attempts` bounds the 100 ms health polls. */
export async function ensureHost(options: { repo?: string; attempts?: number } = {}): Promise<void> {
  const attempts = options.attempts ?? hostStartAttempts;
  try {
    await health();
    return;
  } catch {
    /* A missing socket is normal before the first project. */
  }
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  if (remoteConfig()?.enabled) {
    kickstartRemoteHost();
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(100);
      try {
        await health();
        return;
      } catch {}
    }
    throw new Error(`Remote host did not start. Read ${join(home(), "host.log")}`);
  }
  const log = openSync(join(home(), "host.log"), "a", 0o600);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_PROJECTS_HOST: "1" };
  for (const key of Object.keys(env)) {
    // Kept after the legacy runtime removal: the host loads global extensions, and pi-subagent-manager reads PI_SUBAGENT_*.
    if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE" || key === "PI_PROJECTS_LAUNCHD") delete env[key];
  }
  const repo = options.repo ?? fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, [join(repo, "src", "host.ts")], {
    detached: true,
    stdio: ["ignore", log, log],
    env,
    cwd: repo,
  });
  child.on("error", () => {});
  // Exit 0 means another host holds the lock, so only a failing exit ends the wait.
  let crashed: string | undefined;
  child.on("exit", (code, signal) => {
    if (code !== 0) crashed = signal ? `signal ${signal}` : `code ${code}`;
  });
  child.unref();
  closeSync(log);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(100);
    if (crashed) throw new Error(`Projects host exited with ${crashed} before it answered. Read ${join(home(), "host.log")}`);
    try {
      await health();
      return;
    } catch {
      /* The host may still be loading the SDK. */
    }
  }
  throw new Error(`Projects host did not start. Read ${join(home(), "host.log")}`);
}

/** Transfer an already-running detached host before starting the remote LaunchAgent. */
export async function ensureRemoteHost(): Promise<void> {
  let running: { pid?: number } | null = null;
  try {
    running = (await health()) as { pid?: number };
  } catch {}
  if (running) {
    // A host from before remote access rejects remote-status; it is detached by definition.
    const status = (await request({ action: "remote-status" }, false).catch(() => ({}))) as { launchd?: boolean };
    if (status.launchd) {
      await request({ action: "remote-reload" }, false);
      return;
    }
    const pid = running.pid;
    if (!Number.isSafeInteger(pid) || pid! <= 0) throw new Error("Invalid running host PID");
    await request({ action: "shutdown" }, false);
    const deadline = Date.now() + 120000;
    for (;;) {
      try {
        process.kill(pid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (Date.now() >= deadline) throw new Error("Existing host did not stop; remote LaunchAgent has not taken ownership");
      await sleep(100);
    }
  }
  kickstartRemoteHost();
  for (let attempt = 0; attempt < hostStartAttempts; attempt++) {
    await sleep(100);
    try {
      await health();
      const status = (await request({ action: "remote-status" }, false)) as { launchd?: boolean };
      if (status.launchd) return;
    } catch {}
  }
  throw new Error(`LaunchAgent host did not start. Read ${join(home(), "host.log")}`);
}

export function health(): Promise<unknown> {
  return exchange("GET", "/health");
}

function exchange(method: string, path: string, body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      // A deploy replaces the server behind this path; pooled sockets can still belong to the stopped host.
      { socketPath: socketPath(), path, method, agent: false, headers: { "content-type": "application/json" }, timeout: 120000 },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            call.destroy(new Error("Host response exceeds 4 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const reply = parse(Reply, JSON.parse(Buffer.concat(chunks).toString("utf8")));
            if (reply.ok) resolve(reply.data);
            else reject(new Error(reply.error));
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    call.on("timeout", () => call.destroy(new Error("Projects request timed out")));
    call.on("error", reject);
    call.end(body);
  });
}
