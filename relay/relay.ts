import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as signJwt, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { bootstrapAssets, fingerprint, pushServiceAllowed } from "./shared.ts";
import { clientAuthText, devicesText, fromB64u, hostAuthText, isId, MAX_FRAME, splitChannel, verify, withChannel } from "./bootstrap/wire.js";

// ws has no bundled types. Keep its small used surface here, without a second package dependency.
interface Socket extends EventEmitter {
  readyState: number; bufferedAmount: number;
  send(data: string | Uint8Array, options?: { binary: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
}
interface WSServer extends EventEmitter {
  clients: Set<Socket>;
  handleUpgrade(request: IncomingMessage, socket: unknown, head: Buffer, callback: (socket: Socket) => void): void;
  close(): void;
}
const { WebSocketServer } = createRequire(import.meta.url)("ws") as { WebSocketServer: new (options: Record<string, unknown>) => WSServer };
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.RELAY_DATA ?? join(root, "state"));
const allowFile = join(dataDir, "hosts.json");
const OPEN = 1, BUFFER_LIMIT = 4 * 1024 * 1024, AUTH_MS = 10_000;
type Hosts = Record<string, { name: string }>;
type Peer = { socket: Socket; ip: string; nonce: string; role: "pending" | "host" | "client" | "pair"; id?: string; host?: Host; channel?: number; pairId?: string; authTimer: NodeJS.Timeout; closeTimer?: NodeJS.Timeout; missedPongs: number; closed: boolean; queued: number; queuedMessages: number; queue: Promise<void> };
type Host = { id: string; peer: Peer; channels: Map<number, Peer>; devices: Set<string>; pairing: Set<string>; nextChannel: number };
type PushRate = { since: number; count: number; running: number };

function vapidKey(): { key: KeyObject; publicKey: string } {
  const path = join(dataDir, "vapid.json");
  if (!existsSync(path)) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(path, JSON.stringify(pair.privateKey.export({ format: "jwk" })) + "\n", { mode: 0o600, flag: "wx" });
  }
  const key = createPrivateKey({ key: JSON.parse(readFileSync(path, "utf8")), format: "jwk" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Invalid VAPID key");
  chmodSync(path, 0o600);
  const publicJwk = createPublicKey(key).export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, "base64url"), Buffer.from(publicJwk.y!, "base64url")]).toString("base64url");
  return { key, publicKey };
}
function pushEndpoint(value: unknown): URL | null {
  try {
    if (typeof value !== "string" || value.length > 4096) return null;
    const url = new URL(value);
    if (!pushServiceAllowed(url)) return null;
    return url;
  } catch { return null; }
}
async function push(vapid: { key: KeyObject; publicKey: string }, subject: string, endpoint: URL, body: Buffer, ttl: number, urgency: string): Promise<number> {
  const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encoded({ typ: "JWT", alg: "ES256" })}.${encoded({ aud: endpoint.origin, sub: subject, exp: Math.floor(Date.now() / 1000) + 12 * 3600 })}`;
  const jwt = `${payload}.${signJwt("sha256", Buffer.from(payload), { key: vapid.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `vapid t=${jwt}, k=${vapid.publicKey}`, "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(ttl), urgency }, body: Uint8Array.from(body).buffer, redirect: "manual", signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    return response.status;
  } catch { return 0; }
}

function readHosts(): Hosts {
  if (!existsSync(allowFile)) return {};
  const value: unknown = JSON.parse(readFileSync(allowFile, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hosts.json");
  for (const [id, entry] of Object.entries(value)) if (!isId(id) || !entry || typeof entry !== "object" || typeof (entry as { name?: unknown }).name !== "string") throw new Error("Invalid hosts.json");
  return value as Hosts;
}
function saveHosts(hosts: Hosts) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${allowFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(hosts, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600); renameSync(temporary, allowFile);
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function clientIp(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") {
    const forwarded = request.headers["x-forwarded-for"];
    const last = typeof forwarded === "string" ? forwarded.split(",").at(-1)!.trim() : "";
    if (isIP(last)) return last;
  }
  return address;
}

function serve() {
  if (!existsSync(allowFile)) saveHosts({});
  readHosts();
  const origin = new URL(process.env.RELAY_ORIGIN ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("RELAY_ORIGIN must be an HTTPS origin");
  const vapid = vapidKey(), pushRates = new Map<string, PushRate>();
  const assets = bootstrapAssets(), hosts = new Map<string, Host>(), sequences = new Map<string, number>();
  const pending = new Map<string, number>(), attempts = new Map<string, { since: number; count: number }>();
  const peers = new Set<Peer>();
  const headers = { "content-security-policy": `default-src 'none'; script-src 'self'; connect-src 'self' wss://${origin.host}; worker-src 'self'; manifest-src 'self'; img-src 'self' data: blob:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache" };
  const server = createServer((request, response) => {
    let path: string;
    try { path = new URL(request.url ?? "/", "http://localhost").pathname; } catch { response.writeHead(404, headers).end(); return; }
    if (path === "/vapid" && (request.method === "GET" || request.method === "HEAD")) { response.writeHead(200, { ...headers, "content-type": "application/json" }).end(request.method === "HEAD" ? undefined : JSON.stringify({ key: vapid.publicKey })); return; }
    const asset = assets.get(path);
    if ((request.method !== "GET" && request.method !== "HEAD") || !asset) { response.writeHead(404, { ...headers, "cache-control": "no-store" }).end(); return; }
    if (request.headers["if-none-match"] === asset.etag) { response.writeHead(304, { ...headers, etag: asset.etag }).end(); return; }
    response.writeHead(200, { ...headers, "content-type": asset.mime, "content-length": asset.bytes.length, etag: asset.etag });
    response.end(request.method === "HEAD" ? undefined : asset.bytes);
  });
  server.headersTimeout = 15_000; server.requestTimeout = 30_000;
  const ws = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const log = (peer: Peer, event: string, code?: number) => process.stdout.write(JSON.stringify({ event, role: peer.role, ...(peer.id ? { id: hash(peer.id).slice(0, 8) } : {}), ...(code === undefined ? {} : { code }) }) + "\n");
  const releasePending = (peer: Peer) => { if (peer.role === "pending") { const count = (pending.get(peer.ip) ?? 1) - 1; if (count) pending.set(peer.ip, count); else pending.delete(peer.ip); } clearTimeout(peer.authTimer); };
  const close = (peer: Peer, code = 4403) => {
    if (peer.closed) return;
    peer.closed = true; releasePending(peer); peers.delete(peer);
    const host = peer.host;
    if (peer.role === "host" && host && hosts.get(host.id) === host) {
      hosts.delete(host.id);
      for (const channel of [...host.channels.values()]) close(channel, 4404);
    } else if (host && peer.channel !== undefined && host.channels.get(peer.channel) === peer) {
      host.channels.delete(peer.channel);
      if (host.peer.socket.readyState === OPEN && !host.peer.closed) control(host.peer, { t: "closed", ch: peer.channel });
    }
    peer.socket.close(code, code === 4404 ? "Host offline" : code === 4409 ? "Replaced" : "Access denied");
    peer.closeTimer = setTimeout(() => peer.socket.terminate(), 2000); peer.closeTimer.unref();
  };
  const send = (peer: Peer, data: string | Uint8Array, binary: boolean, source?: Peer) => {
    if (peer.closed || peer.socket.readyState !== OPEN) return false;
    // Leave room for closed-channel control messages when a client outruns its host.
    if (peer.socket.bufferedAmount + Buffer.byteLength(data) > BUFFER_LIMIT - (source ? 8192 : 0)) { close(source ?? peer, 4429); return false; }
    peer.socket.send(data, { binary }); return true;
  };
  const control = (peer: Peer, message: object) => send(peer, JSON.stringify(message), false);

  async function authenticate(peer: Peer, message: Record<string, unknown>) {
    if (message.t === "host") {
      const id = message.hostId;
      if (!isId(id) || !Object.hasOwn(readHosts(), id) || typeof message.sig !== "string" || !(await verify(id, hostAuthText(peer.nonce), message.sig))) { close(peer); return; }
      if (peer.closed) return;
      if (!Object.hasOwn(readHosts(), id)) { close(peer); return; }
      const previous = hosts.get(id);
      if (previous) close(previous.peer, 4409);
      releasePending(peer); peer.role = "host"; peer.id = id;
      const host: Host = { id, peer, channels: new Map(), devices: new Set(), pairing: new Set(), nextChannel: 1 };
      peer.host = host; hosts.set(id, host); control(peer, { t: "ready" }); log(peer, "authenticated"); return;
    }
    const id = message.hostId;
    if ((message.t !== "client" && message.t !== "pair") || !isId(id) || !Object.hasOwn(readHosts(), id)) { close(peer); return; }
    const host = hosts.get(id);
    if (!host || host.peer.closed) { close(peer, 4404); return; }
    const device = message.t === "client" ? message.deviceId : null;
    const pair = message.t === "pair" ? message.pairId : null;
    if (message.t === "client") {
      if (!isId(device) || !host.devices.has(device) || typeof message.sig !== "string" || !(await verify(device, clientAuthText(id, peer.nonce), message.sig))) { close(peer); return; }
    } else if (typeof pair !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(pair) || !host.pairing.has(pair)) { close(peer); return; }
    // The registry or host connection can change during signature verification.
    if (peer.closed || hosts.get(id) !== host || host.peer.closed || (typeof device === "string" && !host.devices.has(device)) || (typeof pair === "string" && !host.pairing.has(pair))) { close(peer); return; }
    if (host.channels.size >= 64 || host.nextChannel > 0xffffffff) { close(peer, 4429); return; }
    releasePending(peer); peer.role = message.t === "client" ? "client" : "pair"; peer.id = typeof device === "string" ? device : String(pair); peer.host = host; peer.channel = host.nextChannel++;
    if (typeof pair === "string") peer.pairId = pair;
    host.channels.set(peer.channel, peer);
    if (!control(host.peer, { t: "open", ch: peer.channel, deviceId: device, pair: message.t === "pair" })) { close(peer, 4404); return; }
    control(peer, { t: "ready" }); log(peer, "authenticated");
  }
  async function message(peer: Peer, bytes: Buffer, binary: boolean) {
    if (peer.closed) return;
    if (peer.role === "pending") {
      if (binary || bytes.length > 8192) { close(peer); return; }
      await authenticate(peer, JSON.parse(bytes.toString("utf8"))); return;
    }
    if (peer.role === "host") {
      const host = peer.host!;
      if (binary) {
        const { channel, payload } = splitChannel(bytes);
        const client = host.channels.get(channel);
        if (client) send(client, payload, true);
        return;
      }
      if (bytes.length > 64 * 1024) { close(peer); return; }
      const input = JSON.parse(bytes.toString("utf8"));
      if (input.t === "close" && Number.isInteger(input.ch)) { const client = host.channels.get(input.ch); if (client) close(client); return; }
      if (input.t === "push") {
        if (!((typeof input.id === "string" && input.id.length <= 128) || Number.isSafeInteger(input.id))) { close(peer); return; }
        const endpoint = pushEndpoint(input.endpoint);
        let body: Buffer | null = null;
        try { if (typeof input.body === "string" && input.body.length <= 5464) body = Buffer.from(fromB64u(input.body)); } catch {}
        if (!endpoint || !body || body.length > 4096 || !Number.isInteger(input.ttl) || input.ttl < 0 || input.ttl > 86400 || !["very-low", "low", "normal", "high"].includes(input.urgency)) { control(peer, { t: "push-result", id: input.id, status: 400 }); return; }
        const now = Date.now();
        let rate = pushRates.get(host.id);
        if (!rate) { rate = { since: now, count: 0, running: 0 }; pushRates.set(host.id, rate); }
        if (now - rate.since >= 60_000) { rate.since = now; rate.count = 0; }
        if (rate.count >= 60 || rate.running >= 8) { control(peer, { t: "push-result", id: input.id, status: 429 }); return; }
        rate.count++; rate.running++;
        void push(vapid, origin.origin, endpoint, body, input.ttl, input.urgency).catch(() => 0).then(status => control(peer, { t: "push-result", id: input.id, status })).finally(() => { rate.running--; });
        return;
      }
      if (input.t !== "devices" || typeof input.list !== "string" || typeof input.sig !== "string" || !(await verify(host.id, devicesText(input.list), input.sig))) { close(peer); return; }
      const list = JSON.parse(Buffer.from(fromB64u(input.list)).toString("utf8"));
      if (peer.closed || hosts.get(host.id) !== host) return;
      if (list.hostId !== host.id || !Number.isSafeInteger(list.seq) || list.seq <= (sequences.get(host.id) ?? -1) || !Array.isArray(list.devices) || list.devices.length > 256 || !list.devices.every(isId) || !Array.isArray(list.pairing) || list.pairing.length > 1 || !list.pairing.every((id: unknown) => typeof id === "string" && /^[A-Za-z0-9_-]{22}$/.test(id))) { close(peer); return; }
      sequences.set(host.id, list.seq); host.devices = new Set(list.devices); host.pairing = new Set(list.pairing);
      // A successful pairing consumes its pairId; that channel remains owned by the host's new device session.
      for (const client of [...host.channels.values()]) if (client.role === "client" && !host.devices.has(client.id!)) close(client);
      return;
    }
    if (!binary) { close(peer); return; }
    if (!peer.host || hosts.get(peer.host.id) !== peer.host) { close(peer, 4404); return; }
    if (bytes.length > MAX_FRAME - 4) { close(peer, 4403); return; }
    send(peer.host.peer, withChannel(peer.channel!, bytes), true, peer);
  }

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    const ip = clientIp(request), now = Date.now();
    let rate = attempts.get(ip);
    if (!rate && attempts.size >= 10000) { socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return; }
    if (!rate || now - rate.since >= 60_000) { rate = { since: now, count: 0 }; attempts.set(ip, rate); }
    if (++rate.count > 30 || (pending.get(ip) ?? 0) >= 4 || peers.size >= 4096) { socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return; }
    pending.set(ip, (pending.get(ip) ?? 0) + 1);
    let upgraded = false;
    const abandon = () => { if (!upgraded) { const count = (pending.get(ip) ?? 1) - 1; if (count) pending.set(ip, count); else pending.delete(ip); } };
    socket.once("close", abandon);
    try { ws.handleUpgrade(request, socket, head, connection => {
      upgraded = true; socket.off("close", abandon);
      const peer: Peer = { socket: connection, ip, nonce: randomBytes(32).toString("base64url"), role: "pending", authTimer: setTimeout(() => close(peer), AUTH_MS), missedPongs: 0, closed: false, queued: 0, queuedMessages: 0, queue: Promise.resolve() };
      peers.add(peer);
      connection.on("pong", () => { peer.missedPongs = 0; });
      connection.on("message", (raw: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
        if (peer.closed) return;
        const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
        peer.queued += bytes.length; peer.queuedMessages++;
        if (peer.queued > BUFFER_LIMIT || peer.queuedMessages > 128) { close(peer, 4429); return; }
        peer.queue = peer.queue.then(() => message(peer, bytes, binary)).catch(() => close(peer)).finally(() => { peer.queued -= bytes.length; peer.queuedMessages--; });
      });
      connection.on("error", () => close(peer));
      connection.on("close", (code: number) => { close(peer, code); clearTimeout(peer.closeTimer); log(peer, "closed", code); });
      control(peer, { t: "challenge", nonce: peer.nonce });
    }); } catch { socket.destroy(); }
  });
  const heartbeat = setInterval(() => {
    let allowed: Hosts = {};
    try { allowed = readHosts(); } catch { /* A broken allowlist fails closed until repaired. */ }
    for (const peer of peers) {
      if (peer.role === "host" && !Object.hasOwn(allowed, peer.id!)) { close(peer); continue; }
      if (peer.missedPongs >= 2) { close(peer, 4408); continue; }
      peer.missedPongs++; peer.socket.ping();
    }
    for (const [ip, rate] of attempts) if (Date.now() - rate.since >= 60_000) attempts.delete(ip);
    for (const [id, rate] of pushRates) if (rate.running === 0 && Date.now() - rate.since >= 60_000) pushRates.delete(id);
  }, 25_000);
  const shutdown = () => { clearInterval(heartbeat); for (const peer of [...peers]) close(peer, 1001); ws.close(); server.close(); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  server.on("error", () => { process.stderr.write("Relay listener failed\n"); shutdown(); process.exitCode = 1; });
  const port = Number(process.env.RELAY_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid RELAY_PORT");
  server.listen(port, "127.0.0.1", () => process.stdout.write(JSON.stringify({ event: "relay-started", port }) + "\n"));
}

function main() {
  const [command, id, ...name] = process.argv.slice(2);
  if (!command || command === "serve") { serve(); return; }
  if (command === "fingerprint") { process.stdout.write(fingerprint() + "\n"); return; }
  const hosts = readHosts();
  if (command === "hosts") { for (const [hostId, entry] of Object.entries(hosts)) process.stdout.write(`${hostId}\t${entry.name}\n`); return; }
  if ((command !== "allow" && command !== "deny") || !isId(id)) throw new Error("Usage: relay.ts [serve | allow <hostId> <name> | deny <hostId> | hosts | fingerprint]");
  if (command === "allow") { const label = name.join(" ").trim(); if (!label || label.length > 80 || /[\r\n\t]/.test(label)) throw new Error("A host name (1–80 characters) is required"); hosts[id] = { name: label }; }
  else delete hosts[id];
  saveHosts(hosts);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write((error instanceof Error ? error.message : "Relay failed") + "\n"); process.exitCode = 1; }
}
