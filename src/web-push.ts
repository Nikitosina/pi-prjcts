import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushNotice = { h: string; hn: string; p: string; pn: string; k: string; s: number };
const decode = (value: unknown, length: number) => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error("Invalid push key"); const bytes = Buffer.from(value, "base64url"); if (bytes.length !== length) throw new Error("Invalid push key"); return bytes; };
const extract = (salt: Buffer, data: Buffer) => createHmac("sha256", salt).update(data).digest();
const expand = (key: Buffer, info: Buffer, size: number) => createHmac("sha256", key).update(info).update(Buffer.from([1])).digest().subarray(0, size);

/** Validate the push destination and key material before storing it. */
export function pushSubscription(value: unknown): PushSubscription {
  const input = value as PushSubscription;
  if (!input || typeof input.endpoint !== "string" || input.endpoint.length > 2048) throw new Error("Invalid push subscription");
  const url = new URL(input.endpoint);
  // Browser-selected push services only; never let a device turn the host into an arbitrary HTTP client.
  const allowed = url.hostname === "web.push.apple.com" || url.hostname.endsWith(".push.apple.com") || url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com";
  if (url.protocol !== "https:" || url.port || url.username || url.password || !allowed) throw new Error("Unsupported push service");
  decode(input.keys?.p256dh, 65); decode(input.keys?.auth, 16);
  return { endpoint: url.href, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}

/** RFC 8291 single-record aes128gcm encoding, with ephemeral ECDH per message. */
export function encryptWebPush(subscription: PushSubscription, notice: PushNotice): Buffer {
  const payload = Buffer.from(JSON.stringify(notice));
  const ua = decode(subscription.keys.p256dh, 65), auth = decode(subscription.keys.auth, 16);
  const dh = createECDH("prime256v1"), as = dh.generateKeys();
  const ikm = expand(extract(auth, dh.computeSecret(ua)), Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32);
  const salt = randomBytes(16), prk = extract(salt, ikm);
  const key = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16), nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const plain = Buffer.concat([payload, Buffer.from([2])]);
  if (plain.length + 16 > 4096) throw new Error("Push payload too large");
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const size = Buffer.alloc(4); size.writeUInt32BE(4096);
  return Buffer.concat([salt, size, Buffer.from([as.length]), as, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

