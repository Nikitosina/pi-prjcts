import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { generateSigningKey, hostWelcome, readHello } from "../../relay/bootstrap/wire.js";

export async function refusedWelcome(page, relay, pinned) {
  const wrong = await generateSigningKey(false);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  try {
    relay.routeNextTo(server.address().port);
    server.once("connection", async (socket) => {
      socket.send(JSON.stringify({ t: "challenge", nonce: Buffer.alloc(32, 1).toString("base64url") }));
      await once(socket, "message");
      socket.send(JSON.stringify({ t: "ready" }));
      const [bytes] = await once(socket, "message");
      const hello = JSON.parse(bytes);
      const { welcome } = await hostWelcome({ hostKey: wrong.privateKey, hello, t1: await readHello(pinned, hello) });
      socket.send(Buffer.from(JSON.stringify(welcome)));
    });
    const reason = await page.evaluate(
      `(async()=>{const {openTunnel}=await import('/inbox-wire/tunnel.js');const {get}=await import('/inbox-wire/store.js');try { const session=await openTunnel({hostId:'${pinned}',endpoint:'${relay.origin.replace("https:", "wss:")}/ws', identity:()=>get('inbox-device:${pinned}')}); session.close(); } catch(e){return e.message;} })()`,
    );
    assert.match(reason, /host key mismatch/i);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}
