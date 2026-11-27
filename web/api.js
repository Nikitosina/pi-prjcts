// The only module that talks to the host. Requests go through `call`.
import { dropHostStorage } from "./drafts.js";
import { hostCache, stamp, wipeHost } from "./host-cache.js";

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
/** A read of a remote host that was never saved while it was online, asked while it is offline. */
export class NeverLoadedError extends HostError {
  constructor(hostName) {
    super(`Never loaded: this was not opened while ${hostName} was online, so there is no offline copy of it.`, 0, true, false);
    this.neverLoaded = true;
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

/**
 * The local host's own stream (`/changes?project=host`) is held by one tab at a time and relayed to the others: a browser allows six
 * connections per origin across all tabs, and a stream per tab would leave none for requests once a second tab is open.
 * The tab holding the Web Lock opens it; when that tab closes another takes over and its first frame is a `sync`.
 */
function openSharedStream(host, path, onFrame, onState = () => {}) {
  if (!navigator.locks || typeof BroadcastChannel === "undefined") return openStream(host, path, onFrame, onState);
  const name = `pi-stream:${location.origin}${path}`,
    channel = new BroadcastChannel(name),
    abort = new AbortController();
  let inner = null,
    up = false,
    release = null;
  channel.onmessage = ({ data }) => {
    if (data.hello) {
      if (!inner) return;
      channel.postMessage({ up });
      channel.postMessage({ frame: { t: "sync" } });
      return;
    }
    if (inner) return;
    if (data.frame) onFrame(data.frame);
    else onState(data.up);
  };
  channel.postMessage({ hello: true });
  navigator.locks
    .request(name, { signal: abort.signal }, () => {
      if (abort.signal.aborted) return;
      inner = openStream(
        host,
        path,
        (frame) => {
          channel.postMessage({ frame });
          onFrame(frame);
        },
        (value) => {
          up = value;
          channel.postMessage({ up });
          onState(value);
        },
      );
      return new Promise((done) => (release = done));
    })
    .catch(() => {});
  return {
    stop() {
      abort.abort();
      inner?.stop();
      inner = null;
      release?.();
      channel.close();
    },
  };
}

const reads = new Set(
  `approvals-list automation-snapshot chat-history coordinator-skills deploy-snapshot host-agent-history jobs-snapshot knowledge-read limits-snapshot list machine-status memory-index memory-recent memory-writes plugin-catalog plugin-section plugins profile-tools profiles-get prompt-blocks-get prompt-render prs remote-devices remote-status schedule-history schedule-snapshot search settings-snapshot show storage-status storage-summary telegram-snapshot thread-history tiers-get tool-summaries-usage transcript-image ui-get usage-snapshot worker-contexts pr-review-files pr-review-file pr-review-lines pr-review-tour-status`.split(
    " ",
  ),
);
const isRead = (action, input) =>
  reads.has(action) || (action === "pr-review-open" && !input?.seen) || (action === "host-agent-settings" && !input?.patch);
// Pending approvals of an offline host are not shown: they cannot be decided there.
const uncached = new Set(["approvals-list"]);
// Offline, only the saved reads answer; a remote host in any other state (revoked, needs update, forgotten) answers nothing.
const SAVING = new Set(["online", "offline"]);
function hostClient(transport) {
  const run = transport.run ?? ((_read, _signal, work) => work(transport.authorizedFetch));
  const cache = transport.local ? null : hostCache(transport.hostId);
  /** Where each answer handed out came from: `{ at, live }`, the time it was read and whether that read was live or a copy from the cache.
   * Keyed by the answer object itself, so a view knows about exactly the data it rendered and no other read can change that. */
  const provenance = new WeakMap();
  const note = (data, at, live) => {
    if (data && typeof data === "object") provenance.set(data, { at, live });
    return data;
  };
  let served = false; // a copy was shown at some point, so a live answer may have to take its place on screen
  const offlineError = () => new HostError(`${transport.name} is offline. Changes are disabled until it is back.`, 0, true, false);
  const plain = (read, action, input, signal) => run(read, signal, (fetch) => requestAction(fetch, action, input, signal));
  const host = Object.assign(transport, {
    provenance: (data) => (data && typeof data === "object" ? (provenance.get(data) ?? null) : null),
    storagePrefix: transport.local ? "" : `pi-host:${transport.hostId}:`,
    /** A flow that reads and then writes (Archive's idle check, a revision lookup before a save): its reads never answer from a copy, and once the
     * host has gone offline at any time since the guard was made, even if it is back, its reads and writes are refused. */
    guard() {
      const epoch = transport.epoch;
      return { call: (action, input, signal) => transport.call(action, input, signal, { fresh: true, epoch }) };
    },
    /** One call. A read of a remote host answers from its offline copy while the host is offline, and an unfinished one answers the same way the moment
     * the host drops: nothing waits for a reconnect and nothing is replayed (REMOTE_SPEC.md, decision 14). `fresh` reads never answer from a copy;
     * `epoch` is the guard's count of connection losses. */
    async call(action, input, signal, { fresh = false, epoch = null } = {}) {
      const read = isRead(action, input);
      const serve = async () => {
        const saved = uncached.has(action) ? null : await cache.get(action, input);
        // The host may have come back or been revoked while the cache answered: that answer is then not for this moment.
        if (transport.state !== "offline") return undefined;
        served = true;
        if (saved) note(saved.data, saved.savedAt, false);
        transport.dispatchEvent?.(new Event("copy"));
        return saved;
      };
      for (;;) {
        if (cache && epoch !== null && transport.epoch !== epoch) throw offlineError();
        if (cache && transport.state === "offline") {
          if (!read || fresh) throw offlineError();
          const saved = await serve();
          if (saved === undefined) continue;
          if (!saved) throw new NeverLoadedError(transport.name);
          return saved.data;
        }
        if (!cache || !read) return plain(read, action, input, signal);
        const started = stamp();
        const attempt = new AbortController(),
          forward = () => attempt.abort(signal.reason),
          drop = () => transport.state === "offline" && attempt.abort(offlineError());
        signal?.addEventListener("abort", forward, { once: true });
        transport.addEventListener("statechange", drop);
        try {
          const data = await plain(read, action, input, attempt.signal);
          if (!uncached.has(action)) {
            note(data, Date.now(), true);
            if (SAVING.has(transport.state)) void cache.put(action, input, data, started);
          }
          if (served) transport.dispatchEvent?.(new Event("copy"));
          return data;
        } catch (error) {
          if (signal?.aborted || !attempt.signal.aborted) throw error;
          // The host dropped while this read was in flight: the loop answers it from the copy, or refuses it, right now.
          if (fresh) throw attempt.signal.reason;
        } finally {
          signal?.removeEventListener("abort", forward);
          transport.removeEventListener("statechange", drop);
        }
      }
    },
    stream(path, onFrame, onState) {
      return (transport.local && path === "/changes?project=host" ? openSharedStream : openStream)(transport, path, onFrame, onState);
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
  /** True while a remote host is offline and answers from its offline copy; never for the local host. */
  Object.defineProperty(host, "offline", { get: () => !!cache && transport.state === "offline" });
  return host;
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
    const wiped = await wipeHost(id).then(
      () => null,
      (error) => error,
    );
    dropHostStorage(id);
    stopViews(id);
    await forgetDevice(id);
    clients.delete(id);
    if (wiped) throw Error(`The host is forgotten, but its offline copy could not be deleted: ${wiped.message}`);
  });
}

export const uuid = () => crypto.randomUUID();
