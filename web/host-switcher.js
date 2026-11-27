import { localHost, pairingEntry, remoteHost } from "./api.js";
import { forgetGroup } from "./hosts.js";
import { fail } from "./state.js";

const inbox = () => location.hostname === "127.0.0.1";
export async function hostForPage() {
  const id = new URL(location.href).searchParams.get("host");
  if (!inbox() || !id) return localHost;
  const entry = (await localHost.call("inbox-hosts")).find((item) => item.hostId === id);
  if (!entry) {
    location.replace("/");
    throw Error("Unknown host");
  }
  return remoteHost(entry);
}
/** Remote hosts saved in the local home; none outside the local inbox (the relay PWA serves one host). */
export async function savedHosts() {
  if (!inbox()) return [];
  return localHost.call("inbox-hosts").catch((error) => (console.warn(error), []));
}
/** The page with Settings or the Host agent (`view`) opened for `host`; the selected project and chat stay. */
function adminUrl(host, view) {
  const url = new URL(location.href);
  host?.hostId ? url.searchParams.set("host", host.hostId) : url.searchParams.delete("host");
  view ? url.searchParams.set("panel", view) : url.searchParams.delete("panel");
  return url;
}
/** The host chosen for Settings and the Host agent, in their own header. Switching reloads the page for that host. */
export async function hostSwitcher(container, selected = localHost, view = "settings") {
  if (!inbox()) return;
  const entries = await localHost.call("inbox-hosts");
  if (!entries.length || !container.isConnected) return;
  const picker = document.createElement("select");
  picker.className = "host-picker";
  picker.setAttribute("aria-label", "Host");
  picker.append(new Option("This machine", ""));
  for (const entry of entries) picker.append(new Option(entry.name, entry.hostId, false, entry.hostId === selected.hostId));
  picker.onchange = () =>
    location.assign(
      adminUrl(
        entries.find((e) => e.hostId === picker.value),
        view,
      ),
    );
  container.hidden = false;
  container.replaceChildren(picker);
}

let menu = null;
export const hostMenuOpen = () => !!menu;
export function closeHostMenu() {
  menu?.remove();
  menu = null;
  removeEventListener("pointerdown", outside, true);
}
function outside(event) {
  if (!menu?.contains(event.target) && !event.target.closest?.("[data-host-menu]")) closeHostMenu();
}
/** A host group's menu in the sidebar: its Settings and Host agent, and Forget host for a remote host. */
export function openHostMenu({ group, button }) {
  const again = menu?.dataset.for === group.key;
  closeHostMenu();
  if (again) return;
  menu = document.createElement("div");
  menu.className = "host-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${group.name} actions`);
  menu.dataset.for = group.key;
  const item = (label, run, danger = false) => {
    const node = document.createElement("button");
    node.type = "button";
    node.setAttribute("role", "menuitem");
    node.textContent = label;
    if (danger) node.className = "danger";
    node.onclick = run;
    menu.append(node);
  };
  const host = group.entry ? { hostId: group.entry.hostId } : null;
  item("Settings", () => location.assign(adminUrl(host, "settings")));
  item("Host agent", () => location.assign(adminUrl(host, "agent")));
  if (group.entry)
    item(
      "Forget host…",
      async () => {
        closeHostMenu();
        if (!confirm(`Forget ${group.name} on this machine?`)) return;
        try {
          await forgetGroup(group);
          if (new URL(location.href).searchParams.get("host") === group.entry.hostId) location.assign(adminUrl(null));
        } catch (error) {
          fail(error);
        }
      },
      true,
    );
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  menu.style.top = `${Math.min(innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, rect.right - menu.offsetWidth))}px`;
  addEventListener("pointerdown", outside, true);
  menu.querySelector("button").focus();
}
export function addHostControl(container) {
  if (!inbox()) return;
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "Paste pairing link";
  input.setAttribute("aria-label", "Host pairing link");
  input.required = true;
  const button = document.createElement("button");
  button.dataset.addHost = "";
  button.textContent = "Add host";
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  form.append(input, button, error);
  container.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const link = input.value;
    input.value = "";
    // The new local document receives the updated CSP. Its opener hands over the code in memory, never via a URL or storage.
    const child = window.open("about:blank", "_blank", "popup,width=460,height=240");
    if (!child) {
      error.textContent = "Allow the local pairing window and try again.";
      return;
    }
    try {
      const { entry, pair } = await pairingEntry(link);
      button.disabled = true;
      error.textContent = "";
      await navigator.locks.request(`pair:${entry.hostId}`, async () => {
        if ((await localHost.call("inbox-hosts")).some((host) => host.hostId === entry.hostId))
          throw Error("Already paired. Forget this host before pairing again.");
        const page = await localHost.authorizedFetch("/inbox/pair-window", { method: "POST", body: entry.relayOrigin });
        if (!page.ok) throw Error("Could not open pairing window.");
        const path = await page.text();
        const identity = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => finish(), 30000);
          function finish(identity) {
            clearTimeout(timeout);
            removeEventListener("message", receive);
            if (identity) resolve(identity);
            else reject(Error("Pairing failed. Use a fresh pairing link."));
          }
          function receive(e) {
            if (e.origin !== location.origin || e.source !== child) return;
            if (e.data === "ready") child.postMessage({ entry, pair }, location.origin);
            else finish(e.data?.identity);
          }
          addEventListener("message", receive);
          child.location.replace(path);
        });
        const { saveDevice, forgetDevice } = await import("./remote-client.js");
        await saveDevice(entry.hostId, identity);
        try {
          await localHost.call("inbox-host-add", entry);
        } catch (error) {
          // The write may have landed. Never replay it or discard the only key for a committed pairing.
          const hosts = await localHost.call("inbox-hosts").catch(() => null);
          if (!hosts) throw Error("Result unknown, check after reconnecting.");
          if (!hosts.some((host) => host.hostId === entry.hostId && host.relayOrigin === entry.relayOrigin)) {
            await forgetDevice(entry.hostId);
            throw error;
          }
        }
      });
      location.assign(adminUrl(null));
    } catch (problem) {
      error.textContent = problem.message;
    } finally {
      button.disabled = false;
      child.close();
    }
  };
}
