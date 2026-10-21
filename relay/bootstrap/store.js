// IndexedDB for this device's identity and paired hosts. The device key is a non-extractable CryptoKey:
// the page can sign with it, but no script can read the private key out.

import { generateSigningKey, keyId } from "./wire.js";

let db = null;
function open() {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("pi-remote", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}
async function run(mode, work) {
  const store = (await open()).transaction("kv", mode).objectStore("kv");
  return new Promise((resolve, reject) => { const request = work(store); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export const get = key => run("readonly", store => store.get(key));
export const put = (key, value) => run("readwrite", store => store.put(value, key));

/** One key per device for every host. Two tabs racing on first use keep whichever was stored first. */
export async function device() {
  const existing = await get("device");
  if (existing) return existing;
  const pair = await generateSigningKey(false);
  const fresh = { privateKey: pair.privateKey, id: await keyId(pair.publicKey) };
  const stored = await run("readwrite", store => store.add(fresh, "device")).then(() => fresh, () => null);
  return stored ?? await get("device");
}

/** Paired hosts: `{hostId, name, pairedAt}`, in pairing order. */
export const hosts = async () => (await get("hosts")) ?? [];
export async function saveHost(host) {
  const list = (await hosts()).filter(item => item.hostId !== host.hostId);
  await put("hosts", [...list, host]);
}
export async function forgetHost(hostId) {
  await put("hosts", (await hosts()).filter(item => item.hostId !== hostId));
  await caches.delete(`host-${hostId}`);
}
