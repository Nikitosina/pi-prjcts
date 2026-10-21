// Injected into a host's inbox page (and the first-load loader). Owns the page's tunnel and answers the service worker's
// forwarded requests through it. The inbox UI itself runs unchanged.

// The inbox refuses to call its API without a token; through the tunnel the host side supplies the real authorization.
localStorage.setItem(`pi-projects-token:${location.origin}`, "remote");

import { openTunnel } from "./tunnel.js";
import { hosts } from "./store.js";

const hostId = location.pathname.split("/")[2];
const loader = document.documentElement.dataset.loader === "1";
let tunnel = null, connecting = null, retry = 1000;

async function ensure() {
  if (tunnel && !tunnel.closed) return tunnel;
  connecting ??= openTunnel({ hostId }).then(opened => {
    tunnel = opened; retry = 1000; banner(null);
    opened.onClose = error => { if (tunnel === opened) tunnel = null; if (!document.hidden) banner(`${error.message} Reconnecting…`); };
    return opened;
  }, error => { banner(`${error.message} Retrying…`); throw error; }).finally(() => { connecting = null; });
  return connecting;
}

async function serve({ method, path, headers, body }, port) {
  const abort = new AbortController();
  port.onmessage = ({ data }) => { if (data?.t === "cancel") abort.abort(); };
  try {
    const response = await (await ensure()).request({ method, path, headers, body, signal: abort.signal });
    port.postMessage({ t: "head", status: response.status, headers: Object.fromEntries(response.headers) });
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const copy = value.slice();
        port.postMessage({ t: "chunk", bytes: copy.buffer }, [copy.buffer]);
      }
      port.postMessage({ t: "end" });
    }
  } catch (error) {
    if (error?.name !== "AbortError") port.postMessage({ t: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

navigator.serviceWorker.onmessage = event => {
  if (event.data?.t === "fetch" && event.ports[0]) void serve(event.data, event.ports[0]);
  else if (event.data?.t === "ui-updated") banner("This host's inbox was updated.", { label: "Reload", run: () => location.reload() });
};

/** One fixed line above the inbox for connection trouble and updates; null hides it. */
function banner(message, action = null) {
  let node = document.querySelector("#pi-remote-banner");
  if (!message) { node?.remove(); return; }
  if (!node) {
    node = document.createElement("div"); node.id = "pi-remote-banner"; node.setAttribute("role", "status");
    node.className = "pi-remote-banner";
    document.body.append(node);
  }
  node.replaceChildren(Object.assign(document.createElement("span"), { textContent: message }));
  if (action) node.append(Object.assign(document.createElement("button"), { type: "button", textContent: action.label, onclick: action.run }));
  node.append(Object.assign(document.createElement("a"), { href: "/", textContent: "Hosts" }));
}

// Reconnect when the app comes back: iOS closes sockets of backgrounded web apps.
const wake = () => { if (!document.hidden && (!tunnel || tunnel.closed)) void ensure().catch(() => setTimeout(wake, retry = Math.min(retry * 2, 30_000))); };
document.addEventListener("visibilitychange", wake);
addEventListener("online", wake);

// The inbox labels itself with the host (web/app.js reads this).
const known = (await hosts()).find(host => host.hostId === hostId);
if (!known) location.replace("/");
document.documentElement.dataset.remoteHost = known?.name ?? "";
document.dispatchEvent(new Event("pi-remote-host"));

if (loader) {
  const status = document.querySelector("#status");
  try {
    for (const path of ["/", "/theme.js", "/styles.css", "/app.js"]) {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`The host answered ${response.status} for ${path}.`);
      await response.arrayBuffer();
    }
    location.reload();
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
} else wake();
