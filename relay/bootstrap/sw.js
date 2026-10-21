// Bootstrap service worker (REMOTE_SPEC.md "Browser client"). It holds no socket and no key:
// requests from a host's inbox page go back to that same page, whose tunnel carries them to the host.

const VERSION = "2";
const BOOT = `boot-${VERSION}`;
/** Every bootstrap file as served; the fingerprint covers exactly this list (relay/relay.ts `fingerprint`). */
const FILES = ["/", "/sw.js", "/manifest.webmanifest", "/boot/host-page.js", "/boot/host.html", "/boot/icon-180.png", "/boot/icon-512.png", "/boot/store.js", "/boot/styles.css", "/boot/switcher.js", "/boot/tunnel.js", "/boot/wire.js"];
const HOST_PAGE = /^\/h\/([A-Za-z0-9_-]{43})\/$/;
const PASS_HEADERS = ["content-type", "x-filename", "accept"];
const HEAD_MS = 125_000;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(BOOT).then(cache => cache.addAll(FILES.map(path => new Request(path, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("boot-") && name !== BOOT) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname === "/ws" || url.pathname === "/vapid") return;
  // A host page's own fetch of "/" is its inbox HTML, not the switcher.
  if (FILES.includes(url.pathname) && !(url.pathname === "/" && event.request.mode !== "navigate")) { event.respondWith(boot(url.pathname)); return; }
  event.respondWith(event.request.mode === "navigate" ? navigate(event, url) : forward(event, url));
});

async function boot(path) {
  return (await (await caches.open(BOOT)).match(path)) ?? fetch(path);
}

const hostOf = client => client ? HOST_PAGE.exec(new URL(client.url).pathname)?.[1] ?? null : null;
const cacheKey = path => new Request(new URL(path, location.origin));

/** A host page from cache (with the tunnel script injected), or the loader that fills the cache first. */
async function navigate(event, url) {
  const hostId = HOST_PAGE.exec(url.pathname)?.[1];
  if (!hostId) return openedElsewhere(event, url);
  const cache = await caches.open(`host-${hostId}`);
  const index = await cache.match(cacheKey("/"));
  if (!index) return boot("/boot/host.html");
  event.waitUntil(revalidate(event.resultingClientId, hostId));
  return new Response(inject(await index.text()), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": hostPolicy(), "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" } });
}

function inject(html) {
  const tags = `<link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="apple-touch-icon" href="/boot/icon-180.png"><script type="module" src="/boot/host-page.js"></script>`;
  return /<head>/i.test(html) ? html.replace(/<head>/i, `<head>${tags}`) : `${tags}${html}`;
}
function hostPolicy() {
  return `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' wss://${location.host}; img-src 'self' blob: data:; media-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}

/** A link from an inbox opened in a new window (an artifact, say): carry it through the most recent page of a host. */
async function openedElsewhere(event, url) {
  const pages = (await self.clients.matchAll({ type: "window" })).filter(hostOf);
  const page = pages.find(client => client.focused) ?? pages[0];
  if (!page) return new Response("Open this host from the Pi Projects app first.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return request(page, { method: "GET", path: url.pathname + url.search, headers: {} });
}

/**
 * Requests from a host page. Cached static assets answer at once and revalidate in the background,
 * because the page's tunnel only starts after a render-blocking script such as /theme.js has loaded.
 */
async function forward(event, url) {
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  const hostId = hostOf(client);
  if (!hostId) return fetch(event.request);
  const path = url.pathname + url.search, method = event.request.method;
  const cache = await caches.open(`host-${hostId}`);
  if (method === "GET") {
    const cached = await cache.match(cacheKey(path));
    if (cached) return cached;
  }
  const headers = {};
  for (const name of PASS_HEADERS) { const value = event.request.headers.get(name); if (value) headers[name] = value; }
  const body = method === "GET" || method === "HEAD" ? null : await event.request.arrayBuffer();
  const response = await request(client, { method, path, headers, body });
  if (method === "GET" && response.status === 200 && response.headers.get("etag")) event.waitUntil(cache.put(cacheKey(path), response.clone()));
  return response;
}

/** Check the cached host UI against the host through the new page; tell the page when it changed. */
async function revalidate(clientId, hostId) {
  let client = null;
  for (let attempt = 0; attempt < 40 && !client; attempt++) { client = await self.clients.get(clientId); if (!client) await new Promise(resolve => setTimeout(resolve, 250)); }
  if (!client) return;
  const cache = await caches.open(`host-${hostId}`);
  let changed = false;
  for (const key of await cache.keys()) {
    const cached = await cache.match(key), etag = cached?.headers.get("etag");
    if (!etag) continue;
    const path = new URL(key.url).pathname + new URL(key.url).search;
    try {
      const response = await request(client, { method: "GET", path, headers: { "if-none-match": etag } });
      if (response.status === 200 && response.headers.get("etag") && response.headers.get("etag") !== etag) { await cache.put(key, response); changed = true; }
      else if (response.status === 404) { await cache.delete(key); changed = true; }
      else await response.body?.cancel();
    } catch { return; }
  }
  if (changed) client.postMessage({ t: "ui-updated" });
}

/** Ask a host page to run one request through its tunnel; stream the answer back. */
function request(client, { method, path, headers, body = null }) {
  const channel = new MessageChannel(), port = channel.port1;
  return new Promise(resolve => {
    let controller = null, answered = false;
    const timer = setTimeout(() => { if (!answered) { answered = true; port.close(); resolve(new Response("The host did not answer.", { status: 504 })); } }, HEAD_MS);
    port.onmessage = ({ data }) => {
      if (data.t === "head") {
        answered = true; clearTimeout(timer);
        const empty = [101, 103, 204, 205, 304].includes(data.status) || method === "HEAD";
        const stream = empty ? null : new ReadableStream({ start: c => { controller = c; }, cancel: () => { port.postMessage({ t: "cancel" }); port.close(); } });
        resolve(new Response(stream, { status: data.status, headers: data.headers }));
        if (empty) port.close();
      } else if (data.t === "chunk") controller?.enqueue(new Uint8Array(data.bytes));
      else if (data.t === "end") { try { controller?.close(); } catch {} port.close(); }
      else if (data.t === "error") {
        if (!answered) { answered = true; clearTimeout(timer); resolve(new Response(JSON.stringify({ ok: false, error: data.message }), { status: 502, headers: { "content-type": "application/json" } })); }
        else try { controller?.error(new Error(data.message)); } catch {}
        port.close();
      }
    };
    client.postMessage({ t: "fetch", method, path, headers, body }, [channel.port2, ...(body ? [body] : [])]);
  });
}

const KINDS = { question: "Question", approval: "Approval needed", result: "Finished", error: "Error", pr: "Pull request" };
const isHost = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const isProject = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}
  const title = typeof data.pn === "string" && data.pn ? data.pn.slice(0, 80) : "Pi Projects";
  const body = `${KINDS[data.k] ?? "Update"} · ${typeof data.hn === "string" ? data.hn.slice(0, 80) : "host"}`;
  event.waitUntil(self.registration.showNotification(title, { body, tag: `${data.h}:${data.s}`, icon: "/boot/icon-180.png", data: { hostId: isHost(data.h) ? data.h : null, projectId: isProject(data.p) ? data.p : null } }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const { hostId, projectId } = event.notification.data ?? {};
  const target = hostId ? `/h/${hostId}/${projectId ? `?project=${projectId}` : ""}` : "/";
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: "window" });
    const page = hostId ? pages.find(client => hostOf(client) === hostId) : pages[0];
    if (page) { await page.focus(); if (projectId) await page.navigate(target).catch(() => {}); }
    else await self.clients.openWindow(target);
  })());
});
