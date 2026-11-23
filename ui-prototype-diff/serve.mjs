// PROTOTYPE server: the prototype page with the real web/ assets (styles.css, font). No host, no API. Usage: node ui-prototype-diff/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const web = join(here, "..", "web");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".md": "text/plain" };
const port = Number(process.argv[2] ?? 4747);

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file =
    path === "/"
      ? join(here, "index.html")
      : path.startsWith("/proto/")
        ? join(here, normalize(path.slice(7)))
        : join(web, normalize(path));
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`PROTOTYPE PR viewer: http://127.0.0.1:${port}/?variant=review`));
