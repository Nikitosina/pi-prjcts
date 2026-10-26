// THROWAWAY PROTOTYPE HOST — static, loopback-only, no persistence or model/API access.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.PORT || 4179);
const host = "127.0.0.1";
const files = new Map([
  ["/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
  ["/theme.js", ["web/theme.js", "text/javascript; charset=utf-8"]],
  ["/prototype-agent-desktop/app.js", ["web/prototype-agent-desktop/app.js", "text/javascript; charset=utf-8"]],
  ["/prototype-agent-desktop/styles.css", ["web/prototype-agent-desktop/styles.css", "text/css; charset=utf-8"]],
]);
const server = createServer(async (request, response) => {
  const headers = {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
  if (request.headers.host !== `${host}:${port}`) {
    response.writeHead(403, headers).end("Prototype host only");
    return;
  }
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      let html = await readFile(`${root}/web/index.html`, "utf8");
      html = html.replace('<script defer src="/app.js"></script>', '<link rel="stylesheet" href="/prototype-agent-desktop/styles.css"><script defer src="/prototype-agent-desktop/app.js"></script>');
      html = html.replace("<title>Pi Projects</title>", "<title>THROWAWAY · Pi agent desktop</title>");
      response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    const asset = files.get(url.pathname);
    if (request.method === "GET" && asset) {
      response.writeHead(200, { ...headers, "content-type": asset[1] }).end(await readFile(`${root}/${asset[0]}`));
      return;
    }
    response.writeHead(404, headers).end("Not found");
  } catch (error) {
    response.writeHead(500, headers).end(String(error));
  }
});
server.listen(port, host, () => {
  console.log(`THROWAWAY Pi agent-desktop prototype: http://${host}:${port}/?variant=terminal`);
  console.log("Static mock data only. No persistence, host API, writes, or model calls. Ctrl+C to stop.");
});
