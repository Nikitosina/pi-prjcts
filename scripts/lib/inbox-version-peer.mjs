// An old peer cannot be made to omit its version on demand. Use the host's real transport and the stopped fixture's identity, with a controlled HTTP responder for compatibility and lost-receipt cases.
import { createServer } from "node:http";
import { once } from "node:events";
import { createRemote } from "../../src/remote.ts";

if (!process.send || !process.env.PI_PROJECTS_HOME?.startsWith(process.env.INBOX_TEST_ROOT + "/"))
  throw Error("Private inbox fixture required");
let version = 2;
const requests = [];
const server = createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  const input = req.url === "/api" ? JSON.parse(Buffer.concat(parts)) : {};
  requests.push(input.action ?? req.url);
  const json = (data) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data }));
  if (input.action === "api-version") return json(version === null ? {} : { version });
  if (input.action === "search" && input.query === "retry probe") {
    if (requests.filter((k) => k === "search").length <= 2) return;
    return json(input.query);
  }
  if (input.action === "message") return; // The host received the write, but its reply is lost.
  if (req.url === "/large") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.alloc(8 << 20, 7));
  if (req.url.startsWith("/changes")) return res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"t":"sync"}\n\n');
  json([]);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const peer = createRemote({ webUrl: `http://127.0.0.1:${server.address().port}`, report: () => {}, summary: async () => ({ needs: 0 }) });
await peer.reload();
process.on("message", async ({ id, op, value }) => {
  try {
    if (op === "restart") {
      await peer.close();
      version = value;
      await peer.reload();
    }
    if (op === "stop") await peer.close();
    process.send({ id, requests, status: peer.status().connection });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
process.on("disconnect", async () => {
  await peer.close();
  server.closeAllConnections();
  server.close();
});
process.send({ ready: true });
