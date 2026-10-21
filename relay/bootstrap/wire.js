// Remote access wire protocol (REMOTE_SPEC.md), shared by the browser bootstrap and the host (src/remote.ts).
// WebCrypto only, so the same file runs in Safari, Chrome and Node.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder(), decoder = new TextDecoder();

/** Largest body chunk in one tunnel message; a sealed record stays well under the relay's 1 MiB frame limit. */
export const CHUNK = 256 * 1024;
export const MAX_FRAME = 1024 * 1024;
export const MAX_IN_FLIGHT = 32;
export const PAIR_MS = 10 * 60_000;

export const utf8 = text => encoder.encode(text);
export const text = bytes => decoder.decode(bytes);

export function b64u(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64u(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export const random = length => globalThis.crypto.getRandomValues(new Uint8Array(length));
export const sha256 = async data => new Uint8Array(await subtle.digest("SHA-256", typeof data === "string" ? utf8(data) : data));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };

// Ed25519 identities: a host or device ID is its base64url raw public key.

/** Device keys stay non-extractable (IndexedDB stores the CryptoKey); hosts pass true to persist theirs as JWK. */
export const generateSigningKey = extractable => subtle.generateKey({ name: "Ed25519" }, extractable, ["sign", "verify"]);
export const keyId = async publicKey => b64u(await subtle.exportKey("raw", publicKey));
export const importSigningKey = jwk => subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
export const sign = async (privateKey, message) => b64u(await subtle.sign({ name: "Ed25519" }, privateKey, utf8(message)));
/** False for any malformed ID or signature, never a throw: callers treat every failure the same. */
export async function verify(id, message, signature) {
  try {
    const raw = fromB64u(id), sig = fromB64u(signature);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = await subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, sig, utf8(message));
  } catch { return false; }
}
export const isId = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

// Relay authentication texts (signed by host or device; the relay verifies).

export const hostAuthText = nonce => `pi-relay-host-v1\n${nonce}`;
export const clientAuthText = (hostId, nonce) => `pi-relay-client-v1\n${hostId}\n${nonce}`;
export const devicesText = list => `pi-relay-devices-v1\n${list}`;

/** Pairing: the code stays on host and device; the relay only sees pairId. */
export const newPairCode = () => b64u(random(16));
export const pairId = async code => b64u((await sha256(`pi-pair-id\n${code}`)).slice(0, 16));
export function pairLink(relayOrigin, hostId, code, hostName) {
  return `${relayOrigin}/#pair=${b64u(utf8(JSON.stringify({ h: hostId, c: code, n: hostName })))}`;
}
export function parsePairFragment(hash) {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("pair");
  if (!value) return null;
  const data = JSON.parse(text(fromB64u(value)));
  if (!isId(data.h) || typeof data.c !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(data.c) || typeof data.n !== "string") throw new Error("Invalid pairing link");
  return { hostId: data.h, code: data.c, hostName: data.n.slice(0, 80) };
}

// Channel framing between relay and host: [channel u32 BE][payload].

export function withChannel(channel, payload) {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, channel);
  out.set(payload, 4);
  return out;
}
export function splitChannel(frame) {
  const bytes = new Uint8Array(frame);
  if (bytes.length < 4) throw new Error("Short channel frame");
  return { channel: new DataView(bytes.buffer, bytes.byteOffset).getUint32(0), payload: bytes.subarray(4) };
}

// Tunnel messages: [u32 BE header length][header JSON][body].

export function encodeMessage(header, body = new Uint8Array(0)) {
  const head = utf8(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4); out.set(body, 4 + head.length);
  return out;
}
export function decodeMessage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  if (4 + length > bytes.length) throw new Error("Truncated tunnel message");
  const header = JSON.parse(text(bytes.subarray(4, 4 + length)));
  if (!header || typeof header.t !== "string") throw new Error("Invalid tunnel message");
  return { header, body: bytes.subarray(4 + length) };
}

// End-to-end handshake.

const helloText = (hostId, h) => `pi-remote-hello-v1\n${hostId}\n${h.mode}\n${h.deviceId}\n${h.e}\n${h.n}\n${h.name ?? ""}`;
const welcomeText = async (t1, w) => `pi-remote-welcome-v1\n${b64u(await sha256(t1))}\n${w.e}\n${w.n}`;
const ephemeral = () => subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
const rawPublic = async key => b64u(await subtle.exportKey("raw", key));
async function hmac(code, message) {
  const key = await subtle.importKey("raw", utf8(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", key, utf8(message)));
}
function sameBytes(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }

/** Client: build the hello. `code` and `name` only in pair mode. Keep the returned state for clientFinish. */
export async function clientHello({ hostId, mode, deviceKey, deviceId, name, code }) {
  if (mode !== "device" && mode !== "pair") throw new Error("Invalid handshake mode");
  const pair = ephemeral(), keys = await pair;
  const hello = { v: 1, mode, deviceId, e: await rawPublic(keys.publicKey), n: b64u(random(32)), ...(mode === "pair" ? { name: String(name ?? "").slice(0, 80) } : {}) };
  const t1 = helloText(hostId, hello);
  hello.sig = await sign(deviceKey, t1);
  if (mode === "pair") hello.mac = b64u(await hmac(code, t1));
  return { hello, state: { hostId, t1, ephemeral: keys.privateKey } };
}

/**
 * Host: check a hello's shape and device signature. Returns the transcript; whether the device is active,
 * or the pairing code is valid (verifyPairMac), is the host's decision.
 */
export async function readHello(hostId, hello) {
  if (!hello || hello.v !== 1 || (hello.mode !== "device" && hello.mode !== "pair")) throw new Error("Invalid hello");
  if (!isId(hello.deviceId) || !isId(hello.e) || typeof hello.n !== "string" || fromB64u(hello.n).length !== 32) throw new Error("Invalid hello");
  if (hello.mode === "pair" && (typeof hello.name !== "string" || hello.name.length > 80 || typeof hello.mac !== "string")) throw new Error("Invalid hello");
  if (hello.mode === "device" && ("name" in hello || "mac" in hello)) throw new Error("Invalid hello");
  const t1 = helloText(hostId, hello);
  if (!(await verify(hello.deviceId, t1, hello.sig))) throw new Error("Invalid hello");
  return t1;
}
export async function verifyPairMac(code, t1, mac) {
  try { return sameBytes(await hmac(code, t1), fromB64u(mac)); } catch { return false; }
}

async function sessionKeys(privateKey, peerPublic, t1, t2, outbound, inbound) {
  const peer = await subtle.importKey("raw", fromB64u(peerPublic), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = await sha256(`${t1}\n${t2}`);
  const derive = info => subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { seal: await derive(`pi-remote ${outbound} v1`), open: await derive(`pi-remote ${inbound} v1`), sealLabel: outbound === "c2h" ? "c2h" : "h2c", openLabel: inbound === "c2h" ? "c2h" : "h2c" };
}

/** Host: answer a hello already accepted by readHello (and, for pair mode, verifyPairMac). */
export async function hostWelcome({ hostKey, hello, t1, send, onMessage, onClose }) {
  const keys = await ephemeral();
  const welcome = { v: 1, e: await rawPublic(keys.publicKey), n: b64u(random(32)) };
  const t2 = await welcomeText(t1, welcome);
  welcome.sig = await sign(hostKey, t2);
  const session = new Session(await sessionKeys(keys.privateKey, hello.e, t1, t2, "h2c", "c2h"), send, onMessage, onClose);
  return { welcome, session };
}

/** Client: verify the host's welcome against the pinned hostId and open the session. */
export async function clientFinish(state, welcome, { send, onMessage, onClose }) {
  if (!welcome || welcome.v !== 1 || !isId(welcome.e) || typeof welcome.n !== "string" || fromB64u(welcome.n).length !== 32) throw new Error("Invalid welcome");
  const t2 = await welcomeText(state.t1, welcome);
  if (!(await verify(state.hostId, t2, welcome.sig))) throw new Error("Host key mismatch: this is not the paired host");
  return new Session(await sessionKeys(state.ephemeral, welcome.e, state.t1, t2, "c2h", "h2c"), send, onMessage, onClose);
}

const iv = counter => { const out = new Uint8Array(12); new DataView(out.buffer).setBigUint64(4, counter); return out; };
const MAX_COUNTER = 2n ** 64n - 1n;

/**
 * Ordered AES-256-GCM records: [8-byte counter BE][ciphertext+tag], IV = 4 zero bytes + counter.
 * Sealing and opening each run through one promise chain, so records leave and arrive in counter order
 * even though WebCrypto may settle out of order. Any bad record closes the session for good.
 */
export class Session {
  #keys; #send; #onMessage; #onClose; #out = 0n; #in = 0n; #sending = Promise.resolve(); #receiving = Promise.resolve(); #closed = false;
  constructor(keys, send, onMessage, onClose) { this.#keys = keys; this.#send = send; this.#onMessage = onMessage; this.#onClose = onClose; }
  get closed() { return this.#closed; }
  /** Seal and hand to `send` in call order. Resolves after `send` returns (await it for back-pressure). */
  write(header, body) {
    const message = encodeMessage(header, body);
    const run = this.#sending.then(async () => {
      if (this.#closed) throw new Error("Session closed");
      if (this.#out === MAX_COUNTER) { this.close("Counter exhausted"); throw new Error("Session closed"); }
      const counter = this.#out++;
      const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv(counter), additionalData: utf8(this.#keys.sealLabel) }, this.#keys.seal, message));
      const record = new Uint8Array(8 + sealed.length);
      new DataView(record.buffer).setBigUint64(0, counter); record.set(sealed, 8);
      await this.#send(record);
    });
    this.#sending = run.catch(() => {});
    return run;
  }
  /** Feed one received record. Messages reach onMessage in order; a bad record closes the session. */
  receive(record) {
    const bytes = new Uint8Array(record);
    this.#receiving = this.#receiving.then(async () => {
      if (this.#closed) return;
      try {
        if (bytes.length < 8 + 16) throw new Error("Short record");
        const counter = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0);
        if (counter !== this.#in) throw new Error("Out-of-order record");
        const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: iv(counter), additionalData: utf8(this.#keys.openLabel) }, this.#keys.open, bytes.subarray(8)));
        this.#in++;
        const { header, body } = decodeMessage(plain);
        await this.#onMessage(header, body);
      } catch (error) { this.close(error instanceof Error ? error.message : String(error)); }
    });
    return this.#receiving;
  }
  close(reason = "closed") {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose?.(reason);
  }
}
