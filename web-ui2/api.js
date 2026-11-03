// The only module that talks to the host. Existing requests go through `call`; requests from docs/ui2-contract.md that the
// host may not know yet go through `contract`, which turns an unknown-action rejection into a quiet `Unavailable` value.

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
/** A contract request the running host does not know yet (before the backend merge). */
export class Unavailable {
  constructor(action) {
    this.action = action;
    this.unavailable = true;
  }
}
export const isUnavailable = (value) => value instanceof Unavailable;
export const UNAVAILABLE_TEXT = "Available after backend merge";

// A pre-merge host validates /api input against a union of the actions it knows, so an unknown action shows up as
// "/action: must be equal to constant" somewhere in the joined branch errors. Only contract() uses this, and logs the raw text.
const unknownAction = (message) => /^Invalid data:.*\/action: must be equal to constant/.test(message) || /unknown action/i.test(message);
const missing = new Set();

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

/** A request from docs/ui2-contract.md: resolves to `Unavailable` when this host predates it, and never asks twice per page load. */
export async function contract(action, input = {}) {
  if (missing.has(action)) return new Unavailable(action);
  try {
    return await call(action, input);
  } catch (error) {
    if (error instanceof HostError && unknownAction(error.message)) {
      console.info(`${action}: treated as not yet on this host (${error.message.slice(0, 160)})`);
      missing.add(action);
      return new Unavailable(action);
    }
    throw error;
  }
}
export const knownMissing = (action) => missing.has(action);

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
