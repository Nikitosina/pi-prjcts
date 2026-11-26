import { localHost, pairingEntry, remoteHost, forgetHost } from "./api.js";

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
function inboxUrl(host, view = "projects") {
  const url = new URL("/", location.origin);
  url.searchParams.set("host", host.hostId);
  url.searchParams.set("panel", view);
  return url;
}
export async function hostSwitcher(container, selected = localHost, view = "projects") {
  if (!inbox()) return;
  const entries = await localHost.call("inbox-hosts");
  if (!entries.length || !container.isConnected) return;
  const picker = document.createElement("select");
  picker.setAttribute("aria-label", "Host");
  picker.append(new Option("This machine", ""));
  for (const entry of entries) picker.append(new Option(entry.name, entry.hostId, false, entry.hostId === selected.hostId));
  picker.onchange = () => {
    const host = entries.find((e) => e.hostId === picker.value);
    location.assign(host ? inboxUrl(host, view) : `/?panel=${view}`);
  };
  container.hidden = false;
  container.replaceChildren(picker);
  if (!selected.local) {
    const forget = document.createElement("button");
    forget.type = "button";
    forget.textContent = "Forget host";
    forget.onclick = async () => {
      if (!confirm(`Forget ${selected.name} on this machine?`)) return;
      try {
        await forgetHost(selected.hostId);
        location.assign("/");
      } catch (error) {
        forget.textContent = error.message;
      }
    };
    container.append(forget);
  }
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
          await forgetDevice(entry.hostId);
          throw error;
        }
      });
      location.assign(inboxUrl(entry));
    } catch (problem) {
      error.textContent = problem.message;
    } finally {
      button.disabled = false;
      child.close();
    }
  };
}
