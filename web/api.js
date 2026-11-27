// The only module that talks to the host. Requests go through `call`.

const key = `pi-projects-token:${location.origin}`;
const supplied = new URLSearchParams(location.hash.slice(1)).get("token");
if (supplied && /^[a-f0-9]{64}$/.test(supplied)) {
  try {
    localStorage.setItem(key, supplied);
  } catch {}
}
// The token never stays in the address bar (screenshots, shared links, history).
if (location.hash.includes("token=")) history.replaceState(history.state, "", location.pathname + location.search);

function storedToken() {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
export let token = storedToken();
export function setToken(value) {
  token = value;
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export class HostError extends Error {
  /**
   * `refused` is true only when the host itself said it changed nothing; any other failure, a gateway's JSON included, leaves the request possibly acted on.
   * `answered` is false when no readable answer came back, so the outcome of a write is unknown.
   */
  constructor(message, status, refused = false, answered = true) {
    super(message);
    this.status = status;
    this.refused = refused;
    this.answered = answered;
  }
}
async function requestAction(fetch, action, input = {}, signal) {
  const response = await fetch("/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, action }),
    signal,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new HostError(`Host answered HTTP ${response.status}`, response.status, false, false);
  }
  if (!body.ok)
    throw new HostError(String(body.error ?? "Request failed"), response.status, body.refused === true, typeof body.error === "string");
  return body.data;
}

/** An authenticated GET of a host path outside `/api` (plugin routes). */
function localFetch(path, init = {}) {
  if (!token) throw new HostError("Not signed in", 401);
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) throw new Error("Expected a host path");
  return fetch(url.pathname + url.search, { ...init, redirect: "error", headers: { ...init.headers, authorization: `Bearer ${token}` } });
}

/**
 * Reads one SSE stream (`/live` or `/changes`) and calls `onFrame` per JSON frame. Reconnects with backoff until `stop()`.
 * `onState(up)` reports the connection for the status line. A 4xx (e.g. host streams before the backend merge) backs off to 60 s.
 */
function openStream(host, path, onFrame, onState = () => {}) {
  let controller = null,
    stopped = false,
    retry = 1000,
    timer = 0;
  const open = async () => {
    controller = new AbortController();
    let failed = false;
    try {
      const response = await host.authorizedFetch(path, { signal: controller.signal });
      if (!response.ok || !response.body) {
        failed = response.status >= 400 && response.status < 500;
        return;
      }
      onState(true);
      retry = 1000;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) return;
        buffered += value;
        let end;
        while ((end = buffered.indexOf("\n\n")) >= 0) {
          const event = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data || stopped) continue;
          try {
            onFrame(JSON.parse(data));
          } catch (error) {
            console.warn("Bad frame", error);
          }
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") console.warn("Stream ended", path, error?.message);
    } finally {
      if (!stopped) {
        onState(false);
        timer = setTimeout(open, failed ? 60000 : retry);
        retry = Math.min(retry * 2, 15000);
      }
    }
  };
  void open();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}

const reads = new Set(
  `approvals-list automation-snapshot chat-history coordinator-skills deploy-snapshot host-agent-history jobs-snapshot knowledge-read limits-snapshot list machine-status memory-index memory-recent memory-writes plugin-catalog plugin-section plugins profile-tools profiles-get prompt-blocks-get prompt-render prs remote-devices remote-status schedule-history schedule-snapshot search settings-snapshot show storage-status storage-summary telegram-snapshot thread-history tiers-get tool-summaries-usage transcript-image ui-get usage-snapshot worker-contexts pr-review-files pr-review-file pr-review-lines pr-review-tour-status`.split(
    " ",
  ),
);
function hostClient(transport) {
  const run = transport.run ?? ((_read, _signal, work) => work(transport.authorizedFetch));
  return Object.assign(transport, {
    storagePrefix: transport.local ? "" : `pi-host:${transport.hostId}:`,
    call(action, input, signal) {
      return run(
        reads.has(action) || (action === "pr-review-open" && !input?.seen) || (action === "host-agent-settings" && !input?.patch),
        signal,
        (fetch) => requestAction(fetch, action, input, signal),
      );
    },
    /** An action the host itself classed as a read (a plugin button with a read policy); replayed after a lost connection like other reads. */
    read(action, input, signal) {
      return run(true, signal, (fetch) => requestAction(fetch, action, input, signal));
    },
    stream(path, onFrame, onState) {
      return openStream(transport, path, onFrame, onState);
    },
    async url(path, { image, maxBytes, ...options } = {}) {
      return run(true, options.signal, async (fetch) => {
        const response = await fetch(path, options);
        if (maxBytes && Number(response.headers.get("content-length")) > maxBytes) {
          await response.body?.cancel();
          throw Error("Resource too large");
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new HostError(`Resource unavailable (${response.status})`, response.status);
        }
        const data = await response.blob();
        const type = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|wav|ogg)|video\/(mp4|webm))$/.test(data.type)
          ? data.type
          : "application/octet-stream";
        if (image && !type.startsWith("image/")) throw Error("Not an image");
        return URL.createObjectURL(data.slice(0, data.size, type));
      });
    },
  });
}
export const localHost = hostClient({ local: true, authorizedFetch: localFetch });

const clients = new Map();
export async function remoteHost(entry) {
  if (clients.has(entry.hostId)) return clients.get(entry.hostId);
  const creating = (async () => {
    const { remoteTransport } = await import("./remote-client.js");
    const transport = await remoteTransport(entry);
    return hostClient(transport);
  })();
  clients.set(entry.hostId, creating);
  try {
    return await creating;
  } catch (error) {
    clients.delete(entry.hostId);
    throw error;
  }
}
export async function pairingEntry(link) {
  const { parsePairFragment } = await import("/inbox-wire/wire.js");
  const url = new URL(link);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search) throw Error("Invalid pairing link");
  const value = parsePairFragment(url.hash);
  if (!value) throw Error("Invalid pairing link");
  return {
    entry: { hostId: value.hostId, name: value.hostName, relayOrigin: url.origin },
    pair: { code: value.code, name: "Local inbox" },
  };
}
export async function forgetHost(id) {
  const { forgetDevice, stopViews } = await import("./remote-client.js");
  await navigator.locks.request(`pair:${id}`, async () => {
    await localHost.call("inbox-host-forget", { hostId: id });
    stopViews(id);
    await forgetDevice(id);
    clients.delete(id);
  });
}

export const uuid = () => crypto.randomUUID();
