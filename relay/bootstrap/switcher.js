// Host switcher (REMOTE_SPEC.md "Host switcher"): paired hosts with their state, pairing from a host's QR link,
// notifications, and the bootstrap fingerprint.

import { b64u, parsePairFragment, utf8 } from "./wire.js";
import { openTunnel } from "./tunnel.js";
import { forgetHost, get, hosts, put, saveHost } from "./store.js";

const $ = selector => document.querySelector(selector);
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
const states = new Map();
const registration = navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "all" });

/** One short session: run `work` with a tunnel to `hostId`, always closing it. */
async function withHost(hostId, work, pair = null) {
  const tunnel = await openTunnel({ hostId, pair });
  try { return await work(tunnel); } finally { tunnel.close(); }
}
async function call(tunnel, method, path, body) {
  const response = await tunnel.request({ method, path, headers: body ? { "content-type": "application/json" } : {}, body: body ? utf8(JSON.stringify(body)) : null });
  const reply = await response.json().catch(() => null);
  if (!response.ok || reply?.ok === false) throw new Error(reply?.error ?? `Host answered ${response.status}`);
  return reply?.data ?? reply;
}

// Hosts

async function renderHosts() {
  const list = await hosts(), root = $("#hosts");
  if (!list.length) { root.replaceChildren(el("p", { className: "card quiet" }, "No hosts yet. On a host, open Settings → Remote access → Pair a device, then scan its QR code with this device's camera.")); return; }
  const card = el("div", { className: "card" });
  for (const host of list) {
    const state = states.get(host.hostId) ?? { state: "checking", text: "Checking…" };
    const forget = el("button", { type: "button", textContent: "Forget" });
    forget.onclick = async () => {
      if (!confirm(`Forget ${host.name} on this device? The host keeps it in its device list until you revoke it there.`)) return;
      await forgetHost(host.hostId); states.delete(host.hostId); await renderHosts();
    };
    card.append(el("div", { className: "host" },
      el("div", { className: "name", textContent: host.name }),
      el("div", { className: "state", textContent: state.text }, ),
      el("div", { className: "actions" }, el("a", { className: "button primary", href: `/h/${host.hostId}/`, textContent: "Open" }), forget)));
    card.lastChild.querySelector(".state").dataset.state = state.state;
  }
  root.replaceChildren(card);
}

async function check(host) {
  try {
    const summary = await withHost(host.hostId, tunnel => call(tunnel, "GET", "/remote/summary"));
    if (typeof summary?.hostName === "string" && summary.hostName && summary.hostName !== host.name) await saveHost({ ...host, name: summary.hostName.slice(0, 80) });
    const needs = Number(summary?.needs) || 0;
    states.set(host.hostId, { state: "online", text: needs ? `Online · ${needs} need${needs === 1 ? "s" : ""} you` : "Online" });
  } catch (error) {
    states.set(host.hostId, error.code === 4404 ? { state: "offline", text: "Offline" } : error.code === 4403 ? { state: "denied", text: "Not allowed: revoked, or not on this relay" } : { state: "offline", text: error.message });
  }
  await renderHosts();
}

// Pairing

// Home Screen apps may not share Safari's identity. Pair inside this app,
// without navigating a credential-bearing link back into Safari.
// An older cached index can briefly run the new module during a worker upgrade.
const addHostButton = $("#add-host") ?? $(".top").appendChild(el("button", { id: "add-host", type: "button", textContent: "Add host" }));
addHostButton.onclick = () => {
  const input = el("input", { className: "pair-link", type: "url", required: true, autocomplete: "off", spellcheck: false, placeholder: `${location.origin}/#pair=…` });
  input.setAttribute("autocapitalize", "off");
  const error = el("p", { className: "pair-error", role: "alert" });
  const cancel = el("button", { type: "button", textContent: "Cancel" });
  cancel.onclick = () => { $("#pair").replaceChildren(); $("#pair").hidden = true; };
  const form = el("form", {}, el("label", {}, "Pairing link", input),
    el("div", { className: "row" }, el("button", { type: "submit", className: "primary", textContent: "Continue" }), cancel), error);
  form.onsubmit = event => {
    event.preventDefault();
    let url;
    try { url = new URL(input.value.trim()); }
    catch { error.textContent = "Paste a valid pairing link copied from your host."; return; }
    if (url.origin !== location.origin) { error.textContent = "Use a pairing link for this relay, copied from your host."; return; }
    try {
      if (url.username || url.password || url.pathname !== "/" || url.search || !parsePairFragment(url.hash)) throw new Error("Invalid link");
    } catch { error.textContent = "Paste a valid pairing link copied from your host."; return; }
    input.value = "";
    void showPairing(url.hash);
  };
  pairCard(el("h2", { textContent: "Add a host" }),
    el("p", { className: "empty", textContent: "On your Mac, open Settings → Remote access → Pair a device, then Copy link. Paste the fresh link here to pair this app, not Safari. Each link works once." }), form);
  input.focus();
};

async function showPairing(hash = location.hash) {
  let link;
  try { link = parsePairFragment(hash); }
  catch (error) { history.replaceState(null, "", "/"); pairCard(el("p", { textContent: error.message })); return; }
  if (!link) return;
  // The code must not stay in the address bar or history.
  history.replaceState(null, "", "/");
  const known = (await hosts()).some(host => host.hostId === link.hostId);
  const name = el("input", { value: guessName(), maxLength: 80, autocomplete: "off" });
  const pair = el("button", { type: "button", className: "primary", textContent: known ? "Pair again" : "Pair" });
  const cancel = el("button", { type: "button", textContent: "Cancel" });
  const status = el("p", { className: "empty" });
  cancel.onclick = () => { $("#pair").hidden = true; };
  pair.onclick = async () => {
    pair.disabled = true; status.textContent = "Pairing…";
    try {
      await withHost(link.hostId, async tunnel => {
        const subscription = await (await (await registration).pushManager?.getSubscription())?.toJSON();
        if (subscription) await call(tunnel, "POST", "/remote/push", { subscription }).catch(() => {});
      }, { code: link.code, name: name.value.trim() || guessName() });
      await saveHost({ hostId: link.hostId, name: link.hostName || "Host", pairedAt: Date.now() });
      $("#pair").hidden = true;
      await renderHosts(); void check({ hostId: link.hostId, name: link.hostName });
    } catch (error) { status.textContent = error.code === 4403 ? "This pairing link was already used or has expired. Make a new one on the host." : error.message; pair.disabled = false; }
  };
  pairCard(el("h2", { textContent: `Pair with ${link.hostName || "this host"}?` }),
    el("p", { className: "empty", textContent: "Only pair with a QR code or link you just made on your own host." }),
    el("label", {}, "This device's name", name), el("div", { className: "row" }, pair, cancel), status);
}
function pairCard(...children) { const card = $("#pair"); card.replaceChildren(...children); card.hidden = false; }
function guessName() {
  const agent = navigator.userAgent;
  return /iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1) ? "iPad" : /iPhone/.test(agent) ? "iPhone" : /Android/.test(agent) ? "Android" : /Mac/.test(agent) ? "Mac" : "Browser";
}

// Notifications: one subscription signed by the relay's VAPID key, given to every paired host.

async function renderNotify(message = "") {
  const root = $("#notify"), reg = await registration;
  const supported = "PushManager" in window && "Notification" in window;
  const subscribed = supported && Notification.permission === "granted" && await reg.pushManager.getSubscription();
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!supported) { root.replaceChildren(standalone ? "This browser has no web push." : "For notifications on iPhone or iPad, tap Share → Add to Home Screen, then open Pi Projects from the Home Screen."); return; }
  const button = el("button", { type: "button", textContent: subscribed ? "Send to hosts again" : "Enable notifications" });
  button.onclick = async () => { button.disabled = true; try { await renderNotify(await subscribe()); } catch (error) { await renderNotify(error.message); } };
  root.replaceChildren(el("div", { className: "row" }, el("span", { textContent: subscribed ? "Notifications are on." : "Get notified when a host needs you." }), button), ...(message ? [el("p", { textContent: message })] : []));
}
async function subscribe() {
  if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked. Allow them in Settings, then try again.");
  const reg = await registration;
  const { key } = await (await fetch("/vapid", { cache: "no-store" })).json();
  let subscription = await reg.pushManager.getSubscription();
  const current = subscription?.options?.applicationServerKey;
  if (subscription && current && b64u(current) !== key) { await subscription.unsubscribe(); subscription = null; }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)) });
  const results = [];
  for (const host of await hosts()) {
    try { await withHost(host.hostId, tunnel => call(tunnel, "POST", "/remote/push", { subscription: subscription.toJSON() })); results.push(`${host.name}: on`); }
    catch (error) { results.push(`${host.name}: ${error.code === 4404 ? "offline, try again later" : error.message}`); }
  }
  return results.join(" · ");
}

// Fingerprint: SHA-256 over the cached bootstrap files in sorted path order, each as `path\n` + bytes (relay/relay.ts `fingerprint`).

async function fingerprint() {
  const name = (await caches.keys()).find(key => key.startsWith("boot-"));
  if (!name) return null;
  const cache = await caches.open(name), entries = [];
  for (const request of await cache.keys()) entries.push({ path: new URL(request.url).pathname, bytes: new Uint8Array(await (await cache.match(request)).arrayBuffer()) });
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const parts = entries.flatMap(entry => [utf8(`${entry.path}\n`), entry.bytes]);
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { all.set(part, at); at += part.length; }
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", all))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function renderFingerprint() {
  const value = await fingerprint();
  $("#fingerprint").textContent = value ?? "…";
  if (!value) return;
  const trusted = await get("fingerprint");
  if (!trusted) { await put("fingerprint", value); return; }
  if (trusted === value) { $("#warning").hidden = true; return; }
  const accept = el("button", { type: "button", textContent: "It matches my host" });
  accept.onclick = async () => { await put("fingerprint", value); $("#warning").hidden = true; };
  $("#warning").replaceChildren(el("h2", { textContent: "The app changed" }),
    el("p", { textContent: "The relay served a new version of this app. Before you open a host, compare the fingerprint below with Settings → Remote access on your host (or `node relay/relay.ts fingerprint` on the relay)." }),
    accept);
  $("#warning").hidden = false;
}

navigator.serviceWorker.addEventListener("controllerchange", () => void renderFingerprint());
await showPairing();
addEventListener("hashchange", () => void showPairing());
await renderHosts();
for (const host of await hosts()) void check(host);
void renderNotify();
void registration.then(reg => reg.active ? renderFingerprint() : navigator.serviceWorker.ready.then(renderFingerprint));
