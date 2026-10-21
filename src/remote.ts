import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest, type ClientRequest } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import qrcode from "qrcode-generator";
import { home, saveJson } from "./state.ts";
import { encryptWebPush, pushSubscription, type PushSubscription } from "./web-push.ts";
import type { Notice } from "./notify.ts";
import { b64u, fromB64u, generateSigningKey, keyId, importSigningKey, sign, hostAuthText, devicesText, newPairCode, pairId, pairLink, readHello, verifyPairMac, hostWelcome, text, utf8, withChannel, splitChannel, isId, CHUNK, MAX_FRAME, MAX_IN_FLIGHT, PAIR_MS, type Hello, type Session, type TunnelHeader } from "../relay/bootstrap/wire.js";

type RemoteConfig = { enabled: boolean; relay: string; hostName: string };
type Device = { id: string; name: string; pairedAt: number; lastSeenAt: number; revokedAt?: number; push?: PushSubscription };
type Registry = { seq: number; devices: Device[] };
type Pair = { code: string; id: string; expiresAt: number; attempts: number; timer: NodeJS.Timeout };
type PendingRequest = { call: ClientRequest; bytes: number; ended: boolean; responseEnded: boolean };
type Channel = { ch: number; relayDevice: string | null; pair: boolean; deviceId: string | null; session?: Session; handshakeTimer: NodeJS.Timeout; requests: Map<number, PendingRequest>; seen: Set<number>; chain: Promise<void>; queuedBytes: number; queuedFrames: number; stopped: boolean };
type Options = { webUrl: string; report: (detail: string) => void; summary: () => Promise<{ hostName?: string; needs: number }> };
const directory = () => join(home(), "remote");
const configPath = () => join(directory(), "config.json");
const REQUEST_LIMIT = 20 * 1024 * 1024;
const requestHeaders = new Set(["content-type", "x-filename", "if-none-match", "accept"]);
const responseHeaders = new Set(["content-type", "content-disposition", "etag", "cache-control", "content-length"]);

/** Read opt-in state without creating anything in an unconfigured host home. */
export function remoteConfig(): RemoteConfig | null {
  if (!existsSync(configPath())) return null;
  const config = JSON.parse(readFileSync(configPath(), "utf8")) as RemoteConfig;
  const relay = new URL(config.relay);
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.pathname !== "/" || relay.search || relay.hash) throw new Error("Remote relay must be an HTTPS origin");
  if (typeof config.hostName !== "string" || !config.hostName.trim() || config.hostName.length > 80 || typeof config.enabled !== "boolean") throw new Error("Invalid remote configuration");
  return { ...config, relay: relay.origin };
}

/** Stable LaunchAgent identity, separate for every project home. */
export function remoteAgentLabel(): string { return `dev.pi-projects.host.${createHash("sha256").update(home()).digest("hex").slice(0, 8)}`; }
const agentPath = () => join(homedir(), "Library", "LaunchAgents", `${remoteAgentLabel()}.plist`);
const launchTarget = () => `gui/${process.getuid!()}/${remoteAgentLabel()}`;
function launchctl(args: string[]): string {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`launchctl ${args[0]} failed${result.error ? `: ${result.error.message}` : ""}`);
  return result.stdout || "";
}
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** Configure remote mode and install its opt-in per-user host service. Does not restart a running host. */
export async function enableRemote(relayOrigin: string, name = hostname()): Promise<{ hostId: string; relay: string; allowCommand: string }> {
  if (process.platform !== "darwin") throw new Error("Remote host service installation requires macOS");
  const relay = new URL(relayOrigin);
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.pathname !== "/" || relay.search || relay.hash) throw new Error("Use an HTTPS relay origin, without path or credentials");
  name = name.trim(); if (!name || name.length > 80) throw new Error("Host name must be 1–80 characters");
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const identity = await hostIdentity();
  saveJson(configPath(), { enabled: true, relay: relay.origin, hostName: name });
  if (!existsSync(join(directory(), "devices.json"))) saveJson(join(directory(), "devices.json"), { seq: 0, devices: [] });
  const root = fileURLToPath(new URL("..", import.meta.url)), host = fileURLToPath(new URL("./host.ts", import.meta.url));
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(remoteAgentLabel())}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(host)}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>EnvironmentVariables</key><dict><key>PI_PROJECTS_HOME</key><string>${xml(home())}</string><key>PI_PROJECTS_HOST</key><string>1</string><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>StandardOutPath</key><string>${xml(join(home(), "host.log"))}</string><key>StandardErrorPath</key><string>${xml(join(home(), "host.log"))}</string></dict></plist>\n`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  if (existsSync(agentPath()) && readFileSync(agentPath(), "utf8") !== plist) throw new Error("Remote service configuration changed; disable it before installing a new service configuration");
  writeFileSync(agentPath(), plist, { mode: 0o600 });
  const loaded = spawnSync("/bin/launchctl", ["print", launchTarget()], { stdio: "ignore" }).status === 0;
  if (!loaded) launchctl(["bootstrap", `gui/${process.getuid!()}`, agentPath()]);
  return { hostId: identity.id, relay: relay.origin, allowCommand: `node relay/relay.ts allow ${identity.id} ${JSON.stringify(name)}` };
}

/** Disable the configured service; identities are retained for the next enable. `keepService` only turns the config off, so a running host can drop its relay connection before launchd stops it. */
export function disableRemote({ keepService = false } = {}): void {
  const config = remoteConfig(); if (config) saveJson(configPath(), { ...config, enabled: false });
  if (!keepService && process.platform === "darwin" && existsSync(agentPath())) {
    if (spawnSync("/bin/launchctl", ["print", launchTarget()], { stdio: "ignore" }).status === 0) launchctl(["bootout", launchTarget()]);
    unlinkSync(agentPath());
  }
}

/** Start the launchd-owned host instead of racing a detached process against it. */
export function kickstartRemoteHost(): void {
  if (process.platform !== "darwin" || !existsSync(agentPath())) throw new Error("Remote host service is missing; run remote enable");
  launchctl(["kickstart", launchTarget()]);
}

/** Read launchd state without starting the host. */
export function remoteServiceStatus() {
  const config = remoteConfig();
  const installed = process.platform === "darwin" && existsSync(agentPath());
  const result = installed ? spawnSync("/bin/launchctl", ["print", launchTarget()], { encoding: "utf8" }) : null;
  return { config, installed, loaded: result?.status === 0, label: remoteAgentLabel() };
}

async function hostIdentity(): Promise<{ id: string; privateKey: CryptoKey }> {
  const path = join(directory(), "host-key.json");
  if (existsSync(path)) {
    const jwk = JSON.parse(readFileSync(path, "utf8"));
    if (!isId(jwk.x)) throw new Error("Invalid remote host identity");
    return { id: jwk.x, privateKey: await importSigningKey(jwk) };
  }
  const pair = await generateSigningKey(true), id = await keyId(pair.publicKey);
  saveJson(path, await crypto.subtle.exportKey("jwk", pair.privateKey));
  return { id, privateKey: pair.privateKey };
}

/** SHA-256 of sorted served paths followed by newline and file bytes; shared with the relay fingerprint CLI. */
export function bootstrapFingerprint(): string {
  const base = fileURLToPath(new URL("../relay/bootstrap/", import.meta.url));
  const files = readdirSync(base, { withFileTypes: true }).filter(file => file.isFile() && file.name !== "wire.d.ts").map(file => ({ name: file.name, path: file.name === "index.html" ? "/" : file.name === "sw.js" || file.name === "manifest.webmanifest" ? `/${file.name}` : `/boot/${file.name}` })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash("sha256"); for (const file of files) hash.update(`${file.path}\n`).update(readFileSync(join(base, file.name)));
  return hash.digest("hex");
}

/** One opt-in relay connection and device registry per running Projects host. */
export function createRemote(options: Options) {
  const token = randomBytes(32).toString("hex");
  let config: RemoteConfig | null = null, identity: { id: string; privateKey: CryptoKey } | null = null;
  let registry: Registry = { seq: 0, devices: [] }, pairing: Pair | null = null;
  let socket: WebSocket | null = null, reconnect: NodeJS.Timeout | null = null, power: ChildProcess | null = null;
  let stopped = true, generation = 0, backoff = 1000, connection: "off" | "connecting" | "connected" | "error" = "off", lastError: string | null = null;
  let controls = Promise.resolve(), reloadOperation = Promise.resolve();
  let pairGeneration = 0;
  const channels = new Map<number, Channel>(), pendingPushes = new Map<string, { deviceId: string; endpoint: string; timer: NodeJS.Timeout }>();
  const persist = () => saveJson(join(directory(), "devices.json"), registry);
  const deviceActive = (id: string) => !stopped && !!registry.devices.find(device => device.id === id && !device.revokedAt);
  const control = (value: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const fail = (detail: string) => { lastError = detail; options.report(detail); };
  const stopChannel = (channel: Channel, notify = true) => {
    if (channel.stopped) return;
    channel.stopped = true; clearTimeout(channel.handshakeTimer); channels.delete(channel.ch);
    for (const request of channel.requests.values()) request.call.destroy();
    channel.requests.clear(); channel.session?.close();
    if (notify) control({ t: "close", ch: channel.ch });
  };
  const clearChannels = () => { for (const channel of channels.values()) stopChannel(channel, false); };
  const clearPushes = () => { for (const push of pendingPushes.values()) clearTimeout(push.timer); pendingPushes.clear(); };
  const sendList = () => {
    controls = controls.then(async () => {
      if (!identity || !socket || socket.readyState !== WebSocket.OPEN || connection !== "connected") return;
      const ws = socket;
      if (!Number.isSafeInteger(registry.seq + 1)) throw new Error("Remote device sequence exhausted");
      const list = b64u(utf8(JSON.stringify({ hostId: identity.id, seq: ++registry.seq, devices: registry.devices.filter(device => !device.revokedAt).map(device => device.id), pairing: pairing && pairing.expiresAt > Date.now() ? [pairing.id] : [] })));
      persist();
      const sig = await sign(identity.privateKey, devicesText(list));
      if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "devices", list, sig }));
    }).catch(() => { fail("Remote device list could not be published"); socket?.close(); });
    return controls;
  };
  const pairCancel = async () => { pairGeneration++; if (pairing) clearTimeout(pairing.timer); pairing = null; await sendList(); };

  async function sendBytes(channel: Channel, payload: Uint8Array) {
    const ws = socket;
    const deadline = Date.now() + 30000;
    while (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 1024 * 1024) { if (channel.stopped || Date.now() >= deadline) throw new Error("Remote send timed out"); await delay(10); }
    if (!ws || ws !== socket || ws.readyState !== WebSocket.OPEN || channel.stopped) throw new Error("Remote disconnected");
    ws.send(withChannel(channel.ch, payload));
  }

  function requestHandler(channel: Channel) {
    // Every producer holds at most one queued chunk. FIFO rotation interleaves ready responses.
    const queue: { header: TunnelHeader; body?: Uint8Array; resolve: () => void; reject: (error: Error) => void }[] = [];
    let draining = false;
    const emit = (header: TunnelHeader, body?: Uint8Array) => new Promise<void>((resolve, reject) => { queue.push({ header, body, resolve, reject }); void drain(); });
    async function drain() {
      if (draining) return; draining = true;
      try {
        while (queue.length) {
          const item = queue.shift()!;
          try { if (channel.stopped || !deviceActive(channel.deviceId!)) throw new Error("Device unavailable"); await channel.session!.write(item.header, item.body); item.resolve(); }
          catch { item.reject(new Error("Remote disconnected")); stopChannel(channel); }
        }
      } finally { draining = false; }
    }
    function finishRequest(id: number) {
      const request = channel.requests.get(id);
      if (request?.ended && request.responseEnded) channel.requests.delete(id);
    }
    return async (header: TunnelHeader, body: Uint8Array) => {
      if (!deviceActive(channel.deviceId!)) { stopChannel(channel); return; }
      const id = header.id;
      if (!Number.isSafeInteger(id) || (id as number) < 0 || body.length > CHUNK) throw new Error("Invalid remote request");
      const requestId = id as number;
      if (header.t === "cancel") { channel.requests.get(requestId)?.call.destroy(); channel.requests.delete(requestId); return; }
      if (header.t !== "req" && header.t !== "data" || typeof header.fin !== "boolean") throw new Error("Invalid remote request");
      let pending = channel.requests.get(requestId);
      if (header.t === "req") {
        if (pending || channel.seen.has(requestId) || channel.requests.size >= MAX_IN_FLIGHT || channel.seen.size >= 1_000_000) throw new Error("Remote request limit");
        if (header.method !== "GET" && header.method !== "POST" || typeof header.path !== "string" || header.path.length > 8192 || !header.path.startsWith("/") || header.path.startsWith("//") || /[\r\n\\#]/.test(header.path)) throw new Error("Invalid remote path or method");
        const origin = new URL(options.webUrl).origin, destination = new URL(header.path, origin);
        if (destination.origin !== origin) throw new Error("Invalid remote destination");
        const headers: Record<string, string> = { host: new URL(origin).host, authorization: `Bearer ${token}`, "x-pi-device": channel.deviceId! };
        if (header.headers && typeof header.headers === "object" && !Array.isArray(header.headers)) {
          for (const [name, value] of Object.entries(header.headers)) if (requestHeaders.has(name.toLowerCase()) && typeof value === "string" && value.length <= 8192 && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
        }
        const call = httpRequest(destination, { method: header.method, headers, timeout: 120000 });
        pending = { call, bytes: 0, ended: false, responseEnded: false };
        channel.requests.set(requestId, pending); channel.seen.add(requestId);
        call.on("timeout", () => call.destroy(new Error("Remote HTTP timeout")));
        call.on("error", () => { channel.requests.delete(requestId); void emit({ t: "err", id: requestId, error: "Host request failed" }).catch(() => {}); });
        call.on("response", response => {
          void (async () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) if (responseHeaders.has(name) && typeof value === "string") headers[name] = value;
            await emit({ t: "res", id: requestId, status: response.statusCode ?? 502, headers, fin: false });
            for await (const raw of response) {
              const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
              for (let at = 0; at < bytes.length; at += CHUNK) await emit({ t: "data", id: requestId, fin: false }, bytes.subarray(at, at + CHUNK));
            }
            await emit({ t: "data", id: requestId, fin: true });
            const request = channel.requests.get(requestId); if (request) request.responseEnded = true;
            finishRequest(requestId);
          })().catch(() => { call.destroy(); channel.requests.delete(requestId); void emit({ t: "err", id: requestId, error: "Host response interrupted" }).catch(() => {}); });
        });
      }
      if (!pending || pending.ended) throw new Error("Unknown or finished remote request");
      pending.bytes += body.length;
      if (pending.bytes > REQUEST_LIMIT) { pending.call.destroy(); channel.requests.delete(requestId); await emit({ t: "err", id: requestId, error: "Request exceeds 20 MiB" }); return; }
      if (body.length && !pending.call.write(body)) await once(pending.call, "drain");
      if (header.fin) { pending.ended = true; pending.call.end(); finishRequest(requestId); }
    };
  }

  async function channelData(channel: Channel, payload: Uint8Array) {
    if (channel.stopped) return;
    if (channel.session) { await channel.session.receive(payload); return; }
    if (!identity || payload.length > 8192) throw new Error("Invalid remote hello");
    const hello = JSON.parse(text(payload)) as Hello;
    const t1 = await readHello(identity.id, hello);
    if (hello.mode === "pair") {
      const pair = pairing;
      if (!channel.pair || !pair || pair.expiresAt <= Date.now() || pair.attempts >= 5) throw new Error("Pairing unavailable");
      const valid = await verifyPairMac(pair.code, t1, hello.mac!);
      if (pairing !== pair) throw new Error("Pairing replaced");
      if (!valid) { pair.attempts++; if (pair.attempts >= 5) await pairCancel(); throw new Error("Pairing refused"); }
      // Burn synchronously after verification, before any further await, to exclude concurrent redemption.
      clearTimeout(pair.timer); pairing = null;
      const existing = registry.devices.find(device => device.id === hello.deviceId);
      if ((!existing || existing.revokedAt) && registry.devices.filter(device => !device.revokedAt).length >= 256) throw new Error("Device limit reached");
      const device: Device = { id: hello.deviceId, name: hello.name!.trim() || "Device", pairedAt: Date.now(), lastSeenAt: Date.now() };
      if (existing) Object.assign(existing, device, { revokedAt: undefined, push: undefined }); else registry.devices.push(device);
      persist(); channel.deviceId = device.id;
    } else {
      if (channel.pair || channel.relayDevice !== hello.deviceId || !deviceActive(hello.deviceId)) throw new Error("Device unavailable");
      channel.deviceId = hello.deviceId;
      registry.devices.find(device => device.id === hello.deviceId)!.lastSeenAt = Date.now(); persist();
    }
    const { welcome, session } = await hostWelcome({ hostKey: identity.privateKey, hello, t1, send: payload => sendBytes(channel, payload), onMessage: requestHandler(channel), onClose: () => stopChannel(channel) });
    if (channel.stopped || !deviceActive(channel.deviceId!)) { session.close(); return; }
    channel.session = session; clearTimeout(channel.handshakeTimer);
    await sendBytes(channel, utf8(JSON.stringify(welcome)));
    if (hello.mode === "pair") await sendList();
  }

  function connect(current: number) {
    if (stopped || current !== generation || !config || !identity) return;
    connection = "connecting";
    const url = new URL("/ws", config.relay); url.protocol = "wss:";
    const ws = new WebSocket(url); socket = ws; ws.binaryType = "arraybuffer";
    let controlChain = Promise.resolve();
    const deadline = setTimeout(() => ws.close(), 10000);
    ws.onmessage = event => {
      if (ws !== socket || stopped) return;
      if (typeof event.data !== "string") {
        try {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          if (bytes.length > MAX_FRAME) throw new Error("Oversized remote frame");
          const { channel: id, payload } = splitChannel(bytes), channel = channels.get(id);
          if (!channel) return;
          if (channel.queuedBytes + payload.length > 4 * 1024 * 1024 || channel.queuedFrames >= 64) { stopChannel(channel); return; }
          channel.queuedBytes += payload.length; channel.queuedFrames++;
          channel.chain = channel.chain.then(() => channelData(channel, payload)).catch(() => stopChannel(channel)).finally(() => { channel.queuedBytes -= payload.length; channel.queuedFrames--; });
        } catch { ws.close(); }
        return;
      }
      controlChain = controlChain.then(async () => {
        if (event.data.length > 65536) throw new Error("Oversized relay control");
        const message = JSON.parse(event.data);
        if (message.t === "challenge") {
          if (!identity || typeof message.nonce !== "string" || fromB64u(message.nonce).length !== 32) throw new Error("Invalid relay challenge");
          ws.send(JSON.stringify({ t: "host", hostId: identity.id, sig: await sign(identity.privateKey, hostAuthText(message.nonce)) }));
        } else if (message.t === "ready") {
          clearTimeout(deadline); connection = "connected"; lastError = null; backoff = 1000; await sendList();
        } else if (message.t === "open") {
          if (!Number.isInteger(message.ch) || message.ch < 1 || message.ch > 0xffffffff || channels.has(message.ch) || channels.size >= 64 || typeof message.pair !== "boolean") throw new Error("Invalid relay channel");
          const channel: Channel = { ch: message.ch, relayDevice: message.deviceId, pair: message.pair, deviceId: null, handshakeTimer: setTimeout(() => stopChannel(channel), 10000), requests: new Map(), seen: new Set(), chain: Promise.resolve(), queuedBytes: 0, queuedFrames: 0, stopped: false };
          channels.set(channel.ch, channel);
        } else if (message.t === "closed") {
          const channel = channels.get(message.ch); if (channel) stopChannel(channel, false);
        } else if (message.t === "push-result") {
          const push = pendingPushes.get(message.id); if (!push) return;
          clearTimeout(push.timer); pendingPushes.delete(message.id);
          if (message.status === 404 || message.status === 410) {
            const device = registry.devices.find(device => device.id === push.deviceId);
            if (device?.push?.endpoint === push.endpoint) { delete device.push; persist(); }
          } else if (message.status < 200 || message.status >= 300) options.report("Push delivery failed");
        }
      }).catch(() => { fail("Relay protocol error"); ws.close(); });
    };
    ws.onerror = () => { if (ws === socket && !stopped) { connection = "error"; fail("Relay connection failed"); } };
    ws.onclose = () => {
      clearTimeout(deadline); if (ws !== socket) return;
      socket = null; clearChannels(); clearPushes();
      if (stopped || current !== generation) return;
      connection = "connecting";
      reconnect = setTimeout(() => connect(current), backoff + Math.random() * Math.min(backoff / 4, 1000));
      backoff = Math.min(backoff * 2, 60000);
    };
  }

  async function stop() {
    stopped = true; generation++; connection = "off"; clearTimeout(reconnect ?? undefined); reconnect = null;
    pairGeneration++; if (pairing) clearTimeout(pairing.timer); pairing = null;
    clearChannels(); clearPushes();
    const ws = socket; socket = null; ws?.close();
    power?.kill(); power = null;
  }
  return {
    token, deviceActive,
    reload() {
      const operation = reloadOperation.then(async () => {
        await stop(); config = remoteConfig();
        if (!config?.enabled) return;
        identity = await hostIdentity();
        registry = existsSync(join(directory(), "devices.json")) ? JSON.parse(readFileSync(join(directory(), "devices.json"), "utf8")) : { seq: 0, devices: [] };
        if (!Number.isSafeInteger(registry.seq) || registry.seq < 0 || !Array.isArray(registry.devices) || registry.devices.some(device => !isId(device.id))) throw new Error("Invalid remote device registry");
        stopped = false;
        if (process.platform === "darwin") { power = spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" }); power.on("error", () => fail("Remote sleep prevention unavailable")); }
        connect(generation);
      });
      reloadOperation = operation.catch(() => {}); return operation;
    },
    close: async () => { await reloadOperation; await stop(); },
    status() { return { enabled: !stopped, relay: config?.relay ?? null, hostId: identity?.id ?? null, hostName: config?.hostName ?? hostname(), connection, lastError, fingerprint: bootstrapFingerprint() }; },
    devices() { return registry.devices.map(({ push, ...device }) => ({ ...device, push: !!push, online: [...channels.values()].some(channel => channel.deviceId === device.id && !channel.stopped) })); },
    async pairStart() {
      if (stopped || !identity || !config || connection !== "connected") throw new Error("Connect this host to its relay before pairing");
      const current = ++pairGeneration;
      if (pairing) clearTimeout(pairing.timer); pairing = null;
      const code = newPairCode(), id = await pairId(code), expiresAt = Date.now() + PAIR_MS;
      if (current !== pairGeneration || stopped) throw new Error("Pairing replaced or cancelled");
      pairing = { code, id, expiresAt, attempts: 0, timer: setTimeout(() => { if (pairing?.id === id) void pairCancel(); }, PAIR_MS) };
      await sendList();
      const link = pairLink(config.relay, identity.id, code, config.hostName), qr = qrcode(0, "L"); qr.addData(link); qr.make();
      return { link, expiresAt, qrSvg: qr.createSvgTag({ scalable: true, margin: 4 }) };
    },
    pairCancel,
    async revoke(id: string, confirm: string) {
      if (confirm !== id) throw new Error("Explicit device confirmation required");
      const device = registry.devices.find(device => device.id === id); if (!device) throw new Error("Unknown device");
      device.revokedAt = Date.now(); delete device.push; persist();
      for (const channel of channels.values()) if (channel.deviceId === id || channel.relayDevice === id) stopChannel(channel);
      await sendList();
    },
    rename(id: string, name: string) {
      const device = registry.devices.find(device => device.id === id); if (!device) throw new Error("Unknown device");
      name = name.trim(); if (!name || name.length > 80) throw new Error("Device name must be 1–80 characters");
      device.name = name; persist();
    },
    setPush(id: string, subscription: unknown) {
      const device = registry.devices.find(device => device.id === id && !device.revokedAt);
      if (stopped || !device) throw new Error("Device unavailable");
      if (subscription === null) delete device.push; else device.push = pushSubscription(subscription);
      persist(); return { subscribed: !!device.push };
    },
    async summary() { return { hostName: config?.hostName ?? hostname(), needs: (await options.summary()).needs }; },
    notices(notices: Notice[]) {
      if (connection !== "connected" || !config || !identity) return;
      for (const notice of notices) for (const device of registry.devices) {
        if (device.revokedAt || !device.push || pendingPushes.size >= 256) continue;
        try {
          const body = encryptWebPush(device.push, { h: identity.id, hn: config.hostName, p: notice.projectId, pn: notice.project, k: notice.kind, s: notice.seq });
          const id = randomUUID(); pendingPushes.set(id, { deviceId: device.id, endpoint: device.push.endpoint, timer: setTimeout(() => pendingPushes.delete(id), 30000) });
          control({ t: "push", id, endpoint: device.push.endpoint, body: body.toString("base64url"), ttl: 86400, urgency: notice.kind === "question" || notice.kind === "approval" ? "high" : "normal" });
        } catch { options.report("Push encryption failed"); }
      }
    },
  };
}
export type RemoteAccess = ReturnType<typeof createRemote>;
