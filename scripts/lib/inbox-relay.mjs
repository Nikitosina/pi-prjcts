import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as netServer, connect } from "node:net";
import { createServer } from "node:tls";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";

export async function inboxRelay() {
  const root = mkdtempSync(join(tmpdir(), "inbox-relay-"));
  const key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const listen = async (s) => {
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    return s.address().port;
  };
  const reserve = netServer();
  const port = await listen(reserve);
  await new Promise((ok) => reserve.close(ok));
  const sockets = new Set();
  const tls = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    const plain = connect(port, "127.0.0.1");
    sockets.add(socket);
    socket.on("error", () => plain.destroy());
    plain.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      plain.destroy();
    });
    plain.on("close", () => socket.destroy());
    plain.pipe(socket).pipe(plain);
  });
  const origin = `https://127.0.0.1:${await listen(tls)}`;
  const env = { ...process.env, HOME: root, RELAY_DATA: root, RELAY_PORT: String(port), RELAY_ORIGIN: origin };
  const child = spawn(process.execPath, ["relay/relay.ts", "serve"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const ended = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      ended.then(() => {
        throw Error("Relay exited before startup");
      }),
    ]);
  } catch (error) {
    tls.close();
    throw error;
  }
  return {
    origin,
    cert,
    spki: createHash("sha256")
      .update(new X509Certificate(readFileSync(cert)).publicKey.export({ format: "der", type: "spki" }))
      .digest("base64"),
    allow: (id) => execFileSync(process.execPath, ["relay/relay.ts", "allow", id, "Remote private host"], { env }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      tls.close();
      child.kill();
      await ended;
    },
  };
}
