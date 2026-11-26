import { remoteHost } from "./api.js";
if (window.opener) {
  async function receive(event) {
    if (event.origin !== location.origin || event.source !== window.opener) return;
    removeEventListener("message", receive);
    let result = "failed";
    try {
      const client = await remoteHost(event.data.entry, event.data.pair);
      if (client.state === "online") result = "paired";
      if (client.state === "needs update") result = "incompatible";
    } finally {
      window.opener.postMessage(result, location.origin);
    }
  }
  addEventListener("message", receive);
  window.opener.postMessage("ready", location.origin);
}
