import { authenticatePair } from "./remote-client.js";

history.replaceState(null, "", location.pathname);
if (window.opener) {
  async function receive(event) {
    if (event.origin !== location.origin || event.source !== window.opener) return;
    removeEventListener("message", receive);
    try {
      const identity = await authenticatePair(event.data.entry, event.data.pair);
      window.opener.postMessage({ identity }, location.origin);
    } catch {
      window.opener.postMessage("failed", location.origin);
    }
  }
  addEventListener("message", receive);
  window.opener.postMessage("ready", location.origin);
}
