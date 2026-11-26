import { localHost, pairingEntry } from "./api.js";

const inbox = () => location.hostname === "127.0.0.1";
export function workspace(host, view = "projects") {
  const url = new URL("/workspace.html", location.origin);
  url.searchParams.set("host", host.hostId);
  url.searchParams.set("view", view);
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
    location.assign(host ? workspace(host, view) : `/?panel=${view}`);
  };
  container.replaceChildren(picker);
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
      await localHost.call("inbox-host-add", entry);
      const timeout = setTimeout(() => finish("Pairing timed out."), 30000);
      function finish(message) {
        clearTimeout(timeout);
        removeEventListener("message", receive);
        child.close();
        button.disabled = false;
        if (message) error.textContent = message;
        else location.assign(workspace(entry));
      }
      function receive(e) {
        if (e.origin !== location.origin || e.source !== child) return;
        if (e.data === "ready") child.postMessage({ entry, pair }, location.origin);
        else if (e.data === "paired") finish();
        else if (e.data === "incompatible") finish();
        else if (e.data === "failed") finish("Pairing failed. Check the host and use a fresh pairing link.");
      }
      button.disabled = true;
      addEventListener("message", receive);
      child.location.replace("/pair-inbox.html");
    } catch {
      child.close();
      error.textContent = "Invalid pairing link, or the host list could not be saved.";
    }
  };
}
