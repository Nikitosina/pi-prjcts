// Offline read cache of the remote hosts (REMOTE_SPEC.md, Multi-host inbox, decision 13). It keeps the answers of read actions the page
// already loaded, in IndexedDB of the local origin, one set per host ID. The local host is never cached: it serves this page itself.
// The database opens on the first remote read, so a page without remote hosts never touches it.

export const limits = { hostBytes: 16 * 1024 * 1024 };

// A wiped host saves nothing again in this page: an answer that was still in flight must not refill it. A new page starts open.
const wiped = new Set();
let db = null;
function open() {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("pi-host-cache", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("meta", { keyPath: "id" }).createIndex("host", "hostId");
      request.result.createObjectStore("data");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.catch(() => (db = null));
  return db;
}
async function transact(work) {
  const tx = (await open()).transaction(["meta", "data"], "readwrite");
  return new Promise((resolve, reject) => {
    const result = work(tx.objectStore("meta"), tx.objectStore("data"));
    tx.oncomplete = () => resolve(result.value);
    tx.onabort = () => reject(tx.error ?? Error("Host cache transaction aborted"));
  });
}
const request = (req) =>
  new Promise((resolve, reject) => ((req.onsuccess = () => resolve(req.result)), (req.onerror = () => reject(req.error))));

const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );

/** The cache of one host. Reads of another host's entries are impossible: every id starts with this host ID and every record is checked against it. */
export function hostCache(hostId) {
  const id = (action, input) => `${hostId}\0${action}\0${stable(input ?? {})}`;
  const closed = () => wiped.has(hostId);
  return {
    /** `{ data, savedAt }`, or null when this read was never saved (or the cache is unavailable). */
    async get(action, input) {
      if (closed()) return null;
      try {
        const key = id(action, input);
        const tx = (await open()).transaction(["meta", "data"]);
        const [meta, data] = await Promise.all([request(tx.objectStore("meta").get(key)), request(tx.objectStore("data").get(key))]);
        return meta?.hostId === hostId && data !== undefined ? { data, savedAt: meta.savedAt } : null;
      } catch (error) {
        console.warn("Host cache unavailable", error);
        return null;
      }
    },
    /** Saves one answer, then removes this host's oldest saved reads until the host is within its limit. An answer over the limit is not saved. */
    async put(action, input, data) {
      if (closed()) return;
      try {
        const bytes = stable(data).length;
        if (bytes > limits.hostBytes) return;
        const key = id(action, input);
        await transact((metas, datas) => {
          if (closed()) return {};
          metas.put({ id: key, hostId, savedAt: Date.now(), bytes });
          datas.put(data, key);
          const all = metas.index("host").getAll(hostId);
          all.onsuccess = () => {
            let total = all.result.reduce((sum, item) => sum + item.bytes, 0);
            for (const old of all.result.sort((a, b) => a.savedAt - b.savedAt)) {
              if (total <= limits.hostBytes) break;
              if (old.id === key) continue;
              total -= old.bytes;
              metas.delete(old.id);
              datas.delete(old.id);
            }
          };
          return {};
        });
      } catch (error) {
        console.warn("Host cache not saved", error);
      }
    },
  };
}

/** Deletes every entry of one host (Forget host, revocation) and stops this page saving for it. Only touches the database when it already exists, so a page that never cached stays untouched. */
export async function wipeHost(hostId) {
  wiped.add(hostId);
  try {
    if (!db && !(await indexedDB.databases?.())?.some((item) => item.name === "pi-host-cache")) return;
    await transact((metas, datas) => {
      const keys = metas.index("host").getAllKeys(hostId);
      keys.onsuccess = () => {
        for (const key of keys.result) {
          metas.delete(key);
          datas.delete(key);
        }
      };
      return {};
    });
  } catch (error) {
    console.warn("Host cache not wiped", error);
  }
}
