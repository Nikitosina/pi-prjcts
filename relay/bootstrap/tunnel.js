// One end-to-end encrypted session to one host through the relay (REMOTE_SPEC.md "Relay protocol", "End-to-end session",
// "HTTP over the tunnel"). Runs in a page, never in the service worker: Safari stops idle workers and would drop the socket.

import { CHUNK, MAX_IN_FLIGHT, clientAuthText, clientFinish, clientHello, pairId, sign, text, utf8 } from "./wire.js";
import { device } from "./store.js";

const HANDSHAKE_MS = 15_000, HIGH_WATER = 1024 * 1024;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const CLOSED = { 4403: "This device is not allowed on that host. It may have been revoked, or the pairing link expired.", 4404: "The host is offline.", 4409: "The host reconnected elsewhere." };

export class TunnelError extends Error {
  constructor(message, code = 0) { super(message); this.code = code; }
}
const closeError = event => new TunnelError(CLOSED[event.code] ?? (event.reason || "Connection to the relay closed."), event.code);

/** Reads socket messages in order; rejects every waiter once the socket closes. */
function reader(ws) {
  const queue = [], waiters = [];
  let ended = null;
  ws.onmessage = event => { const waiter = waiters.shift(); if (waiter) waiter.resolve(event.data); else queue.push(event.data); };
  ws.onclose = event => { ended = event; for (const waiter of waiters.splice(0)) waiter.reject(closeError(event)); };
  ws.onerror = () => {};
  return () => queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.reject(closeError(ended)) : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}
const json = data => { if (typeof data !== "string") throw new TunnelError("Unexpected binary frame from the relay"); return JSON.parse(data); };

/**
 * Connect to `hostId`. With `pair: {code, name}` the hello pairs this device first; the session then continues as the device.
 * Resolves once the host's welcome verified against the pinned hostId.
 */
export async function openTunnel({ hostId, pair = null }) {
  const me = await device();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  const next = reader(ws);
  const timer = setTimeout(() => ws.close(4000, "Handshake timed out"), HANDSHAKE_MS);
  try {
    const challenge = json(await next());
    if (challenge.t !== "challenge") throw new TunnelError("Unexpected relay message");
    ws.send(JSON.stringify(pair ? { t: "pair", hostId, pairId: await pairId(pair.code) } : { t: "client", hostId, deviceId: me.id, sig: await sign(me.privateKey, clientAuthText(hostId, challenge.nonce)) }));
    if (json(await next()).t !== "ready") throw new TunnelError("Unexpected relay message");
    const { hello, state } = await clientHello({ hostId, mode: pair ? "pair" : "device", deviceKey: me.privateKey, deviceId: me.id, name: pair?.name, code: pair?.code });
    ws.send(utf8(JSON.stringify(hello)));
    const welcome = await next();
    if (typeof welcome === "string") throw new TunnelError("Unexpected relay message");
    const tunnel = new Tunnel(ws);
    await tunnel.start(state, JSON.parse(text(new Uint8Array(welcome))));
    return tunnel;
  } catch (error) {
    ws.close();
    throw error instanceof TunnelError ? error : new TunnelError(error instanceof Error ? error.message : String(error));
  } finally { clearTimeout(timer); }
}

class Tunnel {
  #ws; #session = null; #next = 1; #requests = new Map(); #slots = []; #closed = null;
  /** Called once with the reason when the session ends. */
  onClose = null;
  constructor(ws) { this.#ws = ws; }
  get closed() { return this.#closed !== null; }

  async start(state, welcome) {
    this.#session = await clientFinish(state, welcome, {
      send: record => this.#ws.send(record),
      onMessage: (header, body) => this.#receive(header, body),
      onClose: reason => this.#end(new TunnelError(reason)),
    });
    this.#ws.onmessage = event => { if (typeof event.data !== "string") void this.#session.receive(event.data); };
    this.#ws.onclose = event => this.#end(closeError(event));
  }

  close() { this.#ws.close(); this.#end(new TunnelError("Closed")); }

  #end(error) {
    if (this.#closed) return;
    this.#closed = error;
    this.#session?.close(error.message);
    if (this.#ws.readyState <= 1) this.#ws.close();
    for (const entry of this.#requests.values()) entry.fail(error);
    this.#requests.clear();
    for (const wake of this.#slots.splice(0)) wake();
    this.onClose?.(error);
  }

  async #drain() { while (this.#ws.bufferedAmount > HIGH_WATER && !this.#closed) await new Promise(resolve => setTimeout(resolve, 20)); }
  async #slot() { while (this.#requests.size >= MAX_IN_FLIGHT && !this.#closed) await new Promise(resolve => this.#slots.push(resolve)); }

  /** HTTP request to the host's inbox. Resolves with a Response whose body streams; `signal` cancels on the host too. */
  async request({ method = "GET", path, headers = {}, body = null, signal = null }) {
    await this.#slot();
    if (this.#closed) throw this.#closed;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const id = this.#next++, bytes = body ? new Uint8Array(body) : new Uint8Array(0);
    let controller = null, settle;
    const head = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const entry = {
      response: header => {
        const status = header.status;
        const stream = NULL_BODY.has(status) ? null : new ReadableStream({ start: c => { controller = c; }, cancel: () => this.#cancel(id) });
        settle.resolve(new Response(stream, { status, headers: header.headers ?? {} }));
        return stream !== null;
      },
      chunk: data => { if (data.length) controller?.enqueue(data.slice()); },
      finish: () => { try { controller?.close(); } catch {} this.#forget(id); },
      fail: error => { settle.reject(error); try { controller?.error(error); } catch {} this.#forget(id); },
    };
    this.#requests.set(id, entry);
    signal?.addEventListener("abort", () => { entry.fail(new DOMException("Aborted", "AbortError")); void this.#session.write({ t: "cancel", id }).catch(() => {}); }, { once: true });
    try {
      for (let at = 0, first = true; first || at < bytes.length; first = false) {
        const end = Math.min(at + CHUNK, bytes.length), fin = end >= bytes.length;
        await this.#drain();
        if (!this.#requests.has(id)) break;
        await this.#session.write(first ? { t: "req", id, method, path, headers, fin } : { t: "data", id, fin }, bytes.subarray(at, end));
        at = end;
      }
    } catch (error) { entry.fail(this.#closed ?? error); }
    return head;
  }

  #cancel(id) {
    if (!this.#requests.has(id)) return;
    this.#forget(id);
    void this.#session.write({ t: "cancel", id }).catch(() => {});
  }
  #forget(id) {
    if (!this.#requests.delete(id)) return;
    this.#slots.shift()?.();
  }

  #receive(header, body) {
    const entry = this.#requests.get(header.id);
    if (!entry) return;
    if (header.t === "res") {
      const streaming = entry.response(header);
      if (!streaming) { this.#forget(header.id); return; }
      entry.chunk(body);
      if (header.fin) entry.finish();
    } else if (header.t === "data") {
      entry.chunk(body);
      if (header.fin) entry.finish();
    } else if (header.t === "err") entry.fail(new TunnelError(String(header.error ?? "Host request failed")));
  }
}
