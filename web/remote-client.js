import { openTunnel } from "/inbox-wire/tunnel.js";
import { get, put, deleteKey } from "/inbox-wire/store.js";
import { generateSigningKey, keyId } from "/inbox-wire/wire.js";

const deviceKey = (id) => `inbox-device:${id}`;
const endpoint = (entry) => `wss://${new URL(entry.relayOrigin).host}/ws`;
async function compatible(session) {
  const response = await session.request({
    method: "POST",
    path: "/api",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ action: "api-version" })),
  });
  const text = await response.text();
  try {
    const reply = JSON.parse(text);
    return response.ok && reply.ok === true && reply.data?.version === 2;
  } catch {
    return false;
  }
}
export async function authenticatePair(entry, pair) {
  const keys = await generateSigningKey(false);
  const identity = { privateKey: keys.privateKey, id: await keyId(keys.publicKey) };
  const session = await openTunnel({ hostId: entry.hostId, pair, endpoint: endpoint(entry), identity: () => identity });
  try {
    await compatible(session);
    return identity;
  } finally {
    session.close();
  }
}
export const saveDevice = (hostId, identity) => put(deviceKey(hostId), identity);
export const forgetDevice = (hostId) => deleteKey(deviceKey(hostId));

export async function remoteTransport(entry) {
  let active,
    timer,
    delay = 1000,
    stopped = false;
  const channel = new BroadcastChannel(deviceKey(entry.hostId));
  const client = Object.assign(new EventTarget(), entry, {
    local: false,
    state: "offline",
    /** Counts the times the connection went away, so a flow that began before one can tell it must not go on. */
    epoch: 0,
    close,
    /** Nothing is replayed (REMOTE_SPEC.md, decision 14): a request that loses its connection fails at once, and the view asks again after the reconnect. */
    async run(read, signal, operation) {
      const session = active;
      if (client.state !== "online" || !session) throw Error(client.state);
      try {
        return await operation(async (path, init = {}) => {
          const body = init.body == null ? null : await new Response(init.body).arrayBuffer();
          return session.request({ ...init, path, body });
        });
      } catch (error) {
        if (signal?.aborted || !session.closed) throw error;
        throw Error(read ? "Connection lost." : "Result unknown, check after reconnecting.");
      }
    },
    authorizedFetch(path, init = {}) {
      return client.run((init.method ?? "GET") === "GET", init.signal, (fetch) => fetch(path, init));
    },
  });
  function state(value) {
    if (value !== "online") client.epoch++;
    client.state = value;
    client.dispatchEvent(new Event("statechange"));
  }
  function close(reason = "offline") {
    stopped = true;
    clearTimeout(timer);
    active?.close();
    active = null;
    channel.close();
    state(reason);
  }
  function lost(error) {
    active = null;
    if (stopped) return;
    if (error.code === 4403) {
      channel.postMessage("revoked");
      return close("revoked");
    }
    state("offline");
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    delay = Math.min(30000, delay * 2);
  }
  channel.onmessage = ({ data }) => {
    if (data === "forget") close("forgotten");
    if (data === "revoked") close("revoked");
  };
  addEventListener("pagehide", () => close(), { once: true });
  addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
  });
  async function connect() {
    let session;
    try {
      const identity = await get(deviceKey(entry.hostId));
      if (!identity) return close("not paired");
      session = await openTunnel({ hostId: entry.hostId, endpoint: endpoint(entry), identity: () => identity });
      if (stopped) return session.close();
      active = session;
      if (!(await compatible(session))) return close("needs update");
      if (stopped || session.closed) throw Error("Disconnected");
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
export function stopViews(hostId) {
  const channel = new BroadcastChannel(deviceKey(hostId));
  channel.postMessage("forget");
  channel.close();
}
