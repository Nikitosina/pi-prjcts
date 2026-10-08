import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { body, bytes } from "./http.ts";
import { UPLOAD_MAX_BYTES, uploadBytes, validUploadName } from "./uploads.ts";
import { readEvidence } from "./evidence.ts";
import { openArtifact } from "./artifacts.ts";
import { closeSync, createReadStream } from "node:fs";
import { errorText, home, loadProject, parse, projectDir, Request, saveJson, type Request as RequestData } from "./state.ts";
import { join } from "node:path";

type LiveWatch = (projectId: string, onFrame: (frame: unknown) => void, onEnd: () => void, chatId?: string) => Promise<() => void>;

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

export async function startWeb(dispatch: (input: RequestData) => Promise<unknown>, watchLive: LiveWatch, upload: (projectId: string, filename: string, bytes: Buffer) => Promise<unknown>) {
  // Reuse the previous token (and below, port) when present: a tab left open across a host restart keeps its session and its notifications.
  let saved: URL | null = null;
  try { saved = new URL(JSON.parse(readFileSync(join(home(), "web.json"), "utf8")).url); } catch {}
  const previous = new URLSearchParams(saved?.hash.slice(1) ?? "").get("token");
  const token = previous && /^[a-f0-9]{64}$/.test(previous) ? previous : randomBytes(32).toString("hex");
  let origin = "";
  const assets = new Map([
    ["/", { path: "index.html", mime: "text/html; charset=utf-8" }],
    ["/theme.js", { path: "theme.js", mime: "text/javascript; charset=utf-8" }],
    ["/app.js", { path: "app.js", mime: "text/javascript; charset=utf-8" }],
    ["/styles.css", { path: "styles.css", mime: "text/css; charset=utf-8" }],
  ]);
  const server = createServer(async (request, response) => {
    const headers = {
      "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
        const chat = url.searchParams.get("chat") ?? "main";
        if (!/^(main|[a-f0-9-]{36})$/.test(chat)) throw new Error("Invalid chat ID");
        loadProject(id);
        await serveLive(response, headers, (onFrame, onEnd) => watchLive(id, onFrame, onEnd, chat));
        return;
      }
      // Raw file body (≤ 20 MiB); the display name travels URI-encoded in x-filename.
      if (request.method === "POST" && url.pathname === "/upload") {
        const id = url.searchParams.get("project") ?? "";
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid project ID");
        let filename: string;
        try { filename = decodeURIComponent(String(request.headers["x-filename"] ?? "")); } catch { throw new Error("Invalid x-filename header"); }
        validUploadName(filename); loadProject(id);
        let data: Buffer;
        try { data = await bytes(request, UPLOAD_MAX_BYTES); } catch (error) { status = 413; throw error; }
        const stored = await upload(id, filename, data);
        response.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ ok: true, data: stored }));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/uploads/")) {
        const parts = url.pathname.split("/");
        if (parts.length !== 4) throw new Error("Invalid upload URL");
        const project = loadProject(parts[2]);
        const result = uploadBytes(projectDir(project.id), parts[3]);
        response.writeHead(200, { ...headers, "content-type": result.record.kind === "text" ? "text/plain; charset=utf-8" : result.record.mime, "content-length": result.bytes.length }).end(result.bytes);
        return;
      }
      // Worker artifacts: /artifacts/<project>/<thread>/<path…>, token-authenticated like every route here; symlinks and traversal refused in openArtifact.
      if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
        const [, , project, thread, ...rest] = url.pathname.split("/");
        let path: string;
        try { path = rest.map(part => decodeURIComponent(part)).join("/"); } catch { throw new Error("Invalid artifact URL"); }
        if (!/^[a-f0-9-]{36}$/.test(project ?? "") || !/^[a-f0-9-]{36}$/.test(thread ?? "")) throw new Error("Invalid artifact URL");
        loadProject(project);
        let opened: ReturnType<typeof openArtifact>;
        try { opened = openArtifact(projectDir(project), thread, path); } catch (error) { status = /not found/i.test(errorText(error)) ? 404 : 403; throw error; }
        response.writeHead(200, { ...headers, "content-type": opened.mime, "content-length": opened.size, "content-disposition": `${opened.kind === "image" || opened.kind === "video" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(opened.path.split("/").at(-1)!)}` });
        const stream = createReadStream("", { fd: opened.fd, autoClose: true });
        stream.on("error", () => { try { closeSync(opened.fd); } catch {} response.destroy(); });
        stream.pipe(response);
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
      response.writeHead(status, { ...headers, "content-type": "application/json", ...(status === 413 ? { connection: "close" } : {}) }).end(JSON.stringify({ ok: false, error: errorText(error) }));
    }
  });
  server.requestTimeout = 120000;
  server.on("close", () => { for (const end of liveStreams) end(); });
  // Reuse the previous port when it is free: browser notification permission and the notifications toggle are per origin.
  const port = Number(saved?.port) || 0;
  const listen = (port: number) => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  try { await listen(port); } catch (error) { if (!port) throw error; await listen(0); }
  server.on("error", error => process.stderr.write(JSON.stringify({ event: "web-error", error: errorText(error) }) + "\n"));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser listener has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/#token=${token}`;
  saveJson(join(home(), "web.json"), { url, pid: process.pid });
  return { url, close: () => server.close() };
}
