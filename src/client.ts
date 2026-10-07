import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { home, socketPath, parse, Reply, WebInfo, Id, type Request } from "./state.ts";
import { once } from "node:events";

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

export async function ensureHost(): Promise<void> {
  try { await health(); return; } catch { /* A missing socket is normal before the first project. */ }
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const log = openSync(join(home(), "host.log"), "a", 0o600);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_PROJECTS_HOST: "1" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL("./host.ts", import.meta.url))], { detached: true, stdio: ["ignore", log, log], env, cwd: fileURLToPath(new URL("..", import.meta.url)) });
  child.on("error", () => {});
  child.unref(); closeSync(log);
  for (let attempt = 0; attempt < 100; attempt++) {
    await sleep(100);
    try { await health(); return; } catch { /* The host may still be loading the SDK. */ }
  }
  throw new Error(`Projects host did not start. Read ${join(home(), "host.log")}`);
}

export function health(): Promise<unknown> {
  return exchange("GET", "/health");
}

function exchange(method: string, path: string, body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const call = httpRequest({ socketPath: socketPath(), path, method, headers: { "content-type": "application/json" }, timeout: 120000 }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { call.destroy(new Error("Host response exceeds 4 MiB")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const reply = parse(Reply, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (reply.ok) resolve(reply.data);
          else reject(new Error(reply.error));
        } catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    call.on("timeout", () => call.destroy(new Error("Projects request timed out")));
    call.on("error", reject);
    call.end(body);
  });
}
