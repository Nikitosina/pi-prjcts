import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { body } from "./http.ts";
import { readEvidence } from "./evidence.ts";
import { errorText, home, loadProject, parse, projectDir, Request, saveJson, type Request as RequestData } from "./state.ts";
import { join } from "node:path";

type LiveWatch = (projectId: string, onFrame: (frame: unknown) => void, onEnd: () => void) => Promise<() => void>;

const liveStreams = new Set<() => void>();

/** Server-sent events: one `data:` frame per live change, comment heartbeats so idle proxies keep the stream. */
async function serveLive(response: ServerResponse, headers: Record<string, string>, watch: (onFrame: (frame: unknown) => void, onEnd: () => void) => Promise<() => void>) {
  let stop: (() => void) | undefined, heartbeat: NodeJS.Timeout | undefined, done = false;
  const end = () => {
    if (done) return;
    done = true; liveStreams.delete(end); clearInterval(heartbeat); stop?.();
    if (!response.writableEnded) response.end();
  };
  liveStreams.add(end);
  response.on("close", end);
  // Frames can arrive before the watch resolves; hold them until headers are sent so errors can still answer 4xx.
  let held: string[] | null = [];
  const write = (frame: unknown) => {
    if (done) return;
    const text = `data: ${JSON.stringify(frame)}\n\n`;
    if (held) held.push(text); else response.write(text);
  };
  try { stop = await watch(write, end); }
  catch (error) { done = true; liveStreams.delete(end); clearInterval(heartbeat); throw error; }
  if (done) { stop(); return; }
  response.writeHead(200, { ...headers, "content-type": "text/event-stream", connection: "keep-alive" });
  for (const text of held) response.write(text);
  held = null;
  heartbeat = setInterval(() => response.write(": ping\n\n"), 15000);
}

export async function startWeb(dispatch: (input: RequestData) => Promise<unknown>, watchLive: LiveWatch) {
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const assets = new Map([
    ["/", { path: "index.html", mime: "text/html; charset=utf-8" }],
    ["/app.js", { path: "app.js", mime: "text/javascript; charset=utf-8" }],
    ["/styles.css", { path: "styles.css", mime: "text/css; charset=utf-8" }],
  ]);
  const server = createServer(async (request, response) => {
    const headers = {
      "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    };
    let status = 400;
    try {
      if (request.headers.host !== new URL(origin).host) { status = 403; throw new Error("Invalid Host header"); }
      if (request.headers.origin && request.headers.origin !== origin) { status = 403; throw new Error("Cross-origin request denied"); }
      const url = new URL(request.url ?? "/", origin);
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset) {
        response.writeHead(200, { ...headers, "content-type": asset.mime }).end(await readFile(fileURLToPath(new URL(`../web/${asset.path}`, import.meta.url))));
        return;
      }
      if (url.pathname === "/favicon.ico") { response.writeHead(204, headers).end(); return; }
      const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { status = 401; throw new Error("Open this inbox through /projects-ui or the CLI to authenticate"); }
      if (request.headers["sec-fetch-site"] === "cross-site") { status = 403; throw new Error("Cross-site request denied"); }
      if (request.method === "POST" && url.pathname === "/api") {
        const input = parse(Request, JSON.parse(await body(request)));
        const data = await dispatch(input);
        response.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ ok: true, data }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/live") {
        const id = url.searchParams.get("project") ?? "";
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid project ID");
        loadProject(id);
        await serveLive(response, headers, (onFrame, onEnd) => watchLive(id, onFrame, onEnd));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/evidence/")) {
        const parts = url.pathname.split("/");
        if (parts.length !== 4) throw new Error("Invalid evidence URL");
        const project = loadProject(parts[2]);
        const result = await readEvidence(projectDir(project.id), parts[3]);
        response.writeHead(200, { ...headers, "content-type": result.mime, "content-length": result.bytes.length }).end(result.bytes);
        return;
      }
      status = 404;
      throw new Error("Unknown endpoint");
    } catch (error) {
      response.writeHead(status, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: errorText(error) }));
    }
  });
  server.requestTimeout = 120000;
  server.on("close", () => { for (const end of liveStreams) end(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", error => process.stderr.write(JSON.stringify({ event: "web-error", error: errorText(error) }) + "\n"));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser listener has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/#token=${token}`;
  saveJson(join(home(), "web.json"), { url, pid: process.pid });
  return { url, close: () => server.close() };
}
