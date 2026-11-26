import { openTunnel } from "/inbox-wire/tunnel.js";
import { device, deleteKey } from "/inbox-wire/store.js";

export async function remoteTransport(entry, pair) {
  const { hostId, relayOrigin } = entry;
  const key = `inbox-device:${hostId}`;
  let active,
    timer,
    delay = 1000,
    stopped = false;
  const client = Object.assign(new EventTarget(), {
    state: "offline",
    ...entry,
    async authorizedFetch(path, init = {}) {
      const session = active;
      if (!session || client.state !== "online") throw Error(client.state);
      const body = init.body == null ? null : await new Response(init.body).arrayBuffer();
      return session.request({ method: init.method, path, headers: init.headers, body, signal: init.signal });
    },
    async forget() {
      stopped = true;
      clearTimeout(timer);
      active?.close();
      await deleteKey(key);
    },
  });
  function state(value) {
    client.state = value;
    client.dispatchEvent(new Event("statechange"));
  }
  function lost(error) {
    active = null;
    if (stopped) return;
    if (error.code === 4403) {
      stopped = true;
      state("revoked");
      return;
    }
    state("offline");
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    delay = Math.min(30000, delay * 2);
  }
  async function connect() {
    let session;
    try {
      session = await openTunnel({ hostId, pair, endpoint: `wss://${new URL(relayOrigin).host}/ws`, identity: () => device(key) });
      pair = null;
      if (stopped) {
        session.close();
        return;
      }
      const response = await session.request({
        method: "POST",
        path: "/api",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ action: "api-version" })),
      });
      const reply = await response.json();
      if (!response.ok || !reply.ok || reply.data?.version !== 1) {
        stopped = true;
        session.close();
        state("needs update");
        return;
      }
      if (session.closed || stopped) throw Error("Disconnected");
      active = session;
      session.onClose = lost;
      delay = 1000;
      state("online");
    } catch (error) {
      session?.close();
      lost(error);
    }
  }
  await connect();
  return client;
}
