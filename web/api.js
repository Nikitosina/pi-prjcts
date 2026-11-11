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
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
export async function call(action, input = {}) {
  if (!token) throw new HostError("Not signed in", 401);
  const response = await fetch("/api", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...input }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new HostError(`Host answered HTTP ${response.status}`, response.status);
  }
  if (!body.ok) throw new HostError(String(body.error ?? "Request failed"), response.status);
  return body.data;
}

/** An authenticated GET of a host path outside `/api` (plugin routes). */
export function authorizedFetch(path, init = {}) {
  return fetch(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
}

/**
 * Reads one SSE stream (`/live` or `/changes`) and calls `onFrame` per JSON frame. Reconnects with backoff until `stop()`.
 * `onState(up)` reports the connection for the status line. A 4xx (e.g. host streams before the backend merge) backs off to 60 s.
 */
export function stream(path, onFrame, onState = () => {}) {
  let controller = null,
    stopped = false,
    retry = 1000,
    timer = 0;
  const open = async () => {
    controller = new AbortController();
    let failed = false;
    try {
      const response = await fetch(path, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
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

export const uuid = () => crypto.randomUUID();
