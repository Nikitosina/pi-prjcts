// Offline read cache of the remote hosts (REMOTE_SPEC.md, Multi-host inbox, decision 13). It keeps the answers of read actions the page
// already loaded, in IndexedDB of the local origin, one set per host ID. The local host is never cached: it serves this page itself.
// The database opens on the first remote read, so a page with no remote hosts never touches it.
//
// A wipe leaves a tombstone (`wiped`: host ID → time). A save only lands when its read started after the tombstone and an entry only
// reads back when it was saved after it, so another tab's late save, or an entry a failed deletion left behind, never shows again.

export const limits = { hostBytes: 16 * 1024 * 1024 };

let last = 0;
/** One increasing number for every read, save and wipe: the clock alone ties within a millisecond and an older answer could then replace a newer one. */
export const stamp = () => (last = Math.max(Date.now(), last + 1));

const encoder = new TextEncoder();
const bytesOf = (text) => encoder.encode(text).length;

let db = null;
function open() {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("pi-host-cache", 2);
    request.onupgradeneeded = () => {
      const base = request.result;
      if (!base.objectStoreNames.contains("meta")) base.createObjectStore("meta", { keyPath: "id" }).createIndex("host", "hostId");
      if (!base.objectStoreNames.contains("data")) base.createObjectStore("data");
      if (!base.objectStoreNames.contains("wiped")) base.createObjectStore("wiped");
    };
    request.onsuccess = () => {
      // Another tab or a deletion of the database must not be blocked by this connection; the next use opens it again.
      request.result.onversionchange = () => {
        request.result.close();
        db = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  db.catch(() => (db = null));
  return db;
}
const STORES = ["meta", "data", "wiped"];
async function transact(mode, work) {
  const tx = (await open()).transaction(STORES, mode);
  return new Promise((resolve, reject) => {
    let value;
    work(tx.objectStore("meta"), tx.objectStore("data"), tx.objectStore("wiped"), (result) => (value = result));
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error ?? Error("Host cache transaction aborted"));
  });
}
const wait = (req, then) => ((req.onsuccess = () => then(req.result)), req);

const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );

/** The cache of one host. Reads of another host's entries are impossible: every id starts with this host ID and every record is checked against it. */
export function hostCache(hostId) {
  const id = (action, input) => `${hostId}\0${action}\0${stable(input ?? {})}`;
  return {
    /** `{ data, savedAt }`, or null when this read was never saved, was wiped, or the cache is unavailable. */
    async get(action, input) {
      try {
        const key = id(action, input);
        return await transact("readonly", (metas, datas, tombs, done) => {
          wait(metas.get(key), (meta) =>
            wait(datas.get(key), (data) =>
              wait(tombs.get(hostId), (wipedAt) => {
                done(
                  meta?.hostId === hostId && data !== undefined && meta.savedAt > (wipedAt ?? 0) ? { data, savedAt: meta.savedAt } : null,
                );
              }),
            ),
          );
        });
      } catch (error) {
        console.warn("Host cache unavailable", error);
        return null;
      }
    },
    /** Saves one answer of a read that began at `startedAt`, then removes this host's oldest saved reads until its stored bytes fit the limit.
     * An answer over the limit, or one whose read began before a wipe, is not saved. */
    async put(action, input, data, startedAt) {
      try {
        const key = id(action, input),
          text = stable(data),
          bytes = bytesOf(text) + 2 * bytesOf(key);
        if (bytes > limits.hostBytes) return;
        await transact("readwrite", (metas, datas, tombs) => {
          wait(tombs.get(hostId), (wipedAt) => {
            if ((wipedAt ?? 0) >= startedAt) return;
            wait(metas.get(key), (existing) => {
              // The newest read wins: a slower, older answer of the same read never replaces one that began after it.
              if (existing && existing.readAt > startedAt) return;
              metas.put({ id: key, hostId, savedAt: stamp(), readAt: startedAt, bytes });
              datas.put(data, key);
              wait(metas.index("host").getAll(hostId), (all) => {
                let total = all.reduce((sum, item) => sum + item.bytes, 0);
                for (const old of all.sort((a, b) => a.savedAt - b.savedAt)) {
                  if (total <= limits.hostBytes) break;
                  if (old.id === key) continue;
                  total -= old.bytes;
                  metas.delete(old.id);
                  datas.delete(old.id);
                }
              });
            });
          });
        });
      } catch (error) {
        console.warn("Host cache not saved", error);
      }
    },
  };
}

/** Deletes every entry of one host (Forget host, revocation). The tombstone is written first and on its own, even when the database did
 * not exist yet, so another tab's first save cannot escape it; a failed deletion still leaves the entries unreadable and is thrown to the caller.
 * Only called for a remote host, so a page with no remote hosts never opens the database. */
export async function wipeHost(hostId) {
  await transact("readwrite", (_metas, _datas, tombs) => tombs.put(stamp(), hostId));
  await transact("readwrite", (metas, datas) => {
    wait(metas.index("host").getAllKeys(hostId), (keys) => {
      for (const key of keys) {
        metas.delete(key);
        datas.delete(key);
      }
    });
  });
}
