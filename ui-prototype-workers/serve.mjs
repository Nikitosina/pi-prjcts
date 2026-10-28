// PROTOTYPE — throwaway. Three Workers-card variants on the real coordinator chrome, switchable via ?variant=A|B|C.
// Serves the real web/index.html and web/styles.css on loopback, with app.js swapped for a static fixture script.
// Development-only: refuses to start unless PI_PROTOTYPE=workers (set by `npm run prototype:workers`). The production
// host serves only its own asset list from web/, so nothing in this folder can reach production.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

if (process.env.PI_PROTOTYPE !== "workers") { console.error("Prototype mode is off. Run: npm run prototype:workers"); process.exit(1); }
const web = new URL("../web/", import.meta.url), here = new URL("./", import.meta.url);
const port = Number(process.env.PORT ?? 4799);
const files = { "/styles.css": [web, "styles.css", "text/css"], "/theme.js": [web, "theme.js", "text/javascript"], "/proto/proto.js": [here, "proto.js", "text/javascript"], "/proto/proto.css": [here, "proto.css", "text/css"] };

createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    if (path === "/") {
      const html = (await readFile(new URL("index.html", web), "utf8"))
        .replace('<script defer src="/app.js"></script>', '<link rel="stylesheet" href="/proto/proto.css"><script defer src="/proto/proto.js"></script>')
        .replace("<title>Pi Projects</title>", "<title>PROTOTYPE · Workers card</title>");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
      return;
    }
    const file = files[path];
    if (!file) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "content-type": file[2], "cache-control": "no-store" }).end(await readFile(new URL(file[1], file[0])));
  } catch (error) { res.writeHead(500).end(String(error)); }
}).listen(port, "127.0.0.1", () => console.log(`PROTOTYPE Workers card: http://127.0.0.1:${port}/?variant=A  (B, C)`));
